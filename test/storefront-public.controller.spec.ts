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
      expect(ipLimiter.checkAndIncrement).toHaveBeenCalledWith('203.0.113.7');
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
