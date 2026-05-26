import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIPv4, isIPv6 } from 'net';

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

  /**
   * Normalize a source IP into a stable bucket key.
   *
   * IPv4: returned as-is (a single host is a single bucket).
   *
   * IPv6: masked to the /64 prefix (first four hextets) before keying.
   * Rationale (A276-F4-P1-A): every commodity cloud/VPS provider hands
   * a single VM a /64 (Hetzner, OVH, Vultr, Linode, AWS EC2 IPv6,
   * GCP). Keying on the full /128 means an attacker rotates through
   * 2^64 unique buckets from one VM and the 5/hr ceiling becomes
   * decoration. /64 is the smallest IPv6 unit a single tenant can
   * realistically be expected to control, matching how Cloudflare,
   * AWS WAF, and Stripe key their IPv6 rate-limit buckets.
   *
   * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped to the IPv4
   * address first, then treated as IPv4 (same bucket as the bare
   * IPv4 form — important so an attacker cannot bypass by toggling
   * the mapped prefix).
   *
   * Malformed / empty inputs fall back to the literal sentinel
   * `'unknown'` so the limiter still buckets them (rather than
   * crashing or letting them through).
   */
  private normalizeIp(ip: string): string {
    const raw = (ip ?? '').trim();
    if (!raw) return 'unknown';

    // Unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4`) so it shares a bucket
    // with the bare IPv4 address — toggling the prefix MUST NOT mint
    // a fresh bucket.
    const unwrapped = raw.replace(/^::ffff:/i, '');

    if (isIPv4(unwrapped)) {
      // IPv4: one host = one bucket. Defensive 64-char truncation in
      // case something upstream injected garbage; isIPv4 has already
      // validated so the truncation is a no-op on the happy path.
      return unwrapped.slice(0, 64);
    }

    // After unwrapping, if it's still IPv6, mask to /64.
    if (isIPv6(unwrapped)) {
      const prefix = this.ipv6Slash64Prefix(unwrapped);
      if (prefix) return prefix;
    }

    // Some upstreams attach a zone-id (`fe80::1%eth0`) — strip it and
    // retry once. We never key on the zone.
    const stripZone = unwrapped.split('%')[0];
    if (stripZone !== unwrapped && isIPv6(stripZone)) {
      const prefix = this.ipv6Slash64Prefix(stripZone);
      if (prefix) return prefix;
    }

    // Malformed input: bucket under a single 'unknown' key rather
    // than let it through. Truncate defensively.
    return 'unknown';
  }

  /**
   * Expand an IPv6 address (validated by `net.isIPv6`) to its first
   * four hextets, then emit a stable `<h1>:<h2>:<h3>:<h4>::/64`
   * bucket key. Returns `null` if the input cannot be expanded.
   *
   * Handles `::` compression (RFC 5952 §4.2) and the trailing
   * IPv4-in-IPv6 form (`2001:db8::192.0.2.1`).
   */
  private ipv6Slash64Prefix(ip: string): string | null {
    let s = ip.toLowerCase();

    // Trailing IPv4 form: `2001:db8::192.0.2.1` → convert the dotted
    // tail to two hextets so we can split on `:`. Only relevant if
    // the IPv4 piece is inside the first 64 bits, which only happens
    // when the address has ≤2 leading hextets — extremely rare for a
    // /64 mask, but handle it for correctness.
    const dotIdx = s.indexOf('.');
    if (dotIdx !== -1) {
      const lastColon = s.lastIndexOf(':', dotIdx);
      if (lastColon === -1) return null;
      const head = s.slice(0, lastColon + 1);
      const v4 = s.slice(lastColon + 1);
      const octets = v4.split('.');
      if (octets.length !== 4) return null;
      const nums = octets.map((o) => Number(o));
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
      }
      const hi = ((nums[0] << 8) | nums[1]).toString(16);
      const lo = ((nums[2] << 8) | nums[3]).toString(16);
      s = `${head}${hi}:${lo}`;
    }

    // Expand `::` to the right number of zero hextets.
    let parts: string[];
    if (s.includes('::')) {
      const [left, right] = s.split('::');
      const leftParts = left === '' ? [] : left.split(':');
      const rightParts = right === '' ? [] : right.split(':');
      const missing = 8 - leftParts.length - rightParts.length;
      if (missing < 0) return null;
      parts = [
        ...leftParts,
        ...Array(missing).fill('0'),
        ...rightParts,
      ];
    } else {
      parts = s.split(':');
    }

    if (parts.length !== 8) return null;
    // First four hextets, with leading zeros stripped per RFC 5952 §4.1.
    const head = parts.slice(0, 4).map((h) => {
      // Validate each hextet is 1-4 hex digits.
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      return h.replace(/^0+(?=[0-9a-f])/, '');
    });
    if (head.some((h) => h === null)) return null;
    return `${(head as string[]).join(':')}::/64`;
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
