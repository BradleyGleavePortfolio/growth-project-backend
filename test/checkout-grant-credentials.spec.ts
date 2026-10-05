// B-661R2-120 — #661 B-661-14 (Sol) / B-661-15 (Opus): the native first grant erases the
// spent PaymentSheet credentials in the same locked write, on both event owners
// (invoice.paid and customer.subscription.updated). An attempt that grants nothing keeps
// them: an unpaid first invoice, a declined first attempt, a trial whose own card is not
// saved (no default, or a default with the create-time end still set). Also pins the
// conflict-resolved end (C-661-15: H1a / H1d). The real handler on the recurring fakes
// (the AUD-OPUS-661D-120 probe harness). Cases marked "(failed before)" fail on #702 @
// 9ddda117 (src = #661 @ bc399edd).
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
  return { id: `evt_b661r2_${seq}`, type, data: { object } };
};
const invoicePaid = (over: Record<string, unknown> = {}) =>
  ev('invoice.paid', {
    id: 'in_1', subscription: 'sub_n', amount_paid: 4900, currency: 'usd', charge: 'ch_1',
    billing_reason: 'subscription_create', ...over,
  });
const trialRow = { trial_days: 7, stripe_client_secret: SETI_SECRET, stripe_payment_intent_id: null };

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
    retrievePaymentIntent: jest.fn(async () => ({ id: 'pi_first', status: 'succeeded' })),
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
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return {
    svc, prisma, fanout, dunning, deliver,
    row: () => prisma._purchases[0],
    setLive: (s: Record<string, unknown>) => { live = s; },
  };
}
const erased = { stripe_client_secret: null, stripe_ephemeral_key: null };

describe('B-661-14 / B-661-15: a native first grant erases the spent sheet credentials', () => {
  it('(failed before) G1 invoice.paid pays the first invoice: active, entitled, fanned out once, both erased', async () => {
    const h = harness();
    await h.deliver(invoicePaid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, ...erased });
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('(failed before) G2 customer.subscription.updated wins the race with invoice.paid: erased, and the late invoice.paid neither restores nor re-fans-out', async () => {
    const h = harness();
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, ...erased });
    await h.deliver(invoicePaid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, ...erased });
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('(failed before) G3 a trial whose own card was saved is granted by customer.subscription.updated: trialing, trial used, both erased', async () => {
    const h = harness(trialRow);
    const trialing = sub('trialing', { trial_start: NOW });
    h.setLive(trialing);
    await h.deliver(ev('customer.subscription.updated', trialing));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true, ...erased });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
  });

  it('(failed before) G3b the same carded trial granted by its $0 invoice.paid: both erased', async () => {
    const h = harness(trialRow);
    h.setLive(sub('trialing', { trial_start: NOW }));
    await h.deliver(invoicePaid({ amount_paid: 0, charge: null }));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true, ...erased });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
  });

  it('(failed before) G5 a first attempt declined, then paid: the decline keeps them for the retry, the grant erases them', async () => {
    const h = harness();
    await h.deliver(ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'Your card was declined.' } }));
    expect(h.row()).toMatchObject({ status: 'pending', entitlement_active: false });
    expect(h.row()).toMatchObject({ stripe_client_secret: PI_SECRET, stripe_ephemeral_key: EK });
    await h.deliver(invoicePaid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, ...erased });
  });
});

describe('controls: an attempt that grants nothing keeps its payable credentials', () => {
  it.each([
    ['no default card', { default_payment_method: null, cancel_at_period_end: true }],
    ['a default card with the create-time end still set', { cancel_at_period_end: true }],
  ])('G4 a trial with %s: not granted on either event, SetupIntent secret and key kept, no fanout', async (_name, over) => {
    const h = harness(trialRow);
    const unsaved = sub('trialing', { trial_start: NOW, ...over });
    h.setLive(unsaved);
    await h.deliver(ev('customer.subscription.updated', unsaved));
    await h.deliver(invoicePaid({ amount_paid: 0, charge: null }));
    expect(h.row()).toMatchObject({ entitlement_active: false, trial_started_at: null });
    expect(h.row()).toMatchObject({ stripe_client_secret: SETI_SECRET, stripe_ephemeral_key: EK });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('G6 an unpaid first invoice (incomplete): not granted, PaymentIntent secret and key kept', async () => {
    const h = harness();
    const incomplete = sub('incomplete', { default_payment_method: null });
    h.setLive(incomplete);
    await h.deliver(ev('customer.subscription.updated', incomplete));
    expect(h.row()).toMatchObject({ entitlement_active: false });
    expect(h.row()).toMatchObject({ stripe_client_secret: PI_SECRET, stripe_ephemeral_key: EK });
  });
});

describe('C-661-15: the conflict-resolved end erases on paid and carded-trial plans', () => {
  it('H1a a paid plan deleted on Stripe: canceled with Stripe canceled_at, drops canceled, dunning ended, both erased', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    const canceled = sub('canceled', { canceled_at: NOW - 60 });
    h.setLive(canceled);
    expect(await h.deliver(ev('customer.subscription.deleted', canceled))).toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false, ...erased });
    expect(h.row().canceled_at).toEqual(new Date((NOW - 60) * 1000));
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledWith('cp_native', 'subscription_canceled', h.prisma);
    expect(h.dunning.terminate).toHaveBeenCalledWith('cp_native', 'subscription_deleted');
  });

  it('H1d a carded trial deleted before any grant event: canceled, trial recorded as used, both erased', async () => {
    const h = harness(trialRow);
    await h.svc.handle(ev('customer.subscription.deleted', sub('canceled', { trial_start: NOW - DAY, canceled_at: NOW })), h.prisma);
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false, ...erased });
    expect(h.row().trial_started_at).toEqual(new Date((NOW - DAY) * 1000));
  });
});
