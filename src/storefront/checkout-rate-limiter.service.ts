import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

const MAX_ATTEMPTS_PER_HOUR = 5;
const TTL_SECONDS = 3700; // bucket length 3600 + small slack
const REDIS_KEY_PREFIX = 'co:rl:ip:';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
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

  async checkAndIncrement(ip: string): Promise<RateLimitResult> {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const key = `${REDIS_KEY_PREFIX}${this.normalizeIp(ip)}:${hourBucket}`;
    const retryAfterSeconds = this.secondsUntilNextHour();
    if (this.redis) {
      try {
        const pipe = this.redis.pipeline();
        pipe.incr(key);
        pipe.expire(key, TTL_SECONDS);
        const result = (await pipe.exec()) as Array<[Error | null, number]> | null;
        const count = result?.[0]?.[1] ?? 0;
        return {
          allowed: count <= MAX_ATTEMPTS_PER_HOUR,
          count,
          retryAfterSeconds,
        };
      } catch (err) {
        this.logger.warn(
          `Redis INCR failed, falling back: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return this.memoryIncrement(key, retryAfterSeconds);
  }

  /** Test seam: clear state between cases. */
  resetForTests(): void {
    this.memory.clear();
  }

  private normalizeIp(ip: string): string {
    // Strip IPv6 IPv4-mapped prefix; collapse whitespace; truncate to
    // 64 chars defensively in case a header injects garbage.
    return (ip ?? 'unknown')
      .trim()
      .replace(/^::ffff:/, '')
      .slice(0, 64) || 'unknown';
  }

  private secondsUntilNextHour(): number {
    const now = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    return Math.max(1, Math.ceil((nextHour - now) / 1000));
  }

  private memoryIncrement(
    key: string,
    retryAfterSeconds: number,
  ): RateLimitResult {
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return {
        allowed: existing.count <= MAX_ATTEMPTS_PER_HOUR,
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
