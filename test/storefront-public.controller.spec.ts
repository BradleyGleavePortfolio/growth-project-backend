import 'reflect-metadata';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  StorefrontPublicController,
  storefrontJoinIpTracker,
  STOREFRONT_JOIN_SKIP_THROTTLERS,
} from '../src/storefront/storefront-public.controller';
import { withFailOpenStorage } from '../src/throttler/throttler.config';
import {
  CheckoutIpRateLimiterService,
  RATE_LIMIT_SCOPES,
} from '../src/storefront/checkout-rate-limiter.service';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
} from '../src/throttler/throttler.config';

// A276-P1-2 / A276-P1-3 — controller-scoped tests for the rate-limiter
// hardening and the Referrer-Policy header on the magic-link redirect.
//
// All collaborators are jest mocks; we instantiate the controller
// directly (no Nest TestingModule) because every concern under test is
// a pure-function call on the controller class. The IP limiter mock
// returns `allowed:false` to simulate bucket exhaustion.

const ALLOWED = { allowed: true, count: 1, retryAfterSeconds: 60 };
const DENIED = { allowed: false, count: 6, retryAfterSeconds: 1234 };
const SHARE_TOKEN = 'abcdef1234567890abcdef1234567890';

function makeReq(): Request {
  return {
    headers: { 'fly-client-ip': '203.0.113.7' },
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Request;
}

function makeRes(): Response & {
  _headers: Record<string, string>;
  _redirect?: { status: number; url: string };
} {
  const headers: Record<string, string> = {};
  const res = {
    _headers: headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this as unknown as Response;
    },
    redirect(status: number, url: string) {
      (this as unknown as { _redirect: unknown })._redirect = { status, url };
      return undefined;
    },
  };
  return res as unknown as Response & {
    _headers: Record<string, string>;
    _redirect?: { status: number; url: string };
  };
}

function build(deps: {
  ipLimiter?: { checkAndIncrement: jest.Mock };
  storefront?: Partial<Record<string, jest.Mock>>;
  guestCheckout?: Partial<Record<string, jest.Mock>>;
  recovery?: Partial<Record<string, jest.Mock>>;
  cookies?: Partial<Record<string, jest.Mock>>;
  config?: { get: jest.Mock };
} = {}) {
  const ipLimiter = deps.ipLimiter ?? {
    checkAndIncrement: jest.fn().mockResolvedValue(ALLOWED),
  };
  const storefront = deps.storefront ?? { getPublicPackageByToken: jest.fn() };
  const guestCheckout = deps.guestCheckout ?? { createIntent: jest.fn() };
  const recovery =
    deps.recovery ??
    ({
      resumeFromCredentials: jest.fn(),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    } as Record<string, jest.Mock>);
  const cookies = deps.cookies ?? { setSessionCookie: jest.fn() };
  const config =
    deps.config ??
    ({
      get: jest.fn().mockReturnValue('https://joingrowthproject.com'),
    } as { get: jest.Mock });

  const thankYou = { buildViewModel: jest.fn() };
  const controller = new StorefrontPublicController(
    storefront as never,
    guestCheckout as never,
    recovery as never,
    config as never,
    ipLimiter as never,
    cookies as never,
    thankYou as never,
  );
  return { controller, ipLimiter, recovery, config };
}

describe('StorefrontPublicController — A276-P1-2 IP rate limiter on recovery routes', () => {
  describe('POST /checkout/resume', () => {
    it('calls ipLimiter.checkAndIncrement before invoking recovery service', async () => {
      const order: string[] = [];
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockImplementation(async () => {
          order.push('limiter');
          return ALLOWED;
        }),
      };
      const recovery = {
        resumeFromCredentials: jest.fn().mockImplementation(async () => {
          order.push('service');
          return { guest_checkout_id: 'gc_1', resumable: true };
        }),
        sendRecoveryLink: jest.fn(),
        verifyToken: jest.fn(),
      };
      const { controller } = build({ ipLimiter, recovery });
      await controller.resumeGuestCheckout(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
      expect(order).toEqual(['limiter', 'service']);
      // A276-F4-P1-B — the resume route now passes a per-route bucket
      // scope and an explicit maxAttempts. Verify both reach the
      // limiter so the per-route budget cannot regress to the old
      // shared-bucket behavior under a refactor.
      expect(ipLimiter.checkAndIncrement).toHaveBeenCalledWith(
        '203.0.113.7',
        expect.objectContaining({
          scope: RATE_LIMIT_SCOPES.Resume,
          maxAttempts: 5,
        }),
      );
    });

    it('throws 429 with Retry-After header when bucket is exhausted', async () => {
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockResolvedValue(DENIED),
      };
      const recovery = {
        resumeFromCredentials: jest.fn(),
        sendRecoveryLink: jest.fn(),
        verifyToken: jest.fn(),
      };
      const { controller } = build({ ipLimiter, recovery });
      const res = makeRes();
      await expect(
        controller.resumeGuestCheckout(
          SHARE_TOKEN,
          { guest_email: 'j@example.com' } as never,
          makeReq(),
          res as never,
        ),
      ).rejects.toMatchObject({
        getStatus: expect.any(Function),
      });
      // Verify HttpException carries 429
      try {
        await controller.resumeGuestCheckout(
          SHARE_TOKEN,
          { guest_email: 'j@example.com' } as never,
          makeReq(),
          makeRes() as never,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      expect(res._headers['Retry-After']).toBe('1234');
      expect(recovery.resumeFromCredentials).not.toHaveBeenCalled();
    });
  });

  describe('POST /checkout/send-recovery-link', () => {
    it('calls ipLimiter.checkAndIncrement before mailing', async () => {
      const order: string[] = [];
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockImplementation(async () => {
          order.push('limiter');
          return ALLOWED;
        }),
      };
      const recovery = {
        resumeFromCredentials: jest.fn(),
        sendRecoveryLink: jest.fn().mockImplementation(async () => {
          order.push('service');
          return { sent: true };
        }),
        verifyToken: jest.fn(),
      };
      const { controller } = build({ ipLimiter, recovery });
      await controller.sendRecoveryLink(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
      expect(order).toEqual(['limiter', 'service']);
    });

    it('throws 429 with Retry-After when bucket is exhausted, and does not send email', async () => {
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockResolvedValue(DENIED),
      };
      const recovery = {
        resumeFromCredentials: jest.fn(),
        sendRecoveryLink: jest.fn(),
        verifyToken: jest.fn(),
      };
      const { controller } = build({ ipLimiter, recovery });
      const res = makeRes();
      let caught: unknown = null;
      try {
        await controller.sendRecoveryLink(
          SHARE_TOKEN,
          { guest_email: 'j@example.com' } as never,
          makeReq(),
          res as never,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(res._headers['Retry-After']).toBe('1234');
      expect(recovery.sendRecoveryLink).not.toHaveBeenCalled();
    });
  });

  describe('GET /checkout/resume/:jwt', () => {
    it('calls ipLimiter.checkAndIncrement before verifying token', async () => {
      const order: string[] = [];
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockImplementation(async () => {
          order.push('limiter');
          return ALLOWED;
        }),
      };
      const recovery = {
        resumeFromCredentials: jest.fn(),
        sendRecoveryLink: jest.fn(),
        verifyToken: jest.fn().mockImplementation(async () => {
          order.push('verify');
          return { share_token: SHARE_TOKEN, guest_checkout_id: 'gc_1' };
        }),
      };
      const { controller } = build({ ipLimiter, recovery });
      await controller.resumeFromMagicLink(
        SHARE_TOKEN,
        'eyJ.fake.jwt',
        makeReq(),
        makeRes() as never,
      );
      expect(order).toEqual(['limiter', 'verify']);
    });

    it('throws 429 with Retry-After when bucket is exhausted, never verifying token', async () => {
      const ipLimiter = {
        checkAndIncrement: jest.fn().mockResolvedValue(DENIED),
      };
      const recovery = {
        resumeFromCredentials: jest.fn(),
        sendRecoveryLink: jest.fn(),
        verifyToken: jest.fn(),
      };
      const { controller } = build({ ipLimiter, recovery });
      const res = makeRes();
      let caught: unknown = null;
      try {
        await controller.resumeFromMagicLink(
          SHARE_TOKEN,
          'eyJ.fake.jwt',
          makeReq(),
          res as never,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(res._headers['Retry-After']).toBe('1234');
      expect(recovery.verifyToken).not.toHaveBeenCalled();
    });
  });
});

describe('StorefrontPublicController — A276-P1-3 (controller half) Referrer-Policy on resume redirect', () => {
  it('sets Referrer-Policy: no-referrer before redirecting', async () => {
    const recovery = {
      resumeFromCredentials: jest.fn(),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn().mockResolvedValue({
        share_token: SHARE_TOKEN,
        guest_checkout_id: 'gc_abc',
      }),
    };
    const { controller } = build({ recovery });
    const res = makeRes();
    await controller.resumeFromMagicLink(
      SHARE_TOKEN,
      'eyJ.fake.jwt',
      makeReq(),
      res as never,
    );
    expect(res._headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('issues a 302 redirect with the storefront URL (status preserved)', async () => {
    const recovery = {
      resumeFromCredentials: jest.fn(),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn().mockResolvedValue({
        share_token: SHARE_TOKEN,
        guest_checkout_id: 'gc_abc',
      }),
    };
    const config = {
      get: jest.fn().mockReturnValue('https://example.test/'),
    };
    const { controller } = build({ recovery, config });
    const res = makeRes();
    await controller.resumeFromMagicLink(
      SHARE_TOKEN,
      'eyJ.fake.jwt',
      makeReq(),
      res as never,
    );
    expect(res._redirect?.status).toBe(HttpStatus.FOUND);
    // No JWT in the destination URL (audit P1-3).
    expect(res._redirect?.url).not.toContain('eyJ.fake.jwt');
    expect(res._redirect?.url).toContain(SHARE_TOKEN);
    expect(res._redirect?.url).toContain('resume=gc_abc');
  });

  it('does not include the JWT as a query param in the destination URL', async () => {
    const recovery = {
      resumeFromCredentials: jest.fn(),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn().mockResolvedValue({
        share_token: SHARE_TOKEN,
        guest_checkout_id: 'gc_abc',
      }),
    };
    const { controller } = build({ recovery });
    const res = makeRes();
    await controller.resumeFromMagicLink(
      SHARE_TOKEN,
      'eyJ.fake.jwt',
      makeReq(),
      res as never,
    );
    const url = res._redirect?.url ?? '';
    const query = url.split('?')[1] ?? '';
    expect(query).not.toMatch(/jwt|token=eyJ/i);
  });
});

// ---------------------------------------------------------------------------
// A276-F4-P2-G — extractIp must survive array-valued proxy headers.
//
// Node's `IncomingHttpHeaders` types `fly-client-ip` and
// `x-forwarded-for` as `string | string[] | undefined`. Express
// usually coalesces multi-set headers to a comma-joined string, but
// raw Node http2 / a hostile upstream / a misconfigured edge can
// deliver an actual array. Pre-fix, `.trim()` on the array would
// have thrown a TypeError, the limiter would never have incremented,
// and every request from that source would have silently bypassed
// the rate limit. These tests pin the new behavior end-to-end
// through the controller: each route must still drive the limiter
// with a non-empty IP string regardless of the header shape.
// ---------------------------------------------------------------------------

describe('StorefrontPublicController — A276-F4-P2-G XFF array-header handling', () => {
  function makeReqWithHeaders(headers: Record<string, unknown>): Request {
    return {
      headers,
      ip: '10.0.0.99',
      socket: { remoteAddress: '10.0.0.99' },
    } as unknown as Request;
  }

  it('array `fly-client-ip` takes the LAST element (hop closest to our edge)', async () => {
    const calls: string[] = [];
    const ipLimiter = {
      checkAndIncrement: jest.fn().mockImplementation(async (ip: string) => {
        calls.push(ip);
        return ALLOWED;
      }),
    };
    const guestCheckout = {
      createIntent: jest.fn().mockResolvedValue({ guest_checkout_id: 'gc_1' }),
    };
    const cookies = { setSessionCookie: jest.fn() };
    const { controller } = build({ ipLimiter, guestCheckout, cookies });

    await controller.createGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({ 'fly-client-ip': ['1.1.1.1', '2.2.2.2'] }),
      makeRes() as never,
    );
    expect(calls).toEqual(['2.2.2.2']);
  });

  it('array `x-forwarded-for` falls through to last element, then first CSV value', async () => {
    const calls: string[] = [];
    const ipLimiter = {
      checkAndIncrement: jest.fn().mockImplementation(async (ip: string) => {
        calls.push(ip);
        return ALLOWED;
      }),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter, recovery });

    // No fly-client-ip; multi-line XFF (array) where the last entry is
    // itself a comma-separated chain. The originating client is the
    // leftmost token of the closest-hop array element.
    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({
        'x-forwarded-for': ['9.9.9.9', '203.0.113.7, 198.51.100.1'],
      }),
      makeRes() as never,
    );
    expect(calls).toEqual(['203.0.113.7']);
  });

  it('string `x-forwarded-for` still takes the FIRST CSV value (unchanged)', async () => {
    const calls: string[] = [];
    const ipLimiter = {
      checkAndIncrement: jest.fn().mockImplementation(async (ip: string) => {
        calls.push(ip);
        return ALLOWED;
      }),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter, recovery });

    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({
        'x-forwarded-for': '203.0.113.7, 198.51.100.1, 10.0.0.1',
      }),
      makeRes() as never,
    );
    expect(calls).toEqual(['203.0.113.7']);
  });

  it('empty array headers fall back to req.ip (no TypeError, no silent bypass)', async () => {
    const calls: string[] = [];
    const ipLimiter = {
      checkAndIncrement: jest.fn().mockImplementation(async (ip: string) => {
        calls.push(ip);
        return ALLOWED;
      }),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter, recovery });

    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({
        'fly-client-ip': [],
        'x-forwarded-for': [],
      }),
      makeRes() as never,
    );
    expect(calls).toEqual(['10.0.0.99']);
  });

  it('whitespace inside CSV values is trimmed (string and array cases)', async () => {
    const calls: string[] = [];
    const ipLimiter = {
      checkAndIncrement: jest.fn().mockImplementation(async (ip: string) => {
        calls.push(ip);
        return ALLOWED;
      }),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter, recovery });

    // String form with leading/trailing whitespace inside CSV.
    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({
        'x-forwarded-for': '   203.0.113.7   ,  198.51.100.1',
      }),
      makeRes() as never,
    );
    // Array form with whitespace in the last element.
    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReqWithHeaders({
        'x-forwarded-for': ['9.9.9.9', '  198.51.100.42  '],
      }),
      makeRes() as never,
    );
    expect(calls).toEqual(['203.0.113.7', '198.51.100.42']);
  });
});

// ---------------------------------------------------------------------------
// #7 (token enumeration) — TWO-LAYER throttle on GET join/:token.
//
// LAYER 1 — `default` throttler, COMPOSITE (token, IP) key at 20/min. The
// Nest @Throttle `default` bucket on `/v1/packages/public/join/*` routes is
// keyed by UserThrottlerGuard.getTracker(), which composes the share token
// with the client IP (`storefront-join:<token>:<ip>`). The GET now mirrors
// the companion POST checkout bucket exactly (`{ ttl: 60_000, limit: 20 }`),
// giving per-(token, IP) fairness so a real buyer reloading their ONE valid
// link is isolated from traffic to other tokens.
//
// LAYER 2 — `storefront-join-ip` throttler, IP-ONLY key at 120/min
// (STOREFRONT_JOIN_IP_PER_MIN). Layer 1 alone does NOT bound distinct-token
// PROBING from one IP: each guessed token gets its OWN 20/min composite
// bucket, so a single IP could enumerate many tokens at 20 attempts EACH.
// This second layer applies a route-level @Throttle with an IP-only
// getTracker (`storefront-join-ip:<ip>`, via storefrontJoinIpTracker) so ALL
// of an IP's distinct-token join GETs share ONE budget — bounding an
// enumeration sweep across the whole token space, while leaving legitimate
// shared-NAT traffic (≈6 distinct buyers/IP at 20/min each) headroom.
//
// These tests pin: (1) GET default bucket == POST checkout bucket; (2) the
// composite tracker shape (Layer 1); (3) the IP-only tracker shape, route
// metadata, and a real-guard runtime proof that distinct-token probing from
// one IP is bounded by Layer 2 where Layer 1 alone would let it through.
// ---------------------------------------------------------------------------

describe('StorefrontPublicController — #7 composite (token,IP) throttle on GET join/:token', () => {
  // @nestjs/throttler v6 stores the unnamed `default` throttler at
  // `THROTTLER:TTLdefault` / `THROTTLER:LIMITdefault` on the handler.
  const readDefaultThrottle = (
    handler: object,
  ): { ttl: number | undefined; limit: number | undefined } => ({
    ttl: Reflect.getMetadata('THROTTLER:TTLdefault', handler) as
      | number
      | undefined,
    limit: Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as
      | number
      | undefined,
  });

  it('GET join/:token carries the same default @Throttle bucket as POST checkout (ttl 60s, limit 20)', () => {
    const getMeta = readDefaultThrottle(
      StorefrontPublicController.prototype.getPublicPackage,
    );
    const postMeta = readDefaultThrottle(
      StorefrontPublicController.prototype.createGuestCheckout,
    );
    expect(getMeta).toEqual({ ttl: 60_000, limit: 20 });
    // Consistency with the companion POST handler — the issue requires the
    // GET to reuse the POST's throttle strategy, not a divergent one.
    expect(getMeta).toEqual(postMeta);
  });

  it('GET join/:token is tightened from the old IP-only 60/min ceiling', () => {
    const getMeta = readDefaultThrottle(
      StorefrontPublicController.prototype.getPublicPackage,
    );
    // Must be strictly tighter than the pre-fix 60/min so enumeration
    // sweeps are bounded harder than before.
    expect(getMeta.limit).toBeLessThan(60);
  });

  describe('UserThrottlerGuard.getTracker — composite (token,IP) key for the join route', () => {
    const buildGuard = (): UserThrottlerGuard =>
      Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard;
    const tracker = (req: object): Promise<string> =>
      (buildGuard() as unknown as { getTracker(r: object): Promise<string> })
        .getTracker(req);

    const joinReq = (token: string, ip: string) => ({
      route: { path: '/v1/packages/public/join/:token' },
      url: `/v1/packages/public/join/${token}`,
      params: { token },
      headers: { 'fly-client-ip': ip },
    });

    it('keys the GET join route by (token, IP), not IP alone', async () => {
      const key = await tracker(joinReq('tok_abc', '203.0.113.7'));
      expect(key).toBe('storefront-join:tok_abc:203.0.113.7');
      // Crucially NOT the bare per-IP bucket that allowed enumeration.
      expect(key).not.toBe('ip:203.0.113.7');
    });

    it('same IP + different token => different bucket (single-token loads are isolated)', async () => {
      const ip = '203.0.113.7';
      const a = await tracker(joinReq('tok_a', ip));
      const b = await tracker(joinReq('tok_b', ip));
      expect(a).not.toBe(b);
    });

    it('same token + same IP => same bucket (legitimate repeated loads share one bucket)', async () => {
      const a = await tracker(joinReq('tok_same', '203.0.113.7'));
      const b = await tracker(joinReq('tok_same', '203.0.113.7'));
      expect(a).toBe(b);
    });
  });

  // -------------------------------------------------------------------------
  // LAYER 2 — IP-WIDE `storefront-join-ip` throttle bounds distinct-token
  // enumeration from a single IP (the P1 audit finding).
  // -------------------------------------------------------------------------
  describe('storefront-join-ip IP-wide layer (distinct-token enumeration brake)', () => {
    const readNamedThrottle = (
      handler: object,
      name: string,
    ): {
      ttl: number | undefined;
      limit: number | undefined;
      getTracker: unknown;
    } => ({
      ttl: Reflect.getMetadata(`THROTTLER:TTL${name}`, handler) as
        | number
        | undefined,
      limit: Reflect.getMetadata(`THROTTLER:LIMIT${name}`, handler) as
        | number
        | undefined,
      getTracker: Reflect.getMetadata(`THROTTLER:TRACKER${name}`, handler),
    });

    it('GET join/:token carries the storefront-join-ip layer (ttl 60s, IP-wide limit, custom tracker)', () => {
      const meta = readNamedThrottle(
        StorefrontPublicController.prototype.getPublicPackage,
        THROTTLER_NAMES.STOREFRONT_JOIN_IP,
      );
      expect(meta.ttl).toBe(60_000);
      expect(meta.limit).toBe(THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN);
      // A custom getTracker MUST be present — without it the layer would reuse
      // the composite (token, IP) tracker and fail to bound enumeration.
      expect(typeof meta.getTracker).toBe('function');
    });

    it('storefront-join-ip is registered globally with a NON-biting baseline (does not throttle other routes)', () => {
      const entry = THROTTLER_LIMITS.find(
        (t) => t.name === THROTTLER_NAMES.STOREFRONT_JOIN_IP,
      );
      expect(entry).toBeDefined();
      // The global baseline must be far above any real per-route ceiling so
      // unrelated routes (which fall through to this baseline) are unaffected.
      expect(entry!.limit).toBeGreaterThanOrEqual(5_000);
    });

    it('storefrontJoinIpTracker keys by IP ONLY — different tokens share ONE bucket', () => {
      const reqA = {
        params: { token: 'tok_a' },
        headers: { 'fly-client-ip': '203.0.113.9' },
      };
      const reqB = {
        params: { token: 'tok_b' },
        headers: { 'fly-client-ip': '203.0.113.9' },
      };
      const keyA = storefrontJoinIpTracker(reqA);
      const keyB = storefrontJoinIpTracker(reqB);
      expect(keyA).toBe('storefront-join-ip:203.0.113.9');
      // The whole point: distinct tokens from the same IP collapse to the
      // SAME bucket (opposite of the composite Layer-1 tracker).
      expect(keyA).toBe(keyB);
    });

    it('storefrontJoinIpTracker isolates DIFFERENT IPs into different buckets', () => {
      const a = storefrontJoinIpTracker({
        params: { token: 'x' },
        headers: { 'fly-client-ip': '198.51.100.1' },
      });
      const b = storefrontJoinIpTracker({
        params: { token: 'x' },
        headers: { 'fly-client-ip': '198.51.100.2' },
      });
      expect(a).not.toBe(b);
    });

    it('storefrontJoinIpTracker falls back through XFF then req.ip and never throws on bad headers', () => {
      // x-forwarded-for first hop wins when fly-client-ip is absent.
      expect(
        storefrontJoinIpTracker({
          params: {},
          headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' },
        }),
      ).toBe('storefront-join-ip:203.0.113.50');
      // Array-valued header — must not throw.
      expect(
        storefrontJoinIpTracker({
          params: {},
          headers: { 'fly-client-ip': ['10.0.0.9', '203.0.113.77'] },
        }),
      ).toBe('storefront-join-ip:203.0.113.77');
      // No headers at all — falls back to req.ip.
      expect(
        storefrontJoinIpTracker({ ip: '192.0.2.5', headers: {} }),
      ).toBe('storefront-join-ip:192.0.2.5');
      // Nothing usable — never empty/throw.
      expect(storefrontJoinIpTracker({ headers: {} })).toBe(
        'storefront-join-ip:unknown',
      );
    });

    // Strongest proof: drive the REAL @nestjs/throttler ThrottlerGuard with
    // both layers wired exactly as the route declares them, and show that
    // distinct-token probing from ONE IP — which Layer 1 (composite) alone
    // would never block — is bounded by Layer 2 (IP-wide).
    it('bounds distinct-token enumeration from one IP via the IP-wide layer (real guard)', async () => {
      const IP_LIMIT = 5; // tightened for a fast, deterministic test
      const COMPOSITE_LIMIT = 20;
      const hits: Record<string, number> = {};
      const storage = {
        async increment(
          key: string,
          _ttl: number,
          limit: number,
        ): Promise<{
          totalHits: number;
          timeToExpire: number;
          isBlocked: boolean;
          timeToBlockExpire: number;
        }> {
          hits[key] = (hits[key] || 0) + 1;
          const totalHits = hits[key];
          return {
            totalHits,
            timeToExpire: 60,
            isBlocked: totalHits > limit,
            timeToBlockExpire: 60,
          };
        },
      };
      const ipTracker = (req: Record<string, unknown>): Promise<string> =>
        Promise.resolve(storefrontJoinIpTracker(req));
      const reflector = {
        getAllAndOverride(key: string): unknown {
          if (key === `THROTTLER:LIMIT${THROTTLER_NAMES.DEFAULT}`)
            return COMPOSITE_LIMIT;
          if (key === `THROTTLER:TTL${THROTTLER_NAMES.DEFAULT}`) return 60_000;
          if (key === `THROTTLER:LIMIT${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return IP_LIMIT;
          if (key === `THROTTLER:TTL${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return 60_000;
          if (key === `THROTTLER:TRACKER${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return ipTracker;
          return undefined;
        },
      };
      const options = {
        throttlers: [
          { name: THROTTLER_NAMES.DEFAULT, ttl: 60_000, limit: 100 },
          {
            name: THROTTLER_NAMES.STOREFRONT_JOIN_IP,
            ttl: 60_000,
            limit: 10_000,
          },
        ],
      };
      const guard = new ThrottlerGuard(
        options as never,
        storage as never,
        reflector as never,
      );
      // Layer-1 default tracker = composite (token, IP), as UserThrottlerGuard
      // supplies in production.
      (guard as unknown as {
        getTracker(r: Record<string, unknown>): Promise<string>;
      }).getTracker = (r) =>
        Promise.resolve(
          `storefront-join:${(r.params as { token: string }).token}:${
            (r.headers as { 'fly-client-ip': string })['fly-client-ip']
          }`,
        );
      await guard.onModuleInit();

      const res = { header(): void {} };
      const makeCtx = (token: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              params: { token },
              headers: { 'fly-client-ip': '203.0.113.200' },
            }),
            getResponse: () => res,
          }),
          getHandler: () => function getPublicPackage(): void {},
          getClass: () => class StorefrontPublicController {},
        }) as never;

      // Each probe uses a DIFFERENT token from the SAME IP. Layer 1 (composite,
      // 20/min) never trips (1 hit per token-bucket). Layer 2 (IP-wide, 5/min)
      // bites on the 6th distinct-token request.
      let blockedAt: number | null = null;
      for (let i = 1; i <= 8; i++) {
        try {
          await guard.canActivate(makeCtx(`tok_${i}`));
        } catch {
          blockedAt = i;
          break;
        }
      }
      // The IP-wide layer (Layer 2) bites on the (IP_LIMIT + 1)th distinct
      // token, even though each token's composite Layer-1 bucket saw only a
      // single hit. This is the exact P1 enumeration vector being closed.
      expect(blockedAt).toBe(IP_LIMIT + 1);
      // generateKey() hashes (ClassName-handler-throttlerName-tracker), so the
      // raw tracker strings are not visible in `hits` keys. Instead prove the
      // composite Layer-1 buckets were per-token (one storage key per distinct
      // token) while the IP-wide Layer-2 bucket was shared across them: with
      // two throttlers and IP_LIMIT distinct tokens that passed Layer 1, we see
      // IP_LIMIT composite buckets + the shared IP bucket(s). Concretely: the
      // total distinct storage keys must exceed 1 (proving Layer-1 split by
      // token) yet enforcement happened on the IP layer (blockedAt above).
      const distinctKeys = Object.keys(hits).length;
      expect(distinctKeys).toBeGreaterThan(1);
      // Every composite Layer-1 bucket was hit exactly once (no single token
      // ever approached the 20/min composite ceiling) — so Layer 1 alone would
      // NOT have blocked the sweep; only Layer 2 did.
      const singleHitBuckets = Object.values(hits).filter(
        (n) => n === 1,
      ).length;
      expect(singleHitBuckets).toBeGreaterThanOrEqual(IP_LIMIT);
    });

    // A legitimate buyer reloading ONE token must not be blocked by the
    // IP-wide layer below its ceiling.
    it('does NOT block a single-token legitimate reload below the IP-wide ceiling', () => {
      const key = storefrontJoinIpTracker({
        params: { token: 'tok_real' },
        headers: { 'fly-client-ip': '203.0.113.42' },
      });
      // The IP-wide ceiling (120/min) is far above a real buyer's reload rate.
      expect(THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN).toBeGreaterThan(
        20,
      );
      expect(key).toBe('storefront-join-ip:203.0.113.42');
    });
  });

  // -------------------------------------------------------------------------
  // R2 P1 (throttler ISOLATION) — unrelated named throttlers must NOT govern
  // the GET join/:token route. Before the fix, every globally-registered
  // named throttler (auth-password-reset 3/hr, auth-signup 5/hr, …) ran on
  // this route AND fell back to the guard's composite (token, IP) tracker, so
  // the 4th same-token reload tripped the 3/hr password-reset bucket — long
  // before the intended 20/min composite ceiling. @SkipThrottle on the route
  // disables all but `default` + `storefront-join-ip`.
  // -------------------------------------------------------------------------
  describe('throttler isolation (R2 P1) — only default + storefront-join-ip govern the route', () => {
    it('SKIP map covers EVERY named throttler except default + storefront-join-ip', () => {
      const active = new Set<string>([
        THROTTLER_NAMES.DEFAULT,
        THROTTLER_NAMES.STOREFRONT_JOIN_IP,
      ]);
      for (const name of Object.values(THROTTLER_NAMES)) {
        if (active.has(name)) {
          expect(STOREFRONT_JOIN_SKIP_THROTTLERS[name]).toBeUndefined();
        } else {
          // Every unrelated throttler (incl. auth-password-reset 3/hr) is
          // explicitly skipped so it can never govern this route.
          expect(STOREFRONT_JOIN_SKIP_THROTTLERS[name]).toBe(true);
        }
      }
      // Spot-check the exact throttler from the audit finding.
      expect(
        STOREFRONT_JOIN_SKIP_THROTTLERS[THROTTLER_NAMES.AUTH_PASSWORD_RESET],
      ).toBe(true);
    });

    it('the route declares @SkipThrottle metadata for each unrelated throttler', () => {
      const handler = StorefrontPublicController.prototype.getPublicPackage;
      // @nestjs/throttler stores SkipThrottle as `THROTTLER:SKIP<name>` = true.
      for (const name of Object.keys(STOREFRONT_JOIN_SKIP_THROTTLERS)) {
        expect(Reflect.getMetadata(`THROTTLER:SKIP${name}`, handler)).toBe(true);
      }
      // default + storefront-join-ip are NOT skipped (they govern the route).
      expect(
        Reflect.getMetadata(
          `THROTTLER:SKIP${THROTTLER_NAMES.DEFAULT}`,
          handler,
        ),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(
          `THROTTLER:SKIP${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`,
          handler,
        ),
      ).toBeUndefined();
    });

    // Strongest proof: drive the REAL ThrottlerGuard with the FULL global
    // THROTTLER_LIMITS table (incl. auth-password-reset 3/hr) and the route's
    // ACTUAL @SkipThrottle + @Throttle metadata. Same token + same IP must
    // now allow 20 and reject the 21st (composite layer), and distinct tokens
    // from one IP must reject at the 121st (IP-wide layer) — NOT at request 4.
    const buildIsolationGuard = () => {
      const hits: Record<string, number> = {};
      const storage = {
        async increment(key: string, _ttl: number, limit: number) {
          hits[key] = (hits[key] || 0) + 1;
          const totalHits = hits[key];
          return {
            totalHits,
            timeToExpire: 60,
            isBlocked: totalHits > limit,
            timeToBlockExpire: 60,
          };
        },
      };
      // Reflector backed by the route's REAL decorator metadata, so the guard
      // observes the exact @SkipThrottle + @Throttle the controller declares.
      const reflector = {
        getAllAndOverride(key: string): unknown {
          // SkipThrottle map.
          if (key.startsWith('THROTTLER:SKIP')) {
            const name = key.slice('THROTTLER:SKIP'.length);
            return STOREFRONT_JOIN_SKIP_THROTTLERS[name] ?? false;
          }
          // Route-level @Throttle overrides for default + storefront-join-ip.
          if (key === `THROTTLER:LIMIT${THROTTLER_NAMES.DEFAULT}`) return 20;
          if (key === `THROTTLER:TTL${THROTTLER_NAMES.DEFAULT}`) return 60_000;
          if (key === `THROTTLER:LIMIT${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN;
          if (key === `THROTTLER:TTL${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return 60_000;
          if (key === `THROTTLER:TRACKER${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`)
            return (req: Record<string, unknown>): Promise<string> =>
              Promise.resolve(storefrontJoinIpTracker(req));
          return undefined;
        },
      };
      // Register the FULL global throttler table — every named throttler the
      // guard would evaluate in production, including auth-password-reset 3/hr.
      const guard = new ThrottlerGuard(
        { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) } as never,
        storage as never,
        reflector as never,
      );
      // Layer-1 default tracker = composite (token, IP), as UserThrottlerGuard
      // supplies; this is the tracker the unrelated throttlers would ALSO have
      // reused had they not been skipped.
      (guard as unknown as {
        getTracker(r: Record<string, unknown>): Promise<string>;
      }).getTracker = (r) =>
        Promise.resolve(
          `storefront-join:${(r.params as { token: string }).token}:${
            (r.headers as Record<string, string>)['fly-client-ip']
          }`,
        );
      return { guard, hits };
    };

    const makeCtx = (token: string, ip: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            params: { token },
            headers: { 'fly-client-ip': ip },
          }),
          getResponse: () => ({ header(): void {} }),
        }),
        getHandler: () =>
          StorefrontPublicController.prototype.getPublicPackage,
        getClass: () => StorefrontPublicController,
      }) as never;

    it('SAME token + SAME IP: allows 20, rejects the 21st (NOT the 4th)', async () => {
      const { guard } = buildIsolationGuard();
      await guard.onModuleInit();
      let blockedAt: number | null = null;
      for (let i = 1; i <= 25; i++) {
        try {
          await guard.canActivate(makeCtx('tok_real', '203.0.113.250'));
        } catch {
          blockedAt = i;
          break;
        }
      }
      // Pre-fix this was 4 (auth-password-reset 3/hr). Post-isolation it is 21
      // (the intended composite 20/min ceiling).
      expect(blockedAt).toBe(21);
    });

    it('DISTINCT tokens + SAME IP: rejects at the 121st (IP-wide layer), NOT the 4th', async () => {
      const { guard } = buildIsolationGuard();
      await guard.onModuleInit();
      let blockedAt: number | null = null;
      for (let i = 1; i <= 130; i++) {
        try {
          await guard.canActivate(makeCtx(`tok_${i}`, '203.0.113.251'));
        } catch {
          blockedAt = i;
          break;
        }
      }
      // IP-wide ceiling is 120/min; the 121st distinct-token probe is rejected.
      expect(blockedAt).toBe(
        THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN + 1,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// R2 P1 — Redis-down GRACEFUL DEGRADATION (fail-open) for the throttler
// storage. A storage outage must NOT turn throttled routes into 5xx; it must
// fail open (allow the request) while logging a warning + bumping a metric.
// ---------------------------------------------------------------------------
describe('throttler storage fail-open (R2 P1) — Redis-down does not break the user flow', () => {
  const NON_BLOCKING = {
    totalHits: 0,
    isBlocked: false,
  };

  it('returns a non-blocking record (allow) when the backend increment throws', async () => {
    const warnings: unknown[] = [];
    const metrics: Array<{ name: string; labels: Record<string, string> }> = [];
    const downStorage = {
      increment: jest.fn().mockRejectedValue(
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      ),
    };
    const wrapped = withFailOpenStorage(downStorage as never, {
      logger: { warn: (m: unknown) => warnings.push(m) },
      onFailure: (name, labels) => metrics.push({ name, labels }),
    });

    const rec = await wrapped.increment(
      'sha256key',
      60_000,
      20,
      0,
      THROTTLER_NAMES.DEFAULT,
    );

    // FAIL OPEN — request is allowed (0 hits, not blocked).
    expect(rec.totalHits).toBe(NON_BLOCKING.totalHits);
    expect(rec.isBlocked).toBe(NON_BLOCKING.isBlocked);
    // A high-severity structured warning was logged…
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toBe(
      'throttler.storage_unavailable.fail_open',
    );
    expect((warnings[0] as { throttler: string }).throttler).toBe(
      THROTTLER_NAMES.DEFAULT,
    );
    // …and a low-cardinality metric was emitted.
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe('throttler_storage_failures_total');
    expect(metrics[0].labels).toEqual({ throttler: THROTTLER_NAMES.DEFAULT });
  });

  it('passes through the backend record unchanged when the backend is healthy', async () => {
    const healthy = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 3,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    };
    const wrapped = withFailOpenStorage(healthy as never);
    const rec = await wrapped.increment('k', 60_000, 20, 0, 'default');
    expect(rec.totalHits).toBe(3);
    expect(rec.isBlocked).toBe(false);
    expect(healthy.increment).toHaveBeenCalledTimes(1);
  });

  it('never throws even if the metric sink itself throws (fail-open is absolute)', async () => {
    const downStorage = {
      increment: jest.fn().mockRejectedValue(new Error('redis gone')),
    };
    const wrapped = withFailOpenStorage(downStorage as never, {
      logger: { warn: () => undefined },
      onFailure: () => {
        throw new Error('metrics broken');
      },
    });
    await expect(
      wrapped.increment('k', 60_000, 20, 0, 'default'),
    ).resolves.toMatchObject({ isBlocked: false, totalHits: 0 });
  });
});

describe('StorefrontPublicController — resume credential flow surfaces NotFound', () => {
  it('returns 404 when recovery service finds nothing', async () => {
    const recovery = {
      resumeFromCredentials: jest.fn().mockResolvedValue(null),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ recovery });
    await expect(
      controller.resumeGuestCheckout(
        SHARE_TOKEN,
        { guest_email: 'unknown@example.com' } as never,
        makeReq(),
        makeRes() as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// A276-F4-P1-B — per-route IP rate-limit buckets.
//
// The previous revision threaded a single 5/hr-per-IP bucket through all
// four recovery routes. A real buyer behind CGNAT (university WiFi,
// corporate network, mobile carrier) doing normal retries could exhaust
// the shared bucket in a single checkout attempt and earn a 60-minute
// 429 on every endpoint, including the redirect they were about to
// click. These tests pin the new behavior:
//   • each route passes a distinct `scope` + `maxAttempts` to the
//     limiter, matching the cost-asymmetry rationale in the controller
//     doc comments;
//   • exhausting one route's bucket (the wrapped fake here) does NOT
//     deny calls on the other routes.
// ---------------------------------------------------------------------------

describe('StorefrontPublicController — A276-F4-P1-B per-route IP buckets', () => {
  it('each route passes its own scope + maxAttempts to the limiter', async () => {
    // Capture every (ip, options) tuple the limiter sees across all
    // four routes; assert the scope/maxAttempts on each call match the
    // route's documented cost tier.
    const calls: Array<{ ip: string; options: unknown }> = [];
    const ipLimiter = {
      checkAndIncrement: jest
        .fn()
        .mockImplementation(
          async (ip: string, options?: { scope?: string; maxAttempts?: number }) => {
            calls.push({ ip, options: options ?? {} });
            return ALLOWED;
          },
        ),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn().mockResolvedValue({ sent: true }),
      verifyToken: jest.fn().mockResolvedValue({
        share_token: SHARE_TOKEN,
        guest_checkout_id: 'gc_1',
      }),
    };
    const guestCheckout = {
      createIntent: jest.fn().mockResolvedValue({ guest_checkout_id: 'gc_1' }),
    };
    const cookies = { setSessionCookie: jest.fn() };
    const { controller } = build({
      ipLimiter,
      recovery,
      guestCheckout,
      cookies,
    });

    await controller.createGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      makeRes() as never,
    );
    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      makeRes() as never,
    );
    await controller.sendRecoveryLink(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      makeRes() as never,
    );
    await controller.resumeFromMagicLink(
      SHARE_TOKEN,
      'eyJ.fake.jwt',
      makeReq(),
      makeRes() as never,
    );

    expect(calls.map((c) => c.options)).toEqual([
      { scope: RATE_LIMIT_SCOPES.CreateIntent, maxAttempts: 10 },
      { scope: RATE_LIMIT_SCOPES.Resume, maxAttempts: 5 },
      { scope: RATE_LIMIT_SCOPES.SendRecoveryLink, maxAttempts: 3 },
      { scope: RATE_LIMIT_SCOPES.ResumeJwt, maxAttempts: 10 },
    ]);
    // Sanity — same IP, four routes, four distinct scopes.
    expect(new Set(calls.map((c) => c.ip))).toEqual(new Set(['203.0.113.7']));
  });

  it('exhausting /send-recovery-link does NOT block /resume on the same IP (cross-route lockout fix)', async () => {
    // Simulate a real CGNAT'd buyer who triggers 5 email-send attempts
    // (well past the new 3/hr ceiling on that one route). Under the
    // OLD shared-bucket design, the 6th call to a sibling route — the
    // /resume redirect they were about to click — would 429. Under
    // the new per-route design, /resume must still succeed because
    // its bucket (`resume`) is independent of the send-link bucket.
    //
    // We use a fake limiter that tracks per-scope counts against the
    // per-scope `maxAttempts` to reproduce the production semantics
    // without standing up Redis.
    const scopeCounts = new Map<string, number>();
    const fakeLimiter = {
      checkAndIncrement: jest
        .fn()
        .mockImplementation(
          async (
            ip: string,
            options: { scope: string; maxAttempts: number },
          ) => {
            const scope = options.scope;
            const limit = options.maxAttempts;
            const next = (scopeCounts.get(`${ip}:${scope}`) ?? 0) + 1;
            scopeCounts.set(`${ip}:${scope}`, next);
            return {
              allowed: next <= limit,
              count: next,
              retryAfterSeconds: 1234,
            };
          },
        ),
    };
    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn().mockResolvedValue({ sent: true }),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter: fakeLimiter, recovery });

    // Burn the /send-recovery-link bucket: 3 allowed, then 2 over-cap.
    const sendOutcomes: Array<'ok' | '429'> = [];
    for (let i = 0; i < 5; i += 1) {
      try {
        await controller.sendRecoveryLink(
          SHARE_TOKEN,
          { guest_email: 'j@example.com' } as never,
          makeReq(),
          makeRes() as never,
        );
        sendOutcomes.push('ok');
      } catch (err) {
        if (
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
        ) {
          sendOutcomes.push('429');
        } else {
          throw err;
        }
      }
    }
    // 3/hr ceiling on send-recovery-link → first 3 ok, last 2 blocked.
    expect(sendOutcomes).toEqual(['ok', 'ok', 'ok', '429', '429']);
    expect(recovery.sendRecoveryLink).toHaveBeenCalledTimes(3);

    // Critical assertion: /resume on the SAME IP is unaffected.
    const resumeRes = makeRes();
    await expect(
      controller.resumeGuestCheckout(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        resumeRes as never,
      ),
    ).resolves.toBeDefined();
    expect(recovery.resumeFromCredentials).toHaveBeenCalledTimes(1);
    expect(resumeRes._headers['Retry-After']).toBeUndefined();
    // The /resume bucket should hold exactly one increment — proof
    // that it is namespaced separately from /send-recovery-link.
    expect(scopeCounts.get('203.0.113.7:resume')).toBe(1);
    expect(scopeCounts.get('203.0.113.7:send-recovery-link')).toBe(5);
  });

  it('/send-recovery-link enforces its tighter 3/hr ceiling (not the 5/hr default)', async () => {
    // Pin the email-cost-path ceiling: the fourth call must 429 even
    // though the legacy default would have allowed up to 5. This
    // guards against a future refactor that drops the explicit
    // `maxAttempts: 3` and silently inherits the default.
    const scopeCounts = new Map<string, number>();
    const fakeLimiter = {
      checkAndIncrement: jest
        .fn()
        .mockImplementation(
          async (
            ip: string,
            options: { scope: string; maxAttempts: number },
          ) => {
            const scope = options.scope;
            const limit = options.maxAttempts;
            const next = (scopeCounts.get(`${ip}:${scope}`) ?? 0) + 1;
            scopeCounts.set(`${ip}:${scope}`, next);
            return {
              allowed: next <= limit,
              count: next,
              retryAfterSeconds: 1234,
            };
          },
        ),
    };
    const recovery = {
      resumeFromCredentials: jest.fn(),
      sendRecoveryLink: jest.fn().mockResolvedValue({ sent: true }),
      verifyToken: jest.fn(),
    };
    const { controller } = build({ ipLimiter: fakeLimiter, recovery });

    for (let i = 0; i < 3; i += 1) {
      await controller.sendRecoveryLink(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
    }
    let caught: unknown = null;
    try {
      await controller.sendRecoveryLink(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(recovery.sendRecoveryLink).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// A276-F4-P3-K — cross-route lockout, real service (not a fake limiter).
//
// The describe above pins the cross-route property using a hand-rolled
// fake `scopeCounts` map. That suffices to catch most regressions, but
// has a known failure-mode: if a future refactor accidentally breaks
// the real service's per-scope keying (e.g. dropping `scope` from the
// Redis key template), the fake test still passes because the fake
// implements the property the real one might have broken.
//
// This block wires the REAL `CheckoutIpRateLimiterService` (in-memory
// mode, REDIS_URL unset) into the controller and asserts the same
// property end-to-end. Now the keying contract is exercised through
// the actual production code path: any drift between the controller's
// scope literal and the service's key template trips the test.
// ---------------------------------------------------------------------------

describe('StorefrontPublicController — A276-F4-P3-K real-service cross-route isolation', () => {
  function realLimiter(): CheckoutIpRateLimiterService {
    const config = {
      get: (_key: string) => undefined,
    } as unknown as ConfigService;
    return new CheckoutIpRateLimiterService(config);
  }

  it('exhausting /send-recovery-link does NOT block /resume — real service, same IP', async () => {
    const ipLimiter = realLimiter();
    await ipLimiter.onModuleInit();
    ipLimiter.resetForTests();

    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn().mockResolvedValue({ sent: true }),
      verifyToken: jest.fn(),
    };
    const guestCheckout = {
      createIntent: jest.fn().mockResolvedValue({ guest_checkout_id: 'gc_1' }),
    };
    const cookies = { setSessionCookie: jest.fn() };
    const storefront = { getPublicPackageByToken: jest.fn() };
    const config = {
      get: jest.fn().mockReturnValue('https://joingrowthproject.com'),
    };

    const thankYou = { buildViewModel: jest.fn() };
    const controller = new StorefrontPublicController(
      storefront as never,
      guestCheckout as never,
      recovery as never,
      config as never,
      ipLimiter as never,
      cookies as never,
      thankYou as never,
    );

    // Burn the send-recovery-link bucket: 3 allowed (limit=3), then 2
    // over-cap. All five requests share the same IP.
    const sendOutcomes: Array<'ok' | '429'> = [];
    for (let i = 0; i < 5; i += 1) {
      try {
        await controller.sendRecoveryLink(
          SHARE_TOKEN,
          { guest_email: 'j@example.com' } as never,
          makeReq(),
          makeRes() as never,
        );
        sendOutcomes.push('ok');
      } catch (err) {
        if (
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
        ) {
          sendOutcomes.push('429');
        } else {
          throw err;
        }
      }
    }
    expect(sendOutcomes).toEqual(['ok', 'ok', 'ok', '429', '429']);
    expect(recovery.sendRecoveryLink).toHaveBeenCalledTimes(3);

    // /resume on the SAME IP must succeed — its bucket (scope=resume)
    // is independent of send-recovery-link in the real service.
    const resumeRes = makeRes();
    await controller.resumeGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      resumeRes as never,
    );
    expect(recovery.resumeFromCredentials).toHaveBeenCalledTimes(1);
    expect(resumeRes._headers['Retry-After']).toBeUndefined();

    // /checkout (create-intent, limit=10) and /resume/:jwt (resume-jwt,
    // limit=10) must also be untouched.
    await controller.createGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      makeRes() as never,
    );
    expect(guestCheckout.createIntent).toHaveBeenCalledTimes(1);

    recovery.verifyToken.mockResolvedValue({
      share_token: SHARE_TOKEN,
      guest_checkout_id: 'gc_1',
    });
    await controller.resumeFromMagicLink(
      SHARE_TOKEN,
      'eyJ.fake.jwt',
      makeReq(),
      makeRes() as never,
    );
    expect(recovery.verifyToken).toHaveBeenCalledTimes(1);
  });

  it('/resume bucket independently exhausts at its own 5/hr ceiling (real service)', async () => {
    // Pin that the /resume bucket honors its own limit through the
    // real key template, independent of whatever load other scopes
    // have. Exhaust /resume to 5 then assert the 6th call 429s while
    // a fresh /checkout call on the same IP still succeeds.
    const ipLimiter = realLimiter();
    await ipLimiter.onModuleInit();
    ipLimiter.resetForTests();

    const recovery = {
      resumeFromCredentials: jest
        .fn()
        .mockResolvedValue({ guest_checkout_id: 'gc_1', resumable: true }),
      sendRecoveryLink: jest.fn(),
      verifyToken: jest.fn(),
    };
    const guestCheckout = {
      createIntent: jest.fn().mockResolvedValue({ guest_checkout_id: 'gc_1' }),
    };
    const cookies = { setSessionCookie: jest.fn() };
    const storefront = { getPublicPackageByToken: jest.fn() };
    const config = {
      get: jest.fn().mockReturnValue('https://joingrowthproject.com'),
    };
    const thankYou = { buildViewModel: jest.fn() };
    const controller = new StorefrontPublicController(
      storefront as never,
      guestCheckout as never,
      recovery as never,
      config as never,
      ipLimiter as never,
      cookies as never,
      thankYou as never,
    );

    for (let i = 0; i < 5; i += 1) {
      await controller.resumeGuestCheckout(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
    }
    let caught: unknown = null;
    try {
      await controller.resumeGuestCheckout(
        SHARE_TOKEN,
        { guest_email: 'j@example.com' } as never,
        makeReq(),
        makeRes() as never,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    // create-intent on the same IP is still allowed.
    await controller.createGuestCheckout(
      SHARE_TOKEN,
      { guest_email: 'j@example.com' } as never,
      makeReq(),
      makeRes() as never,
    );
    expect(guestCheckout.createIntent).toHaveBeenCalledTimes(1);
  });
});
