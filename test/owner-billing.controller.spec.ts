import { BadRequestException, HttpException } from '@nestjs/common';
import { OwnerBillingController } from '../src/billing/owner-billing.controller';
import {
  StripeApiError,
  StripeApiService,
} from '../src/billing/stripe-api.service';

class TestStripeApi extends StripeApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createCustomerImpl: any = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createSubscriptionImpl: any = jest.fn();
  override async createCustomer(args: any) {
    return this.createCustomerImpl(args);
  }
  override async createSubscription(args: any) {
    return this.createSubscriptionImpl(args);
  }
}

interface PrismaOptions {
  user?: { id: string; role: string; email: string; name: string } | null;
  profile?: { stripe_customer_id?: string | null } | null;
  existingSub?: { status: string } | null;
}

function makePrisma(opts: PrismaOptions) {
  const updates: any[] = [];
  const upserts: any[] = [];
  return {
    _profileUpdates: updates,
    _subUpserts: upserts,
    user: {
      findUnique: jest.fn().mockResolvedValue(opts.user ?? null),
    },
    coachProfile: {
      findUnique: jest.fn().mockResolvedValue(opts.profile ?? null),
      update: jest.fn(async ({ data }: any) => {
        updates.push(data);
        return { ...(opts.profile as any), ...data };
      }),
    },
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.existingSub ?? null),
      upsert: jest.fn(async (args: any) => {
        upserts.push(args);
        return { ...args.create };
      }),
    },
  } as any;
}

const VALID_COACH = {
  id: 'coach-1',
  role: 'coach',
  email: 'c@x.io',
  name: 'Coach One',
};

describe('OwnerBillingController.startSubscription', () => {
  const ORIG_KEY = process.env.STRIPE_SECRET_KEY;
  const ORIG_PRICE = process.env.STRIPE_PRICE_ID_FITNESS;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_y';
    process.env.STRIPE_PRICE_ID_FITNESS = 'price_flat_300';
  });
  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIG_KEY;
    if (ORIG_PRICE === undefined) delete process.env.STRIPE_PRICE_ID_FITNESS;
    else process.env.STRIPE_PRICE_ID_FITNESS = ORIG_PRICE;
  });

  it('rejects non-coach target user', async () => {
    const controller = new OwnerBillingController(
      makePrisma({ user: { ...VALID_COACH, role: 'student' } }),
      new TestStripeApi(),
    );
    await expect(
      controller.startSubscription(
        { user: { id: 'o' } } as any,
        'coach-1',
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 STRIPE_NOT_CONFIGURED when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const controller = new OwnerBillingController(
      makePrisma({ user: VALID_COACH, profile: {} }),
      new TestStripeApi(),
    );
    await expect(
      controller.startSubscription(
        { user: { id: 'o' } } as any,
        'coach-1',
        {},
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'STRIPE_NOT_CONFIGURED' }),
    });
  });

  it('400 STRIPE_PRICE_NOT_CONFIGURED when STRIPE_PRICE_ID_FITNESS is unset', async () => {
    delete process.env.STRIPE_PRICE_ID_FITNESS;
    const controller = new OwnerBillingController(
      makePrisma({ user: VALID_COACH, profile: {} }),
      new TestStripeApi(),
    );
    await expect(
      controller.startSubscription(
        { user: { id: 'o' } } as any,
        'coach-1',
        {},
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'STRIPE_PRICE_NOT_CONFIGURED',
      }),
    });
  });

  it.each([
    ['negative', -1],
    ['too large', 365],
    ['fractional', 7.5],
  ])('rejects invalid trialDays (%s)', async (_label, value) => {
    const controller = new OwnerBillingController(
      makePrisma({ user: VALID_COACH, profile: {} }),
      new TestStripeApi(),
    );
    await expect(
      controller.startSubscription(
        { user: { id: 'o' } } as any,
        'coach-1',
        { trialDays: value as number },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'INVALID_TRIAL_DAYS' }),
    });
  });

  it('refuses when an active subscription already exists', async () => {
    const controller = new OwnerBillingController(
      makePrisma({
        user: VALID_COACH,
        profile: {},
        existingSub: { status: 'active' },
      }),
      new TestStripeApi(),
    );
    await expect(
      controller.startSubscription(
        { user: { id: 'o' } } as any,
        'coach-1',
        {},
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'SUBSCRIPTION_ALREADY_ACTIVE',
      }),
    });
  });

  it('creates customer + subscription, mirrors immediately, sends correct idempotency keys', async () => {
    const prisma = makePrisma({
      user: VALID_COACH,
      profile: { stripe_customer_id: null },
      existingSub: null,
    });
    const stripe = new TestStripeApi();
    stripe.createCustomerImpl.mockResolvedValue({ id: 'cus_NEW' });
    stripe.createSubscriptionImpl.mockResolvedValue({
      id: 'sub_NEW',
      status: 'trialing',
      current_period_end: 1764554400,
      trial_end: 1764000000,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_flat_300' } }] },
    });
    const controller = new OwnerBillingController(prisma, stripe);
    const out = await controller.startSubscription(
      { user: { id: 'owner-1' } } as any,
      'coach-1',
      { plan: 'flat_300', trialDays: 14 },
    );
    expect(out.stripe_customer_id).toBe('cus_NEW');
    expect(out.stripe_subscription_id).toBe('sub_NEW');
    expect(out.status).toBe('trialing');

    expect(stripe.createCustomerImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'c@x.io',
        idempotencyKey: 'coach_customer_coach-1',
        metadata: { coach_id: 'coach-1' },
      }),
    );
    expect(stripe.createSubscriptionImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_NEW',
        priceId: 'price_flat_300',
        trialPeriodDays: 14,
        idempotencyKey: 'coach_subscription_coach-1_price_flat_300',
        metadata: expect.objectContaining({
          coach_id: 'coach-1',
          plan_tier: 'flat_300',
          started_by_owner_id: 'owner-1',
        }),
      }),
    );
    // CoachSubscription mirror written
    expect(prisma._subUpserts).toHaveLength(1);
    expect(prisma._subUpserts[0].create.stripe_subscription_id).toBe('sub_NEW');
    // CoachProfile mirror written, including the enum-mapped status
    expect(prisma._profileUpdates).toHaveLength(1);
    expect(prisma._profileUpdates[0].subscription_status).toBe('trialing');
  });

  it('skips customer creation when CoachProfile already has a customer id', async () => {
    const prisma = makePrisma({
      user: VALID_COACH,
      profile: { stripe_customer_id: 'cus_EXISTING' },
    });
    const stripe = new TestStripeApi();
    stripe.createSubscriptionImpl.mockResolvedValue({
      id: 'sub_X',
      status: 'active',
      current_period_end: 1764554400,
      items: { data: [{ price: { id: 'price_flat_300' } }] },
    });
    const controller = new OwnerBillingController(prisma, stripe);
    await controller.startSubscription(
      { user: { id: 'owner-1' } } as any,
      'coach-1',
      {},
    );
    expect(stripe.createCustomerImpl).not.toHaveBeenCalled();
    expect(stripe.createSubscriptionImpl).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_EXISTING' }),
    );
  });

  it('translates StripeApiError into matching HttpException with stripeCode', async () => {
    const prisma = makePrisma({
      user: VALID_COACH,
      profile: { stripe_customer_id: 'cus_E' },
    });
    const stripe = new TestStripeApi();
    stripe.createSubscriptionImpl.mockRejectedValue(
      new StripeApiError('Card declined', 402, 'card_declined', 'card_error'),
    );
    const controller = new OwnerBillingController(prisma, stripe);
    let thrown: unknown = null;
    try {
      await controller.startSubscription(
        { user: { id: 'owner-1' } } as any,
        'coach-1',
        {},
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(402);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      error: 'STRIPE_START_FAILED',
      stripeCode: 'card_declined',
    });
  });
});
