// Independent exact-head boundary probes, AUD-SOL-R34R5-117.
// Only provider and storage boundaries are doubles; the handler and the
// first-payment service/emitter are the real candidate implementations.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const PERIOD = NOW + 30 * 86400;
let sequence = 0;
const event = (type: string, object: Record<string, unknown>) => ({
  id: `evt_sol_r34_${++sequence}`, type, data: { object },
});
const subscription = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_sol_r34', status, customer: 'cus_sol_r34',
  current_period_end: PERIOD, default_payment_method: 'pm_sol_r34',
  cancel_at_period_end: false, ...over,
});
const paid = () => event('invoice.paid', {
  id: 'in_sol_r34', subscription: 'sub_sol_r34', amount_paid: 14800,
  currency: 'usd', charge: 'ch_sol_r34', billing_reason: 'subscription_cycle',
});
const failed = (reason = 'subscription_cycle') => event('invoice.payment_failed', {
  id: 'in_sol_r34', subscription: 'sub_sol_r34', amount_due: 14800,
  billing_reason: reason, attempt_count: 1,
  last_payment_error: { message: 'Your card was declined.' },
});

function fixture(over: Record<string, unknown> = {}, money = false) {
  const db = makeFakePrisma();
  db._packages.push({ id: 'pkg_sol_r34', billing_type: 'recurring', duration_periods: null });
  db._purchases.push({
    id: 'cp_sol_r34', package_id: 'pkg_sol_r34', client_user_id: 'client_sol_r34',
    coach_user_id: 'coach_sol_r34', amount_cents: 4900, currency: 'usd',
    billing_type: 'recurring', stripe_subscription_id: 'sub_sol_r34',
    stripe_checkout_session_id: 'sub_sol_r34', stripe_payment_intent_id: 'pi_sol_r34',
    stripe_customer_id: 'cus_sol_r34', stripe_client_secret: 'pi_sol_r34_secret_x',
    stripe_ephemeral_key: 'ek_sol_r34', status: 'active', entitlement_active: true,
    trial_days: null, trial_started_at: null, current_period_end: new Date(PERIOD * 1000),
    access_expires_at: new Date((PERIOD + 86400) * 1000),
    canceled_at: null, cancel_at_period_end: false, last_error: null,
    idempotency_key: 'sub-sol-r34', created_at: new Date(), ...over,
  });
  let live = subscription('active');
  let invoiceStatus = 'open';
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_sol_r34', status: invoiceStatus })),
  };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const notifications: any = { createNotification: jest.fn(async () => undefined) };
  const firstPayment = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));
  db.coachFirstPaymentNotification = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: any) => ({ id: 'fp_sol_r34', ...data })),
  };
  const handler = new CheckoutWebhookHandlerService(
    db, stripe, splits, dunning, undefined, fanout, undefined, undefined,
    money ? firstPayment : undefined,
  );
  const deliver = async (e: ReturnType<typeof event>) =>
    handler.handle(e, db, await handler.prefetchForOuterTx(e));
  return {
    db, stripe, handler, deliver, fanout, dunning, splits, notifications,
    row: () => db._purchases[0],
    setLive: (s: ReturnType<typeof subscription>) => { live = s; },
    setInvoice: (status: string) => { invoiceStatus = status; },
  };
}

describe('Sol R34: authority must stay valid until the serialized write', () => {
  it('B-680-2 narrowed: renewal payment wins after failed-invoice prefetch, then the delayed decline cannot reopen dunning', async () => {
    const h = fixture({ status: 'past_due', last_error: 'Your card was declined.' });
    const decline = failed();
    const pre = await h.handler.prefetchForOuterTx(decline);
    expect(pre.failedInvoiceStatus).toBe('open');
    h.setInvoice('paid');
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    try { await h.handler.handle(decline, h.db, pre); } catch (err) {
      expect(String(err)).toMatch(/redeliver/);
    }
    await h.deliver(decline);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('B-680-1 narrowed: an old paid-invoice read cannot regrant after a newer unpaid subscription write', async () => {
    const h = fixture();
    const payment = paid();
    const pre = await h.handler.prefetchForOuterTx(payment);
    h.setLive(subscription('unpaid'));
    await h.deliver(event('customer.subscription.updated', subscription('unpaid')));
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    // Redelivery or settlement-without-regrant is acceptable; stale activation is not.
    try { await h.handler.handle(payment, h.db, pre); } catch (err) {
      expect(String(err)).toMatch(/retry|redeliver/);
    }
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('B-680-2 narrowed: first-invoice decline cannot append its stale error after invoice.paid grants access', async () => {
    const h = fixture({ status: 'pending', entitlement_active: false });
    const realRead = h.db.clientPurchase.findUnique.getMockImplementation();
    h.db.clientPurchase.findUnique.mockImplementationOnce(async (args: any) => {
      const old = await realRead(args);
      await h.deliver(paid());
      return old;
    });
    await h.handler.handle(failed('subscription_create'), h.db, { failedInvoiceStatus: 'open' });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
  });

  it('B-680-2 narrowed: the PaymentIntent decline also rechecks the purchase after a concurrent grant', async () => {
    const h = fixture({ status: 'pending', entitlement_active: false });
    const realRead = h.db.clientPurchase.findFirst.getMockImplementation();
    h.db.clientPurchase.findFirst.mockImplementationOnce(async (args: any) => {
      const old = await realRead(args);
      await h.deliver(paid());
      return old;
    });
    await h.handler.handle(event('payment_intent.payment_failed', {
      id: 'pi_sol_r34', last_payment_error: { message: 'Your card was declined.' },
    }), h.db);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
  });

  it('control: a decline whose invoice was already paid at prefetch is ignored', async () => {
    const h = fixture();
    h.setInvoice('paid');
    await h.deliver(failed());
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: live subscription authority does not revive a canceled purchase', async () => {
    const h = fixture({ status: 'canceled', entitlement_active: false, canceled_at: new Date() });
    await h.deliver(event('customer.subscription.updated', subscription('active')));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });
});

describe('Sol R34 round 5: remaining authority counterexamples', () => {
  it('B-680-2 residual R119: a paid write into past_due is not the decline-associated subscription update', async () => {
    const h = fixture({ status: 'active', updated_at: new Date(Date.now() - 60_000) });
    h.setLive(subscription('past_due', { latest_invoice: 'in_sol_r34' }));
    const decline = failed();
    const pre = await h.handler.prefetchForOuterTx(decline);
    expect(pre.failedInvoiceAuthority?.purchaseStatus).toBe('active');
    h.setInvoice('paid');
    h.setLive(subscription('past_due', { latest_invoice: 'in_newer_still_open' }));
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'past_due', last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    try { await h.handler.handle(decline, h.db, pre); } catch (err) {
      expect(String(err)).toMatch(/redeliver/);
    }
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    expect(h.row().last_error).toBeNull();
  });

  it.each(['refunded', 'chargeback_lost'])('R119 terminal %s never regrants on live subscription update', async (status) => {
    const h = fixture({ status, entitlement_active: false });
    await h.deliver(event('customer.subscription.updated', subscription('active')));
    expect(h.row()).toMatchObject({ status, entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it.each(['canceled', 'expired', 'refunded', 'chargeback_lost'])('R119 terminal %s never regrants on a paid invoice prefetched after revocation', async (status) => {
    const h = fixture({ status, entitlement_active: false });
    const result = await h.deliver(paid());
    expect(result).toMatchObject({ deferredSplit: { charge_id: 'ch_sol_r34', invoice_amount_cents: 14800 } });
    expect(h.row()).toMatchObject({ status, entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('B-680-2 residual: a paid old invoice stays settled even if another invoice keeps the subscription past_due', async () => {
    const h = fixture({ status: 'past_due', updated_at: new Date(Date.now() - 60_000) });
    h.setLive(subscription('past_due', { latest_invoice: 'in_sol_r34' }));
    const decline = failed();
    const pre = await h.handler.prefetchForOuterTx(decline);
    h.setInvoice('paid');
    h.setLive(subscription('past_due', { latest_invoice: 'in_newer_still_open' }));
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'past_due', last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    try { await h.handler.handle(decline, h.db, pre); } catch (err) {
      expect(String(err)).toMatch(/redeliver/);
    }
    // The newer unpaid invoice is not permission to re-open the paid old one.
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    expect(h.row().last_error).toBeNull();
  });

  it('B-680-5: a default card with the create-time end still on is not proof that this attempt saved a card', async () => {
    const h = fixture({ status: 'pending', entitlement_active: false, trial_days: 7, cancel_at_period_end: true });
    h.setLive(subscription('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    await h.deliver(event('customer.subscription.updated', subscription('trialing')));
    expect(h.row()).toMatchObject({ entitlement_active: false, trial_started_at: null });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('B-680-5: the own successful SetupIntent lifts the create-time end even if the subscription already has a default', async () => {
    const h = fixture({
      status: 'trialing', entitlement_active: false, trial_days: 7,
      stripe_client_secret: 'seti_OwnR5_secret_x', cancel_at_period_end: true,
    });
    h.setLive(subscription('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    h.stripe.setSubscriptionDefaultPaymentMethod = jest.fn(async () => ({}));
    await h.deliver(event('setup_intent.succeeded', {
      id: 'seti_OwnR5', customer: 'cus_sol_r34', status: 'succeeded', payment_method: 'pm_own_r5',
    }));
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith({
      subscriptionId: 'sub_sol_r34', paymentMethodId: 'pm_own_r5',
      idempotencyKey: 'tgp-trial-card-sub_sol_r34-pm_own_r5',
      liftTrialEnd: true,
    });
  });

  it('control: a client-canceled already-granted trial is never resumed by redelivered SetupIntent success', async () => {
    const h = fixture({
      status: 'trialing', entitlement_active: true, trial_days: 7, trial_started_at: new Date(),
      stripe_client_secret: 'seti_OwnR5_secret_x', cancel_at_period_end: true,
    });
    h.setLive(subscription('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    h.stripe.setSubscriptionDefaultPaymentMethod = jest.fn(async () => ({}));
    await h.deliver(event('setup_intent.succeeded', {
      id: 'seti_OwnR5', customer: 'cus_sol_r34', status: 'succeeded', payment_method: 'pm_own_r5',
    }));
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(h.row().cancel_at_period_end).toBe(true);
  });
});

describe('Sol R34: paid invoice is distinct from subscription resync', () => {
  const oldFlag = process.env.FEATURE_ROMAN_FIRST_PAYMENT;
  beforeEach(() => { process.env.FEATURE_ROMAN_FIRST_PAYMENT = 'true'; });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env.FEATURE_ROMAN_FIRST_PAYMENT;
    else process.env.FEATURE_ROMAN_FIRST_PAYMENT = oldFlag;
  });

  it('B-680-3 narrowed: trial conversion with an unreadable subscription is not acknowledged without money effects', async () => {
    const h = fixture({ status: 'trialing', trial_days: 7, trial_started_at: new Date() }, true);
    h.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('Stripe unavailable'));
    let retriable = false;
    let result: any;
    try { result = await h.deliver(paid()); } catch (err) {
      expect(String(err)).toMatch(/retry|redeliver/);
      retriable = true;
    }
    // Either preserve retryability, or perform both money effects on the known paid invoice.
    if (!retriable) {
      expect(h.db.coachFirstPaymentNotification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: 14800, currency: 'usd' }),
      });
      expect(result.deferredSplit).toMatchObject({
        charge_id: 'ch_sol_r34', invoice_amount_cents: 14800,
      });
    }
  });

  it('control: readable trial conversion records the actual positive paid amount and exact charge', async () => {
    const h = fixture({ status: 'trialing', trial_days: 7, trial_started_at: new Date() }, true);
    const result = await h.deliver(paid());
    expect(h.db.coachFirstPaymentNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 14800, currency: 'usd' }),
    });
    expect(result.deferredSplit).toMatchObject({
      charge_id: 'ch_sol_r34', invoice_amount_cents: 14800,
    });
    expect(h.notifications.createNotification).toHaveBeenCalledTimes(2);
  });
});
