// B-RECUR5A-117 fix round 5 (#678 + #679). Acceptance cases for Sol
// B-679-4 / B-679-7 / B-679-8 and Opus B-679-8 / B-679-9 / C-679-3 (lens IDs
// collide: each case names its lens). Every case marked (failed before)
// failed at #679 f48fa8f0. Synthetic stateful doubles only.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD = 25 * 3600 * 1000;
const ENDED = new Set(['canceled', 'incomplete_expired']);

function setup(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const checkout: any = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'synthetic@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
    id: PKG,
    coach_id: COACH,
    name: 'Plan A',
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    stripe_price_id: 'price_A',
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    is_active: true,
    published_at: new Date('2026-09-01'),
    archived_at: null,
    ...over,
  });
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const packages: any = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
  };
  const feePolicy: any = { planFor: jest.fn(async () => ({ head_coach_id: null })) };
  const svc = new SubscriptionCheckoutService(
    prisma,
    stripe,
    packages,
    { ready: true } as any,
    feePolicy,
    checkout,
  );
  return { svc, prisma, stripe };
}
type F = ReturnType<typeof setup>;

async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (error) {
    if (error instanceof HttpException) {
      return { body: error.getResponse(), status: error.getStatus() };
    }
    return { error };
  }
}

const intent = (svc: SubscriptionCheckoutService, key = KEY1) =>
  svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: key });
const timeout = () =>
  new StripeConnectApiError(
    'synthetic lost response',
    503,
    'request_timeout',
    'api_connection_error',
  );
const missing = () =>
  new StripeConnectApiError(
    'No such subscription',
    404,
    'resource_missing',
    'invalid_request_error',
  );
const liveSubs = (f: F) => [...f.stripe._subs.values()].filter((s: any) => !ENDED.has(s.status));

function age(f: F) {
  Object.assign(f.prisma._purchases[0], {
    created_at: new Date(Date.now() - OLD),
    updated_at: new Date(Date.now() - OLD),
  });
}

/**
 * Stripe's documented trial end (docs.stripe.com/billing/subscriptions/trials/free-trials):
 * a subscription set to cancel at period end ends; otherwise Stripe charges the
 * subscription's or the CUSTOMER's default card; with neither it cancels
 * (missing_payment_method=cancel).
 */
function trialEnd(sub: any, customerDefault: string | null): 'charged' | 'ended' {
  if (sub.status !== 'trialing' || sub.cancel_at_period_end === true) return 'ended';
  return sub.default_payment_method || customerDefault ? 'charged' : 'ended';
}

/** The real Stripe client with its HTTP recorded (no network). */
class Recording extends StripeConnectApiService {
  forms: string[] = [];
  protected fetchImpl: typeof fetch = async (_input: any, init: any) => {
    this.forms.push(decodeURIComponent(String(init?.body ?? '')));
    return new Response(JSON.stringify({ id: 'sub_x', status: 'trialing' }), { status: 200 });
  };
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});
afterEach(() => jest.restoreAllMocks());

describe('Opus B-679-8 a trial converts only on the attempt’s own saved card', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('(failed before) a trial create carries a Stripe-enforced end; a plan without a trial does not', async () => {
    const api = new Recording();
    const base = { customer: 'cus_A', recurringPriceId: 'price_A', onBehalfOf: 'acct_coach' };
    await api.createSubscription({ ...base, trialPeriodDays: 7, idempotencyKey: 'k1' });
    await api.createSubscription({ ...base, idempotencyKey: 'k2' });
    expect(api.forms[0]).toContain('trial_period_days=7');
    expect(api.forms[0]).toContain('cancel_at_period_end=true');
    expect(api.forms[1]).not.toContain('cancel_at_period_end');
  });

  it('(failed before) the saved-card attach lifts that end in the same request', async () => {
    const api = new Recording();
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_x',
      paymentMethodId: 'pm_own',
      idempotencyKey: 'k3',
    });
    expect(api.forms).toEqual([
      expect.stringMatching(/^(?=.*default_payment_method=pm_own)(?=.*cancel_at_period_end=false)/),
    ]);
  });

  it('(failed before) an abandoned attempt never converts on the customer default card', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc);
    expect(out.mode).toBe('setup');
    // Everything the app does afterwards: list and read the plan, then leave.
    await f.svc.listPlans(CLIENT);
    await resultOf(f.svc.getPlan(CLIENT, out.purchase_id));
    const sub = f.stripe._subs.get(out.subscription_id);
    expect(trialEnd(sub, 'pm_portal_default')).toBe('ended');
  });

  it('control: the attempt’s own saved card converts the trial', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc);
    f.stripe._saveTrialCard(out.subscription_id, 'pm_own');
    const plan = await f.svc.getPlan(CLIENT, out.purchase_id);
    expect(plan.checkout_state).toBe('card_saved');
    const sub = f.stripe._subs.get(out.subscription_id);
    expect(sub.default_payment_method).toBe('pm_own');
    expect(trialEnd(sub, null)).toBe('charged');
  });

  it('(failed before) when Stripe made the own card the default itself, the plan read lifts the end', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc);
    f.stripe._saveTrialCard(out.subscription_id, 'pm_own');
    const sub = f.stripe._subs.get(out.subscription_id);
    Object.assign(sub, { default_payment_method: 'pm_own', cancel_at_period_end: true });
    const plan = await f.svc.getPlan(CLIENT, out.purchase_id);
    expect(plan.checkout_state).toBe('card_saved');
    expect(sub.cancel_at_period_end).toBe(false);
    expect(trialEnd(sub, null)).toBe('charged');
  });

  it('(failed before) a default that is not the attempt’s own card never lifts the end; the attempt stays open', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc);
    const sub = f.stripe._subs.get(out.subscription_id);
    // Its own SetupIntent never succeeded; some other card is the default.
    Object.assign(sub, { default_payment_method: 'pm_other', cancel_at_period_end: true });
    const again = await resultOf(intent(f.svc, KEY2));
    expect(again.value?.subscription_id).toBe(out.subscription_id);
    expect(again.value?.mode).toBe('setup');
    expect(f.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(sub.cancel_at_period_end).toBe(true);
    expect(f.stripe._subs.size).toBe(1);
  });
});

describe('Opus B-679-9 a canceled trial SetupIntent is not proof the attempt ended', () => {
  // An abandoned trial is retired 25 h later by a new key: its SetupIntent is
  // canceled, then the DELETE fails. The original key then replays.
  async function drive(deleteFails: boolean) {
    const f = setup({ trial_days: 7 });
    await intent(f.svc, KEY1);
    age(f);
    if (deleteFails) f.stripe.cancelSubscription.mockRejectedValue(timeout());
    const second = await resultOf(intent(f.svc, KEY2));
    const replay = await resultOf(intent(f.svc, KEY1));
    const third = await resultOf(intent(f.svc, KEY3));
    return { f, second, replay, third };
  }

  it('(failed before) the replay keeps the row and never says nothing was charged while the trial is live', async () => {
    const { f, second, replay } = await drive(true);
    expect(second.status).toBe(503);
    expect(f.stripe._setups.get('seti_1').status).toBe('canceled');
    expect(f.stripe._subs.get('sub_1').status).toBe('trialing');
    expect(replay.status).toBe(503);
    expect(replay.body.code).toBe('PAYMENT_RETRY');
    expect(String(replay.body.message)).not.toMatch(/nothing was charged/i);
    expect(f.prisma._purchases[0].status).toBe('pending');
  });

  it('(failed before) a new key never starts a second live subscription for the plan', async () => {
    const { f, third } = await drive(true);
    expect(third.status).toBe(503);
    expect(liveSubs(f).map((s: any) => s.id)).toEqual(['sub_1']);
  });

  it('control: when the DELETE succeeds the attempt ends with its subscription', async () => {
    const { f, second } = await drive(false);
    expect(f.stripe._subs.get('sub_1').status).toBe('canceled');
    expect(f.prisma._purchases[0].status).toBe('expired');
    expect(second.value?.subscription_id).toBe('sub_2');
  });
});

describe('Opus C-679-3 a subscription Stripe does not have frees the plan', () => {
  it('(failed before) a new key starts the plan when the attempt’s subscription is resource_missing', async () => {
    const f = setup();
    await intent(f.svc, KEY1);
    age(f);
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(missing());
    const out = await resultOf(intent(f.svc, KEY2));
    expect(out.value?.subscription_id).toBe('sub_2');
    expect(f.prisma._purchases[0].status).toBe('expired');
  });

  it('(failed before) the same key answers expired instead of a secret of a missing subscription', async () => {
    const f = setup();
    await intent(f.svc, KEY1);
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(missing());
    const out = await resultOf(intent(f.svc, KEY1));
    expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(f.prisma._purchases[0].status).toBe('expired');
  });

  it('control: any other read failure stays retryable and keeps the attempt', async () => {
    const f = setup();
    await intent(f.svc, KEY1);
    age(f);
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(timeout());
    const out = await resultOf(intent(f.svc, KEY2));
    expect(out.status).toBe(503);
    expect(f.prisma._purchases[0].status).toBe('pending');
    expect(f.stripe._subs.size).toBe(1);
  });
});

describe('Sol B-679-4 a failed read-back never applies a cached keep answer', () => {
  it('(failed before) cached keep reply plus failed read: nothing written, a coded retry answer', async () => {
    const f = setup();
    const out = await intent(f.svc);
    const row = f.prisma._purchases[0];
    const sub = f.stripe._subs.get(out.subscription_id);
    Object.assign(row, {
      status: 'active',
      entitlement_active: true,
      cancel_at_period_end: true,
      current_period_end: new Date(Date.now() + 20 * 86400000),
    });
    Object.assign(sub, { status: 'active', cancel_at_period_end: true });
    f.stripe.resumeSubscription.mockResolvedValueOnce({
      id: sub.id,
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: Math.floor(row.current_period_end.getTime() / 1000),
    });
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(timeout());
    const answer = await resultOf(f.svc.resumePlan(CLIENT, out.purchase_id, KEY2));
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('PLAN_CHANGE_UNCONFIRMED');
    expect(row.cancel_at_period_end).toBe(true);
  });

  it('control: a successful read-back writes Stripe’s current state', async () => {
    const f = setup();
    const out = await intent(f.svc);
    const row = f.prisma._purchases[0];
    const sub = f.stripe._subs.get(out.subscription_id);
    Object.assign(row, { status: 'active', entitlement_active: true, cancel_at_period_end: true });
    Object.assign(sub, { status: 'active', cancel_at_period_end: false });
    const view = await f.svc.resumePlan(CLIENT, out.purchase_id, KEY2);
    expect(view.cancel_at_period_end).toBe(false);
    expect(row.cancel_at_period_end).toBe(false);
  });
});

describe('Sol B-679-7 an attempt closed during the retry lookup never sends its create', () => {
  it('(failed before) closure while the metadata lookup is in flight: no second create', async () => {
    const f = setup();
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async () => {
      throw timeout(); // nothing was made on Stripe
    });
    expect((await resultOf(intent(f.svc))).status).toBe(503);
    const lookup = f.stripe.listSubscriptionsForCustomer.getMockImplementation();
    f.stripe.listSubscriptionsForCustomer.mockImplementationOnce(async (...args: any[]) => {
      const answer = await lookup(...args);
      Object.assign(f.prisma._purchases[0], {
        status: 'canceled',
        stripe_client_secret: null,
        stripe_ephemeral_key: null,
      });
      return answer;
    });
    f.stripe.createSubscription.mockImplementation(create);
    const out = await resultOf(intent(f.svc));
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(f.stripe._subs.size).toBe(0);
    expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
  });
});

describe('Sol B-679-8 rejected-bind cleanup uses the guarded unpaid termination', () => {
  /** The create answers an unpaid snapshot; the row closes before the bind lands. */
  function closeBeforeBind(f: F, land?: (sub: any) => void) {
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await create(args);
      sub.latest_invoice.status = 'open';
      return structuredClone(sub);
    });
    const write = f.prisma.clientPurchase.updateMany.getMockImplementation();
    f.prisma.clientPurchase.updateMany.mockImplementation(async (args: any) => {
      if (args.data.stripe_subscription_id && args.data.stripe_checkout_session_id) {
        Object.assign(f.prisma._purchases[0], { status: 'expired' });
        if (land) land(f.stripe._subs.get(args.data.stripe_subscription_id));
      }
      return write(args);
    });
  }

  it('(failed before) a payment that lands before the cleanup is never canceled or called no charge', async () => {
    const f = setup();
    closeBeforeBind(f, (sub) => {
      Object.assign(sub, { status: 'active' });
      sub.latest_invoice.status = 'paid';
      sub.latest_invoice.payment_intent.status = 'succeeded';
    });
    const out = await resultOf(intent(f.svc));
    const sub = f.stripe._subs.get('sub_1');
    expect(sub.status).toBe('active');
    expect(f.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(out.body?.code).toBe('PAYMENT_RETRY');
    expect(f.prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
  });

  it('(failed before) an unconfirmed cleanup keeps the subscription on the row and never says no charge', async () => {
    const f = setup();
    closeBeforeBind(f);
    f.stripe.voidInvoice.mockRejectedValueOnce(timeout());
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(timeout());
    f.stripe.cancelSubscription.mockRejectedValue(timeout());
    const out = await resultOf(intent(f.svc));
    expect(out.body?.code).toBe('PAYMENT_RETRY');
    expect(String(out.body?.message)).not.toMatch(/nothing was charged/i);
    expect(f.prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
  });

  it('(failed before) an unpaid one is voided first, then ended, and only then called no charge', async () => {
    const f = setup();
    closeBeforeBind(f);
    const out = await resultOf(intent(f.svc));
    expect(f.stripe.voidInvoice).toHaveBeenCalledWith('in_1', 'tgp-void-in_1');
    expect(ENDED.has(f.stripe._subs.get('sub_1').status)).toBe(true);
    expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
  });
});
