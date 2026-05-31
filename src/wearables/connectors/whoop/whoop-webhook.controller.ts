import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ZodError } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../prisma.service';
import { WhoopConnector } from './whoop.connector';
import {
  WHOOP_SIGNATURE_HEADER,
  WHOOP_SIGNATURE_TIMESTAMP_HEADER,
  WhoopWebhookEvent,
  WhoopWebhookEventSchema,
} from './whoop.types';

/**
 * PR-HK-2.l — WHOOP v2 webhook receiver.
 *
 * `POST /v1/wearables/webhooks/whoop`
 *
 * Security & correctness posture (mirrors the Stripe webhook + Oura
 * connector pattern):
 *  1. `@Public()` — WHOOP is not a Supabase user; trust comes from the HMAC
 *     signature, NOT a JWT.
 *  2. HMAC VERIFY FIRST — the controller verifies `X-WHOOP-Signature`
 *     against the RAW request bytes BEFORE any JSON parse. A missing /
 *     malformed / mismatched / stale signature → 401 and the body is never
 *     interpreted (constant-time compare inside the connector).
 *  3. Dedup / replay protection — each WHOOP event UUID is recorded in
 *     {@link WearableProcessedEvent} (provider='WHOOP', provider_event_id =
 *     event UUID). A redelivery of an already-processed event is a no-op
 *     (200, `duplicate:true`) — 50-Failures #28/#29.
 *  4. Revocation — a `user.deauthorized` event flips the matching
 *     connection to `status='disconnected'` (soft-disconnect; WHOOP stops
 *     delivering once revoked).
 *  5. Throttled — a per-route throttle caps inbound volume so a misbehaving
 *     or hostile sender cannot exhaust the worker.
 *
 * The raw body is required (`req.rawBody`, wired globally via `rawBody:true`
 * in main.ts). If it is absent the route is misconfigured and we reject 401
 * rather than reconstruct signed bytes from parsed JSON.
 */
@ApiTags('wearables-webhooks')
@Controller('v1/wearables/webhooks')
export class WhoopWebhookController {
  private readonly logger = new Logger(WhoopWebhookController.name);

  constructor(
    private readonly connector: WhoopConnector,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('whoop')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: Request,
    @Headers(WHOOP_SIGNATURE_HEADER) _signature: string,
    @Headers(WHOOP_SIGNATURE_TIMESTAMP_HEADER) _timestamp: string,
  ): Promise<{ ok: true; duplicate: boolean; revoked?: boolean }> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'WHOOP webhook received without rawBody. Verify rawBody:true is set in main.ts.',
      );
      // Missing raw body means we cannot verify — refuse rather than trust.
      throw new UnauthorizedException('WHOOP webhook raw body unavailable');
    }

    // (2) HMAC VERIFY FIRST — before any parse.
    const verified = this.connector.verifyWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!verified) {
      // Do not leak which check failed (signature vs timestamp vs staleness).
      throw new UnauthorizedException('Invalid WHOOP webhook signature');
    }

    // Parse + RUNTIME-VALIDATE only AFTER verification. A correctly-signed but
    // MALFORMED body (bad JSON, non-UUID id, unknown type, non-positive
    // user_id, or extra fields) is a contract violation — reject it with a
    // 400 so it never reaches dedup / revocation / logging (R1 Finding 2).
    // 400 (not 500) signals a client/contract error without masking it as a
    // server fault; WHOOP does not retry a 4xx.
    let payload: WhoopWebhookEvent;
    try {
      const json: unknown = JSON.parse(rawBody.toString('utf8'));
      payload = WhoopWebhookEventSchema.parse(json);
    } catch (err) {
      // Do not echo the (verified) body or per-field user data back; log only
      // the structural reason for observability.
      const reason =
        err instanceof ZodError
          ? 'schema validation failed'
          : 'body was not valid JSON';
      this.logger.warn(`WHOOP webhook: rejected malformed payload — ${reason}`);
      throw new BadRequestException('Malformed WHOOP webhook payload');
    }

    // (3) Dedup / replay protection on the event UUID. createMany with the
    // composite PK (provider, provider_event_id) is the idempotency point: a
    // redelivery throws/zero-counts and we short-circuit as a no-op.
    const { count } = await this.prisma.wearableProcessedEvent.createMany({
      data: [
        {
          provider: WearableProvider.WHOOP,
          provider_event_id: payload.id,
          type: payload.type,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      // Already processed — replay no-op.
      this.logger.log({
        msg: 'wearables.whoop.webhook.duplicate',
        provider_event_id: payload.id,
        type: payload.type,
      });
      return { ok: true, duplicate: true };
    }

    // (4) Revocation handling.
    if (this.connector.isRevocationEvent(payload.type)) {
      const revoked = await this.handleRevocation(payload);
      await this.markHandled(payload.id);
      return { ok: true, duplicate: false, revoked };
    }

    // Data events: record acceptance. The full record fetch + normalize +
    // ingest is performed by the async sync worker keyed off this event
    // (kept out of the request path so WHOOP gets a fast 200 — #21/#35).
    //
    // NO PII IN LOGS (R1 Finding 3): the raw WHOOP `user_id` is a
    // user-identifying external account id and is NEVER logged. Ops
    // correlation uses a one-way salted hash (`user_hash`) plus the
    // non-PII event id / type / trace id.
    this.logger.log({
      msg: 'wearables.whoop.webhook.accepted',
      provider_event_id: payload.id,
      type: payload.type,
      trace_id: payload.trace_id,
      user_hash: hashWhoopUserId(payload.user_id),
    });
    await this.markHandled(payload.id);
    return { ok: true, duplicate: false };
  }

  /**
   * Flip the WHOOP connection(s) for the de-authorizing user to
   * `status='disconnected'`. WHOOP stops delivering once revoked; we mirror
   * that as a soft-disconnect (audit survives a future re-link). Matches on
   * the WHOOP external_account_id (the WHOOP user id as text).
   */
  private async handleRevocation(
    payload: WhoopWebhookEvent,
  ): Promise<boolean> {
    const externalId = String(payload.user_id);
    const { count } = await this.prisma.wearableConnection.updateMany({
      where: {
        provider: WearableProvider.WHOOP,
        external_account_id: externalId,
        status: { not: 'disconnected' },
      },
      data: {
        status: 'disconnected',
        disconnected_at: new Date(),
        last_error: 'WHOOP authorization revoked by user',
      },
    });
    // No raw WHOOP user_id in logs (R1 Finding 3) — salted-hash correlation
    // only, alongside the (non-PII) disconnect count + event id / type.
    this.logger.log({
      msg: 'wearables.whoop.webhook.revoked',
      provider_event_id: payload.id,
      type: payload.type,
      trace_id: payload.trace_id,
      user_hash: hashWhoopUserId(payload.user_id),
      connections_disconnected: count,
    });
    return count > 0;
  }

  /** Stamp `handler_completed_at` so the event is observably fully handled. */
  private async markHandled(providerEventId: string): Promise<void> {
    await this.prisma.wearableProcessedEvent.updateMany({
      where: {
        provider: WearableProvider.WHOOP,
        provider_event_id: providerEventId,
      },
      data: { handler_completed_at: new Date() },
    });
  }
}

/**
 * Derive a NON-reversible, event-scoped correlation id from a WHOOP user id
 * for logs (R1 Finding 3 — no PII in logs). We SHA-256 a salted
 * `whoop:<user_id>:<salt>` and keep the first 16 hex chars: enough to group
 * an operator's log lines for a single account without storing the
 * reversible provider-native id. The salt comes from `WHOOP_WEBHOOK_SALT`
 * (falls back to the webhook/client secret) so the hash is not trivially
 * rainbow-tableable across a small integer id space.
 */
function hashWhoopUserId(userId: number): string {
  const salt =
    process.env.WHOOP_WEBHOOK_SALT ??
    process.env.WHOOP_WEBHOOK_SECRET ??
    process.env.WHOOP_CLIENT_SECRET ??
    '';
  return createHash('sha256')
    .update(`whoop:${userId}:${salt}`)
    .digest('hex')
    .slice(0, 16);
}
