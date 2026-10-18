import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ipRateLimitBucket } from '../throttler/ip-bucket';

// r48 #10 — IP rate limit on POST /v1/packages/public/join/:token/checkout.
//
// Failure mode: a bad actor scripts thousands of checkout-create
// requests against a coach's link.  Even though Stripe handles the
// money side, every PI we mint costs us a Stripe API call, a
// Connect-account read, a DB write — and the bad actor learns coach
// names + email validation paths.
//
// Mitigation: Redis-backed IP throttle, 5 attempts per hour per IP.
// Bucket key: `co:rl:ip:<ip>:<hour-bucket>` where hour-bucket =
// floor(now / 3600 * 1000).  INCR + EXPIRE pipeline (atomic-enough)
// per the same pattern landing-pages.lead-rate-limiter uses.
//
// The Nest @Throttle decorator on the controller already provides
// per-IP throttling, but its window is 60s/20 which is too generous
// for hour-scale abuse.  This service is the long-window backstop.

const TTL_SECONDS = 3700; // bucket length 3600 + small slack
const REDIS_KEY_PREFIX = 'co:rl:ip:';

// A276-F4-P3-I — single source of truth for per-route bucket scopes.
// Defined once here so the controller and the test files import the
// same constants; a typo at any call site is a compile error rather
// than a silently-minted isolated bucket.
//
// The values are the literal scope strings that become part of the
// Redis key (`co:rl:ip:<scope>:<ip>:<hour>`). Changing a value here
// will orphan the in-flight bucket under the old name during the
// deploy hour — same one-hour transient as any scope rename. Avoid
// without good cause.
export const RATE_LIMIT_SCOPES = {
  CreateIntent: 'create-intent',
  Resume: 'resume',
  SendRecoveryLink: 'send-recovery-link',
  ResumeJwt: 'resume-jwt',
} as const;

export type RateLimitScope =
  (typeof RATE_LIMIT_SCOPES)[keyof typeof RATE_LIMIT_SCOPES];

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export interface CheckAndIncrementOptions {
  /**
   * Bucket scope — a per-route identifier. Buckets with different
   * scopes are independent, so exhausting one route's budget does
   * NOT lock the caller out of the others.
   *
   * A276-F4-P3-I — typed to the union of known scopes so a typo at
   * a call site fails at compile time.
   * A276-F4-P3-J — required (no default fallback): every production
   * call site must declare its scope explicitly.
   */
  scope: RateLimitScope;
  /**
   * Maximum attempts allowed in the (per-IP, per-scope, per-hour)
   * bucket. Required — each route's ceiling is expressed at the
   * call site to make cost asymmetry visible in code review.
   */
  maxAttempts: number;
}

@Injectable()
export class CheckoutIpRateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutIpRateLimiterService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  private readonly memory = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.log(
        'CheckoutIpRateLimiterService: REDIS_URL unset — using in-memory limiter',
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('CheckoutIpRateLimiterService: Redis connected');
    } catch (err) {
      this.logger.warn(
        `CheckoutIpRateLimiterService: Redis unavailable, falling back: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      this.redis = null;
    }
  }

  async checkAndIncrement(
    ip: string,
    options: CheckAndIncrementOptions,
  ): Promise<RateLimitResult> {
    // A276-F4-P3-J — exhaustiveness check: the switch below enumerates
    // every member of RATE_LIMIT_SCOPES. If a new scope is added to
    // the union without a corresponding case here, the `never`
    // assignment fails to compile. This is the type-system
    // replacement for the v1 `'default'` fallback that used to swallow
    // unknown scopes at runtime.
    switch (options.scope) {
      case RATE_LIMIT_SCOPES.CreateIntent:
      case RATE_LIMIT_SCOPES.Resume:
      case RATE_LIMIT_SCOPES.SendRecoveryLink:
      case RATE_LIMIT_SCOPES.ResumeJwt:
        break;
      default: {
        const _exhaustive: never = options.scope;
        // Unreachable at runtime under the typed contract; if we ever
        // get here it means a caller defeated the type checker (e.g.
        // `as RateLimitScope` cast). Bucket under a sentinel so the
        // attempt is still counted rather than silently dropped.
        void _exhaustive;
        break;
      }
    }
    const scope = options.scope;
    const limit = options.maxAttempts;
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `${REDIS_KEY_PREFIX}${scope}:${ipRateLimitBucket(ip)}:${hourBucket}`;
    const retryAfterSeconds = this.secondsUntilNextHour();
    if (this.redis) {
      try {
        const pipe = this.redis.pipeline();
        pipe.incr(key);
        pipe.expire(key, TTL_SECONDS);
        const result = (await pipe.exec()) as Array<[Error | null, number]> | null;
        const count = result?.[0]?.[1] ?? 0;
        return {
          allowed: count <= limit,
          count,
          retryAfterSeconds,
        };
      } catch (err) {
        this.logger.warn(
          `Redis INCR failed, falling back: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return this.memoryIncrement(key, retryAfterSeconds, limit);
  }

  /** Test seam: clear state between cases. */
  resetForTests(): void {
    this.memory.clear();
  }

  private secondsUntilNextHour(): number {
    const now = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    return Math.max(1, Math.ceil((nextHour - now) / 1000));
  }

  private memoryIncrement(
    key: string,
    retryAfterSeconds: number,
    limit: number,
  ): RateLimitResult {
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return {
        allowed: existing.count <= limit,
        count: existing.count,
        retryAfterSeconds,
      };
    }
    const fresh = { count: 1, expiresAt: now + TTL_SECONDS * 1000 };
    this.memory.set(key, fresh);
    // Cap map size — drop expired entries lazily.
    if (this.memory.size > 4096) {
      for (const [k, v] of this.memory) {
        if (v.expiresAt <= now) this.memory.delete(k);
      }
    }
    return { allowed: true, count: 1, retryAfterSeconds };
  }
}
