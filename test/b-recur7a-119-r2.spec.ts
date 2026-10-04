// B-RECUR7A-119 fix round 7, R2 (#679) half; lives in R5 #701 (tests-only
// piece; #679 sits near its size ceiling). Stateful doubles, no network.
// "(failed before)" cases failed at #679 8bbf4a41 in the CI lane before the fix.
//   Sol B-679-10 (narrowed) / Opus C-679-4  a customer default with no SetupIntent
//                 is never a settled trial (retire / terms changed).
//   Sol B-679-11  abandoned history never hides an older billable plan.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const PKG2 = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(trialDays = 7) {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  db._users.push(
    { id: CLIENT, email: 'client@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  db._packages.push({
    ...{ id: PKG, coach_id: COACH, name: 'Plan', amount_cents: 4900, currency: 'usd' },
    ...{ billing_type: 'recurring', interval: 'month', interval_count: 1 },
    ...{ stripe_price_id: 'price_4900', recurring_amount_cents: null, recurring_interval: null },
    ...{ recurring_interval_count: null, recurring_stripe_price_id: null, is_active: true },
    ...{ published_at: new Date('2026-09-01'), archived_at: null, trial_days: trialDays },
  });
  db._accounts.push({
    ...{ coach_user_id: COACH, stripe_account_id: 'acct_coach' },
    ...{ charges_enabled: true, deauthorized_at: null },
  });
  const packages: any = {
    getById: async (id: string) => db._packages.find((p: any) => p.id === id),
  };
  const fees: any = { planFor: async () => ({ head_coach_id: null }) };
  const service = new SubscriptionCheckoutService(
    db,
    stripe,
    packages,
    { ready: true } as any,
    fees,
    makeCheckoutHelpers(db) as any,
  );
  // Stripe set the trial up off-session on the customer's default card: no
  // pending SetupIntent, a subscription default, the enforced end still set.
  const create = stripe.createSubscription.getMockImplementation();
  stripe.createSubscription.mockImplementation(async (args: any) => {
    const sub = await create(args);
    sub.pending_setup_intent = null;
    sub.default_payment_method = 'pm_customer_default';
    return structuredClone(sub);
  });
  return { db, stripe, service };
}

async function result(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (err) {
    if (err instanceof HttpException) return { body: err.getResponse() };
    throw err;
  }
}
const intent = (f: ReturnType<typeof setup>) =>
  f.service.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY });
const transient = () =>
  new StripeConnectApiError('synthetic timeout', 503, 'request_timeout', 'api_connection_error');

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});

describe('Sol B-679-10 a customer default is never a settled trial', () => {
  it('control: a failed own SetupIntent create recovers on unchanged terms (own sheet, end kept)', async () => {
    const f = setup();
    f.stripe.createSetupIntent.mockRejectedValueOnce(transient());
    expect((await result(intent(f))).body.code).toBe('STRIPE_CHECKOUT_ERROR');
    expect((await intent(f)).mode).toBe('setup');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(f.stripe._subs.get('sub_1').cancel_at_period_end).toBe(true);
  });

  it.each(['trial removed', 'price changed'])(
    '(failed before) %s after a failed own SetupIntent: attempt expired, trial ended, no active claim',
    async (change) => {
      const f = setup();
      f.stripe.createSetupIntent.mockRejectedValueOnce(transient());
      expect((await result(intent(f))).body.code).toBe('STRIPE_CHECKOUT_ERROR');
      expect(f.db._purchases[0].stripe_client_secret).toBeNull();
      if (change === 'trial removed') f.db._packages[0].trial_days = 0;
      else Object.assign(f.db._packages[0], { amount_cents: 5900, stripe_price_id: 'price_5900' });
      const out = await result(intent(f));
      expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
      expect(f.stripe._subs.get('sub_1').status).toBe('canceled');
      expect(f.db._purchases[0]).toMatchObject({ entitlement_active: false, status: 'expired' });
    },
  );

  it('(failed before) Opus C-679-4: ephemeral key failed, price changed, same key: never ALREADY_ACTIVE', async () => {
    const f = setup();
    f.stripe.createEphemeralKey.mockRejectedValueOnce(transient());
    expect((await result(intent(f))).body.code).toBe('STRIPE_CHECKOUT_ERROR');
    expect(f.db._purchases[0].stripe_client_secret ?? null).toBeNull();
    f.db._packages[0].amount_cents = 5900;
    const out = await result(intent(f));
    expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(f.stripe._subs.get('sub_1').status).toBe('canceled');
  });

  it('control: the own saved card (end lifted) still answers settled, nothing canceled', async () => {
    const f = setup();
    expect((await intent(f)).mode).toBe('setup');
    const sub = f.stripe._subs.get('sub_1');
    Object.assign(sub, { default_payment_method: 'pm_own', cancel_at_period_end: false });
    f.db._packages[0].amount_cents = 5900;
    const out = await result(intent(f));
    expect(out.body?.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(sub.status).toBe('trialing');
  });
});

describe('Sol B-679-11 the plan list is complete for live plans', () => {
  const base = {
    client_user_id: CLIENT,
    coach_user_id: COACH,
    package_id: PKG,
    billing_type: 'recurring',
    amount_cents: 4900,
    currency: 'usd',
    entitlement_active: false,
    trial_started_at: null,
    status: 'pending',
    cancel_at_period_end: false,
    current_period_end: new Date(Date.now() + 86400e3),
    checkout_terms: null,
  };
  const push = (f: ReturnType<typeof setup>, n: number, over: Record<string, unknown>) => {
    for (let i = 0; i < n; i += 1) {
      f.db._purchases.push({
        ...base,
        id: `pur_${String(over.status)}_${i}`,
        stripe_subscription_id: `sub_${String(over.status)}_${i}`,
        package_id: PKG2,
        created_at: new Date(1000 + i),
        ...over,
      });
    }
  };
  const live = (over: Record<string, unknown> = {}) => ({
    ...base,
    id: 'pur_live_old',
    stripe_subscription_id: 'sub_live_old',
    entitlement_active: true,
    status: 'active',
    created_at: new Date(0),
    ...over,
  });

  it('(failed before) fifty newer abandoned attempts never hide an older paid plan', async () => {
    const f = setup();
    f.db._purchases.push(live());
    push(f, 50, { status: 'expired' });
    const ids = (await f.service.listPlans(CLIENT)).map((p) => p.purchase_id);
    expect(ids).toEqual(['pur_live_old']);
  });

  it('(failed before) sixty ended plans: history capped at fifty, the older live plans all listed', async () => {
    const f = setup();
    f.db._purchases.push(
      live(),
      live({ id: 'pur_past_due', stripe_subscription_id: 'sub_pd', entitlement_active: false }),
    );
    f.db._purchases[f.db._purchases.length - 1].status = 'past_due';
    push(f, 60, { status: 'canceled' });
    const ids = (await f.service.listPlans(CLIENT)).map((p) => p.purchase_id);
    expect(ids).toHaveLength(52);
    expect(ids.slice(-2).sort()).toEqual(['pur_live_old', 'pur_past_due']);
    expect(ids[0]).toBe('pur_canceled_59');
    expect(ids).not.toContain('pur_canceled_9');
  });

  it('control: newest first, unpaid abandoned hidden, another client never listed', async () => {
    const f = setup();
    f.db._purchases.push(
      live({ created_at: new Date(5000) }),
      live({ id: 'pur_trial', stripe_subscription_id: 'sub_t', entitlement_active: false }),
      live({ id: 'pur_other', stripe_subscription_id: 'sub_o', client_user_id: OTHER }),
    );
    Object.assign(f.db._purchases[1], { status: 'pending', trial_started_at: new Date(1) });
    push(f, 3, { status: 'expired' });
    const ids = (await f.service.listPlans(CLIENT)).map((p) => p.purchase_id);
    expect(ids).toEqual(['pur_live_old', 'pur_trial']);
  });
});
