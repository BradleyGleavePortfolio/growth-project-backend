import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';

// r48 #7 — Stripe Connect preflight cache.
//
// Failure mode: a coach disconnects their Stripe Express account
// between GET /v1/packages/public/join/:token (which checks readiness)
// and POST /checkout (which mints the PaymentIntent). The GET resolves
// readiness from the local CoachConnectAccount mirror, but Stripe's
// account status can have drifted (Stripe-side disabled_reason set,
// charges_enabled flipped to false) since the mirror was last
// synced.  Without a preflight we mint a PI that Stripe immediately
// rejects, leaving the storefront in a half-broken state.
//
// Mitigation: before createIntent calls /payment_intents, check the
// live Stripe state for the connected account and cache the result
// in Redis (60s TTL).  A disabled account short-circuits the call
// with 503 + COACH_PAYOUT_DISABLED so the storefront can surface a
// "this coach can't accept payments right now" copy and email the
// coach in the same response cycle (out of scope for this PR — the
// alert path is owned by ConnectService).
//
// Also captures the account's `capabilities` so we can return
// supportsApplePay / supportsGooglePay flags (#8) — the same
// preflight feeds both responses with one Stripe round trip.

const TTL_SECONDS = 60;
const REDIS_KEY_PREFIX = 'co:preflight:';

export interface PreflightResult {
  /** Whether the coach can currently accept charges through Stripe. */
  charges_enabled: boolean;
  /** Stripe's disabled_reason field (null when not disabled). */
  disabled_reason: string | null;
  /** Stripe payment_method capabilities at the account level. */
  supports_apple_pay: boolean;
  supports_google_pay: boolean;
}

@Injectable()
export class ConnectPreflightService implements OnModuleInit {
  private readonly logger = new Logger(ConnectPreflightService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  /** In-memory fallback for dev/test boots without REDIS_URL. */
  private readonly memory = new Map<
    string,
    { value: PreflightResult; expiresAt: number }
  >();

  constructor(
    private readonly stripe: StripeConnectApiService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.log(
        'ConnectPreflightService: REDIS_URL unset — using in-memory cache',
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('ConnectPreflightService: Redis cache connected');
    } catch (err) {
      this.logger.warn(
        `ConnectPreflightService: Redis unavailable, falling back: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      this.redis = null;
    }
  }

  /**
   * Cached lookup of a connected account's readiness.  Always returns
   * a PreflightResult; a Stripe outage degrades safely to "assume
   * disabled" so we'd rather miss a sale than mint a doomed PI.
   */
  async getReadiness(stripeAccountId: string): Promise<PreflightResult> {
    const cached = await this.readCache(stripeAccountId);
    if (cached) return cached;
    const fresh = await this.fetchFromStripe(stripeAccountId);
    await this.writeCache(stripeAccountId, fresh);
    return fresh;
  }

  /** Test seam: clear cache state between cases. */
  resetForTests(): void {
    this.memory.clear();
  }

  private async readCache(accountId: string): Promise<PreflightResult | null> {
    const key = `${REDIS_KEY_PREFIX}${accountId}`;
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as PreflightResult;
      } catch (err) {
        this.logger.debug(
          `preflight cache read failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    const memEntry = this.memory.get(key);
    if (!memEntry) return null;
    if (memEntry.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return memEntry.value;
  }

  private async writeCache(
    accountId: string,
    value: PreflightResult,
  ): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}${accountId}`;
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
        return;
      } catch (err) {
        this.logger.debug(
          `preflight cache write failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    this.memory.set(key, {
      value,
      expiresAt: Date.now() + TTL_SECONDS * 1000,
    });
  }

  private async fetchFromStripe(accountId: string): Promise<PreflightResult> {
    try {
      const acc = await this.stripe.retrieveAccount(accountId);
      // The Connect account shape includes `charges_enabled`,
      // `disabled_reason`, and `capabilities.{apple_pay,google_pay}`.
      // Capabilities surface as 'active' / 'inactive' / 'pending';
      // we treat 'active' as enabled.
      const caps = (acc as Record<string, unknown>).capabilities as
        | Record<string, unknown>
        | undefined;
      const applePay = caps?.['apple_pay'];
      const googlePay = caps?.['google_pay'];
      // Standard card capability also gates Apple/Google Pay — if
      // card_payments is anything other than 'active', wallet methods
      // won't actually work even if their capability is 'active'.
      const cardActive = caps?.['card_payments'] === 'active';
      return {
        charges_enabled: Boolean(
          (acc as Record<string, unknown>).charges_enabled,
        ),
        disabled_reason:
          ((acc as Record<string, unknown>).disabled_reason as string | null) ??
          null,
        supports_apple_pay: cardActive && applePay === 'active',
        supports_google_pay: cardActive && googlePay === 'active',
      };
    } catch (err) {
      this.logger.warn(
        `preflight Stripe fetch failed for ${accountId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return {
        charges_enabled: false,
        disabled_reason: 'stripe_unreachable',
        supports_apple_pay: false,
        supports_google_pay: false,
      };
    }
  }
}
