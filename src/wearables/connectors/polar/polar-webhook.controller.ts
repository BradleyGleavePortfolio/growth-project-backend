import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'crypto';
import { WearableProvider } from '@prisma/client';
import { z } from 'zod';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { PolarConnector, redactErrorMessage } from './polar.connector';
import { PolarWebhookEvent } from './polar.types';

/**
 * PR-HK-2.g — Polar AccessLink webhook receiver.
 *
 * `POST /v1/wearables/webhooks/polar` — Polar pushes one event per changed
 * entity (plus periodic `PING` liveness checks). Security model (mirrors the
 * Oura/Stripe raw-body HMAC pattern):
 *  1. `@Public` — Polar is not a Supabase user; auth is the HMAC, not a JWT.
 *  2. Raw-body HMAC verify FIRST (constant-time). Invalid → 401, no handling.
 *  3. Zod-validate the parsed payload (#8). Malformed → 400 (no payload echo).
 *  4. `PING` is acknowledged with a plain 200 — no fetch, no dedup row.
 *  5. Replay/idempotency via `WearableProcessedEvent` (provider='POLAR',
 *     provider_event_id) — a duplicate is a 200 no-op (#28/#29).
 *  6. Resolve the connection (by Polar user_id), fetch ONLY the just-changed
 *     resource, normalize, and batch-ingest via IngestionService (#21 no N+1).
 *  7. ONLY AFTER a successful fetch+ingest, persist the
 *     {@link WearableProcessedEvent} dedup row ("check → process → commit").
 * Throttled (#6). Never logs raw payloads/ids/tokens — only redacted,
 * hashed metadata (audit patterns 3 + 7).
 *
 * Idempotency ordering (audit pattern 1 + 6): the dedup row is written AFTER
 * fetch+normalize+ingest succeed, not before. If fetch/ingest throws, NO
 * processed-event row exists, so Polar's redelivery is reprocessed (not
 * silently no-op'd) and no data is lost. A small race window (two concurrent
 * deliveries of the SAME event) is absorbed by the PR-HK-0 sample `dedup_key`
 * UNIQUE constraint (`createMany({ skipDuplicates: true })`); the
 * processed-event `create` treats a concurrent P2002 on the composite PK as a
 * benign 200 no-op rather than a 500.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class PolarWebhookController {
  private readonly logger = new Logger(PolarWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly connector: PolarConnector,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('polar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Polar AccessLink webhook event' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    // (2) Raw body is the only signature source we trust.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Polar webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/polar in main.ts.',
      );
      throw new BadRequestException('Polar webhook raw body unavailable');
    }

    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      // Do NOT reveal which check failed. One 401 for all signature failures.
      throw new UnauthorizedException('Invalid Polar webhook signature');
    }

    // (3) Zod-validate the parsed payload. Unknown fields are ignored safely.
    const event = this.parseAndValidate(rawBody);

    // (4) PING liveness check — acknowledge with a 200, nothing to process.
    if (event.event === 'PING') {
      this.logger.log({ msg: 'wearables.polar.webhook.ping', provider: 'POLAR' });
      return { ok: true };
    }

    const providerEventId = this.connector.eventId(event);

    // (5) Replay protection. A prior row for (POLAR, providerEventId) means we
    // already FULLY processed this delivery → 200 no-op. The row is written
    // only AFTER a successful ingest (step 7), so a present row proves
    // completion — there is no half-processed state to re-drive.
    const existing = await this.prisma.wearableProcessedEvent.findUnique({
      where: {
        provider_provider_event_id: {
          provider: WearableProvider.POLAR,
          provider_event_id: providerEventId,
        },
      },
    });
    if (existing) {
      this.logger.log({
        msg: 'wearables.polar.webhook.replay_noop',
        provider: 'POLAR',
        event_type: event.event,
      });
      return { ok: true };
    }

    // (6) Resolve the connection by Polar user id, fetch the just-changed
    // resource, normalize, and batch-ingest — BEFORE any dedup row is written.
    // If fetch/ingest throws here, we never reach the dedup-row write (step 7),
    // so Polar's retry reprocesses the event instead of being dropped.
    const externalAccountId =
      event.user_id != null ? String(event.user_id) : null;

    if (externalAccountId) {
      const connection = await this.prisma.wearableConnection.findFirst({
        where: {
          provider: WearableProvider.POLAR,
          external_account_id: externalAccountId,
          disconnected_at: null,
        },
      });

      if (connection) {
        try {
          const raw = await this.connector.fetchChangedRecord(
            connection,
            event,
          );
          const samples = this.connector.normalize(raw);
          if (samples.length > 0) {
            await this.ingestion.ingest(samples);
          }
        } catch (err) {
          // Fail-explicit: mark the connection in error, log redacted +
          // PII-free, and rethrow so the delivery is retried. No
          // processed-event row was written, so the retry reprocesses.
          await this.prisma.wearableConnection
            .update({
              where: { id: connection.id },
              data: { status: 'error', last_error: redactErrorMessage(err) },
            })
            .catch(() => undefined);
          this.logger.error({
            msg: 'wearables.polar.webhook.ingest_failure',
            provider: 'POLAR',
            event_type: event.event,
            user_id_hash: this.hash(externalAccountId),
            error_class: err instanceof Error ? err.name : 'unknown',
            error_message: redactErrorMessage(err),
          });
          throw err;
        }
      } else {
        this.logger.warn({
          msg: 'wearables.polar.webhook.no_connection',
          provider: 'POLAR',
          event_type: event.event,
          user_id_hash: this.hash(externalAccountId),
        });
      }
    }

    // (7) COMMIT: only now that fetch+ingest have succeeded do we persist the
    // dedup row. `handler_completed_at` is set in the same write so the row is
    // never observed in a half-done state. A concurrent delivery that already
    // wrote the row produces a P2002 on the composite PK — we absorb it as a
    // benign no-op; the sample dedup_key UNIQUE constraint already prevented
    // double-counted samples.
    try {
      await this.prisma.wearableProcessedEvent.create({
        data: {
          provider: WearableProvider.POLAR,
          provider_event_id: providerEventId,
          type: event.event,
          handler_completed_at: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log({
          msg: 'wearables.polar.webhook.concurrent_commit_noop',
          provider: 'POLAR',
          event_type: event.event,
        });
        return { ok: true };
      }
      throw err;
    }

    this.logger.log({
      msg: 'wearables.polar.webhook.handled',
      provider: 'POLAR',
      event_type: event.event,
    });
    return { ok: true };
  }

  /**
   * Zod schema for the Polar webhook event payload. `.passthrough()` keeps
   * unknown fields from rejecting the request (ignored safely). `event` +
   * `timestamp` are always required; resource events additionally carry a
   * numeric `user_id` and either an `entity_id` or a `date`. A `PING` carries
   * only `event` + `timestamp`.
   */
  private parseAndValidate(rawBody: Buffer): PolarWebhookEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Polar webhook payload is not valid JSON');
    }

    const schema = z
      .object({
        event: z.string().min(1),
        timestamp: z.string().min(1),
        user_id: z.number().int().optional(),
        entity_id: z.string().min(1).optional(),
        date: z.string().min(1).optional(),
        url: z.string().url().optional(),
      })
      .passthrough()
      .superRefine((val, ctx) => {
        // Non-PING events must identify a subject (entity_id or date) and a
        // user so the connection can be resolved.
        if (val.event !== 'PING') {
          if (val.user_id === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['user_id'],
              message: 'required for non-PING events',
            });
          }
          if (val.entity_id === undefined && val.date === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['entity_id'],
              message: 'entity_id or date required for non-PING events',
            });
          }
        }
      });

    const result = schema.safeParse(json);
    if (!result.success) {
      // Redacted: report field paths, never the raw payload values.
      throw new BadRequestException(
        `Polar webhook payload failed validation: ${result.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
      );
    }
    return result.data as PolarWebhookEvent;
  }

  /** Stable, PII-free user hash for log lines (audit pattern 3). */
  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}
