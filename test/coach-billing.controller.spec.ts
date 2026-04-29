import { BadRequestException, HttpException } from '@nestjs/common';
import { CoachBillingController } from '../src/billing/coach-billing.controller';
import {
  StripeApiError,
  StripeApiService,
} from '../src/billing/stripe-api.service';
import type { AuthedRequest } from '../src/auth/auth-request';

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

function makeBilling() {
  return { getCoachBilling: jest.fn() } as any;
}

class TestStripeApi extends StripeApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createBillingPortalSessionImpl: any = jest.fn();
  override async createBillingPortalSession(args: any) {
    return this.createBillingPortalSessionImpl(args);
  }
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

describe('CoachBillingController.portalSession', () => {
  const ORIG = snapshotEnv();
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    delete process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL;
    delete process.env.STRIPE_BILLING_PORTAL_RETURN_URL;
  });
  afterEach(() => {
    restoreEnv(ORIG);
  });

  // --- SDK path (STRIPE_SECRET_KEY set) ---

  it('400 BILLING_NOT_PROVISIONED when no customer id is on subscription or profile', async () => {
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({ subscription: null, profile: null }) as any,
      new TestStripeApi(),
    );
    await expect(
      controller.portalSession({ user: { id: 'c' } } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses stripe_customer_id from CoachSubscription when present', async () => {
    const stripe = new TestStripeApi();
    stripe.createBillingPortalSessionImpl.mockResolvedValue({
      url: 'https://x',
    });
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any,
      stripe,
    );
    const out = await controller.portalSession({ user: { id: 'c' } } as any);
    expect(out).toEqual({ url: 'https://x' });
    expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_S' }),
    );
  });

  it('falls back to CoachProfile.stripe_customer_id when subscription row lacks it', async () => {
    const stripe = new TestStripeApi();
    stripe.createBillingPortalSessionImpl.mockResolvedValue({
      url: 'https://x',
    });
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({
        subscription: { stripe_customer_id: null },
        profile: { stripe_customer_id: 'cus_P' },
      }) as any,
      stripe,
    );
    await controller.portalSession({ user: { id: 'c' } } as any);
    expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_P' }),
    );
  });

  it('uses STRIPE_BILLING_PORTAL_RETURN_URL when set', async () => {
    process.env.STRIPE_BILLING_PORTAL_RETURN_URL =
      'https://staging.example.com/billing';
    const stripe = new TestStripeApi();
    stripe.createBillingPortalSessionImpl.mockResolvedValue({
      url: 'https://x',
    });
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any,
      stripe,
    );
    await controller.portalSession({ user: { id: 'c' } } as any);
    expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://staging.example.com/billing',
      }),
    );
  });

  it('translates StripeApiError into matching HttpException', async () => {
    const stripe = new TestStripeApi();
    stripe.createBillingPortalSessionImpl.mockRejectedValue(
      new StripeApiError('Resource not found', 404, 'resource_missing', 'invalid_request_error'),
    );
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any,
      stripe,
    );
    let thrown: unknown = null;
    try {
      await controller.portalSession({ user: { id: 'c' } } as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(404);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: 'STRIPE_PORTAL_ERROR',
      stripeCode: 'resource_missing',
    });
  });

  it('SDK path takes precedence over the login-link fallback when STRIPE_SECRET_KEY is set', async () => {
    process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
      'https://billing.stripe.com/p/login/test_abc123';
    const stripe = new TestStripeApi();
    stripe.createBillingPortalSessionImpl.mockResolvedValue({
      url: 'https://sdk-session.example.com',
    });
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({ subscription: { stripe_customer_id: 'cus_S' } }) as any,
      stripe,
    );
    const out = await controller.portalSession({ user: { id: 'c' } } as any);
    expect(out).toEqual({ url: 'https://sdk-session.example.com' });
    // The fallback URL should not have leaked into the result.
    expect(stripe.createBillingPortalSessionImpl).toHaveBeenCalled();
  });

  // --- Login-link fallback (STRIPE_SECRET_KEY unset) ---

  const fakeReq = { user: { id: 'coach-123' } } as unknown as AuthedRequest;

  it('returns the login-link fallback when STRIPE_SECRET_KEY is unset and STRIPE_CUSTOMER_PORTAL_LOGIN_URL is a hosted Stripe portal URL', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
      'https://billing.stripe.com/p/login/test_abc123';
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({}) as any,
      new TestStripeApi(),
    );
    const result = await controller.portalSession(fakeReq);
    expect(result).toEqual({
      url: 'https://billing.stripe.com/p/login/test_abc123',
      fallback: true,
      coachId: 'coach-123',
    });
  });

  it('throws STRIPE_NOT_CONFIGURED when neither STRIPE_SECRET_KEY nor STRIPE_CUSTOMER_PORTAL_LOGIN_URL is set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({}) as any,
      new TestStripeApi(),
    );
    await expect(controller.portalSession(fakeReq)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
    });
  });

  it('rejects a non-Stripe URL in STRIPE_CUSTOMER_PORTAL_LOGIN_URL and falls through to STRIPE_NOT_CONFIGURED', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL =
      'https://evil.example.com/login';
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({}) as any,
      new TestStripeApi(),
    );
    await expect(controller.portalSession(fakeReq)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
    });
  });

  it('treats a whitespace-only STRIPE_CUSTOMER_PORTAL_LOGIN_URL as unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL = '   ';
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({}) as any,
      new TestStripeApi(),
    );
    await expect(controller.portalSession(fakeReq)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
