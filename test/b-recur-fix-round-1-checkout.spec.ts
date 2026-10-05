// B-RECUR-BE fix round 1 (agent 114) — gaps closed in the native
// subscription checkout (#654). Every case here failed before this round:
//   R1-1 a trial attempt whose $0 trial invoice was paid (row status
//        'trialing', no card yet) answered SUBSCRIPTION_ALREADY_ACTIVE and
//        could never be reused, and stopped holding the client's one trial;
//   R1-2 a client who already holds the package through an invite / free
//        grant (or a one-time purchase) could be charged for it again;
//   R1-3 a recurring $0 package answered PACKAGE_NOT_FOUND instead of
//        PACKAGE_IS_FREE; a combo with a $0 recurring part was unsellable;
//   R1-4 a change of a combo's one-time price was invisible to the price
//        check and to the reuse of an open attempt;
//   R1-5 a same-key retry of an expired attempt spun 5 s and answered
//        "still being set up" forever; of a paid attempt it handed back a
//        spent PaymentIntent secret;
//   R1-6 an abandoned trial attempt older than Stripe's 23 h window stayed
//        trialing on Stripe until the trial ended;
// B-RECUR5B-117 (agent 117) — moved unchanged from
// test/b-recur-fix-round-1.spec.ts (#680) for size; R1-7 and R1-8
// (webhooks) stay there.
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { isRecurringPackage } from '../src/checkout/checkout.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const PKG2 = '44444444-4444-4444-8444-444444444444';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOUR = 3600 * 1000;

function recurringPkg(over: Record<string, unknown> = {}) {
  return {
    id: PKG,
    coach_id: COACH,
    name: 'Coaching',
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    stripe_price_id: 'price_rec_4900',
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    ...over,
  };
}

const COMBO = {
  billing_type: 'one_time',
  interval: null,
  interval_count: null,
  amount_cents: 9900,
  stripe_price_id: 'price_one_9900',
  recurring_amount_cents: 4900,
  recurring_interval: 'month',
  recurring_interval_count: 1,
  recurring_stripe_price_id: 'price_rec_4900',
};

function setup(pkgOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const helpers = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(recurringPkg(pkgOver));
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const packages: any = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
  };
  const state: any = { ready: true };
  const feePolicy: any = {
    planFor: jest.fn(async () => ({
      application_fee_cents: 98,
      head_coach_split_cents: 0,
      head_coach_id: null,
    })),
  };
  const checkout: any = helpers;
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
  return { prisma, stripe, helpers, svc };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err: any) {
    return { status: err.getStatus?.(), body: err.getResponse?.() };
  }
  throw new Error('expected a coded error');
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});

describe('R1-1 a trial attempt after its $0 trial invoice (status trialing, no card)', () => {
  it('is reused for a new key, not answered SUBSCRIPTION_ALREADY_ACTIVE', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    // invoice.paid ($0 trial invoice) landed: row mirrors Stripe 'trialing', no access.
    prisma._purchases[0].status = 'trialing';
    const again = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(again.reused).toBe(true);
    expect(again.mode).toBe('setup');
    expect(again.subscription_id).toBe('sub_1');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('still holds the one trial with this coach for another package', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    prisma._packages.push(recurringPkg({ id: PKG2, trial_days: 14, stripe_price_id: 'price_b' }));
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    prisma._purchases[0].status = 'trialing';
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG2, idempotency_key: KEY2 });
    expect(stripe.createSubscription).toHaveBeenCalledTimes(2);
    expect(stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBeUndefined();
  });

  it('a trial that STARTED (card saved, trial_started_at) is a live plan -> 409', async () => {
    const { svc, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    Object.assign(prisma._purchases[0], {
      status: 'trialing',
      entitlement_active: true,
      trial_started_at: new Date(),
    });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    );
    expect(err.status).toBe(409);
    expect(err.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
  });
});

describe('R1-2 the package is already included for this client', () => {
  it.each([
    ['invite_grant:free', 'invite'],
    ['invite_grant:prepaid', 'invite'],
    ['free_package_claim', 'free_claim'],
    [null, 'purchase'],
  ])('active %s row -> 409 PACKAGE_ALREADY_INCLUDED, no Stripe object', async (source, kind) => {
    const { svc, stripe, helpers, prisma } = setup();
    prisma._purchases.push({
      id: 'grant-1',
      client_user_id: CLIENT,
      coach_user_id: COACH,
      package_id: PKG,
      amount_cents: 0,
      billing_type: 'recurring',
      status: 'active',
      entitlement_active: true,
      stripe_subscription_id: null,
      access_expires_at: null,
      source,
      idempotency_key: `grant-${CLIENT}`,
      stripe_checkout_session_id: 'grant_x',
      created_at: new Date(),
    });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(409);
    expect(err.body).toEqual(
      expect.objectContaining({
        code: 'PACKAGE_ALREADY_INCLUDED',
        error: 'PACKAGE_ALREADY_INCLUDED',
        purchase_id: 'grant-1',
        included_by: kind,
      }),
    );
    expect(err.body.message).not.toMatch(/!|went wrong|please try again/i);
    expect(stripe.createSubscription).not.toHaveBeenCalled();
    expect(helpers.ensureCustomer).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(1);
  });

  it('an expired or revoked grant does not block a subscription', async () => {
    const { svc, stripe, prisma } = setup();
    prisma._purchases.push(
      {
        id: 'grant-old',
        client_user_id: CLIENT,
        coach_user_id: COACH,
        package_id: PKG,
        amount_cents: 0,
        billing_type: 'recurring',
        status: 'active',
        entitlement_active: true,
        stripe_subscription_id: null,
        access_expires_at: new Date(Date.now() - HOUR),
        source: 'invite_grant:free',
        idempotency_key: 'g1',
        stripe_checkout_session_id: 'g1',
        created_at: new Date(),
      },
      {
        id: 'grant-revoked',
        client_user_id: CLIENT,
        coach_user_id: COACH,
        package_id: PKG,
        amount_cents: 0,
        billing_type: 'recurring',
        status: 'revoked',
        entitlement_active: false,
        stripe_subscription_id: null,
        access_expires_at: null,
        source: 'invite_grant:free',
        idempotency_key: 'g2',
        stripe_checkout_session_id: 'g2',
        created_at: new Date(),
      },
    );
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('R1-3 $0 renewing prices', () => {
  it('a recurring $0 package -> 400 PACKAGE_IS_FREE (claim it, no card), no Stripe object', async () => {
    const { svc, stripe, helpers } = setup({ amount_cents: 0 });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(400);
    expect(err.body.code).toBe('PACKAGE_IS_FREE');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
    expect(helpers.ensureCustomer).not.toHaveBeenCalled();
  });

  it('a one-time package whose recurring part is $0 is a one-time sale, not a subscription', () => {
    expect(
      isRecurringPackage({
        billing_type: 'one_time',
        recurring_amount_cents: 0,
        recurring_interval: 'month',
      }),
    ).toBe(false);
    expect(
      isRecurringPackage({
        billing_type: 'one_time',
        recurring_amount_cents: 4900,
        recurring_interval: 'month',
      }),
    ).toBe(true);
  });
});

describe('R1-4 a combo package whose one-time price changed', () => {
  it('expected_one_time_cents mismatch -> 409 PACKAGE_PRICE_CHANGED with both current prices', async () => {
    const { svc, stripe } = setup(COMBO);
    const input = {
      package_id: PKG,
      idempotency_key: KEY1,
      expected_amount_cents: 4900,
      expected_one_time_cents: 7900,
    };
    const err = await codeOf(svc.createSubscriptionIntent(CLIENT, input));
    expect(err.status).toBe(409);
    expect(err.body).toEqual(
      expect.objectContaining({
        code: 'PACKAGE_PRICE_CHANGED',
        amount_cents: 4900,
        one_time_cents: 9900,
        first_charge_cents: 14800,
        currency: 'usd',
      }),
    );
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it("an open attempt whose first invoice no longer matches today's charge is retired, not reused", async () => {
    const { svc, stripe, prisma } = setup(COMBO);
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    // The first invoice was built at the old one-time price.
    stripe._subs.get('sub_1').latest_invoice.amount_due = 7900 + 4900;
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(prisma._purchases[0].status).toBe('expired');
    expect(out.subscription_id).toBe('sub_2');
    expect(out.reused).toBe(false);
  });

  it("an open attempt whose first invoice matches today's charge is reused", async () => {
    const { svc, stripe } = setup(COMBO);
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._subs.get('sub_1').latest_invoice.amount_due = 9900 + 4900;
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(out.reused).toBe(true);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe('R1-5 same-key retry of an attempt that is over', () => {
  it('expired attempt -> 409 SUBSCRIPTION_ATTEMPT_EXPIRED at once, no Stripe write', async () => {
    const { svc, stripe, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    Object.assign(prisma._purchases[0], {
      status: 'expired',
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
    });
    const started = Date.now();
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err.status).toBe(409);
    expect(err.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(err.body.message).toMatch(/Nothing was charged/);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('paid attempt -> 409 SUBSCRIPTION_ALREADY_ACTIVE, never the spent PaymentIntent secret', async () => {
    const { svc, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    Object.assign(prisma._purchases[0], { status: 'active', entitlement_active: true });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(409);
    expect(err.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(JSON.stringify(err.body)).not.toMatch(/secret/);
  });
});

describe('R1-6 abandoned trial attempts older than 23 h', () => {
  // B-679-1 (current rule): an open trial attempt holds the one trial with
  // this coach at any age until Stripe shows it ended or never got a card.
  it('trialing without a card on Stripe -> canceled and marked expired; the next plan of the coach gets the trial', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    prisma._packages.push(recurringPkg({ id: PKG2, trial_days: 7, stripe_price_id: 'price_b' }));
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const abandoned = prisma._purchases[0];
    abandoned.created_at = new Date(Date.now() - 30 * HOUR);
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG2, idempotency_key: KEY2 });
    expect(stripe.cancelSubscription).toHaveBeenCalledWith(abandoned.stripe_subscription_id);
    expect(abandoned.status).toBe('expired');
    expect(abandoned.stripe_client_secret).toBeNull();
    expect(prisma._purchases[1].trial_days).toBe(7);
  });

  it('trialing with a saved card -> left alone, and it keeps holding the one trial with this coach', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    prisma._packages.push(recurringPkg({ id: PKG2, trial_days: 7, stripe_price_id: 'price_b' }));
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const carded = prisma._purchases[0];
    carded.created_at = new Date(Date.now() - 30 * HOUR);
    // This one saved its card; only its webhook is late. Never cancel it.
    // B-RECUR5B-117: the attach also clears the trial's cancel at period end (#679 round 5).
    Object.assign(stripe._subs.get(carded.stripe_subscription_id), { default_payment_method: 'pm_card', cancel_at_period_end: false });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG2, idempotency_key: KEY3 });
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith(carded.stripe_subscription_id);
    expect(carded.status).toBe('pending');
    expect(prisma._purchases[1].trial_days).toBeNull();
  });

  it('a Stripe error while retiring never blocks the checkout: the open attempt is reused, no second subscription', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    prisma._purchases[0].created_at = new Date(Date.now() - 30 * HOUR);
    stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(new Error('stripe down'));
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});
