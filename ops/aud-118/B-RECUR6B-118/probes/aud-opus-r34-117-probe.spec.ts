// AUD-OPUS-R34-117 (lens Claude Opus 5.5, agent 117) — independent probes on
// #680 @ 8e05ad0ecf11b5ebf6c1002956bb99616702abe8. Test-only; never merged.
// Every case drives the REAL CheckoutWebhookHandlerService in the BillingService
// order (prefetchForOuterTx out of the tx, then handle on it) against the
// shared in-memory fakes. "control" cases are expected green; "observation"
// cases pin current behaviour the verdict discusses; "outside this diff"
// cases are main-era behaviour expected RED (acceptance assertions).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_p',
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
  return { id: `evt_p${seq}`, type, data: { object } };
};

function harness(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_p', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    stripe_checkout_session_id: 'sub_p', stripe_subscription_id: 'sub_p',
    stripe_payment_intent_id: 'pi_first', stripe_customer_id: 'cus_1',
    stripe_client_secret: 'pi_first_secret_x', stripe_ephemeral_key: 'ek_x',
    status: 'pending', entitlement_active: false, cancel_at_period_end: false,
    current_period_end: null, canceled_at: null, trial_days: null, trial_started_at: null,
    last_error: null, idempotency_key: 'sub-client-k', created_at: new Date(), ...over,
  });
  let live: Record<string, unknown> = sub('active');
  let invoice: Record<string, unknown> = { id: 'in_1', status: 'open' };
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ ...invoice })),
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
  const svc = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout);
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return {
    svc, prisma, stripe, dunning, fanout, splits, deliver,
    row: () => prisma._purchases[0],
    setLive: (s: Record<string, unknown>) => { live = s; },
    setInvoice: (i: Record<string, unknown>) => { invoice = i; },
  };
}

describe('AUD-OPUS-R34-117 observation: benign concurrent writes and the revision fence', () => {
  it('observation: created(incomplete) racing the checkout bind (current_period_end write) answers 5xx once, then applies on redelivery', async () => {
    const meta = { tgp_package_id: 'pkg', tgp_client_user_id: 'client', tgp_coach_user_id: 'coach', tgp_purchase_id: 'cp_p' };
    const h = harness({ stripe_subscription_id: null, stripe_checkout_session_id: 'sub-res-sub-client-k', stripe_payment_intent_id: null });
    h.setLive(sub('incomplete', { default_payment_method: null, metadata: meta }));
    const e = ev('customer.subscription.created', sub('incomplete', { default_payment_method: null, metadata: meta }));
    const pre = await h.svc.prefetchForOuterTx(e);
    // The checkout's bind lands after the webhook read the row (same values as subscription-checkout.service bind).
    Object.assign(h.row(), {
      stripe_checkout_session_id: 'sub_p', stripe_subscription_id: 'sub_p', stripe_payment_intent_id: 'pi_first',
      current_period_end: new Date((NOW + 30 * DAY) * 1000),
    });
    await expect(h.svc.handle(e, h.prisma, pre)).rejects.toThrow(/changed during the Stripe read/);
    expect(h.row().status).toBe('pending');
    // Stripe redelivers the same event id later: it applies.
    await expect(h.deliver(e)).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'incomplete', entitlement_active: false });
  });

  it('control: trial created(trialing, no card) racing its own $0 invoice.paid is claimed unchanged, never a 5xx', async () => {
    const h = harness({ trial_days: 7, stripe_client_secret: 'seti_p_secret_x', stripe_payment_intent_id: null });
    h.setLive(sub('trialing', { default_payment_method: null, trial_start: NOW }));
    const e = ev('customer.subscription.created', sub('trialing', { default_payment_method: null, trial_start: NOW }));
    const pre = await h.svc.prefetchForOuterTx(e);
    await h.deliver(ev('invoice.paid', { id: 'in_0', subscription: 'sub_p', amount_paid: 0, currency: 'usd', billing_reason: 'subscription_create' }));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: false, trial_started_at: null });
    await expect(h.svc.handle(e, h.prisma, pre)).resolves.toMatchObject({ claimed: true, reason: 'subscription_unchanged' });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('control: renewal updated(active, new period) racing the renewal invoice.paid is claimed unchanged', async () => {
    const h = harness({ status: 'active', entitlement_active: true, current_period_end: new Date((NOW + 2 * DAY) * 1000) });
    h.setLive(sub('active', { current_period_end: NOW + 32 * DAY }));
    const e = ev('customer.subscription.updated', sub('active', { current_period_end: NOW + 32 * DAY }));
    const pre = await h.svc.prefetchForOuterTx(e);
    await h.deliver(ev('invoice.paid', { id: 'in_2', subscription: 'sub_p', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', charge: 'ch_2' }));
    await expect(h.svc.handle(e, h.prisma, pre)).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.row().current_period_end).toEqual(new Date((NOW + 32 * DAY) * 1000));
  });
});

describe('AUD-OPUS-R34-117 controls: ended subscriptions and declines', () => {
  it('control: updated(live canceled) ends a running plan once (drops canceled, dunning terminated); the later deletion repeats nothing', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setLive(sub('canceled', { canceled_at: NOW }));
    await h.deliver(ev('customer.subscription.updated', sub('canceled', { canceled_at: NOW })));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledTimes(1);
    expect(h.dunning.terminate).toHaveBeenCalledTimes(1);
    await h.deliver(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW })));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledTimes(1);
  });

  it('control: deletion without an outer tx runs under its own locked transaction and still cancels drops', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    await h.svc.handle(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW })));
    expect(h.prisma.$transaction).toHaveBeenCalled();
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledTimes(1);
  });

  it('control: a decline on an uncollectible renewal invoice of a running plan still enters dunning', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setInvoice({ id: 'in_2', status: 'uncollectible' });
    await h.deliver(ev('invoice.payment_failed', { id: 'in_2', subscription: 'sub_p', amount_due: 4900, attempt_count: 2, billing_reason: 'subscription_cycle' }));
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: the trial-end charge of a trial whose card was never saved is not a renewal (no past_due, no dunning)', async () => {
    const h = harness({ status: 'trialing', trial_days: 7, stripe_client_secret: 'seti_p_secret_x', stripe_payment_intent_id: null });
    await h.deliver(ev('invoice.payment_failed', { id: 'in_t', subscription: 'sub_p', amount_due: 4900, attempt_count: 1, billing_reason: 'subscription_cycle' }));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: false });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: the decline of a carded, granted trial at conversion enters dunning', async () => {
    const h = harness({ status: 'trialing', entitlement_active: true, trial_days: 7, trial_started_at: new Date() });
    await h.deliver(ev('invoice.payment_failed', { id: 'in_t', subscription: 'sub_p', amount_due: 4900, attempt_count: 1, billing_reason: 'subscription_cycle' }));
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-OPUS-R34-117 observation: a locally ended row whose Stripe subscription still bills', () => {
  it('observation: updated(live active) keeps the locally canceled row ended; the next paid invoice re-grants (money collected)', async () => {
    // e.g. dunning adminCancel marked the row canceled although its Stripe cancel failed.
    const h = harness({ status: 'canceled', entitlement_active: false, canceled_at: new Date() });
    h.setLive(sub('active'));
    await expect(h.deliver(ev('customer.subscription.updated', sub('active')))).resolves.toMatchObject({ reason: 'subscription_already_ended' });
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    await h.deliver(ev('invoice.paid', { id: 'in_3', subscription: 'sub_p', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', charge: 'ch_3' }));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });
});

describe('AUD-OPUS-R34-117 outside this diff (main-era, expected RED): renewal invoice.paid when the subscription read fails', () => {
  it('outside this diff: a paid dunning retry whose subscription prefetch fails still resolves dunning and posts the split', async () => {
    const h = harness({ status: 'past_due', entitlement_active: true });
    h.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('stripe down'));
    let threw = false;
    let r: Record<string, unknown> = {};
    try {
      r = (await h.deliver(ev('invoice.paid', { id: 'in_4', subscription: 'sub_p', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', charge: 'ch_4' }))) as Record<string, unknown>;
    } catch {
      threw = true; // redelivery is an acceptable answer
    }
    if (!threw) {
      // Processed: it must not be marked done without the dunning resolution and the split.
      expect(h.dunning.recordResolution).toHaveBeenCalledWith('cp_p');
      expect(r).toHaveProperty('deferredSplit');
    }
  });
});

describe('AUD-OPUS-R34-117 post-verdict reassessment (acceptance, expected RED at 8e05ad0e)', () => {
  it('a renewal decline whose invoice was paid between the invoice read and the lock does not reopen dunning', async () => {
    const h = harness({ status: 'past_due', entitlement_active: true, last_error: 'Your card was declined.' });
    h.setInvoice({ id: 'in_5', status: 'open' });
    const decline = ev('invoice.payment_failed', { id: 'in_5', subscription: 'sub_p', amount_due: 4900, attempt_count: 3, billing_reason: 'subscription_cycle', last_payment_error: { message: 'Your card was declined.' } });
    const pre = await h.svc.prefetchForOuterTx(decline);
    // The same invoice is paid (second card) and its invoice.paid commits first.
    h.setInvoice({ id: 'in_5', status: 'paid' });
    h.setLive(sub('active'));
    await h.deliver(ev('invoice.paid', { id: 'in_5', subscription: 'sub_p', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', charge: 'ch_5' }));
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    let threw = false;
    try {
      await h.svc.handle(decline, h.prisma, pre);
    } catch {
      threw = true; // redelivery re-reads the invoice as paid: acceptable
    }
    if (!threw) {
      expect(h.row()).toMatchObject({ status: 'active', last_error: null });
      expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    }
  });

  it('an invoice.paid whose subscription read predates a committed unpaid update does not regrant', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setLive(sub('active'));
    const paid = ev('invoice.paid', { id: 'in_6', subscription: 'sub_p', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', charge: 'ch_6' });
    const pre = await h.svc.prefetchForOuterTx(paid);
    h.setLive(sub('unpaid'));
    await h.deliver(ev('customer.subscription.updated', sub('unpaid')));
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    let threw = false;
    try {
      await h.svc.handle(paid, h.prisma, pre);
    } catch {
      threw = true;
    }
    if (!threw) expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
  });
});
