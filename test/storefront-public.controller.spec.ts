import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { StorefrontPublicController } from '../src/storefront/storefront-public.controller';
import {
  CheckoutIpRateLimiterService,
  RATE_LIMIT_SCOPES,
} from '../src/storefront/checkout-rate-limiter.service';

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

  const controller = new StorefrontPublicController(
    storefront as never,
    guestCheckout as never,
    recovery as never,
    config as never,
    ipLimiter as never,
    cookies as never,
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

    const controller = new StorefrontPublicController(
      storefront as never,
      guestCheckout as never,
      recovery as never,
      config as never,
      ipLimiter as never,
      cookies as never,
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
    const controller = new StorefrontPublicController(
      storefront as never,
      guestCheckout as never,
      recovery as never,
      config as never,
      ipLimiter as never,
      cookies as never,
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
