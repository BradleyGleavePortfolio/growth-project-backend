// AUD-OPUS-661E-120 lens probe (never merge). Branch from #702 @ b96611de (= #661 e0cc97e1 src + #702 tests).
// Composes the REAL SubscriptionCheckoutService (R2, POST /v1/checkout/subscription-intent and the plan reads) with
// the REAL CheckoutWebhookHandlerService on ONE recurring fake store (test/support/b-recur-fakes.ts), so every
// reader of stripe_client_secret / stripe_ephemeral_key runs AFTER the round-9 grant erase (B-661-14 / B-661-15):
//   R1 paid first invoice: grant erases; same-key replay and a new key answer SUBSCRIPTION_ALREADY_ACTIVE with no
//      Stripe write and no credential; plan reads carry no credential.
//   R2 trial: setup_intent.succeeded attaches, subscription.updated grants and erases; a redelivered
//      setup_intent.succeeded (Stripe's pending SetupIntent: no tgp metadata, found only by the stored secret's
//      prefix before) is now unclaimed, with no Stripe write and no throw; replay ALREADY_ACTIVE.
//   R3 a late R2 credential store after the grant never writes a credential back (B-679-3 guard).
//   R4 a granted plan that went `unpaid` (not entitled, not ended): same-key replay never returns or stores a
//      credential and never cancels or voids anything on Stripe (pre-round-9 it handed back the spent secret).
// Every test asserts the CORRECT behaviour; a failure is a defect at this head (R4b documents copy).
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Math.floor(Date.now() / 1000);

function pkgRow(over: Record<string, unknown> = {}) {
  return {
    id: PKG, coach_id: COACH, name: 'Coaching', description: null, amount_cents: 4900, currency: 'usd',
    billing_type: 'recurring', interval: 'month', interval_count: 1, recurring_amount_cents: null,
    recurring_interval: null, recurring_interval_count: null, recurring_stripe_price_id: null,
    stripe_price_id: 'price_rec_4900', is_active: true, archived_at: null, published_at: new Date('2026-09-01'),
    duration_periods: null, ...over,
  };
}

let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_aud661e_${seq}`, type, data: { object } } as any;
};

function setup(pkgOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const helpers = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(pkgRow(pkgOver));
  prisma._accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true, deauthorized_at: null });
  const packages: any = { getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null) };
  const feePolicy: any = {
    planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_split_cents: 0, head_coach_id: null })),
  };
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, { ready: true } as any, feePolicy, helpers as any);
  // The webhook side of the same Stripe double.
  stripe.retrieveSubscription = jest.fn(async (id: string) => {
    const s = stripe._subs.get(id);
    if (!s) throw new Error('no such subscription');
    return { ...s };
  });
  stripe.retrieveInvoice = jest.fn(async (id: string) => ({ id, status: 'paid' }));
  stripe.retrievePaymentIntent = jest.fn(async (id: string) => ({ id, status: 'succeeded', latest_charge: 'ch_1' }));
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const fanout: any = { onPurchaseEntitled: jest.fn(async () => undefined), cancelPendingForPurchase: jest.fn(async () => 0) };
  const hooks = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, undefined);
  const deliver = async (e: any) => hooks.handle(e, prisma, await hooks.prefetchForOuterTx(e));
  const row = () => prisma._purchases[0];
  const stripeWrites = () =>
    ['createSubscription', 'createEphemeralKey', 'cancelSubscription', 'voidInvoice', 'cancelSetupIntent',
      'setSubscriptionDefaultPaymentMethod', 'createSetupIntent']
      .map((m) => [m, (stripe[m] as jest.Mock).mock.calls.length] as const);
  return { prisma, stripe, svc, hooks, deliver, row, fanout, stripeWrites };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err: any) {
    return { status: err.getStatus?.(), body: err.getResponse?.() };
  }
  throw new Error('expected a coded error');
}
const noCredential = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toMatch(/_secret_/);
  expect(s).not.toMatch(/"ek_/);
};

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});

describe('AUD-OPUS-661E-120 R1: paid first invoice through R2 + webhook', () => {
  it('R1a invoice.paid grants and erases; same-key replay and a new key answer ALREADY_ACTIVE with no Stripe write and no credential', async () => {
    const h = setup();
    const out = await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(out.client_secret).toBe('pi_1_secret_x');
    expect(h.row()).toMatchObject({ stripe_client_secret: 'pi_1_secret_x' });
    expect(h.row().stripe_ephemeral_key).toMatch(/^ek_/);
    // The client pays in the sheet; Stripe marks the first invoice paid.
    const s = h.stripe._subs.get('sub_1');
    Object.assign(s, { status: 'active', default_payment_method: 'pm_card' });
    s.latest_invoice.status = 'paid';
    s.latest_invoice.payment_intent.status = 'succeeded';
    await h.deliver(ev('invoice.paid', { id: 'in_1', subscription: 'sub_1', amount_paid: 4900, currency: 'usd', charge: 'ch_1' }));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null });
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    const writes = h.stripeWrites();

    const same = await codeOf(h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    noCredential(same.body);
    const fresh = await codeOf(h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }));
    expect(fresh.status).toBe(409);
    expect(fresh.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    noCredential(fresh.body);
    expect(h.stripeWrites()).toEqual(writes);
    expect(h.prisma._purchases).toHaveLength(1);
    expect(h.row()).toMatchObject({ stripe_client_secret: null, stripe_ephemeral_key: null });
  });

  it('R1b plan reads after the grant carry no credential and make no Stripe read', async () => {
    const h = setup();
    await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const s = h.stripe._subs.get('sub_1');
    Object.assign(s, { status: 'active', default_payment_method: 'pm_card' });
    s.latest_invoice.status = 'paid';
    s.latest_invoice.payment_intent.status = 'succeeded';
    await h.deliver(ev('customer.subscription.updated', { ...s }));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null });
    const reads = (h.stripe.retrieveSubscriptionForCheckout as jest.Mock).mock.calls.length;
    const plans = await h.svc.listPlans(CLIENT);
    const plan = await h.svc.getPlan(CLIENT, h.row().id);
    expect(plans).toHaveLength(1);
    expect(plan.checkout_state).toBeNull();
    noCredential(plans);
    noCredential(plan);
    expect((h.stripe.retrieveSubscriptionForCheckout as jest.Mock).mock.calls.length).toBe(reads);
  });
});

describe('AUD-OPUS-661E-120 R2: trial through R2 + webhook', () => {
  it('R2a setup_intent.succeeded attaches, subscription.updated grants and erases; a redelivered setup_intent.succeeded is a no-op; replay ALREADY_ACTIVE', async () => {
    const h = setup({ trial_days: 7 });
    const out = await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(out.mode).toBe('setup');
    expect(h.row()).toMatchObject({ stripe_client_secret: 'seti_1_secret_x', trial_days: 7 });
    // The client saves the card in the sheet (Stripe: SetupIntent succeeded, pending_setup_intent null).
    h.stripe._saveTrialCard('sub_1', 'pm_card');
    const siEvent = () => ev('setup_intent.succeeded', { id: 'seti_1', payment_method: 'pm_card', customer: 'cus_1111', status: 'succeeded', metadata: {} });
    const first = await h.deliver(siEvent());
    expect(first).toMatchObject({ claimed: true });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    const s = h.stripe._subs.get('sub_1');
    expect(s).toMatchObject({ default_payment_method: 'pm_card', cancel_at_period_end: false });
    await h.deliver(ev('customer.subscription.updated', { ...s, trial_start: NOW }));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null });
    expect(h.row().trial_started_at).toBeInstanceOf(Date);
    const writes = h.stripeWrites();

    // Redelivery of the same SetupIntent event after the erase: the prefix lookup finds nothing now.
    const again = await h.deliver(siEvent());
    expect(again.claimed).toBe(false);
    expect(h.stripeWrites()).toEqual(writes);
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true });

    const replay = await codeOf(h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }));
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    noCredential(replay.body);
    expect(h.stripeWrites()).toEqual(writes);
  });

  it('R2b R2 own SetupIntent (tgp metadata) redelivered after the grant: claimed via metadata, no Stripe write', async () => {
    const h = setup({ trial_days: 7 });
    await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    h.stripe._saveTrialCard('sub_1', 'pm_card');
    const s = h.stripe._subs.get('sub_1');
    Object.assign(s, { default_payment_method: 'pm_card', cancel_at_period_end: false });
    await h.deliver(ev('customer.subscription.updated', { ...s, trial_start: NOW }));
    expect(h.row()).toMatchObject({ entitlement_active: true, stripe_client_secret: null });
    const writes = h.stripeWrites();
    const own = await h.deliver(ev('setup_intent.succeeded', {
      id: 'seti_own0001', payment_method: 'pm_card', customer: 'cus_1111', status: 'succeeded',
      metadata: { tgp_checkout: 'native_subscription_trial', tgp_purchase_id: h.row().id, tgp_subscription_id: 'sub_1' },
    }));
    expect(own).toMatchObject({ claimed: true });
    expect(h.stripeWrites()).toEqual(writes);
  });
});

describe('AUD-OPUS-661E-120 R3: a late R2 credential store after the grant', () => {
  it('R3 storeCredentials after the erase writes nothing back and answers ALREADY_ACTIVE', async () => {
    const h = setup();
    await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const s = h.stripe._subs.get('sub_1');
    Object.assign(s, { status: 'active', default_payment_method: 'pm_card' });
    s.latest_invoice.status = 'paid';
    s.latest_invoice.payment_intent.status = 'succeeded';
    await h.deliver(ev('invoice.paid', { id: 'in_1', subscription: 'sub_1', amount_paid: 4900, currency: 'usd', charge: 'ch_1' }));
    expect(h.row()).toMatchObject({ entitlement_active: true, stripe_client_secret: null });
    const late = await codeOf((h.svc as any).storeCredentials({ ...h.row() }, s, 'pi_1_secret_late', 'ek_late'));
    expect(late.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(h.row()).toMatchObject({ stripe_client_secret: null, stripe_ephemeral_key: null });
  });
});

describe('AUD-OPUS-661E-120 R4: a granted plan that went unpaid, then its first key is replayed', () => {
  async function unpaidPlan() {
    const h = setup();
    await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const s = h.stripe._subs.get('sub_1');
    Object.assign(s, { status: 'active', default_payment_method: 'pm_card' });
    s.latest_invoice.status = 'paid';
    s.latest_invoice.payment_intent.status = 'succeeded';
    await h.deliver(ev('invoice.paid', { id: 'in_1', subscription: 'sub_1', amount_paid: 4900, currency: 'usd', charge: 'ch_1' }));
    // Renewal failed and Stripe's retries ended: `unpaid`, an open renewal invoice with a payable PaymentIntent.
    Object.assign(s, {
      status: 'unpaid',
      latest_invoice: { id: 'in_r', status: 'open', payment_intent: { id: 'pi_r', client_secret: 'pi_r_secret_renewal', status: 'requires_payment_method' } },
    });
    await h.deliver(ev('customer.subscription.updated', { ...s }));
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false, stripe_client_secret: null, stripe_ephemeral_key: null });
    return h;
  }

  it('R4a replay never returns or stores a credential and never cancels or voids anything on Stripe', async () => {
    const h = await unpaidPlan();
    let answer: unknown;
    try {
      answer = await h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    } catch (err: any) {
      answer = err.getResponse?.() ?? String(err);
    }
    noCredential(answer);
    expect(h.row()).toMatchObject({ status: 'unpaid', stripe_client_secret: null, stripe_ephemeral_key: null });
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(h.stripe.voidInvoice).not.toHaveBeenCalled();
    expect(h.stripe.cancelSetupIntent).not.toHaveBeenCalled();
    expect(h.stripe._subs.get('sub_1').status).toBe('unpaid');
  });

  it('R4b (copy, C) the replay answers ALREADY_ACTIVE like a new key does, with no Stripe write', async () => {
    const h = await unpaidPlan();
    const writes = h.stripeWrites();
    const fresh = await codeOf(h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }));
    expect(fresh.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    const same = await codeOf(h.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }));
    expect({ code: same.body.code, message: same.body.message }).toEqual({ code: 'SUBSCRIPTION_ALREADY_ACTIVE', message: expect.any(String) });
    expect(h.stripeWrites()).toEqual(writes);
  });
});
