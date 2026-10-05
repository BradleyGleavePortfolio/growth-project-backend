// Independent R2 continuation of B-679-10: a customer default is never
// the attempt's own consent, including after an uncertain own-setup create.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup() {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  db._users.push(
    { id: CLIENT, email: 'client@example.test', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', coach_id: null },
  );
  db._packages.push({
    id: PKG, coach_id: COACH, name: 'Plan', billing_type: 'recurring',
    amount_cents: 4900, currency: 'usd', interval: 'month', interval_count: 1,
    stripe_price_id: 'price_4900', recurring_amount_cents: null, recurring_interval: null,
    trial_days: 7, is_active: true, published_at: new Date('2026-09-01'), archived_at: null,
  });
  db._accounts.push({
    coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true, deauthorized_at: null,
  });
  const service = new SubscriptionCheckoutService(
    db, stripe, { getById: async () => ({ ...db._packages[0] }) } as any,
    { ready: true } as any, { planFor: async () => ({ head_coach_id: null }) } as any,
    makeCheckoutHelpers(db) as any,
  );
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
  try { return { value: await p }; }
  catch (error) {
    if (error instanceof HttpException) return { body: error.getResponse() };
    throw error;
  }
}
const intent = (f: ReturnType<typeof setup>) =>
  f.service.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY });
const transient = () => new StripeConnectApiError(
  'synthetic timeout', 503, 'request_timeout', 'api_connection_error',
);

beforeAll(() => { process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic'; });

it('control: failed own SetupIntent create can recover on unchanged terms without accepting the customer default', async () => {
  const f = setup();
  f.stripe.createSetupIntent.mockRejectedValueOnce(transient());
  expect((await result(intent(f))).body.code).toBe('STRIPE_CHECKOUT_ERROR');
  expect((await intent(f)).mode).toBe('setup');
  expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  expect(f.stripe._subs.get('sub_1').cancel_at_period_end).toBe(true);
});

it.each(['trial removed', 'price changed'])(
  'B-679-10 retained: %s after failed own-setup creation must not call the customer default an active own trial',
  async (change) => {
    const f = setup();
    f.stripe.createSetupIntent.mockRejectedValueOnce(transient());
    expect((await result(intent(f))).body.code).toBe('STRIPE_CHECKOUT_ERROR');
    expect(f.db._purchases[0].stripe_client_secret).toBeNull();
    if (change === 'trial removed') f.db._packages[0].trial_days = 0;
    else Object.assign(f.db._packages[0], { amount_cents: 5900, stripe_price_id: 'price_5900' });
    const out = await result(intent(f));
    console.log('SOL_TRIAL_DEFAULT_AFTER_SETUP_FAILURE', {
      change, code: out.body?.code, status: f.stripe._subs.get('sub_1').status,
      safetyEnd: f.stripe._subs.get('sub_1').cancel_at_period_end,
      hasOwnSecret: !!f.db._purchases[0].stripe_client_secret,
      entitled: f.db._purchases[0].entitlement_active,
    });
    expect(out.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(f.stripe._subs.get('sub_1').status).toBe('canceled');
  },
);
