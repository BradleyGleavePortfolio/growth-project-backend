import { createHash } from 'crypto';
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
import { WearableProvider } from '@prisma/client';
import { z } from 'zod';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { redactErrorMessage, WahooConnector } from './wahoo.connector';
import { WahooWebhookEvent } from './wahoo.types';

/**
 * Supported Wahoo webhook event types. Wahoo's Cloud API pushes one event per
 * changed workout summary under the `workout_summary` event type — the only
 * event this connector ingests. Any other `event_type` is an unsupported /
 * malformed delivery and is rejected at the schema boundary (R1 Finding 2) so
 * it can never be durably committed as "processed" without ingestion.
 */
const SUPPORTED_WAHOO_EVENT_TYPES = ['workout_summary'] as const;

/**
 * PR-HK-2.h — Wahoo webhook receiver.
 *
 * `POST /v1/wearables/webhooks/wahoo` — Wahoo pushes one event per changed
 * workout summary. Security model (mirrors StripeWebhookController):
 *  1. `@Public` — Wahoo is not a Supabase user; auth is the HMAC + shared
 *     `webhook_token`, not a JWT.
 *  2. Raw-body required FIRST (Buffer check → 400 if rawBody middleware is not
 *     wired).
 *  3. HMAC-SHA256 + webhook_token verify (constant-time). Invalid → 401.
 *  4. Zod-validate the parsed payload with a STRICT schema (#8, audit pattern
 *     #4). Malformed/unknown-keys → 400 (no payload echo).
 *  5. Replay/idempotency via `WearableProcessedEvent` (provider='WAHOO',
 *     provider_event_id) — a duplicate is a 200 no-op (#28/#29).
 *  6. Resolve the connection (by Wahoo user id), extract ONLY the just-changed
 *     workout from the webhook body, normalize, and batch-ingest via
 *     IngestionService (#21 no N+1).
 *  7. ONLY AFTER a successful normalize+ingest, persist the
 *     {@link WearableProcessedEvent} dedup row ("check → process → commit",
 *     audit pattern #1). Throttled (#6). Never logs raw payloads / PII — only
 *     redacted, hashed metadata (#12/#36, audit pattern #3).
 *
 * Idempotency ordering: the dedup row is written AFTER normalize+ingest
 * succeed, not before. If ingest throws, NO processed-event row exists, so
 * Wahoo's redelivery is reprocessed (not silently no-op'd). A concurrent P2002
 * unique violation on the composite PK is absorbed as a benign no-op; the
 * sample `dedup_key` UNIQUE constraint already prevents double-counted samples.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class WahooWebhookController {
  private readonly logger = new Logger(WahooWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly connector: WahooConnector,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('wahoo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Wahoo Cloud API webhook event' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    // (2) Raw body is the only signature source we trust.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Wahoo webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/wahoo in main.ts.',
      );
      throw new BadRequestException('Wahoo webhook raw body unavailable');
    }

    // (3) HMAC + shared-token verify FIRST. One 401 for all signature failures.
    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      throw new UnauthorizedException('Invalid Wahoo webhook signature');
    }

    // (4) Strict Zod validation (audit pattern #4). No payload echo on failure.
    const event = this.parseAndValidate(rawBody);

    const providerEventId = this.connector.eventId(event);
    // Schema guarantees `user.id` for a supported workout event (R1 Finding 2),
    // so connection resolution always has a subject id to key on.
    const userId = String(event.user!.id);

    // (5) Replay protection. A prior row for (WAHOO, providerEventId) proves a
    // prior FULL completion (the row is written only after successful ingest)
    // → 200 no-op.
    const existing = await this.prisma.wearableProcessedEvent.findUnique({
      where: {
        provider_provider_event_id: {
          provider: WearableProvider.WAHOO,
          provider_event_id: providerEventId,
        },
      },
    });
    if (existing) {
      this.logger.log({
        msg: 'wearables.wahoo.webhook.replay_noop',
        provider: 'WAHOO',
        event_type: event.event_type,
      });
      return { ok: true };
    }

    // (6) Resolve the connection by Wahoo user id, extract the just-changed
    // workout, normalize, and batch-ingest — BEFORE any dedup row is written.
    const connection = await this.prisma.wearableConnection.findFirst({
      where: {
        provider: WearableProvider.WAHOO,
        external_account_id: userId,
        disconnected_at: null,
      },
    });

    if (connection) {
      try {
        const raw = this.connector.extractWorkoutRecords(connection, event);
        const samples = this.connector.normalize(raw);
        if (samples.length > 0) {
          await this.ingestion.ingest(samples);
        }
      } catch (err) {
        // Fail-explicit: mark the connection in error (redacted), log hashed
        // metadata, and rethrow so the delivery is retried. No processed
        // row was written, so the retry reprocesses.
        // R1 Finding 3: redact before persisting. The connector's redaction
        // helper strips bearer tokens / token-like query params / secrets so
        // a provider URL or token fragment in the thrown error can never
        // leak into durable connection state (#1/#12, audit pattern #7).
        await this.prisma.wearableConnection
          .update({
            where: { id: connection.id },
            data: {
              status: 'error',
              last_error: redactErrorMessage(err),
            },
          })
          .catch(() => undefined);
        this.logger.error({
          msg: 'wearables.wahoo.webhook.ingest_failure',
          provider: 'WAHOO',
          event_type: event.event_type,
          user_hash: this.hash(userId),
          error_class: (err as Error)?.name ?? 'Error',
        });
        throw err;
      }
    } else {
      // Verified, well-formed delivery for a user we have no ACTIVE connection
      // for (e.g. disconnected after the event was queued). Not an error: we
      // still commit the dedup row below so Wahoo's redeliveries are no-ops.
      this.logger.warn({
        msg: 'wearables.wahoo.webhook.no_connection',
        provider: 'WAHOO',
        event_type: event.event_type,
        user_hash: this.hash(userId),
      });
    }

    // (7) COMMIT: only now that normalize+ingest have succeeded do we persist
    // the dedup row. A concurrent delivery that already wrote it produces a
    // P2002 on the composite PK — absorbed as a benign no-op.
    try {
      await this.prisma.wearableProcessedEvent.create({
        data: {
          provider: WearableProvider.WAHOO,
          provider_event_id: providerEventId,
          type: event.event_type,
          handler_completed_at: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log({
          msg: 'wearables.wahoo.webhook.concurrent_commit_noop',
          provider: 'WAHOO',
          event_type: event.event_type,
        });
        return { ok: true };
      }
      throw err;
    }

    this.logger.log({
      msg: 'wearables.wahoo.webhook.handled',
      provider: 'WAHOO',
      event_type: event.event_type,
    });
    return { ok: true };
  }

  /**
   * STRICT Zod schema for the Wahoo webhook payload (audit pattern #4). The
   * documented top-level keys are enumerated; unknown TOP-LEVEL keys reject
   * with a 400.
   *
   * R1 Finding 2 hardening: Wahoo's workout delivery is `event_type ===
   * 'workout_summary'`. For that (the only supported, ingest-bearing) event we
   * REQUIRE the fields the handler depends on so a malformed-but-authenticated
   * delivery is rejected BEFORE any dedup lookup or processed-event commit:
   *  - `event_type` must be a SUPPORTED Wahoo event,
   *  - `user.id` must be present (connection resolution),
   *  - `workout_summary` must be present with a stable `id`,
   *  - the embedded `workout` must carry an `id` and a `starts` instant
   *    (the normalizer's window/dedup anchor).
   * Nested objects stay `.passthrough()` for forward-compat on UNKNOWN keys,
   * but the KNOWN required keys are enforced. On failure we report field PATHS
   * only — never the raw payload values.
   */
  private parseAndValidate(rawBody: Buffer): WahooWebhookEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Wahoo webhook payload is not valid JSON');
    }

    const id = z.union([z.number(), z.string().min(1)]);

    const workoutSchema = z
      .object({
        id,
        starts: z.string().min(1),
      })
      .passthrough();

    const schema = z
      .object({
        event_type: z.enum(SUPPORTED_WAHOO_EVENT_TYPES),
        webhook_token: z.string().min(1).optional(),
        user: z.object({ id }).passthrough(),
        workout_summary: z
          .object({
            id,
            workout: workoutSchema,
          })
          .passthrough(),
      })
      .strict();

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new BadRequestException(
        `Wahoo webhook payload failed validation: ${result.error.issues
          .map((i) => i.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }
    return result.data as WahooWebhookEvent;
  }

  /** Hash a user id for structured logs (audit pattern #3 — no raw PII). */
  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
}
