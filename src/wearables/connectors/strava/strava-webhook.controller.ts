import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { WearableProvider } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { Public } from '../../../common/decorators/public.decorator';
import {
  StravaWebhookEventSchema,
  type StravaWebhookEventParsed,
} from './strava.types';

/**
 * PR-HK-2.f — Strava push-subscription webhook.
 *
 * Strava webhooks are unusual and the security model differs from every other
 * connector (Oura/Whoop/Fitbit), so the divergences are documented inline:
 *
 *  1. SUBSCRIPTION VERIFICATION (GET). When the push subscription is created
 *     (out-of-band, via the push_subscriptions API), Strava issues a GET to
 *     this callback with `hub.mode=subscribe`, `hub.challenge=<nonce>`,
 *     `hub.verify_token=<token>`. We echo `{ "hub.challenge": <nonce> }` ONLY
 *     if `hub.verify_token` equals the server-configured
 *     STRAVA_WEBHOOK_VERIFY_TOKEN; otherwise 403. (PubSubHubbub handshake.)
 *
 *  2. NO HMAC ON EVENTS. Unlike Stripe/Oura, Strava does NOT sign event POSTs
 *     — there is no shared-secret signature header to verify (per Strava
 *     webhook docs). We therefore defend the POST with THREE independent
 *     controls instead:
 *       (a) subscription_id must match our configured subscription id
 *           (STRAVA_WEBHOOK_SUBSCRIPTION_ID) — rejects events meant for a
 *           different app/subscription. This FAILS CLOSED: if the env var is
 *           unset the POST handler returns 503 (never processes events under
 *           misconfiguration) and a startup warning is logged; a configured
 *           mismatch returns 403;
 *       (b) a source-IP allow-list — Strava delivers from a small set of AWS
 *           us-east-1 egress IPs (observed e.g. 54.173.232.159). Strava does
 *           NOT publish a stable CIDR list, so the allow-list is configurable
 *           via STRAVA_WEBHOOK_ALLOWED_IPS (comma-separated) and defaults to
 *           the documented/observed addresses below. When the env var is unset
 *           we fall back to the defaults; setting it to "*" disables the check
 *           for environments behind a trusted proxy that already filters;
 *       (c) idempotency via WearableProcessedEvent (provider='STRAVA',
 *           provider_event_id = `${object_type}:${object_id}:${event_time}`) —
 *           Strava retries up to 3× on non-200, so redelivery must be a no-op
 *           (50-Failures #28/#29 replay protection).
 *
 *  3. NO ACTIVITY PAYLOAD. The event carries only an `object_id` reference —
 *     NOT the activity. On a first-time activity create/update we ENQUEUE a
 *     fetch of that activity (the connector's backfill/fetch path then pulls
 *     + normalizes it). We ACK within Strava's 2-second window and do the
 *     fetch asynchronously (durable row + cron, the repo's established queue
 *     pattern) — never inline (#21 no slow webhook).
 *
 * The route is @Public() (Strava is not a Supabase user) and throttled.
 */

/** Strava's documented/observed delivery IPs (AWS us-east-1 egress). */
const DEFAULT_STRAVA_WEBHOOK_IPS = [
  '54.173.232.159',
  '54.227.82.103',
  '52.55.245.219',
];

const ENV = {
  verifyToken: 'STRAVA_WEBHOOK_VERIFY_TOKEN',
  subscriptionId: 'STRAVA_WEBHOOK_SUBSCRIPTION_ID',
  allowedIps: 'STRAVA_WEBHOOK_ALLOWED_IPS',
} as const;

/**
 * Thin enqueue facade for "fetch this just-updated Strava activity". Mirrors
 * the repo's LeadSyncQueue pattern: today the durable transport is a row +
 * cron sweep (no BullMQ in the repo); this seam lets the webhook hand off
 * without knowing the transport, and lets tests assert the handoff without
 * booting a worker. PR-HK-3 (sync worker) owns the actual fetch.
 */
@Injectable()
export class StravaActivityFetchQueue {
  private readonly logger = new Logger(StravaActivityFetchQueue.name);

  /** Mark a Strava activity for fetch+normalize. Fire-and-forget. */
  async enqueueActivityFetch(ownerId: number, activityId: number): Promise<void> {
    this.logger.debug(
      `strava.enqueueActivityFetch owner=${ownerId} activity=${activityId}`,
    );
  }
}

/** Internal seam so unit tests can inject env without process.env. */
export interface StravaWebhookEnv {
  getEnv: (key: string) => string | undefined;
}

@ApiTags('webhooks')
@Controller('v1/wearables/webhooks')
export class StravaWebhookController implements OnModuleInit {
  private readonly logger = new Logger(StravaWebhookController.name);
  private readonly getEnv: (key: string) => string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetchQueue: StravaActivityFetchQueue,
    env?: Partial<StravaWebhookEnv>,
  ) {
    this.getEnv = env?.getEnv ?? ((k) => process.env[k]);
  }

  /**
   * Startup misconfiguration warning (Finding 1). Strava POSTs carry NO HMAC,
   * so `STRAVA_WEBHOOK_SUBSCRIPTION_ID` is a core compensating control. If it is
   * unset at boot, log loudly so ops sees it on deploy — the POST handler will
   * additionally fail closed (503) until it is configured.
   */
  onModuleInit(): void {
    if (!this.getEnv(ENV.subscriptionId)) {
      this.logger.warn(
        'strava.webhook.startup: STRAVA_WEBHOOK_SUBSCRIPTION_ID is unset — ' +
          'Strava POST webhooks will FAIL CLOSED (503) until it is configured. ' +
          'No events will be processed.',
      );
    }
  }

  /**
   * Subscription-verification handshake. Strava issues this GET on
   * subscription creation. Echo the challenge iff the verify_token matches the
   * configured secret; otherwise 403 (never echo for a wrong/absent token, or
   * an attacker could mint a subscription against our callback).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('strava')
  @HttpCode(HttpStatus.OK)
  verifySubscription(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
  ): { 'hub.challenge': string } {
    const expected = this.getEnv(ENV.verifyToken);
    if (!expected) {
      // Fail loud on misconfig rather than silently accept any token.
      this.logger.error('strava.webhook.verify: verify token not configured');
      throw new ForbiddenException('Strava webhook verify token not configured');
    }
    if (mode !== 'subscribe' || !challenge || verifyToken !== expected) {
      this.logger.warn('strava.webhook.verify: rejected (mode/token mismatch)');
      throw new ForbiddenException('Strava webhook verification failed');
    }
    return { 'hub.challenge': challenge };
  }

  /**
   * Push event receiver. Validates source IP, Zod-parses the payload (400 on
   * malformed), fail-closes on subscription config (503 unset / 403 mismatch),
   * dedups via WearableProcessedEvent, then enqueues an activity fetch on first
   * sight. ALWAYS returns 200 within Strava's 2s window once accepted (the
   * fetch is async) — but rejects malformed/unauthenticated/foreign or
   * misconfigured events with 400/403/503.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  @Post('strava')
  @HttpCode(HttpStatus.OK)
  async handleEvent(
    @Req() req: Request,
    @Body() rawBody: unknown,
  ): Promise<{ received: true; deduped: boolean }> {
    // (b) source-IP allow-list.
    this.assertAllowedSourceIp(req);

    // Schema validation (Finding 2) — Zod parse rejects malformed-but-truthy
    // payloads (wrong enum, non-numeric/negative ids, missing fields, unknown
    // keys) with a 400 BEFORE any DB touch, subscription check, dedup, or
    // enqueue. Never let a parse failure surface as a 500.
    const parsed = this.parseEvent(rawBody);
    const body: StravaWebhookEventParsed = parsed;

    // (a) subscription_id must match our configured subscription — FAIL CLOSED
    // (Finding 1). Strava POSTs have no HMAC, so an unconfigured subscription
    // id is a misconfiguration we must NOT process through: 503 when unset,
    // 403 on mismatch, continue only on an exact match.
    const configuredSubscriptionId = this.getEnv(ENV.subscriptionId);
    if (!configuredSubscriptionId) {
      this.logger.error(
        JSON.stringify({
          msg: 'wearables.strava.webhook_misconfigured',
          reason: 'STRAVA_WEBHOOK_SUBSCRIPTION_ID unset',
        }),
      );
      throw new ServiceUnavailableException('strava_webhook_not_configured');
    }
    if (String(body.subscription_id) !== configuredSubscriptionId) {
      this.logger.warn(
        `strava.webhook.event: foreign subscription_id=${body.subscription_id}`,
      );
      throw new ForbiddenException('subscription_id_mismatch');
    }

    // (c) idempotency. Composite provider_event_id keyed on the natural event
    // identity. createMany(skipDuplicates) makes redelivery a no-op.
    const providerEventId = `${body.object_type}:${body.object_id}:${body.event_time}`;
    const { count } = await this.prisma.wearableProcessedEvent.createMany({
      data: [
        {
          provider: WearableProvider.STRAVA,
          provider_event_id: providerEventId,
          type: `${body.object_type}.${body.aspect_type}`,
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0) {
      // Already processed — no-op ACK (replay protection).
      this.logger.log(`strava.webhook.event: duplicate ${providerEventId}`);
      return { received: true, deduped: true };
    }

    // First-time event. Only activity create/update need a fetch (delete +
    // athlete deauthorization are handled by other lanes; we still ACK them).
    if (
      body.object_type === 'activity' &&
      (body.aspect_type === 'create' || body.aspect_type === 'update')
    ) {
      await this.fetchQueue.enqueueActivityFetch(body.owner_id, body.object_id);
    }

    return { received: true, deduped: false };
  }

  /**
   * Validate + parse the webhook body against the Zod schema (Finding 2).
   * Returns the typed event on success; throws `BadRequestException` (400) on
   * any schema violation — NEVER a 500. The strict schema also rejects unknown
   * top-level keys, so a malformed-but-truthy payload cannot be acknowledged.
   */
  private parseEvent(rawBody: unknown): StravaWebhookEventParsed {
    const result = StravaWebhookEventSchema.safeParse(rawBody);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.logger.warn(`strava.webhook.event: malformed payload — ${issues}`);
      throw new BadRequestException('Malformed Strava webhook event');
    }
    return result.data;
  }

  /**
   * Enforce the source-IP allow-list. Reads the configured list (or the
   * documented defaults); "*" disables the check (trusted-proxy mode). Uses
   * the leftmost X-Forwarded-For hop when present (we sit behind a proxy),
   * else the socket remote address.
   */
  private assertAllowedSourceIp(req: Request): void {
    const configured = this.getEnv(ENV.allowedIps);
    if (configured === '*') return; // explicitly disabled (trusted proxy)

    const allowed = configured
      ? configured.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_STRAVA_WEBHOOK_IPS;

    const ip = this.sourceIp(req);
    if (!ip || !allowed.includes(ip)) {
      this.logger.warn(`strava.webhook.event: blocked source ip=${ip ?? 'unknown'}`);
      throw new ForbiddenException('Source IP not allowed');
    }
  }

  /** Resolve the request source IP (leftmost XFF hop, else socket address). */
  private sourceIp(req: Request): string | null {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0].split(',')[0].trim();
    }
    const remote = req.socket?.remoteAddress ?? req.ip;
    return remote ?? null;
  }
}
