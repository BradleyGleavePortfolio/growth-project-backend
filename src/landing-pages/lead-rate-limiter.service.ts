/**
 * Per-page daily lead capacity limiter.
 *
 * Anti-abuse layer that sits on top of the per-IP burst throttler
 * (@nestjs/throttler at 3 leads/min/IP). The throttler stops a single
 * scripted attacker; this stops a botnet from quietly soaking a coach's
 * landing page with 10k garbage leads overnight.
 *
 * Bucket: `lead-form:<pageId>:<UTC YYYY-MM-DD>`
 * Limit:  100 leads / page / UTC day
 * TTL:    90_000 s (25h) — well clear of the 24h bucket plus DST safety
 *
 * UTC was chosen over the coach's local timezone deliberately: the
 * counter is an internal abuse signal, not a user-facing report.  Aligning
 * the reset on UTC midnight gives every page the same fairness window
 * regardless of where the coach lives, and avoids the (cheap but real)
 * cost of looking up the coach's timezone on every public POST.
 *
 * Falls back to an in-memory counter when REDIS_URL is unset so dev/test
 * still works.  In-memory mode resets on process restart — acceptable for
 * a dev environment.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DAILY_LIMIT = 100;
const TTL_SECONDS = 90_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Current count after this check (1-based; the request that hit 101 sees 101 here). */
  count: number;
  /** Seconds until the bucket resets — sent in Retry-After on a 429. */
  retryAfterSeconds: number;
}

@Injectable()
export class LeadRateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(LeadRateLimiterService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  // Test-friendly in-memory fallback. Map<bucketKey, { count, expiresAt }>.
  private memory = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly config?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config?.get<string>('REDIS_URL') || process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('REDIS_URL unset — using in-memory lead rate limiter');
      return;
    }
    try {
      // Lazy-import: unit tests don't need ioredis loaded.
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('Redis lead rate limiter connected');
    } catch (err) {
      this.logger.warn(
        `Redis lead rate limiter unavailable, falling back to in-memory: ${(err as Error).message}`,
      );
      this.redis = null;
    }
  }

  /**
   * Increment the page's daily counter atomically and return whether the
   * request is under the cap.  Uses Redis INCR + EXPIRE (set only on first
   * increment) for an O(1) check.  The in-memory fallback is best-effort —
   * single-process only — but matches the same semantics so tests can use it.
   */
  async checkAndIncrement(pageId: string): Promise<RateLimitResult> {
    // Internal abuse key only — a UTC date string is acceptable here
    // because the bucket is not surfaced to users (R45 user-facing date
    // rules do not apply). Slice the ISO string once and reuse.
    const day = new Date().toISOString().slice(0, 10);
    const key = `lead-form:${pageId}:${day}`;
    const secondsUntilUtcMidnight = secondsUntilNextUtcMidnight(new Date());

    if (this.redis) {
      try {
        // Pipeline: INCR + EXPIRE in one round trip. EXPIRE on every call
        // is cheap and idempotent (Redis re-applies the same TTL).
        const pipe = this.redis.pipeline();
        pipe.incr(key);
        pipe.expire(key, TTL_SECONDS);
        const result = (await pipe.exec()) as Array<[Error | null, number]> | null;
        const count = result?.[0]?.[1] ?? 0;
        return {
          allowed: count <= DAILY_LIMIT,
          count,
          retryAfterSeconds: secondsUntilUtcMidnight,
        };
      } catch (err) {
        this.logger.warn(`Redis INCR failed, falling back to memory: ${(err as Error).message}`);
        // fall through
      }
    }
    return this.memoryIncrement(key, secondsUntilUtcMidnight);
  }

  private memoryIncrement(key: string, retryAfterSeconds: number): RateLimitResult {
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return {
        allowed: existing.count <= DAILY_LIMIT,
        count: existing.count,
        retryAfterSeconds,
      };
    }
    const fresh = { count: 1, expiresAt: now + TTL_SECONDS * 1000 };
    this.memory.set(key, fresh);
    // Best-effort cleanup so the map does not grow unbounded in dev.
    if (this.memory.size > 1000) {
      for (const [k, v] of this.memory) {
        if (v.expiresAt <= now) this.memory.delete(k);
      }
    }
    return { allowed: true, count: 1, retryAfterSeconds };
  }

  /** Test-only seam: clear all state so spec cases don't leak between tests. */
  resetForTests(): void {
    this.memory.clear();
  }
}

/**
 * Exported as a free function so the test suite can pin "now" without
 * touching the service instance.
 */
export function secondsUntilNextUtcMidnight(now: Date): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}
