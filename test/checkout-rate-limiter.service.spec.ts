import { ConfigService } from '@nestjs/config';
import { CheckoutIpRateLimiterService } from '../src/storefront/checkout-rate-limiter.service';

// A276-F4-P1-A — IPv6 source addresses must be masked to the /64
// prefix before they become a rate-limit bucket key.
//
// The service exposes only `checkAndIncrement(ip)` publicly; we
// observe the normalization indirectly via the in-memory limiter:
// IPs that share a bucket increment the same `count`, IPs that
// don't share a bucket each see `count: 1`. We force in-memory mode
// by constructing the service with a ConfigService that returns
// `undefined` for REDIS_URL (matches the production-not-configured
// codepath in onModuleInit).

function makeService(): CheckoutIpRateLimiterService {
  const config = {
    get: (_key: string) => undefined,
  } as unknown as ConfigService;
  const svc = new CheckoutIpRateLimiterService(config);
  // onModuleInit is async; without REDIS_URL it short-circuits, so
  // we don't strictly need to call it. Calling it preserves parity.
  return svc;
}

describe('CheckoutIpRateLimiterService.normalizeIp (A276-F4-P1-A — IPv6 /64 mask)', () => {
  let svc: CheckoutIpRateLimiterService;

  beforeEach(async () => {
    svc = makeService();
    await svc.onModuleInit();
    svc.resetForTests();
  });

  it('IPv4 — two distinct addresses get independent buckets (unchanged behavior)', async () => {
    const a = await svc.checkAndIncrement('203.0.113.7');
    const b = await svc.checkAndIncrement('198.51.100.42');
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it('IPv4 — same address shares its bucket across calls (unchanged behavior)', async () => {
    const first = await svc.checkAndIncrement('203.0.113.7');
    const second = await svc.checkAndIncrement('203.0.113.7');
    const third = await svc.checkAndIncrement('203.0.113.7');
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(third.count).toBe(3);
  });

  it('IPv4-mapped IPv6 (::ffff:1.2.3.4) shares the bucket with the bare IPv4 address', async () => {
    const bare = await svc.checkAndIncrement('203.0.113.7');
    const mapped = await svc.checkAndIncrement('::ffff:203.0.113.7');
    expect(bare.count).toBe(1);
    expect(mapped.count).toBe(2);
  });

  it('IPv6 — two addresses in the SAME /64 share one bucket (the bypass fix)', async () => {
    // 2001:db8:1234:5678::/64 — two distinct /128s inside one /64.
    const a = await svc.checkAndIncrement('2001:db8:1234:5678:abcd:ef01:2345:6789');
    const b = await svc.checkAndIncrement('2001:db8:1234:5678:0000:0000:0000:0001');
    const c = await svc.checkAndIncrement('2001:db8:1234:5678::beef');
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(c.count).toBe(3);
  });

  it('IPv6 — addresses in DIFFERENT /64s get independent buckets', async () => {
    // Differ in the 4th hextet (still inside the /64 prefix) → different bucket.
    const a = await svc.checkAndIncrement('2001:db8:1234:5678::1');
    const b = await svc.checkAndIncrement('2001:db8:1234:9999::1');
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it('IPv6 — :: compression at start, middle, and end all normalize to the same /64', async () => {
    // All three of these are inside 2001:0db8:0000:0000::/64.
    const a = await svc.checkAndIncrement('2001:db8::1');
    const b = await svc.checkAndIncrement('2001:0db8:0000:0000:0000:0000:0000:00ff');
    const c = await svc.checkAndIncrement('2001:db8:0:0::2');
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(c.count).toBe(3);
  });

  it('IPv6 — link-local with zone id (fe80::1%eth0) is normalized (zone stripped)', async () => {
    // fe80::/10 — first /64 prefix `fe80::/64`. Same bucket regardless of zone.
    const a = await svc.checkAndIncrement('fe80::1%eth0');
    const b = await svc.checkAndIncrement('fe80::2%eth1');
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
  });

  it('malformed / empty / nonsense input is bucketed under the `unknown` sentinel', async () => {
    const a = await svc.checkAndIncrement('not-an-ip');
    const b = await svc.checkAndIncrement('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = await svc.checkAndIncrement(undefined as any);
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(c.count).toBe(3);
  });

  it('limit is enforced at 5/hr per (normalized) bucket', async () => {
    const ip = '2001:db8:cafe:f00d::1';
    for (let i = 1; i <= 5; i += 1) {
      const r = await svc.checkAndIncrement(ip);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
    const sixth = await svc.checkAndIncrement(ip);
    expect(sixth.allowed).toBe(false);
    expect(sixth.count).toBe(6);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limit also fires for sibling /128s inside the same /64 (the bypass fix end-to-end)', async () => {
    // Five distinct /128s inside one /64 — pre-fix this was 5 buckets
    // of 1; post-fix it is 1 bucket of 5 (and the 6th is blocked).
    const siblings = [
      '2001:db8:dead:beef::1',
      '2001:db8:dead:beef::2',
      '2001:db8:dead:beef:1111:2222:3333:4444',
      '2001:db8:dead:beef:ffff::',
      '2001:db8:dead:beef:0:0:0:abcd',
    ];
    for (const ip of siblings) {
      const r = await svc.checkAndIncrement(ip);
      expect(r.allowed).toBe(true);
    }
    const blocked = await svc.checkAndIncrement('2001:db8:dead:beef::99');
    expect(blocked.allowed).toBe(false);
  });
});
