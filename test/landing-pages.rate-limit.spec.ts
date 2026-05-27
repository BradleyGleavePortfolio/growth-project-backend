/**
 * R47 lead-form rate limiter tests.
 *
 * Exercises the in-memory fallback (no REDIS_URL set in test env so the
 * Redis branch is skipped); the algorithm is identical to the Redis
 * INCR path so a passing in-memory case validates the threshold logic.
 */

import {
  LeadRateLimiterService,
  secondsUntilNextUtcMidnight,
} from '../src/landing-pages/lead-rate-limiter.service';

describe('LeadRateLimiterService (in-memory)', () => {
  let svc: LeadRateLimiterService;

  beforeEach(async () => {
    svc = new LeadRateLimiterService();
    await svc.onModuleInit();
    svc.resetForTests();
  });

  it('allows requests up to the 100/day cap for a single page', async () => {
    for (let i = 1; i <= 100; i += 1) {
      const r = await svc.checkAndIncrement('page-1');
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
  });

  it('rejects the 101st request and reports retry_after_seconds', async () => {
    for (let i = 0; i < 100; i += 1) {
      await svc.checkAndIncrement('page-1');
    }
    const r = await svc.checkAndIncrement('page-1');
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(101);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('buckets per page — second page is not affected by the first', async () => {
    for (let i = 0; i < 100; i += 1) {
      await svc.checkAndIncrement('page-1');
    }
    const other = await svc.checkAndIncrement('page-2');
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });

  it('secondsUntilNextUtcMidnight returns positive seconds within a day', () => {
    const noon = new Date('2026-05-26T12:00:00Z');
    const s = secondsUntilNextUtcMidnight(noon);
    expect(s).toBe(12 * 3600);
  });

  it('secondsUntilNextUtcMidnight handles near-midnight correctly', () => {
    const justBefore = new Date('2026-05-26T23:59:30Z');
    const s = secondsUntilNextUtcMidnight(justBefore);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(30);
  });
});
