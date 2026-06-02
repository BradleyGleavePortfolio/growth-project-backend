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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { WithingsConnector, redactErrorMessage } from './withings.connector';
import {
  WithingsNotifyEvent,
  WithingsNotifySchema,
} from './withings.types';

/**
 * PR-HK-2.i — Withings notify (webhook) receiver.
 *
 * `POST /v1/wearables/webhooks/withings` — Withings pushes one form-encoded
 * notification per changed window/category (`userid`, `startdate`, `enddate`,
 * `appli`). Security model (mirrors the Oura/Strava receivers, adapted to
 * Withings' form-encoded + secret-callback posture):
 *
 *  1. `@Public` — Withings is not a Supabase user; auth is the callback secret,
 *     not a JWT.
 *  2. FAIL CLOSED on missing webhook secret (audit pattern #5): if
 *     `WITHINGS_WEBHOOK_SECRET` is unset the POST returns 503 and never
 *     processes — an unconfigured callback secret is a misconfiguration we must
 *     not silently accept.
 *  3. Callback-secret verify. Withings Health Data notify callbacks carry no
 *     provider HMAC; authenticity comes from the unguessable secret URL we
 *     registered with `notify subscribe`. We extract the callback secret from
 *     the request (`?secret=` query param of our registered callback URL, or
 *     an `X-Webhook-Secret` header behind a proxy) and the connector compares
 *     it constant-time against `WITHINGS_WEBHOOK_SECRET`. Mismatch/absent → 401.
 *  4. Zod-validate the parsed form payload (audit pattern #4). Malformed → 400
 *     (no payload echo).
 *  5. Replay/idempotency via `WearableProcessedEvent` (provider='WITHINGS',
 *     provider_event_id) — a duplicate is a 200 no-op (#28/#29).
 *  6. Resolve the connection (by Withings userid), fetch ONLY the just-changed
 *     window, normalize, and batch-ingest via IngestionService (#21 no N+1).
 *  7. ONLY AFTER a successful fetch+ingest, persist the
 *     {@link WearableProcessedEvent} dedup row ("check → process → commit").
 * Throttled (#6). Never logs raw payloads / userid / tokens — only redacted
 * metadata (#12/#36).
 *
 * Idempotency ordering: the dedup row is written AFTER fetch+normalize+ingest
 * succeed, not before. If fetch/ingest throws, NO processed-event row exists, so
 * Withings' redelivery is reprocessed (not silently no-op'd) and no data is
 * permanently lost. A small race window exists — two concurrent deliveries of
 * the SAME event may both fetch and ingest — but the PR-HK-0 sample `dedup_key`
 * UNIQUE constraint absorbs it (`createMany({ skipDuplicates: true })`), and the
 * processed-event `create` treats a concurrent P2002 on the composite PK as a
 * benign 200 no-op rather than a 500.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class WithingsWebhookController {
  private readonly logger = new Logger(WithingsWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly connector: WithingsConnector,
  ) {}

  /**
   * Withings subscription verification handshake. When a notify subscription is
   * created, Withings can issue a GET to the callback to confirm reachability.
   * We echo `{ challenge }` iff the `verification_token` matches the configured
   * `WITHINGS_VERIFICATION_TOKEN`, rejecting spoofed verification probes.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('withings')
  @ApiOperation({ summary: 'Withings notify subscription verification handshake' })
  verify(
    @Query('verification_token') token: string,
    @Query('challenge') challenge: string,
  ): { challenge: string } {
    const expected = process.env.WITHINGS_VERIFICATION_TOKEN;
    if (!expected || token !== expected || !challenge) {
      throw new UnauthorizedException('Invalid Withings verification handshake');
    }
    return { challenge };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('withings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a Withings notify callback' })
  async handle(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    // (1) Raw body is the only signature source we trust.
    const rawBody = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Withings webhook received without rawBody. Verify rawBody middleware is wired for /v1/wearables/webhooks/withings in main.ts.',
      );
      throw new BadRequestException('Withings webhook raw body unavailable');
    }

    // (2) Fail closed on missing webhook secret (audit pattern #5). An
    // unconfigured callback secret is a misconfiguration — return 503 and never
    // process, rather than silently accepting unauthenticated callbacks.
    if (!process.env.WITHINGS_WEBHOOK_SECRET) {
      this.logger.error(
        JSON.stringify({
          msg: 'wearables.withings.webhook_misconfigured',
          reason: 'WITHINGS_WEBHOOK_SECRET unset',
        }),
      );
      throw new ServiceUnavailableException('withings_webhook_not_configured');
    }

    // (3) Callback-secret verify. Withings notify callbacks have no provider
    // HMAC, so authenticity rests on the unguessable secret URL we registered:
    // a genuine callback is delivered to that exact URL and therefore presents
    // the matching secret. The secret arrives as the `secret` query param of
    // our registered callback URL (default) or an `X-Webhook-Secret` header
    // (proxy setups that strip the token from the URL). We normalize both into
    // the headers map under `x-webhook-secret` so the connector verifier reads
    // a single source, then compare constant-time inside the connector.
    const headers = {
      ...(req.headers as Record<string, string | string[] | undefined>),
    };
    const querySecret = this.callbackSecretFromQuery(req);
    if (querySecret && headers['x-webhook-secret'] === undefined) {
      headers['x-webhook-secret'] = querySecret;
    }
    const verified = this.connector.verifyWebhook({ rawBody, headers });
    if (!verified) {
      // Do NOT reveal which check failed. One 401 for all auth failures.
      throw new UnauthorizedException('Invalid Withings webhook authentication');
    }

    // (4) Zod-validate the parsed form payload. Strict on the four fields we
    // consume; a malformed-but-truthy body is rejected with a 400.
    const event = this.parseAndValidate(rawBody);

    const providerEventId = this.connector.eventId(event);

    // (5) Replay protection. A prior row for (WITHINGS, providerEventId) means
    // we already FULLY processed this delivery → 200 no-op. Because the row is
    // written only AFTER successful ingest (step 7), a present row proves
    // completion — there is no half-processed state to re-drive.
    const existing = await this.prisma.wearableProcessedEvent.findUnique({
      where: {
        provider_provider_event_id: {
          provider: WearableProvider.WITHINGS,
          provider_event_id: providerEventId,
        },
      },
    });
    if (existing) {
      this.logger.log({
        msg: 'wearables.withings.webhook.replay_noop',
        provider: 'WITHINGS',
        appli: event.appli,
      });
      return { ok: true };
    }

    // (6) Resolve the connection by Withings userid, fetch the just-changed
    // window, normalize, and batch-ingest — BEFORE any dedup row is written. If
    // fetch/ingest throws here, we never reach the dedup-row write (step 7), so
    // Withings' retry reprocesses the event instead of being silently dropped.
    const connection = await this.prisma.wearableConnection.findFirst({
      where: {
        provider: WearableProvider.WITHINGS,
        external_account_id: event.userid,
        disconnected_at: null,
      },
    });

    if (connection) {
      try {
        const raw = await this.connector.fetchChangedRecord(connection, event);
        const samples = this.connector.normalize(raw);
        if (samples.length > 0) {
          await this.ingestion.ingest(samples);
        }
      } catch (err) {
        // Fail-explicit: mark the connection in error, log redacted, and
        // rethrow so the delivery is retried (no silent swallow, #36/#50). No
        // processed-event row was written, so the retry reprocesses.
        //
        // A lower-level fetch/normalize/ingest error may embed an access token,
        // Authorization header, request URL, or client secret in its message,
        // so it is run through the connector's `redactErrorMessage` redactor
        // BEFORE it is persisted to `last_error` or logged (audit pattern
        // #7 / #1 / #12) — never the raw exception string.
        const safeError = redactErrorMessage(err);
        // Best-effort: mark the connection in error state. This is secondary to
        // the primary fetch/ingest failure, but the inner failure is NEVER
        // swallowed silently (#36) — if the status write itself fails we log a
        // structured, redacted warning before the original error rethrows.
        try {
          await this.prisma.wearableConnection.update({
            where: { id: connection.id },
            data: {
              status: 'error',
              last_error: safeError,
            },
          });
        } catch (markErr) {
          this.logger.error({
            msg: 'wearables.withings.webhook.error_marking_failed',
            provider: 'WITHINGS',
            conn_id: connection.id,
            appli: event.appli,
            error_class: (markErr as Error)?.name ?? typeof markErr,
            // Redact before emit — a DB error may echo column/connection data.
            error_message: redactErrorMessage(markErr),
          });
        }
        this.logger.error({
          msg: 'wearables.withings.webhook.ingest_failure',
          provider: 'WITHINGS',
          appli: event.appli,
          error_class: (err as Error)?.name ?? typeof err,
          // Already redacted — safe to emit.
          error_message: safeError,
        });
        throw err;
      }
    } else {
      this.logger.warn({
        msg: 'wearables.withings.webhook.no_connection',
        provider: 'WITHINGS',
        appli: event.appli,
      });
    }

    // (7) COMMIT: only now that fetch+ingest have succeeded do we persist the
    // dedup row. `handler_completed_at` is set in the same write so the row is
    // never observed half-done. A concurrent delivery that already wrote the
    // row produces a P2002 on the composite PK — absorbed as a benign no-op
    // (ON CONFLICT DO NOTHING semantics); the sample dedup_key UNIQUE
    // constraint already prevented any double-counted samples.
    try {
      await this.prisma.wearableProcessedEvent.create({
        data: {
          provider: WearableProvider.WITHINGS,
          provider_event_id: providerEventId,
          type: `withings.appli.${event.appli}`,
          handler_completed_at: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log({
          msg: 'wearables.withings.webhook.concurrent_commit_noop',
          provider: 'WITHINGS',
          appli: event.appli,
        });
        return { ok: true };
      }
      throw err;
    }

    this.logger.log({
      msg: 'wearables.withings.webhook.handled',
      provider: 'WITHINGS',
      appli: event.appli,
    });
    return { ok: true };
  }

  /**
   * Resolve the callback secret token Withings presents on a genuine notify
   * callback. Withings delivers to the exact `callbackurl` we registered via
   * `notify subscribe`, so the unguessable secret we embedded in that URL
   * (`?secret=<token>`) rides along on every authentic callback. We read it
   * from the parsed Express query (`req.query.secret`); a single multi-value
   * occurrence collapses to its first entry. Returns null when absent so the
   * verifier fails closed.
   */
  private callbackSecretFromQuery(
    req: RawBodyRequest<Request>,
  ): string | null {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const raw = q['secret'];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].length > 0) {
      return raw[0];
    }
    return null;
  }

  /**
   * Parse + Zod-validate the Withings notify form body (audit pattern #4).
   * Returns the typed event on success; throws `BadRequestException` (400) on
   * any schema violation — NEVER a 500, and NEVER echoing payload values (only
   * field paths). Withings delivers form-encoded data, so we parse the raw body
   * with `URLSearchParams` before validating.
   */
  private parseAndValidate(rawBody: Buffer): WithingsNotifyEvent {
    const params = new URLSearchParams(rawBody.toString('utf8'));
    // Build the candidate from ALL submitted keys. The Withings notify
    // callback body is purely the four event fields (`userid`, `startdate`,
    // `enddate`, `appli`) — authenticity is carried by the secret callback URL,
    // NOT by any body signature — so the `.strict()` schema rejects ANY extra
    // key (including a smuggled `signature`) as a malformed-but-truthy body
    // (audit #4).
    const candidate: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      candidate[k] = v;
    }

    const result = WithingsNotifySchema.safeParse(candidate);
    if (!result.success) {
      // Redacted: report field paths, never the raw payload values.
      throw new BadRequestException(
        `Withings webhook payload failed validation: ${result.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
      );
    }
    return result.data;
  }
}
