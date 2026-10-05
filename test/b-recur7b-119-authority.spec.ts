// B-RECUR7B-119 — #680 fix round 7. Sol R34 (agent 119) counterexamples
// (run 37228836878) and Opus C-680-11 / C-680-12 (run 37229300646) as
// regressions. Only Stripe and storage are doubles; the handler is the real
// implementation. `deliver` is the BillingService order: prefetch out of the
// transaction, then handle on it. Cases marked "(failed before)" fail on
// #680 @ 216489ff.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const PERIOD = NOW + 30 * 86400;
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_r7b_${seq}`, type, data: { object } };
};
const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_7b',
  status,
  customer: 'cus_7b',
  current_period_end: PERIOD,
  default_payment_method: 'pm_7b',
  cancel_at_period_end: false,
  ...over,
});
const paid = () =>
  ev('invoice.paid', {
    id: 'in_7b',
    subscription: 'sub_7b',
    amount_paid: 14800,
    currency: 'usd',
    charge: 'ch_7b',
    billing_reason: 'subscription_cycle',
  });
const declined = () =>
  ev('invoice.payment_failed', {
    id: 'in_7b',
    subscription: 'sub_7b',
    amount_due: 14800,
    attempt_count: 2,
    billing_reason: 'subscription_cycle',
    last_payment_error: { message: 'Your card was declined.' },
  });

function harness(over: Record<string, unknown> = {}) {
  const db = makeFakePrisma();
  db._packages.push({ id: 'pkg_7b', billing_type: 'recurring', duration_periods: null });
  db._purchases.push({
    id: 'cp_7b',
    package_id: 'pkg_7b',
    client_user_id: 'client_7b',
    coach_user_id: 'coach_7b',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: 'sub_7b',
    stripe_checkout_session_id: 'sub_7b',
    stripe_payment_intent_id: 'pi_7b',
    stripe_customer_id: 'cus_7b',
    stripe_client_secret: 'pi_7b_secret_x',
    stripe_ephemeral_key: 'ek_7b',
    status: 'active',
    entitlement_active: true,
    trial_days: null,
    trial_started_at: null,
    current_period_end: new Date(PERIOD * 1000),
    access_expires_at: new Date((PERIOD + 86400) * 1000),
    canceled_at: null,
    cancel_at_period_end: false,
    last_error: null,
    idempotency_key: 'sub-7b',
    // Older than any write below, so every write moves the version.
    created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(Date.now() - 60_000),
    ...over,
  });
  let live: Record<string, unknown> = sub('active');
  let invoiceStatus = 'open';
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_7b', status: invoiceStatus })),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const svc = new CheckoutWebhookHandlerService(db, stripe, splits, dunning, undefined, fanout);
  const deliver = async (e: ReturnType<typeof ev>) =>
    svc.handle(e, db, await svc.prefetchForOuterTx(e));
  return {
    db,
    svc,
    deliver,
    fanout,
    dunning,
    row: () => db._purchases[0],
    setLive: (s: Record<string, unknown>) => {
      live = s;
    },
    setInvoice: (status: string) => {
      invoiceStatus = status;
    },
    // What the refund / dispute handler writes (refund-dispute-handler.service.ts).
    revoke: (status: string) => {
      Object.assign(db._purchases[0], {
        status,
        entitlement_active: false,
        updated_at: new Date(),
      });
    },
  };
}

const MONEY_REVOKED = ['refunded', 'chargeback_lost', 'disputed'];
const REVOKED = ['canceled', 'expired', ...MONEY_REVOKED];

describe('B-680-1 (R119): a revoked plan never regains access from a Stripe event', () => {
  it.each(MONEY_REVOKED)(
    '(failed before) %s: a live active subscription update grants nothing and seeds nothing',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      await expect(
        h.deliver(ev('customer.subscription.updated', sub('active'))),
      ).resolves.toMatchObject({ claimed: true, reason: 'subscription_already_ended' });
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    },
  );

  it.each(MONEY_REVOKED)(
    '(failed before) %s: the pause_collection update the dispute pause sends restores nothing',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      const paused = sub('active', { pause_collection: { behavior: 'void', resumes_at: null } });
      h.setLive(paused);
      await h.deliver(ev('customer.subscription.updated', paused));
      const cancelAtEnd = sub('active', {
        pause_collection: { behavior: 'void' },
        cancel_at_period_end: true,
      });
      h.setLive(cancelAtEnd);
      await h.deliver(ev('customer.subscription.updated', cancelAtEnd));
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    },
  );

  it.each(REVOKED)(
    '(failed before) %s: a paid invoice read after the revocation keeps it revoked; the charge still settles',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      const result = await h.deliver(paid());
      expect(result).toMatchObject({
        claimed: true,
        deferredSplit: { charge_id: 'ch_7b', invoice_amount_cents: 14800 },
      });
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    },
  );

  it.each(REVOKED)(
    '(failed before for refunded, chargeback_lost, disputed) %s: a delayed old paid invoice read before the revocation keeps it revoked, no redelivery; the charge still settles',
    async (status) => {
      const h = harness();
      const e = paid();
      const pre = await h.svc.prefetchForOuterTx(e);
      h.revoke(status);
      await expect(h.svc.handle(e, h.db, pre)).resolves.toMatchObject({
        claimed: true,
        deferredSplit: { charge_id: 'ch_7b', invoice_amount_cents: 14800 },
      });
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
      expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    },
  );

  it.each(MONEY_REVOKED)(
    '(failed before) %s: a subscription update read before the revocation restores nothing',
    async (status) => {
      const h = harness();
      const e = ev('customer.subscription.updated', sub('active'));
      const pre = await h.svc.prefetchForOuterTx(e);
      h.revoke(status);
      await expect(h.svc.handle(e, h.db, pre)).resolves.toMatchObject({
        reason: 'subscription_already_ended',
      });
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
    },
  );

  it.each(MONEY_REVOKED)(
    '(failed before) %s: the deletion keeps the revocation history; a decline opens no dunning',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      h.setLive(sub('past_due', { latest_invoice: 'in_7b' }));
      await expect(h.deliver(declined())).resolves.toMatchObject({
        reason: 'subscription_already_ended',
      });
      expect(h.dunning.recordFailure).not.toHaveBeenCalled();
      const gone = sub('canceled', { canceled_at: NOW });
      h.setLive(gone);
      await h.deliver(ev('customer.subscription.deleted', gone));
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
    },
  );

  it('control: a dispute on this tree that kept access (entitled) still follows Stripe; no regrant path is needed', async () => {
    const h = harness({ status: 'disputed', entitlement_active: true });
    const gone = sub('canceled', { canceled_at: NOW });
    h.setLive(gone);
    await h.deliver(ev('customer.subscription.deleted', gone));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
  });

  it('control: a first paid invoice still grants a pending attempt and seeds content once', async () => {
    const h = harness({ status: 'pending', entitlement_active: false });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('control: a renewal paid on a running plan still renews it', async () => {
    const h = harness({ status: 'past_due', last_error: 'Your card was declined.' });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
  });
});

describe('B-680-2 (R119): no write after the decline read is exempt from the fence', () => {
  it('(failed before) a paid write into past_due (another invoice unpaid) never lets the old decline reopen dunning', async () => {
    const h = harness({ status: 'active' });
    h.setLive(sub('past_due', { latest_invoice: 'in_7b' }));
    const decline = declined();
    const pre = await h.svc.prefetchForOuterTx(decline);
    h.setInvoice('paid');
    h.setLive(sub('past_due', { latest_invoice: 'in_newer_still_open' }));
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'past_due', last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    await expect(h.svc.handle(decline, h.db, pre)).rejects.toThrow(/redeliver/);
    await expect(h.deliver(decline)).resolves.toMatchObject({ reason: 'invoice_already_settled' });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    expect(h.row().last_error).toBeNull();
  });

  it('control: the paired past_due update first costs one redelivery; then dunning opens once', async () => {
    const h = harness({ status: 'active' });
    h.setLive(sub('past_due', { latest_invoice: 'in_7b' }));
    const decline = declined();
    const pre = await h.svc.prefetchForOuterTx(decline);
    await h.deliver(ev('customer.subscription.updated', sub('past_due')));
    await expect(h.svc.handle(decline, h.db, pre)).rejects.toThrow(/redeliver/);
    await expect(h.deliver(decline)).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({
      status: 'past_due',
      entitlement_active: true,
      // D4 (C-690-1): last_error is a decline code, never Stripe's message.
      last_error: 'invoice_payment_failed',
    });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: an open latest-invoice decline with nothing in between enters dunning at once', async () => {
    const h = harness();
    h.setLive(sub('past_due', { latest_invoice: 'in_7b' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('C-680-11: a decline never rewrites unpaid as past_due', () => {
  it('(failed before) unpaid (access ended), a retry decline: stays unpaid without access', async () => {
    const h = harness({ status: 'unpaid', entitlement_active: false });
    h.setLive(sub('unpaid', { latest_invoice: 'in_7b' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
  });
});
