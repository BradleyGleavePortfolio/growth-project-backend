// B-RECUR3-117 — #680 fix round 4. Stripe does not deliver webhook events in
// order and retries a failed delivery for up to three days. Each case below
// delivers the events of ONE native subscription in an order Stripe allows
// (the R3 lens probes, rebuilt here) and asserts the purchase ends where
// Stripe ends. `deliver` is the BillingService order: prefetch out of the
// transaction, then handle on it. Cases marked "(failed before)" fail on #680
// @ 929f3968 without the fix.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

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
  return { id: `evt_${seq}`, type, data: { object } };
};
const invoicePaid = (over: Record<string, unknown> = {}) =>
  ev('invoice.paid', {
    id: 'in_1', subscription: 'sub_n', amount_paid: 4900, currency: 'usd', charge: 'ch_1',
    billing_reason: 'subscription_create', ...over,
  });
const declined = (over: Record<string, unknown> = {}) =>
  ev('invoice.payment_failed', {
    id: 'in_1', subscription: 'sub_n', amount_due: 4900, attempt_count: 1,
    billing_reason: 'subscription_create', last_payment_error: { message: 'Your card was declined.' }, ...over,
  });

function harness(over: Record<string, unknown> = {}, firstPayment?: CoachFirstPaymentService) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_native', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    stripe_checkout_session_id: 'sub_n', stripe_subscription_id: 'sub_n',
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
  const svc = new CheckoutWebhookHandlerService(
    prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, firstPayment,
  );
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return {
    svc, prisma, stripe, dunning, fanout, deliver,
    row: () => prisma._purchases[0],
    setLive: (s: Record<string, unknown>) => { live = s; },
    setInvoice: (i: Record<string, unknown>) => { invoice = i; },
  };
}

describe('B-680-1 / C-680-3: the live subscription, not a late payload, decides access', () => {
  it('(failed before) invoice.paid granted, then the created event (first delivery failed) arrives: the plan stays paid', async () => {
    const h = harness();
    await h.deliver(invoicePaid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
    await h.deliver(ev('customer.subscription.created', sub('incomplete', { default_payment_method: null })));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('(failed before) without a live read, a late incomplete snapshot never revokes a started plan', async () => {
    const h = harness();
    await h.svc.handle(ev('customer.subscription.updated', sub('active')), h.prisma);
    await h.svc.handle(ev('customer.subscription.created', sub('incomplete', { default_payment_method: null })), h.prisma);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('(failed before) a deleted paid plan is never revived by an older active snapshot; no second content fan-out', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setLive(sub('canceled', { canceled_at: NOW }));
    await h.deliver(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW })));
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('(failed before) C-680-3: deleted, then a stale past_due snapshot without a live read: stays canceled', async () => {
    const h = harness({ status: 'past_due', entitlement_active: true });
    await h.svc.handle(ev('customer.subscription.deleted', sub('canceled', { canceled_at: NOW })), h.prisma);
    await h.svc.handle(ev('customer.subscription.updated', sub('past_due')), h.prisma);
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
  });

  it('(failed before) a past_due payload delivered after the retry paid: the purchase follows Stripe (active)', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    await h.deliver(ev('customer.subscription.updated', sub('past_due')));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('(failed before) Stripe unreadable: the event is redelivered and the purchase is untouched', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(new Error('stripe down'));
    await expect(h.deliver(ev('customer.subscription.updated', sub('past_due')))).rejects.toThrow(/redeliver/);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('(failed before) a write that lands between the Stripe read and the lock is never overwritten: redeliver', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    const e = ev('customer.subscription.updated', sub('active'));
    const pre = await h.svc.prefetchForOuterTx(e);
    h.row().cancel_at_period_end = true; // a newer delivery committed meanwhile
    await expect(h.svc.handle(e, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(h.row().cancel_at_period_end).toBe(true);
  });

  it('control: a concurrent write that matches the live state is claimed without a write or a redelivery', async () => {
    const h = harness();
    const e = ev('customer.subscription.updated', sub('active'));
    const pre = await h.svc.prefetchForOuterTx(e);
    Object.assign(h.row(), { status: 'active', entitlement_active: true }); // invoice.paid won
    await expect(h.svc.handle(e, h.prisma, pre)).resolves.toMatchObject({ claimed: true });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });
});

describe('B-680-2: a late or settled decline never opens dunning', () => {
  it('(failed before) the first-invoice decline delivered after a second card paid: no past_due, no dunning, no decline text', async () => {
    const h = harness();
    await h.deliver(invoicePaid());
    await h.svc.handle(declined(), h.prisma);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) the first-invoice PaymentIntent decline after invoice.paid leaves no decline on the paid plan', async () => {
    const h = harness();
    await h.deliver(invoicePaid());
    await h.deliver(ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'Your card was declined.' } }));
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
  });

  it('(failed before) Stripe expired the abandoned attempt, then the decline arrives: it stays ended', async () => {
    const h = harness();
    h.setLive(sub('incomplete_expired', { default_payment_method: null }));
    await h.deliver(ev('customer.subscription.updated', sub('incomplete_expired', { default_payment_method: null })));
    await h.deliver(declined());
    expect(h.row()).toMatchObject({ status: 'incomplete_expired', entitlement_active: false });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) an attempt retired by checkout (expired), then a late renewal-shaped decline: it stays expired', async () => {
    const h = harness({ status: 'expired' });
    await h.svc.handle(declined({ billing_reason: 'subscription_cycle' }), h.prisma);
    expect(h.row().status).toBe('expired');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) a renewal decline delivered after its retry paid the invoice: no past_due, no dunning', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.setInvoice({ id: 'in_2', status: 'paid' });
    await h.deliver(declined({ id: 'in_2', billing_reason: 'subscription_cycle' }));
    expect(h.row().status).toBe('active');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) the invoice cannot be read on Stripe: redeliver, nothing written', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    h.stripe.retrieveInvoice.mockRejectedValueOnce(new Error('stripe down'));
    await expect(h.deliver(declined({ id: 'in_2', billing_reason: 'subscription_cycle' }))).rejects.toThrow(/redeliver/);
    expect(h.row().status).toBe('active');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(race) the deletion commits between the decline read and its write: the plan stays canceled, no dunning', async () => {
    const h = harness({ status: 'past_due', entitlement_active: true });
    // The deletion holds the package lock first; the decline waits on it.
    h.prisma.$queryRaw.mockImplementationOnce(async () => {
      Object.assign(h.row(), { status: 'canceled', entitlement_active: false, canceled_at: new Date() });
      return [];
    });
    await expect(h.deliver(declined({ id: 'in_3', billing_reason: 'subscription_cycle', attempt_count: 4 })))
      .resolves.toMatchObject({ reason: 'subscription_already_ended' });
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: an open renewal decline on a running plan still enters dunning (access kept)', async () => {
    const h = harness({ status: 'active', entitlement_active: true });
    await h.deliver(declined({ id: 'in_2', billing_reason: 'subscription_cycle' }));
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: a decline while the client is still in the sheet records the decline only', async () => {
    const h = harness();
    await expect(h.deliver(declined())).resolves.toMatchObject({ reason: 'first_attempt_declined' });
    expect(h.row()).toMatchObject({ status: 'pending', last_error: 'Your card was declined.' });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });
});

describe('B-680-3 / C-680-6: the first-payment notice is money collected, never access granted', () => {
  const flag = process.env.FEATURE_ROMAN_FIRST_PAYMENT;
  beforeEach(() => { process.env.FEATURE_ROMAN_FIRST_PAYMENT = 'true'; });
  afterEach(() => {
    if (flag === undefined) delete process.env.FEATURE_ROMAN_FIRST_PAYMENT;
    else process.env.FEATURE_ROMAN_FIRST_PAYMENT = flag;
  });
  function money(over: Record<string, unknown> = {}, alreadySent = false) {
    const notifications: any = { createNotification: jest.fn(async () => undefined) };
    const h = harness(over, new CoachFirstPaymentService(new FirstPaymentEmitter(notifications)));
    const ledger = {
      findUnique: jest.fn(async () => (alreadySent ? { id: 'fp_1' } : null)),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'fp_new', ...data })),
    };
    h.prisma.coachFirstPaymentNotification = ledger;
    return { ...h, ledger, notifications };
  }

  it('(failed before) saving a free trial card sends no first-payment notice', async () => {
    const h = money({ trial_days: 7 });
    h.setLive(sub('trialing', { trial_start: NOW }));
    await h.deliver(ev('customer.subscription.updated', sub('trialing', { trial_start: NOW })));
    expect(h.row().entitlement_active).toBe(true);
    expect(h.ledger.create).not.toHaveBeenCalled();
    expect(h.notifications.createNotification).not.toHaveBeenCalled();
  });

  it('(failed before) the first paid invoice after a trial records the amount Stripe collected', async () => {
    const h = money({ trial_days: 7, trial_started_at: new Date(), status: 'trialing', entitlement_active: true });
    await h.deliver(invoicePaid({ billing_reason: 'subscription_cycle' }));
    expect(h.ledger.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 4900, currency: 'usd' }) });
  });

  it('(failed before) a combo first invoice reports the $148 paid, not the $49 renewal', async () => {
    const h = money();
    await h.deliver(invoicePaid({ amount_paid: 14800 }));
    expect(h.ledger.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 14800 }) });
  });

  it('control: a coach who already has the notice is skipped before the insert; a $0 invoice never sends one', async () => {
    const h = money({ status: 'active', entitlement_active: true }, true);
    await h.deliver(invoicePaid({ billing_reason: 'subscription_cycle' }));
    expect(h.ledger.create).not.toHaveBeenCalled();
    const z = money({ trial_days: 7 });
    z.setLive(sub('trialing', { trial_start: NOW }));
    await z.deliver(invoicePaid({ amount_paid: 0 }));
    expect(z.ledger.findUnique).not.toHaveBeenCalled();
  });
});

describe('B-680-4 / C-680-5 / C-680-4: trial use and attempt binding survive any delivery order', () => {
  it('(failed before) the paid conversion delivered before the trialing event still uses the one trial with this coach', async () => {
    const CLIENT = '11111111-1111-4111-8111-111111111111';
    const COACH = '22222222-2222-4222-8222-222222222222';
    const PKG = '33333333-3333-4333-8333-333333333333';
    const PKG2 = '44444444-4444-4444-8444-444444444444';
    const prisma = makeFakePrisma();
    const stripe = makeFakeStripe();
    prisma._users.push(
      { id: CLIENT, email: 'client@example.test', name: 'Client', coach_id: COACH },
      { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
    );
    const pkg = {
      coach_id: COACH, name: 'Coaching', amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
      interval: 'month', interval_count: 1, recurring_amount_cents: null, recurring_interval: null,
      recurring_interval_count: null, recurring_stripe_price_id: null, stripe_price_id: 'price_trial',
      trial_days: 7, is_active: true, archived_at: null, published_at: new Date(),
    };
    prisma._packages.push({ ...pkg, id: PKG }, { ...pkg, id: PKG2 });
    prisma._accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true, deauthorized_at: null });
    const packages: any = { getById: jest.fn(async (id: string) => prisma._packages.find((p: { id: string }) => p.id === id)) };
    const fee: any = { planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_id: null })) };
    const ready: any = { ready: true };
    const helpers: any = makeCheckoutHelpers(prisma);
    const checkout = new SubscriptionCheckoutService(prisma, stripe, packages, ready, fee, helpers);
    const handler = new CheckoutWebhookHandlerService(prisma, stripe);
    const oldKey = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
    try {
      const first = await checkout.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      stripe._saveTrialCard(first.subscription_id);
      const live = stripe._subs.get(first.subscription_id);
      Object.assign(live, { status: 'active', default_payment_method: 'pm_card', trial_start: NOW - 7 * DAY, trial_end: NOW });
      await handler.handle({ id: 'evt_conv', type: 'customer.subscription.updated', data: { object: { ...live } } }, prisma);
      await handler.handle({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: first.subscription_id, canceled_at: NOW } } }, prisma);
      await checkout.createSubscriptionIntent(CLIENT, { package_id: PKG2, idempotency_key: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      expect(prisma._purchases[0].trial_started_at).toEqual(new Date((NOW - 7 * DAY) * 1000));
      expect(stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBeUndefined();
    } finally {
      if (oldKey === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
      else process.env.STRIPE_PUBLISHABLE_KEY = oldKey;
    }
  });

  it('(failed before) a carded trial that ended before any grant event arrived is recorded as used (canceled, not expired)', async () => {
    const h = harness({ trial_days: 7, stripe_client_secret: 'seti_n_secret_x' });
    await h.svc.handle(ev('customer.subscription.deleted', sub('canceled', { trial_start: NOW - DAY, canceled_at: NOW })), h.prisma);
    expect(h.row()).toMatchObject({ status: 'canceled', entitlement_active: false });
    expect(h.row().trial_started_at).toEqual(new Date((NOW - DAY) * 1000));
  });

  it('(failed before) C-680-4: an attempt bound by the webhook fallback ends as an expired attempt, not churn', async () => {
    const h = harness({ stripe_subscription_id: null, stripe_payment_intent_id: null, stripe_checkout_session_id: 'sub-retry-sub-client-k' });
    const metadata = { tgp_package_id: 'pkg', tgp_client_user_id: 'client', tgp_coach_user_id: 'coach', tgp_purchase_id: 'cp_native' };
    // The live read expands the first invoice; the event payload carries only its id.
    h.setLive(sub('incomplete', { default_payment_method: null, metadata, latest_invoice: { id: 'in_1', payment_intent: { id: 'pi_first' } } }));
    await h.deliver(ev('customer.subscription.created', sub('incomplete', { default_payment_method: null, metadata, latest_invoice: 'in_1' })));
    expect(h.row()).toMatchObject({ stripe_subscription_id: 'sub_n', stripe_checkout_session_id: 'sub_n', stripe_payment_intent_id: 'pi_first' });
    await h.svc.handle(ev('customer.subscription.deleted', sub('incomplete_expired', { default_payment_method: null, metadata })), h.prisma);
    expect(h.row().status).toBe('expired');
  });
});
