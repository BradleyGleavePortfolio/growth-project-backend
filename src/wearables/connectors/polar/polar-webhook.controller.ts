import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { WearablesCloudConnectorsGuard } from '../../cloud-connectors.feature';
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
import { POLAR_WEBHOOK_EVENTS, PolarWebhookEvent } from './polar.types';

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
 *     provider_event_id) — RESERVE FIRST, then process (#28/#29).
 *  6. Resolve the connection (by Polar user_id), fetch ONLY the just-changed
 *     resource, normalize, and batch-ingest via IngestionService (#21 no N+1).
 *  7. ONLY AFTER a successful fetch+ingest, STAMP `handler_completed_at` on the
 *     reservation row to mark the delivery durably complete.
 * Throttled (#6). Never logs raw payloads/ids/tokens — only redacted,
 * hashed metadata (audit patterns 3 + 7).
 *
 * Idempotency ordering (audit pattern 1 + 6) — RESERVATION-FIRST, not
 * check-then-act. We atomically reserve the event with
 * `createMany({ skipDuplicates: true })` BEFORE any fetch/ingest work. The
 * insert's `count` tells us whether THIS delivery owns processing:
 *  - `count === 0` → a concurrent or prior delivery already holds the row. We
 *    return a 200 no-op; that owner is (or already finished) doing the work, so
 *    we never double-fetch the provider or double-call ingestion.
 *  - `count === 1` → we own it. We run fetch+normalize+ingest, then stamp
 *    `handler_completed_at` to mark completion.
 * If our owned processing FAILS, we delete OUR reservation row before
 * rethrowing so Polar's redelivery can re-reserve and reprocess — there is no
 * stuck half-done state and no silently-dropped event. This converts the prior
 * check-then-act window (where two concurrent misses both ran the expensive
 * work) into a single-winner atomic barrier on the composite PK.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
@UseGuards(WearablesCloudConnectorsGuard)
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

    // (5) RESERVE FIRST. Atomically insert the processed-event row BEFORE any
    // fetch/ingest work. `createMany({ skipDuplicates: true })` is a single
    // INSERT ... ON CONFLICT DO NOTHING on the composite (provider,
    // provider_event_id) PK, so exactly one concurrent delivery gets count===1
    // and owns processing; every other delivery gets count===0 and no-ops.
    // `handler_completed_at` is left NULL until processing completes (step 7).
    const { count } = await this.prisma.wearableProcessedEvent.createMany({
      data: [
        {
          provider: WearableProvider.POLAR,
          provider_event_id: providerEventId,
          type: event.event,
          // handler_completed_at left NULL → reserved, not yet completed.
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0) {
      // A prior or concurrent delivery already owns this event → 200 no-op.
      // We never re-run the expensive fetch/ingest for a duplicate.
      this.logger.log({
        msg: 'wearables.polar.webhook.replay_noop',
        provider: 'POLAR',
        event_type: event.event,
      });
      return { ok: true };
    }

    // (6) We own processing. Resolve the connection by Polar user id, fetch the
    // just-changed resource, normalize, and batch-ingest. If anything here
    // fails we release OUR reservation (delete the row we just inserted) before
    // rethrowing, so Polar's redelivery can re-reserve and reprocess instead of
    // being silently dropped by a stuck NULL-completion row.
    try {
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
            // Fail-explicit: mark the connection in error (PII-free, redacted)
            // and rethrow. The outer catch releases our reservation so the
            // delivery is retried — no silent swallow, no half-done barrier.
            await this.prisma.wearableConnection.update({
              where: { id: connection.id },
              data: {
                status: 'error',
                last_error: redactErrorMessage(err),
              },
            });
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
    } catch (err) {
      // Release our reservation so the redelivery reprocesses (the event is NOT
      // durably complete). Use deleteMany so a not-found row is not an error.
      await this.prisma.wearableProcessedEvent.deleteMany({
        where: {
          provider: WearableProvider.POLAR,
          provider_event_id: providerEventId,
          handler_completed_at: null,
        },
      });
      throw err;
    }

    // (7) COMPLETE: processing succeeded. Stamp `handler_completed_at` so the
    // reservation row is now observably a durable, fully-processed dedup row.
    await this.prisma.wearableProcessedEvent.updateMany({
      where: {
        provider: WearableProvider.POLAR,
        provider_event_id: providerEventId,
        handler_completed_at: null,
      },
      data: { handler_completed_at: new Date() },
    });

    this.logger.log({
      msg: 'wearables.polar.webhook.handled',
      provider: 'POLAR',
      event_type: event.event,
    });
    return { ok: true };
  }

  /**
   * Strict Zod schema for the Polar webhook event payload. `.strict()` rejects
   * any unknown top-level field as provider drift instead of silently ignoring
   * it, and `event` is constrained to the supported {@link POLAR_WEBHOOK_EVENTS}
   * enum so an unrecognised event type fails closed with a 400 rather than
   * reaching connection resolution and mapping to a null resource. `event` +
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
        event: z.enum(POLAR_WEBHOOK_EVENTS),
        timestamp: z.string().min(1),
        user_id: z.number().int().optional(),
        entity_id: z.string().min(1).optional(),
        date: z.string().min(1).optional(),
        url: z.string().url().optional(),
      })
      .strict()
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
          .map((i) => i.path.join('.') || '(root)')
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
