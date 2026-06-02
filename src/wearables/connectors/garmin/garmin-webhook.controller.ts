import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import {
  GarminConnector,
  hashGarminUserId,
  redactGarminError,
} from './garmin.connector';
import {
  GarminDeregistration,
  GarminDeregistrationSchema,
  GarminRawPayload,
  GarminSummary,
} from './garmin.types';

/**
 * PR-HK-2.d — Garmin Health API push ("ping/push") webhook receiver.
 *
 * `POST /v1/wearables/webhooks/garmin`          — summary push (data)
 * `POST /v1/wearables/webhooks/garmin/deregistration` — user revoked access
 *
 * Garmin's push security model differs from the HMAC connectors
 * (Oura/WHOOP) — the divergences are documented inline:
 *
 *  1. `@Public()` — Garmin is not a Supabase user; trust comes from the
 *     partner-configured push token, NOT a JWT.
 *  2. PUSH-TOKEN VERIFY FIRST — Garmin Health push carries NO per-event HMAC,
 *     so the controller verifies the partner-configured `X-Garmin-Push-Token`
 *     header against the RAW request bytes' headers BEFORE any JSON parse, via
 *     a constant-time compare inside the connector. Missing config FAILS
 *     CLOSED (the connector returns false → 401); a missing/mismatched token →
 *     401 and the body is never interpreted (#5/#36).
 *  3. Zod-validate the parsed envelope (`.strict()` on top-level keys —
 *     audit pattern #4). A verified-but-malformed body → 400.
 *  4. Per-RECORD idempotency / replay — each summary record's event id
 *     (`garmin:<kind>:<summaryId>`) is checked against
 *     {@link WearableProcessedEvent}; an already-processed record is skipped.
 *     The dedup row is committed AFTER its samples are ingested
 *     ("check → process → commit"), so a fetch/ingest failure leaves NO row
 *     and Garmin's redelivery reprocesses rather than silently dropping work
 *     (50-Failures #28/#29). The sample `dedup_key` UNIQUE constraint absorbs
 *     the small concurrent-redelivery race (createMany skipDuplicates).
 *  5. INLINE NORMALIZE+INGEST — Garmin pushes the FULL summary payload (not a
 *     lean reference like WHOOP), so there is no follow-up fetch; the records
 *     are normalized and batch-ingested via {@link IngestionService} (#21 no
 *     N+1). Ingest failure → connection status='error' + redacted log +
 *     rethrow (fail-explicit, #36/#50).
 *  6. DEREGISTRATION — a Garmin de-registration push flips matching
 *     connection(s) to `status='disconnected'` (soft-disconnect).
 *
 * NO PII IN LOGS (audit pattern #3): the raw Garmin `userId` is never logged —
 * only a salted sha256 `user_hash` plus non-PII counts / kinds / event ids.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class GarminWebhookController {
  private readonly logger = new Logger(GarminWebhookController.name);

  constructor(
    private readonly connector: GarminConnector,
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('garmin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Garmin Health API summary push' })
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ ok: true; processed: number; duplicate: number }> {
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Garmin webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/garmin in main.ts.',
      );
      // Cannot verify the partner token against headers/body — refuse.
      throw new UnauthorizedException('Garmin webhook raw body unavailable');
    }

    // (2) PUSH-TOKEN VERIFY FIRST — fail closed on missing config / token.
    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      throw new UnauthorizedException('Invalid Garmin push token');
    }

    // (3) Parse + Zod-validate (strict envelope). parseWebhook returns []
    // for malformed JSON / a schema-rejected envelope — a verified-but-
    // malformed body is a contract violation → 400 (Garmin does not retry 4xx)
    // rather than masking it as a 500.
    const events = this.connector.parseWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (events.length === 0) {
      this.logger.warn('Garmin webhook: rejected malformed/empty push payload');
      throw new BadRequestException('Malformed Garmin push payload');
    }

    let processed = 0;
    let duplicate = 0;

    for (const event of events) {
      const record = event.records[0];
      const payload = record?.payload as GarminRawPayload | undefined;
      const summary = payload?.data as GarminSummary | undefined;
      if (!payload || !summary) {
        continue;
      }

      // (4) Replay protection. A prior row for (GARMIN, providerEventId) means
      // this record was FULLY processed (normalized + ingested + committed) →
      // skip it. The row is written only AFTER ingest (below), so a present
      // row proves completion (no half-processed state).
      const existing = await this.prisma.wearableProcessedEvent.findUnique({
        where: {
          provider_provider_event_id: {
            provider: WearableProvider.GARMIN,
            provider_event_id: event.providerEventId,
          },
        },
      });
      if (existing) {
        duplicate += 1;
        continue;
      }

      // (5) Resolve the subject connection by Garmin user id, thread the
      // subject/connection ctx onto the payload, normalize, and batch-ingest —
      // BEFORE the dedup row is written.
      const connection = await this.prisma.wearableConnection.findFirst({
        where: {
          provider: WearableProvider.GARMIN,
          external_account_id: summary.userId,
          disconnected_at: null,
        },
      });
      if (!connection) {
        // No live connection for this Garmin user — record nothing, log a
        // redacted miss, and DO NOT write a dedup row (so a later connect +
        // redelivery can still ingest). user_hash only — never the raw id.
        this.logger.warn({
          msg: 'wearables.garmin.webhook.no_connection',
          provider: 'GARMIN',
          type: event.type,
          user_hash: hashGarminUserId(summary.userId),
        });
        continue;
      }

      payload.userId = connection.user_id;
      payload.connectionId = connection.id;

      try {
        const samples = this.connector.normalize([record]);
        if (samples.length > 0) {
          await this.ingestion.ingest(samples);
        }
      } catch (err) {
        // Fail-explicit: mark the connection in error, log redacted, rethrow
        // so Garmin's redelivery reprocesses (no dedup row was written, no
        // silent swallow — #36/#50).
        //
        // An upstream normalize/ingest/Prisma error can embed provider payload,
        // the raw Garmin userId, or token-like fragments in its message. We
        // NEVER persist or log that raw text: redactGarminError strips the
        // user id + token/secret fragments and yields a structured, length-
        // capped descriptor (Wave-2 audit pattern #3, PII/token redaction).
        const redacted = redactGarminError(err, summary.userId);
        // Mark the connection in error state — best effort, but NEVER silent.
        // If this secondary write fails we log a redacted, structured record
        // (no PII/token text) so the failed status write stays observable; the
        // original ingest error still rethrows below (#36 no silent failure).
        try {
          await this.prisma.wearableConnection.update({
            where: { id: connection.id },
            data: {
              status: 'error',
              last_error: redacted.redacted_message,
            },
          });
        } catch (markErr) {
          const markRedacted = redactGarminError(
            markErr,
            summary.userId,
            'GARMIN_ERROR_MARKING_FAILED',
          );
          this.logger.error({
            msg: 'wearables.garmin.webhook.error_marking_failed',
            provider: 'GARMIN',
            type: event.type,
            conn_id: connection.id,
            user_hash: hashGarminUserId(summary.userId),
            error_code: markRedacted.error_code,
            error_class: markRedacted.error_class,
            error_message: markRedacted.redacted_message,
          });
        }
        this.logger.error({
          msg: 'wearables.garmin.webhook.ingest_failure',
          provider: 'GARMIN',
          type: event.type,
          user_hash: hashGarminUserId(summary.userId),
          error_code: redacted.error_code,
          error_class: redacted.error_class,
          error_message: redacted.redacted_message,
        });
        throw err;
      }

      // (6) COMMIT the dedup row only after ingest succeeded.
      // `handler_completed_at` is set in the same write so the row is never
      // observed half-done. A concurrent delivery that already wrote it
      // produces a benign P2002 we absorb (createMany skipDuplicates).
      const { count } = await this.prisma.wearableProcessedEvent.createMany({
        data: [
          {
            provider: WearableProvider.GARMIN,
            provider_event_id: event.providerEventId,
            type: event.type,
            handler_completed_at: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        // Lost the race — another worker committed first; treat as duplicate.
        duplicate += 1;
        continue;
      }
      processed += 1;
    }

    this.logger.log({
      msg: 'wearables.garmin.webhook.handled',
      provider: 'GARMIN',
      processed,
      duplicate,
    });
    return { ok: true, processed, duplicate };
  }

  /**
   * Garmin de-registration push. Garmin delivers
   * `{ "deregistrations": [ { userId, userAccessToken } ] }` to a separate
   * callback when a user revokes access. We token-verify FIRST, Zod-validate
   * (`.strict()`), then flip matching live connection(s) to
   * `status='disconnected'` (soft-disconnect; audit survives a re-link).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 200 } })
  @Post('garmin/deregistration')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Garmin user de-registration push' })
  async deregister(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ ok: true; disconnected: number }> {
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new UnauthorizedException('Garmin webhook raw body unavailable');
    }
    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      throw new UnauthorizedException('Invalid Garmin push token');
    }

    let body: GarminDeregistration;
    try {
      const json: unknown = JSON.parse(rawBody.toString('utf8'));
      body = GarminDeregistrationSchema.parse(json);
    } catch {
      this.logger.warn('Garmin deregistration: rejected malformed payload');
      throw new BadRequestException('Malformed Garmin deregistration payload');
    }

    let disconnected = 0;
    for (const dereg of body.deregistrations) {
      const { count } = await this.prisma.wearableConnection.updateMany({
        where: {
          provider: WearableProvider.GARMIN,
          external_account_id: dereg.userId,
          status: { not: 'disconnected' },
        },
        data: {
          status: 'disconnected',
          disconnected_at: new Date(),
          last_error: 'Garmin authorization revoked by user',
        },
      });
      disconnected += count;
      this.logger.log({
        msg: 'wearables.garmin.webhook.deregistered',
        provider: 'GARMIN',
        user_hash: hashGarminUserId(dereg.userId),
        connections_disconnected: count,
      });
    }
    return { ok: true, disconnected };
  }

  /**
   * Fail-closed guard surfaced as a method so misconfiguration is observable.
   * The push token is required; if it is unset the data handler's
   * {@link GarminConnector.verifyWebhook} already returns false (→ 401), but
   * this helper lets the (future) subscription-management lane assert the
   * receiver is wired before registering a Garmin push URL — returning 503 if
   * not (never a silent success, #36).
   */
  assertPushConfigured(): void {
    if (!this.connector.pushToken) {
      throw new ServiceUnavailableException(
        'Garmin push receiver not configured (GARMIN_PUSH_TOKEN unset)',
      );
    }
  }
}
