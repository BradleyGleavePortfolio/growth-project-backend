import { createHash } from 'crypto';
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WearableProvider } from '@prisma/client';
import { z } from 'zod';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { FitbitConnector, redactErrorMessage } from './fitbit.connector';
import {
  FITBIT_NOTIFICATION_COLLECTION_TYPES,
  FITBIT_NOTIFICATION_OWNER_TYPE,
  FitbitNotification,
} from './fitbit.types';

/**
 * PR-HK-2.e — Fitbit subscription webhook receiver.
 *
 * `POST /v1/wearables/webhooks/fitbit` — Fitbit pushes a JSON ARRAY of
 * notifications (one per changed collection/day) to the configured subscriber
 * endpoint. Each notification carries NO data, only a reference to fetch.
 * Security model (mirrors OuraWebhookController / StripeWebhookController):
 *  1. `@Public` — Fitbit is not a Supabase user; auth is the HMAC, not a JWT.
 *  2. Raw-body HMAC verify FIRST (constant-time, base64(HMAC-SHA1(rawBody,
 *     `<client_secret>&`)) vs `X-Fitbit-Signature`). Invalid → 401, no handling.
 *  3. Zod-validate the parsed array (#8). Malformed → 400. The envelope is
 *     `.strict()` and array-only: unknown fields, a singleton object, an
 *     unknown `collectionType`, or a non-`user` `ownerType` are all rejected
 *     with a redacted 400 (field paths only) before any fetch/dedup/ingest.
 *  4. Per notification: replay/idempotency via `WearableProcessedEvent`
 *     (provider='FITBIT', provider_event_id) — a duplicate is a no-op (#28/#29).
 *  5. Resolve the connection (by Fitbit ownerId → external_account_id), fetch
 *     ONLY the just-changed day's records, normalize, and batch-ingest via
 *     IngestionService (#21 no N+1).
 *  6. ONLY AFTER a successful fetch+ingest, persist the
 *     {@link WearableProcessedEvent} dedup row ("check → process → commit").
 * Throttled (#6). Never logs raw payloads — only redacted metadata (#12/#36).
 *
 * Idempotency ordering (R2 invariant): the dedup row is written AFTER
 * fetch+normalize+ingest succeed, not before. If fetch/ingest throws, NO
 * processed-event row exists, so Fitbit's redelivery is reprocessed (not
 * silently no-op'd) and no data is permanently lost. The PR-HK-0 sample
 * `dedup_key` UNIQUE constraint (IngestionService `createMany({
 * skipDuplicates: true })`) absorbs the small concurrent race window. The
 * processed-event `create` treats a concurrent P2002 unique violation on the
 * composite PK as a benign no-op rather than a 500.
 *
 * Subscription verification: when a subscriber endpoint is configured, Fitbit
 * issues a one-time GET `?verify=<code>`. We echo nothing — Fitbit expects a
 * `204 No Content` when the `verify` value matches the configured
 * `FITBIT_VERIFICATION_CODE`, and `404 Not Found` otherwise. Fails CLOSED
 * (404) when the code is unconfigured.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class FitbitWebhookController {
  private readonly logger = new Logger(FitbitWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly connector: FitbitConnector,
  ) {}

  /**
   * Fitbit subscriber verification handshake. Fitbit sends a GET with a
   * `verify` query param when the endpoint is registered. Respond `204` when
   * it matches `FITBIT_VERIFICATION_CODE`, else `404`. Fails closed (404) when
   * the code is unconfigured — a spoofed probe must never elicit a 204.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('fitbit')
  @ApiOperation({ summary: 'Fitbit webhook subscriber verification handshake' })
  verify(@Query('verify') verify: string, @Res() res: Response): void {
    const expected = process.env.FITBIT_VERIFICATION_CODE;
    // Constant-time-ish equality on equal-length codes; a mismatch or unset
    // code yields 404 (fail-closed). We never reveal which condition failed.
    if (expected && verify && this.safeEquals(verify, expected)) {
      res.status(HttpStatus.NO_CONTENT).send();
      return;
    }
    res.status(HttpStatus.NOT_FOUND).send();
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('fitbit')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Receive a Fitbit subscription notification batch' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<void> {
    // (2) Raw body is the only signature source we trust.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Fitbit webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/fitbit in main.ts.',
      );
      throw new BadRequestException('Fitbit webhook raw body unavailable');
    }

    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      // Do NOT reveal which check failed. One 401 for all signature failures.
      throw new UnauthorizedException('Invalid Fitbit webhook signature');
    }

    // (3) STRICT Zod-validate the parsed array. A non-Fitbit envelope (unknown
    // fields, singleton object, unknown collectionType, non-`user` ownerType)
    // is rejected with 400 before any fetch/dedup/ingest — fail closed.
    const notifications = this.parseAndValidate(rawBody);

    // (4–6) Process each notification independently. Fitbit batches multiple
    // changes per delivery; each gets its own dedup key + connection resolution
    // so a partial failure reprocesses only the unfinished notifications.
    for (const notification of notifications) {
      await this.handleNotification(notification);
    }
  }

  /**
   * Process one subscription notification end-to-end: replay-check, fetch the
   * referenced day's records, normalize, ingest, then commit the dedup row.
   */
  private async handleNotification(
    notification: FitbitNotification,
  ): Promise<void> {
    const providerEventId = this.connector.eventId(notification);
    const userHash = this.userHash(notification.ownerId);

    // (4) Replay protection. A prior row for (FITBIT, providerEventId) proves
    // we already FULLY processed (fetched + ingested + committed) this
    // notification (the row is written only AFTER ingest, step 6) → no-op.
    const existing = await this.prisma.wearableProcessedEvent.findUnique({
      where: {
        provider_provider_event_id: {
          provider: WearableProvider.FITBIT,
          provider_event_id: providerEventId,
        },
      },
    });
    if (existing) {
      this.logger.log({
        msg: 'wearables.fitbit.webhook.replay_noop',
        provider: 'FITBIT',
        collection_type: notification.collectionType,
        user_hash: userHash,
      });
      return;
    }

    // userRevokedAccess carries no data to fetch; it is handled by the token
    // lane (PR-HK-1). We still record it so redeliveries are no-ops.
    if (notification.collectionType !== 'userRevokedAccess') {
      // (5) Resolve the connection by Fitbit owner id, fetch the just-changed
      // day's records, normalize, and batch-ingest — BEFORE any dedup row is
      // written. If fetch/ingest throws here, we never reach step 6, so
      // Fitbit's retry reprocesses the notification (R2 invariant).
      const connection = await this.prisma.wearableConnection.findFirst({
        where: {
          provider: WearableProvider.FITBIT,
          external_account_id: notification.ownerId,
          disconnected_at: null,
        },
      });

      if (connection) {
        try {
          const raw = await this.connector.fetchNotificationRecords(
            connection,
            notification,
          );
          const samples = this.connector.normalize(raw);
          if (samples.length > 0) {
            await this.ingestion.ingest(samples);
          }
        } catch (err) {
          // Fail-explicit: mark the connection in error, log redacted, and
          // rethrow so the delivery is retried (no silent swallow, #36/#50).
          // No processed-event row was written, so the retry reprocesses.
          // Redact token-like secrets (Bearer/Basic/access_token/refresh_token/
          // client_secret/code/…) from the upstream error BEFORE it is
          // persisted to `last_error` or logged. Same helper the connector's
          // backfill/refresh paths use, so the webhook edge path can't leak a
          // credential that an HTTP/provider error string happened to carry.
          const safeMessage = redactErrorMessage(err);
          await this.prisma.wearableConnection
            .update({
              where: { id: connection.id },
              data: {
                status: 'error',
                last_error: safeMessage,
              },
            })
            .catch(() => undefined);
          this.logger.error({
            msg: 'wearables.fitbit.webhook.ingest_failure',
            provider: 'FITBIT',
            collection_type: notification.collectionType,
            user_hash: userHash,
            error_message: safeMessage,
          });
          throw err;
        }
      } else {
        this.logger.warn({
          msg: 'wearables.fitbit.webhook.no_connection',
          provider: 'FITBIT',
          collection_type: notification.collectionType,
          user_hash: userHash,
        });
      }
    }

    // (6) COMMIT: only now that fetch+ingest have succeeded do we persist the
    // dedup row, with `handler_completed_at` set in the same write so the row
    // is never observed half-done. A concurrent delivery that already wrote
    // the row produces a P2002 on the composite PK — absorbed as a benign
    // no-op (the sample dedup_key UNIQUE constraint already prevented any
    // double-counted samples).
    try {
      await this.prisma.wearableProcessedEvent.create({
        data: {
          provider: WearableProvider.FITBIT,
          provider_event_id: providerEventId,
          type: `${notification.collectionType}.updated`,
          handler_completed_at: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log({
          msg: 'wearables.fitbit.webhook.concurrent_commit_noop',
          provider: 'FITBIT',
          collection_type: notification.collectionType,
          user_hash: userHash,
        });
        return;
      }
      throw err;
    }

    this.logger.log({
      msg: 'wearables.fitbit.webhook.handled',
      provider: 'FITBIT',
      collection_type: notification.collectionType,
      user_hash: userHash,
    });
  }

  /**
   * STRICT Zod schema for the Fitbit subscription notification batch. Fitbit
   * POSTs a JSON ARRAY of notifications whose envelope is documented exactly as
   * `{ collectionType, date, ownerId, ownerType, subscriptionId }`. This
   * validation is fail-closed (Wave-2 webhook doctrine):
   *  - `.strict()` — ANY unknown/extra field rejects the whole payload (no
   *    `.passthrough()`), so a non-Fitbit envelope cannot be acknowledged.
   *  - array-only — a bare singleton object is rejected (Fitbit always sends an
   *    array; a non-array shape is not a Fitbit notification).
   *  - `collectionType` is constrained to the documented Fitbit enum, and
   *    `ownerType` to the literal `user`; unknown/misspelled values reject.
   * On failure we return 400 with field PATHS only — never the raw payload
   * values — and no dedup/fetch/ingest is performed.
   */
  private parseAndValidate(rawBody: Buffer): FitbitNotification[] {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Fitbit webhook payload is not valid JSON');
    }

    const notification = z
      .object({
        collectionType: z.enum(FITBIT_NOTIFICATION_COLLECTION_TYPES),
        // Fitbit omits `date` only for the synthetic userRevokedAccess event.
        date: z.string().min(1).optional(),
        ownerId: z.string().min(1),
        ownerType: z.literal(FITBIT_NOTIFICATION_OWNER_TYPE),
        subscriptionId: z.string().min(1),
      })
      .strict();

    // Fitbit ALWAYS sends a JSON array. A singleton object or any other shape
    // is not a Fitbit subscription notification and is rejected.
    const schema = z.array(notification);

    const result = schema.safeParse(json);
    if (!result.success) {
      // Field PATHS only — never the raw payload values (no PII / secret echo).
      const fieldPaths = result.error.issues
        .map((i) => i.path.join('.') || '(root)')
        .join(', ');
      // Audit a rejected (but HMAC-valid) delivery so a misconfigured or
      // spoofing subscriber is visible in logs, without echoing the body.
      this.logger.warn({
        msg: 'wearables.fitbit.webhook.invalid_payload',
        provider: 'FITBIT',
        invalid_fields: fieldPaths,
        issue_count: result.error.issues.length,
      });
      throw new BadRequestException(
        `Fitbit webhook payload failed validation: ${fieldPaths}`,
      );
    }
    return result.data as FitbitNotification[];
  }

  /**
   * Stable, non-reversible user identifier for logs. We NEVER log the raw
   * Fitbit ownerId (PII per #12/#36); a sha256 hash is sufficient to correlate
   * a single user's deliveries without storing the identity in log sinks.
   */
  private userHash(ownerId: string): string {
    return createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
  }

  /** Length-safe constant-time string comparison for the verify code. */
  private safeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
