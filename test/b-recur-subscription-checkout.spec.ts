// B-RECUR (agent 113, OR-113-1 / OR-113-2) — native subscription checkout.
// Every contract point of POST /v1/checkout/subscription-intent, the plan
// read/resume routes, and the payment-intent refusal of renewing plans.
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const PKG2 = '44444444-4444-4444-8444-444444444444';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  return { prisma, stripe, helpers, svc, state };
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

describe('POST /v1/checkout/subscription-intent — recurring package', () => {
  it('creates ONE platform subscription on_behalf_of the coach and returns PaymentSheet params', async () => {
    const { svc, stripe, prisma } = setup();
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    const args = stripe.createSubscription.mock.calls[0][0];
    expect(args.onBehalfOf).toBe('acct_coach');
    expect(args.recurringPriceId).toBe('price_rec_4900');
    expect(args.oneTimePriceId).toBeUndefined();
    expect(args.trialPeriodDays).toBeUndefined();
    expect(args.metadata).toEqual(
      expect.objectContaining({
        tgp_client_user_id: CLIENT,
        tgp_coach_user_id: COACH,
        tgp_package_id: PKG,
        tgp_fee_mechanism: 'separate_charge_transfer',
      }),
    );
    expect(args).not.toHaveProperty('transferData');
    expect(args).not.toHaveProperty('applicationFeePercent');
    expect(out).toEqual(
      expect.objectContaining({
        mode: 'payment',
        client_secret: 'pi_1_secret_x',
        customer_id: 'cus_1111',
        publishable_key: 'pk_test_example',
        subscription_id: 'sub_1',
        status: 'incomplete',
        reused: false,
      }),
    );
    expect(out.ephemeral_key).toMatch(/^ek_/);
    expect(out.purchase_id).toBe(prisma._purchases[0].id);
    expect(out.plan).toEqual(
      expect.objectContaining({
        amount_cents: 4900,
        interval: 'month',
        interval_count: 1,
        first_charge_cents: 4900,
      }),
    );
    // Entitlement is never granted by the create route.
    expect(prisma._purchases[0]).toEqual(
      expect.objectContaining({
        status: 'pending',
        entitlement_active: false,
        billing_type: 'recurring',
        stripe_subscription_id: 'sub_1',
        stripe_payment_intent_id: 'pi_1',
      }),
    );
  });

  it('one-time + recurring package: first invoice carries the one-time price, renewals the recurring one', async () => {
    const { svc, stripe } = setup({
      billing_type: 'one_time',
      amount_cents: 9900,
      interval: null,
      stripe_price_id: 'price_one_9900',
      recurring_amount_cents: 4900,
      recurring_interval: 'month',
      recurring_interval_count: 1,
    });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    const args = stripe.createSubscription.mock.calls[0][0];
    expect(args.recurringPriceId).toBe('price_rec_4900');
    expect(args.oneTimePriceId).toBe('price_one_9900');
    expect(out.plan).toEqual(
      expect.objectContaining({
        amount_cents: 4900,
        one_time_cents: 9900,
        first_charge_cents: 14800,
        interval: 'month',
      }),
    );
  });

  it('same Idempotency-Key -> same subscription, no second Stripe write (retry after timeout / double tap)', async () => {
    const { svc, stripe, prisma } = setup();
    const a = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    const b = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    expect(b.subscription_id).toBe(a.subscription_id);
    expect(b.client_secret).toBe(a.client_secret);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(prisma._purchases).toHaveLength(1);
  });

  it('two concurrent taps with DIFFERENT keys share one subscription (per-(client, coach) lock)', async () => {
    const { svc, stripe, prisma } = setup();
    const [a, b] = await Promise.all([
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    ]);
    expect(a.subscription_id).toBe(b.subscription_id);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._locks[0]).toBe(`${CLIENT}:${COACH}`);
  });

  it('an abandoned open attempt is reused for a new key (no orphan incomplete subscriptions)', async () => {
    const { svc, stripe, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const again = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(again.reused).toBe(true);
    expect(again.subscription_id).toBe('sub_1');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(1);
  });

  it('a stale open attempt (price changed) is canceled on Stripe and marked expired before a new one', async () => {
    const { svc, stripe, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(prisma._purchases[0].status).toBe('expired');
    expect(prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(out.subscription_id).toBe('sub_2');
    expect(out.plan.amount_cents).toBe(5900);
  });

  it('an expired attempt on Stripe (incomplete_expired) is retired, not reused', async () => {
    const { svc, stripe, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._subs.get('sub_1').status = 'incomplete_expired';
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(prisma._purchases[0].status).toBe('expired');
    expect(out.subscription_id).toBe('sub_2');
  });

  it('an existing active subscription to the package answers 409 SUBSCRIPTION_ALREADY_ACTIVE, no Stripe call', async () => {
    const { svc, stripe, prisma } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    Object.assign(prisma._purchases[0], {
      status: 'active',
      entitlement_active: true,
      cancel_at_period_end: true,
    });
    stripe.createSubscription.mockClear();
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    );
    expect(err.status).toBe(409);
    expect(err.body).toEqual(
      expect.objectContaining({
        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
        purchase_id: prisma._purchases[0].id,
        cancel_at_period_end: true,
      }),
    );
    expect(err.body.message).toMatch(/Keep it from Your plan/);
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it('an attempt paid a moment ago (Stripe active, webhook pending) answers 409, never a second subscription', async () => {
    const { svc, stripe } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._subs.get('sub_1').status = 'active';
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    );
    expect(err.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('a Stripe failure frees the key; the same-key retry creates the subscription once', async () => {
    const { svc, stripe, prisma } = setup();
    stripe.createEphemeralKey.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    ).rejects.toThrow('socket hang up');
    expect(prisma._purchases).toHaveLength(0);
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    // Stripe's Idempotency-Key collapsed the retry onto the first subscription.
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe._subs.size).toBe(1);
  });

  it('price shown in the app differs -> 409 PACKAGE_PRICE_CHANGED with the current price, no Stripe call', async () => {
    const { svc, stripe } = setup();
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, {
        package_id: PKG,
        idempotency_key: KEY1,
        expected_amount_cents: 3900,
      }),
    );
    expect(err.status).toBe(409);
    expect(err.body).toEqual(
      expect.objectContaining({ code: 'PACKAGE_PRICE_CHANGED', amount_cents: 4900 }),
    );
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['unpublished', { published_at: null }],
    ['archived', { archived_at: new Date() }],
    ['another coach', { coach_id: '99999999-9999-4999-8999-999999999999' }],
  ])('%s package -> 404 PACKAGE_NOT_FOUND, no Stripe call', async (_n, over) => {
    const { svc, stripe } = setup(over);
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(404);
    expect(err.body.code).toBe('PACKAGE_NOT_FOUND');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it('a free ($0) one-time package never creates Stripe objects', async () => {
    const { svc, stripe, helpers } = setup({
      billing_type: 'one_time',
      amount_cents: 0,
      interval: null,
    });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.body.code).toBe('PACKAGE_IS_FREE');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
    expect(helpers.ensureCustomer).not.toHaveBeenCalled();
  });

  it('a one-time package is refused with ONE_TIME_REQUIRES_PAYMENT_INTENT', async () => {
    const { svc, stripe } = setup({ billing_type: 'one_time', interval: null });
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.body.code).toBe('ONE_TIME_REQUIRES_PAYMENT_INTENT');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it('payments not configured -> 503 CONNECT_NOT_CONFIGURED in plain words', async () => {
    const { svc, state } = setup();
    state.ready = false;
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(503);
    expect(err.body.code).toBe('CONNECT_NOT_CONFIGURED');
    expect(err.body.message).not.toMatch(/\bwe\b|\bus\b|!/i);
  });

  it('a coach without payouts -> 409 COACH_NOT_PAYOUT_READY before any Stripe write', async () => {
    const { svc, stripe, prisma } = setup();
    prisma._accounts[0].charges_enabled = false;
    const err = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.body.code).toBe('COACH_NOT_PAYOUT_READY');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });
});

describe('free trials (OR-113-2)', () => {
  it('trial package -> trial_period_days, card collected up front in PaymentSheet setup mode', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    expect(stripe.createSubscription.mock.calls[0][0].trialPeriodDays).toBe(7);
    expect(out.mode).toBe('setup');
    expect(out.client_secret).toBe('seti_1_secret_x');
    expect(out.status).toBe('trialing');
    expect(out.plan).toEqual(
      expect.objectContaining({ trial_days: 7, first_charge_cents: 0, amount_cents: 4900 }),
    );
    expect(out.plan.trial_ends_at).not.toBeNull();
    expect(prisma._purchases[0]).toEqual(
      expect.objectContaining({ trial_days: 7, entitlement_active: false, trial_started_at: null }),
    );
  });

  it('trial already used with this coach -> a normal paid subscription, no trial', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    prisma._purchases.push({
      id: 'old',
      client_user_id: CLIENT,
      coach_user_id: COACH,
      package_id: PKG2,
      billing_type: 'recurring',
      status: 'canceled',
      entitlement_active: false,
      trial_days: 7,
      trial_started_at: new Date('2026-08-01'),
      idempotency_key: 'sub-old',
      stripe_checkout_session_id: 'sub_old',
      created_at: new Date('2026-08-01'),
    });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    expect(stripe.createSubscription.mock.calls[0][0].trialPeriodDays).toBeUndefined();
    expect(out.mode).toBe('payment');
    expect(out.plan.trial_days).toBe(0);
    expect(out.plan.first_charge_cents).toBe(4900);
  });

  it('an open trial attempt on another package of the same coach holds the one trial (race)', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    prisma._packages.push(
      recurringPkg({ id: PKG2, trial_days: 14, stripe_price_id: 'price_rec_b' }),
    );
    await Promise.all([
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG2, idempotency_key: KEY2 }),
    ]);
    const trials = stripe.createSubscription.mock.calls.filter((c: any[]) => c[0].trialPeriodDays);
    expect(trials).toHaveLength(1);
  });

  it('a combo (one-time + recurring) package never starts a trial', async () => {
    const { svc, stripe } = setup({
      billing_type: 'one_time',
      amount_cents: 9900,
      interval: null,
      recurring_amount_cents: 4900,
      recurring_interval: 'month',
      trial_days: 7,
    });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(stripe.createSubscription.mock.calls[0][0].trialPeriodDays).toBeUndefined();
  });

  it('while confirming, a saved trial card becomes the subscription default (webhook then grants)', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    Object.assign(stripe._subs.get('sub_1').pending_setup_intent, {
      status: 'succeeded',
      payment_method: 'pm_card',
    });
    const view = await svc.getPlan(CLIENT, out.purchase_id);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', paymentMethodId: 'pm_card' }),
    );
    // The read never grants access itself.
    expect(view.entitlement_active).toBe(false);
    expect(view.state).toBe('confirming');
    expect(prisma._purchases[0].entitlement_active).toBe(false);
  });
});

describe('plan read model + keep-my-plan', () => {
  it('plan view: next charge date, cancel and resume affordances, no secrets', async () => {
    const { svc, prisma } = setup();
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    const end = new Date(Date.now() + 20 * 86400_000);
    Object.assign(prisma._purchases[0], {
      status: 'active',
      entitlement_active: true,
      current_period_end: end,
    });
    const view = await svc.getPlan(CLIENT, out.purchase_id);
    expect(view).toEqual(
      expect.objectContaining({
        state: 'active',
        amount_cents: 4900,
        interval: 'month',
        next_charge_at: end.toISOString(),
        can_cancel: true,
        can_resume: false,
        can_resubscribe: false,
        package_name: 'Coaching',
      }),
    );
    expect(JSON.stringify(view)).not.toMatch(/secret|ek_/);
    const list = await svc.listPlans(CLIENT);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/secret|ek_/);
  });

  it('cancel scheduled: access through the paid period, no next charge, resume offered', async () => {
    const { svc, stripe, prisma } = setup();
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    const end = new Date(Date.now() + 20 * 86400_000);
    Object.assign(prisma._purchases[0], {
      status: 'active',
      entitlement_active: true,
      current_period_end: end,
      cancel_at_period_end: true,
    });
    const view = await svc.getPlan(CLIENT, out.purchase_id);
    expect(view).toEqual(
      expect.objectContaining({
        next_charge_at: null,
        access_ends_at: end.toISOString(),
        can_resume: true,
        can_cancel: false,
      }),
    );
    const kept = await svc.resumePlan(CLIENT, out.purchase_id, KEY2);
    expect(stripe.resumeSubscription).toHaveBeenCalledWith({
      subscriptionId: 'sub_1',
      idempotencyKey: `tgp-resume-sub_1-${KEY2}`,
    });
    expect(kept.cancel_at_period_end).toBe(false);
    expect(kept.can_cancel).toBe(true);
  });

  it('a foreign or unknown plan id -> 404 PURCHASE_NOT_FOUND', async () => {
    const { svc } = setup();
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY1,
    });
    const err = await codeOf(svc.getPlan(COACH, out.purchase_id));
    expect(err.status).toBe(404);
    expect(err.body.code).toBe('PURCHASE_NOT_FOUND');
  });

  it('an abandoned unpaid attempt is not listed as a plan', async () => {
    const { svc } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(await svc.listPlans(CLIENT)).toEqual([]);
  });
});

describe('POST /v1/checkout/payment-intent refuses renewing plans', () => {
  function makeCheckout(pkg: Record<string, unknown>) {
    const prisma = makeFakePrisma();
    prisma._users.push({ id: CLIENT, email: 'c@example.test', name: 'C', coach_id: COACH });
    const stripe: any = {
      createPaymentIntent: jest.fn(),
      createEphemeralKey: jest.fn(),
      createCustomer: jest.fn(),
    };
    const packages: any = { getById: jest.fn(async () => recurringPkg(pkg)) };
    const state: any = { ready: true };
    const feePolicy: any = { planFor: jest.fn() };
    const gate: any = { evaluate: jest.fn(async () => ({ ok: true })) };
    const svc = new CheckoutService(prisma, stripe, packages, state, feePolicy, gate);
    return { svc, stripe, prisma };
  }

  it.each([
    ['recurring package', {}],
    [
      'one-time + recurring package',
      {
        billing_type: 'one_time',
        interval: null,
        recurring_amount_cents: 4900,
        recurring_interval: 'month',
      },
    ],
  ])('%s -> 409 RECURRING_REQUIRES_SUBSCRIPTION, no PaymentIntent', async (_n, over) => {
    const { svc, stripe, prisma } = makeCheckout(over);
    const err = await codeOf(
      svc.createPaymentIntentForClient(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(err.status).toBe(409);
    expect(err.body.code).toBe('RECURRING_REQUIRES_SUBSCRIPTION');
    expect(err.body.error).toBe('RECURRING_REQUIRES_SUBSCRIPTION');
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.clientPurchase.create).not.toHaveBeenCalled();
  });
});

describe('StripeConnectApiService.createSubscription wire format (Stripe-Version 2024-09-30.acacia)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeConnectApiService } = require('../src/connect/stripe-connect-api.service');
  class Recording extends StripeConnectApiService {
    calls: Array<{ url: string; headers: Record<string, string>; form: URLSearchParams }> = [];
    protected fetchImpl: typeof fetch = async (input: any, init: any) => {
      this.calls.push({
        url: String(input),
        headers: init.headers,
        form: new URLSearchParams(init.body),
      });
      return new Response(JSON.stringify({ id: 'sub_x', status: 'incomplete' }), { status: 200 });
    };
  }
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('default_incomplete, save card on_subscription, expand first invoice PI, on_behalf_of, no fee / transfer_data', async () => {
    const api = new Recording();
    await api.createSubscription({
      customer: 'cus_1',
      recurringPriceId: 'price_r',
      oneTimePriceId: 'price_o',
      onBehalfOf: 'acct_coach',
      metadata: { tgp_package_id: 'p' },
      idempotencyKey: 'tgp-sub-k',
    });
    const { url, headers, form } = api.calls[0];
    expect(url).toMatch(/\/v1\/subscriptions$/);
    expect(headers['Stripe-Version']).toBe('2024-09-30.acacia');
    expect(headers['Idempotency-Key']).toBe('tgp-sub-k');
    expect(form.get('payment_behavior')).toBe('default_incomplete');
    expect(form.get('payment_settings[save_default_payment_method]')).toBe('on_subscription');
    expect(form.get('expand[0]')).toBe('latest_invoice.payment_intent');
    expect(form.get('on_behalf_of')).toBe('acct_coach');
    expect(form.get('items[0][price]')).toBe('price_r');
    expect(form.get('add_invoice_items[0][price]')).toBe('price_o');
    expect([...form.keys()].filter((k) => /transfer_data|application_fee/.test(k))).toEqual([]);
    expect(form.get('trial_period_days')).toBeNull();
  });

  it('trial: trial_period_days, cancel when the trial ends without a card, expand pending_setup_intent', async () => {
    const api = new Recording();
    await api.createSubscription({
      customer: 'cus_1',
      recurringPriceId: 'price_r',
      onBehalfOf: 'acct_coach',
      trialPeriodDays: 7,
      idempotencyKey: 'tgp-sub-t',
    });
    const { form } = api.calls[0];
    expect(form.get('trial_period_days')).toBe('7');
    expect(form.get('trial_settings[end_behavior][missing_payment_method]')).toBe('cancel');
    expect(form.get('expand[1]')).toBe('pending_setup_intent');
  });

  it('resume and trial-card writes carry their own idempotency keys', async () => {
    const api = new Recording();
    await api.resumeSubscription({ subscriptionId: 'sub_1', idempotencyKey: 'tgp-resume-1' });
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_1',
      paymentMethodId: 'pm_1',
      idempotencyKey: 'tgp-trial-card-1',
    });
    expect(api.calls[0].form.get('cancel_at_period_end')).toBe('false');
    expect(api.calls[0].headers['Idempotency-Key']).toBe('tgp-resume-1');
    expect(api.calls[1].form.get('default_payment_method')).toBe('pm_1');
    expect(api.calls[1].headers['Idempotency-Key']).toBe('tgp-trial-card-1');
  });
});
