import { BadRequestException, HttpException } from '@nestjs/common';
import { CoachBillingController } from '../src/billing/coach-billing.controller';
import {
  StripeApiError,
  StripeApiService,
} from '../src/billing/stripe-api.service';

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

describe('CoachBillingController.portalSession', () => {
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

  it('400 STRIPE_NOT_CONFIGURED when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const controller = new CoachBillingController(
      makeBilling(),
      makePrisma({}) as any,
      new TestStripeApi(),
    );
    await expect(
      controller.portalSession({ user: { id: 'c' } } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
    });
  });

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
});
