// AUD-OPUS-661D-120 lens probe (never merge). Branch from #702 @ 9ddda117 (= #661 bc399edd src + #702 tests).
// Drives the REAL CheckoutWebhookHandlerService with the recurring fakes (test/support/b-recur-fakes.ts, the
// harness of test/b-recur3-117-webhook-order.spec.ts) through the code that 010f9b57 resolved by hand:
//   H1 endSubscriptionPurchase  (the `...trial` + `...CLEARED_PAYMENT_SECRETS` hunk)
//   H2 applyPaymentIntentSucceeded (recurring early return vs #661 activation predicate)
//   H3 applyPaymentIntentFailed (recurring early return before the #661 status fence)
// and the C-661-3 obligation the second lander carries (G1/G2: native first grant erases credentials).
// Every test asserts the CORRECT behaviour; a failure is a defect at this head.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const PI_SECRET = 'pi_first_secret_canary';
const SETI_SECRET = 'seti_trial1_secret_canary';
const EK = 'ek_test_canary';

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_n',
  status,
  customer: 'cus_1',
  current_period_end: NOW + 30 * DAY,
  cancel_at_period_end: false,
  default_payment_method: 'pm_card',
  ...over,
});
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_aud661d_${seq}`, type, data: { object } };
};
const invoicePaid = (over: Record<string, unknown> = {}) =>
  ev('invoice.paid', {
    id: 'in_1', subscription: 'sub_n', amount_paid: 4900, currency: 'usd', charge: 'ch_1',
    billing_reason: 'subscription_create', ...over,
  });

function harness(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_native', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    stripe_checkout_session_id: 'sub_n', stripe_subscription_id: 'sub_n',
    stripe_payment_intent_id: 'pi_first', stripe_customer_id: 'cus_1',
    stripe_client_secret: PI_SECRET, stripe_ephemeral_key: EK,
    status: 'pending', entitlement_active: false, cancel_at_period_end: false,
    current_period_end: null, canceled_at: null, trial_days: null, trial_started_at: null,
    last_error: null, idempotency_key: 'sub-client-k', created_at: new Date(), updated_at: new Date(),
    ...over,
  });
  let live: Record<string, unknown> = sub('active');
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_1', status: 'open' })),
    retrievePaymentIntent: jest.fn(async () => ({ id: 'pi_first', status: 'succeeded', latest_charge: 'ch_1' })),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const svc = new CheckoutWebhookHandlerService(
    prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, undefined,
  );
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e as any, prisma, await svc.prefetchForOuterTx(e as any));
  return {
    svc, prisma, stripe, splits, dunning, fanout, deliver,
    row: () => prisma._purchases[0],
    setLive: (s: Record<string, unknown>) => { live = s; },
  };
}

describe('AUD-OPUS-661D-120 H1 (conflict hunk): endSubscriptionPurchase keeps recurring ending/trial and erases credentials', () => {
  it('H1a paid, entitled plan deleted on Stripe: canceled with Stripe canceled_at, access ends, drops canceled, dunning ended, credentials erased', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setLive(sub('canceled', { canceled_at: NOW - 60 }));
    const res = await h.deliver(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW - 60 })));
    expect(res).toMatchObject({ claimed: true, purchase_id: 'cp_native' });
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.row().canceled_at).toEqual(new Date((NOW - 60) * 1000));
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledWith('cp_native', 'subscription_canceled', h.prisma);
    expect(h.dunning.terminate).toHaveBeenCalledWith('cp_native', 'subscription_deleted');
  });

  it('H1b customer.subscription.updated to canceled (live read) takes the same end: canceled, credentials erased', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setLive(sub('canceled', { canceled_at: NOW - 30 }));
    await h.deliver(ev('customer.subscription.updated', sub('canceled', { canceled_at: NOW - 30 })));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
  });

  it('H1c an unpaid attempt Stripe expired after 23 h ends incomplete_expired (not churn), credentials erased', async () => {
    const h = harness();
    h.setLive(sub('incomplete_expired', { default_payment_method: null }));
    await h.deliver(ev('customer.subscription.updated', sub('incomplete_expired', { default_payment_method: null })));
    expect(h.row()).toMatchObject({ status: 'incomplete_expired', entitlement_active: false });
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
    expect(h.fanout.cancelPendingForPurchase).not.toHaveBeenCalled();
  });

  it('H1d a carded trial deleted before any grant event: trial recorded as used (canceled, trial_started_at), credentials erased', async () => {
    const h = harness({ trial_days: 7, stripe_client_secret: SETI_SECRET, stripe_payment_intent_id: null });
    await h.svc.handle(
      ev('customer.subscription.deleted', sub('canceled', { trial_start: NOW - DAY, canceled_at: NOW })) as any,
      h.prisma,
    );
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.row().trial_started_at).toEqual(new Date((NOW - DAY) * 1000));
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
  });

  it('H1e a redelivered deletion of a plan that already ended keeps its status and canceled_at; leftover credentials are erased', async () => {
    const endedAt = new Date((NOW - 5 * DAY) * 1000);
    const h = harness({ status: 'canceled', entitlement_active: false, canceled_at: endedAt });
    await h.svc.handle(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW })) as any, h.prisma);
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.row().canceled_at).toEqual(endedAt);
    expect(h.row().stripe_client_secret).toBeNull();
  });
});

describe('AUD-OPUS-661D-120 H2 (conflict hunk): payment_intent.succeeded never activates a native subscription row', () => {
  it('H2a pending native attempt: claimed as invoice.paid-owned; nothing written, no fanout, no split', async () => {
    const h = harness();
    const before = { ...h.row() };
    const res = await h.deliver(ev('payment_intent.succeeded', { id: 'pi_first', latest_charge: 'ch_1' }));
    expect(res).toEqual({ claimed: true, purchase_id: 'cp_native', reason: 'subscription_invoice_owned_by_invoice_paid' });
    expect(h.row()).toMatchObject({
      status: 'pending', entitlement_active: false,
      stripe_client_secret: before.stripe_client_secret, stripe_ephemeral_key: before.stripe_ephemeral_key,
    });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(h.splits.onChargeSucceeded).not.toHaveBeenCalled();
  });

  it('H2b no purchase holds the PaymentIntent: no_matching_purchase (the `purchase &&` guard), nothing written', async () => {
    const h = harness({ stripe_payment_intent_id: 'pi_other' });
    const res = await h.deliver(ev('payment_intent.succeeded', { id: 'pi_first', latest_charge: 'ch_1' }));
    expect(res).toEqual({ claimed: false, reason: 'no_matching_purchase' });
    expect(h.row()).toMatchObject({ status: 'pending', entitlement_active: false });
  });

  it('H2c plan already active through invoice.paid: the late success neither re-activates nor re-fans-out', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    const res = await h.deliver(ev('payment_intent.succeeded', { id: 'pi_first', latest_charge: 'ch_1' }));
    expect(res).toMatchObject({ claimed: false });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(h.splits.onChargeSucceeded).not.toHaveBeenCalled();
  });
});

describe('AUD-OPUS-661D-120 H3 (conflict hunk): payment_intent.payment_failed hands native rows to the invoice events before the #661 fence', () => {
  it('H3a settled native plan, Stripe PaymentIntent unreadable in the prefetch: claimed by the recurring return, never a 503, plan untouched', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.prisma.$queryRaw = jest.fn(async () => [{ status: 'active', row_version: '7' }]);
    h.stripe.retrievePaymentIntent = jest.fn(async () => { throw new Error('stripe down'); });
    const res = await h.deliver(ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'declined' } }));
    expect(res).toEqual({ claimed: true, purchase_id: 'cp_native', reason: 'subscription_invoice_owned_by_invoice_events' });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    expect(h.fanout.cancelPendingForPurchase).not.toHaveBeenCalled();
  });

  it('H3b the same decline inside a transaction with no prefetch at all: claimed, never a 503', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    const res = await h.svc.handle(
      ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'declined' } }) as any,
      h.prisma,
      undefined,
    );
    expect(res).toMatchObject({ claimed: true, reason: 'subscription_invoice_owned_by_invoice_events' });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('H3c first-attempt decline of a never-entitled attempt: recorded as last_error only, never payment_failed, credentials kept for the retry', async () => {
    const h = harness();
    const res = await h.deliver(ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'Your card was declined.' } }));
    expect(res).toMatchObject({ claimed: true, reason: 'subscription_invoice_owned_by_invoice_events' });
    expect(h.row()).toMatchObject({ status: 'pending', entitlement_active: false, last_error: 'Your card was declined.' });
    expect(h.row().stripe_client_secret).toBe(PI_SECRET);
  });

  it('H3d (observation, C) the #661 status prefetch still reads Stripe for a settled native row although the in-tx recurring return never uses it', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.prisma.$queryRaw = jest.fn(async () => [{ status: 'active', row_version: '7' }]);
    await h.svc.prefetchForOuterTx(ev('payment_intent.payment_failed', { id: 'pi_first' }) as any);
    expect(h.stripe.retrievePaymentIntent).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-OPUS-661D-120 G (C-661-3, second lander): the native first grant erases the spent PaymentSheet credentials', () => {
  it('G1 invoice.paid grants the first invoice: active and entitled, and the first-invoice client secret and ephemeral key are erased', async () => {
    const h = harness();
    await h.deliver(invoicePaid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
  });

  it('G2 customer.subscription.updated wins the race with invoice.paid and grants: credentials erased', async () => {
    const h = harness();
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
  });

  it('G3 a trial whose own card was saved is granted: trialing and entitled, the SetupIntent secret and ephemeral key are erased', async () => {
    const h = harness({ trial_days: 7, stripe_client_secret: SETI_SECRET, stripe_payment_intent_id: null });
    const trialing = sub('trialing', { default_payment_method: 'pm_card', cancel_at_period_end: false, trial_start: NOW });
    h.setLive(trialing);
    await h.deliver(ev('customer.subscription.updated', trialing));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
    expect(h.row().stripe_client_secret).toBeNull();
    expect(h.row().stripe_ephemeral_key).toBeNull();
  });

  it('G4 (control, constraint on the fix) a trial with no card yet is not granted and KEEPS its SetupIntent secret (the sheet still needs it)', async () => {
    const h = harness({ trial_days: 7, stripe_client_secret: SETI_SECRET, stripe_payment_intent_id: null });
    const noCard = sub('trialing', { default_payment_method: null, cancel_at_period_end: true, trial_start: NOW });
    h.setLive(noCard);
    await h.deliver(ev('customer.subscription.updated', noCard));
    await h.deliver(invoicePaid({ amount_paid: 0, charge: null }));
    expect(h.row()).toMatchObject({ entitlement_active: false, trial_started_at: null });
    expect(h.row().stripe_client_secret).toBe(SETI_SECRET);
    expect(h.row().stripe_ephemeral_key).toBe(EK);
  });
});
