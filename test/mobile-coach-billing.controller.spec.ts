import { BadRequestException } from '@nestjs/common';
import { MobileCoachBillingController } from '../src/billing/mobile-coach-billing.controller';
import { StripeApiService } from '../src/billing/stripe-api.service';

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

describe('MobileCoachBillingController', () => {
  const ORIG = process.env.STRIPE_SECRET_KEY;
  const ORIG_RETURN = process.env.STRIPE_BILLING_PORTAL_RETURN_URL;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIG;
    if (ORIG_RETURN === undefined)
      delete process.env.STRIPE_BILLING_PORTAL_RETURN_URL;
    else process.env.STRIPE_BILLING_PORTAL_RETURN_URL = ORIG_RETURN;
  });

  describe('GET /coach/billing/status', () => {
    it('returns "unprovisioned" when no subscription row exists (no fake "active")', async () => {
      const billing = {
        getCoachBilling: jest.fn().mockResolvedValue({ subscription: null, invoices: [] }),
      } as any;
      const controller = new MobileCoachBillingController(
        billing,
        makePrisma({}) as any,
        new TestStripeApi(),
      );
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
      const controller = new MobileCoachBillingController(
        billing,
        makePrisma({}) as any,
        new TestStripeApi(),
      );
      const out = await controller.getStatus({ user: { id: 'c-1' } } as any);
      expect(out.status).toBe('active');
      expect(out.plan_tier).toBe('price_pro');
      expect(out.current_period_end).toEqual(new Date('2026-05-30T00:00:00Z'));
      expect(out.cancel_at_period_end).toBe(false);
    });
  });

  describe('POST /coach/billing/portal-session', () => {
    it('400 STRIPE_NOT_CONFIGURED when STRIPE_SECRET_KEY is unset', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const controller = new MobileCoachBillingController(
        { getCoachBilling: jest.fn() } as any,
        makePrisma({}) as any,
        new TestStripeApi(),
      );
      await expect(
        controller.portalSession({ user: { id: 'c-1' } } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
      });
    });

    it('400 BILLING_NOT_PROVISIONED when no customer id is on subscription or profile', async () => {
      const controller = new MobileCoachBillingController(
        { getCoachBilling: jest.fn() } as any,
        makePrisma({ subscription: null, profile: null }) as any,
        new TestStripeApi(),
      );
      await expect(
        controller.portalSession({ user: { id: 'c-1' } } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('uses stripe_customer_id from CoachSubscription when present', async () => {
      const stripe = new TestStripeApi();
      stripe.createBillingPortalSessionImpl.mockResolvedValue({ url: 'https://x' });
      const controller = new MobileCoachBillingController(
        { getCoachBilling: jest.fn() } as any,
        makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any,
        stripe,
      );
      const out = await controller.portalSession({ user: { id: 'c-1' } } as any);
      expect(out).toEqual({ url: 'https://x' });
      expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_S' }),
      );
    });

    it('falls back to CoachProfile.stripe_customer_id when subscription row lacks it', async () => {
      const stripe = new TestStripeApi();
      stripe.createBillingPortalSessionImpl.mockResolvedValue({ url: 'https://y' });
      const controller = new MobileCoachBillingController(
        { getCoachBilling: jest.fn() } as any,
        makePrisma({
          subscription: { stripe_customer_id: null },
          profile: { stripe_customer_id: 'cus_P' },
        }) as any,
        stripe,
      );
      const out = await controller.portalSession({ user: { id: 'c-1' } } as any);
      expect(out).toEqual({ url: 'https://y' });
      expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_P' }),
      );
    });
  });
});
