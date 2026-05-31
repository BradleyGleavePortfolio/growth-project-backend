import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
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
  WhoopWebhookPayload,
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

    // Parse only AFTER verification. Bad JSON on a verified body is a WHOOP
    // contract change — log and 200 (do not make WHOOP retry a poison body).
    let payload: WhoopWebhookPayload | null = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WhoopWebhookPayload;
    } catch {
      this.logger.warn('WHOOP webhook: verified body was not valid JSON');
      return { ok: true, duplicate: false };
    }
    if (!payload || !payload.id || !payload.type) {
      this.logger.warn('WHOOP webhook: verified body missing id/type');
      return { ok: true, duplicate: false };
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
    this.logger.log({
      msg: 'wearables.whoop.webhook.accepted',
      provider_event_id: payload.id,
      type: payload.type,
      whoop_user_id: payload.user_id,
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
    payload: WhoopWebhookPayload,
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
    this.logger.log({
      msg: 'wearables.whoop.webhook.revoked',
      whoop_user_id: payload.user_id,
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
