import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StorefrontPublicController } from '../src/storefront/storefront-public.controller';

// A276-P1-2 / A276-P1-3 — controller-scoped tests for the rate-limiter
// hardening and the Referrer-Policy header on the magic-link redirect.
//
// All collaborators are jest mocks; we instantiate the controller
// directly (no Nest TestingModule) because every concern under test is
// a pure-function call on the controller class. The IP limiter mock
// returns `allowed:false` to simulate bucket exhaustion.

const ALLOWED = { allowed: true, count: 1, retryAfterSeconds: 60, limit: 5 };
const DENIED = { allowed: false, count: 6, retryAfterSeconds: 1234, limit: 5 };
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
        expect.objectContaining({ scope: 'resume', maxAttempts: 5 }),
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
      { scope: 'create-intent', maxAttempts: 10 },
      { scope: 'resume', maxAttempts: 5 },
      { scope: 'send-recovery-link', maxAttempts: 3 },
      { scope: 'resume-jwt', maxAttempts: 10 },
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
            options?: { scope?: string; maxAttempts?: number },
          ) => {
            const scope = options?.scope ?? 'default';
            const limit = options?.maxAttempts ?? 5;
            const next = (scopeCounts.get(`${ip}:${scope}`) ?? 0) + 1;
            scopeCounts.set(`${ip}:${scope}`, next);
            return {
              allowed: next <= limit,
              count: next,
              retryAfterSeconds: 1234,
              limit,
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
            options?: { scope?: string; maxAttempts?: number },
          ) => {
            const scope = options?.scope ?? 'default';
            const limit = options?.maxAttempts ?? 5;
            const next = (scopeCounts.get(`${ip}:${scope}`) ?? 0) + 1;
            scopeCounts.set(`${ip}:${scope}`, next);
            return {
              allowed: next <= limit,
              count: next,
              retryAfterSeconds: 1234,
              limit,
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
