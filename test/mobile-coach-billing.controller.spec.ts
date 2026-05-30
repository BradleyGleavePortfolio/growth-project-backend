import { BadRequestException } from '@nestjs/common';
import { MobileCoachBillingController } from '../src/billing/mobile-coach-billing.controller';
import { BillingService } from '../src/billing/billing.service';
import { StripeApiService } from '../src/billing/stripe-api.service';
import type { AuthedRequest } from '../src/auth/auth-request';

// Pins the mobile-app billing surface (PR #66 contract).
// Routes:
//   GET  /coach/billing/status         — compact billing summary
//   POST /coach/billing/portal-session — Customer Portal redirect

function makePrisma(opts: {
  subscription?: { stripe_customer_id?: string | null } | null;
  profile?: { stripe_customer_id?: string | null } | null;
}) {
  return {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.subscription ?? null),
    },
    coachProfile: {
      findUnique: jest.fn().mockResolvedValue(opts.profile ?? null),
    },
  };
}

class TestStripeApi extends StripeApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createBillingPortalSessionImpl: any = jest.fn();
  override async createBillingPortalSession(args: any) {
    return this.createBillingPortalSessionImpl(args);
  }
}

// B1 — portal-session logic now lives in BillingService.createCoachPortalSession;
// the controller delegates. Build a real BillingService over the stub prisma +
// TestStripeApi so the portal-session tests exercise the full path. `billing`
// lets a test inject a custom BillingService (used by the getStatus tests,
// which stub getCoachBilling directly).
function makeController(
  prisma: any,
  stripe: StripeApiService,
  billingOverride?: any,
) {
  const billing =
    billingOverride ??
    new BillingService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      { write: jest.fn(), list: jest.fn() } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stripe,
    );
  return new MobileCoachBillingController(billing);
}

const STRIPE_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_CUSTOMER_PORTAL_LOGIN_URL',
  'STRIPE_BILLING_PORTAL_RETURN_URL',
] as const;

function snapshotEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const k of STRIPE_VARS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of STRIPE_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
}

describe('MobileCoachBillingController', () => {
  const ORIG = snapshotEnv();
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    delete process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL;
    delete process.env.STRIPE_BILLING_PORTAL_RETURN_URL;
  });
  afterEach(() => {
    restoreEnv(ORIG);
  });

  describe('GET /coach/billing/status', () => {
    it('returns "unprovisioned" when no subscription row exists (no fake "active")', async () => {
      const billing = {
        getCoachBilling: jest.fn().mockResolvedValue({ subscription: null, invoices: [] }),
      } as any;
      const controller = makeController(makePrisma({}) as any, new TestStripeApi(), billing);
      const out = await controller.getStatus({ user: { id: 'c-1' } } as any);
      expect(out).toEqual({
        status: 'unprovisioned',
        plan_tier: null,
        current_period_end: null,
        cancel_at_period_end: false,
        trial_end: null,
      });
    });

    it('mirrors a real subscription row into the compact mobile shape', async () => {
      const billing = {
        getCoachBilling: jest.fn().mockResolvedValue({
          subscription: {
            status: 'active',
            stripe_price_id: 'price_pro',
            current_period_end: new Date('2026-05-30T00:00:00Z'),
            trial_end: null,
            cancel_at_period_end: false,
          },
          invoices: [],
        }),
      } as any;
      const controller = makeController(makePrisma({}) as any, new TestStripeApi(), billing);
      const out = await controller.getStatus({ user: { id: 'c-1' } } as any);
      expect(out.status).toBe('active');
      expect(out.plan_tier).toBe('price_pro');
      expect(out.current_period_end).toEqual(new Date('2026-05-30T00:00:00Z'));
      expect(out.cancel_at_period_end).toBe(false);
    });
  });

  describe('POST /coach/billing/portal-session', () => {
    const fakeReq = { user: { id: 'coach-123' } } as unknown as AuthedRequest;

    it('400 STRIPE_NOT_CONFIGURED when STRIPE_SECRET_KEY is unset and no login-link fallback', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const controller = makeController(makePrisma({}) as any, new TestStripeApi());
      await expect(
        controller.portalSession({ user: { id: 'c-1' } } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
      });
    });

    it('returns the login-link fallback when STRIPE_SECRET_KEY is unset and STRIPE_CUSTOMER_PORTAL_LOGIN_URL is a hosted Stripe portal URL', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
        'https://billing.stripe.com/p/login/test_abc123';
      const controller = makeController(makePrisma({}) as any, new TestStripeApi());
      const result = await controller.portalSession(fakeReq);
      expect(result).toEqual({
        url: 'https://billing.stripe.com/p/login/test_abc123',
        fallback: true,
        coachId: 'coach-123',
      });
    });

    it('rejects a non-Stripe URL in STRIPE_CUSTOMER_PORTAL_LOGIN_URL and falls through to STRIPE_NOT_CONFIGURED', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
        'https://evil.example.com/login';
      const controller = makeController(makePrisma({}) as any, new TestStripeApi());
      await expect(controller.portalSession(fakeReq)).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
      });
    });

    it('treats a whitespace-only STRIPE_CUSTOMER_PORTAL_LOGIN_URL as unset', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL = '   ';
      const controller = makeController(makePrisma({}) as any, new TestStripeApi());
      await expect(controller.portalSession(fakeReq)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('SDK path takes precedence over the login-link fallback when STRIPE_SECRET_KEY is set', async () => {
      process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
        'https://billing.stripe.com/p/login/test_abc123';
      const stripe = new TestStripeApi();
      stripe.createBillingPortalSessionImpl.mockResolvedValue({
        url: 'https://sdk-session.example.com',
      });
      const controller = makeController(makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any, stripe);
      const out = await controller.portalSession(fakeReq);
      expect(out).toEqual({ url: 'https://sdk-session.example.com' });
      expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalled();
    });

    it('400 BILLING_NOT_PROVISIONED when no customer id is on subscription or profile', async () => {
      const controller = makeController(makePrisma({ subscription: null, profile: null }) as any, new TestStripeApi());
      await expect(
        controller.portalSession({ user: { id: 'c-1' } } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('uses stripe_customer_id from CoachSubscription when present', async () => {
      const stripe = new TestStripeApi();
      stripe.createBillingPortalSessionImpl.mockResolvedValue({ url: 'https://x' });
      const controller = makeController(makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any, stripe);
      const out = await controller.portalSession({ user: { id: 'c-1' } } as any);
      expect(out).toEqual({ url: 'https://x' });
      expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_S' }),
      );
    });

    it('falls back to CoachProfile.stripe_customer_id when subscription row lacks it', async () => {
      const stripe = new TestStripeApi();
      stripe.createBillingPortalSessionImpl.mockResolvedValue({ url: 'https://y' });
      const controller = makeController(makePrisma({
          subscription: { stripe_customer_id: null },
          profile: { stripe_customer_id: 'cus_P' },
        }) as any, stripe);
      const out = await controller.portalSession({ user: { id: 'c-1' } } as any);
      expect(out).toEqual({ url: 'https://y' });
      expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_P' }),
      );
    });
  });
});
