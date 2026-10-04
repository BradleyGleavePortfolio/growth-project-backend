import { Logger } from '@nestjs/common';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

// Audit-only probes. Candidate code remains byte-identical to #680 @2b10687c.
// Delivery order is intentionally different from object creation order.
const NOW = 1_800_000_000;
const CANARY = 'audit.person@example.test';

function setup(over: Record<string, unknown> = {}, firstPayment?: any) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_native', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    stripe_subscription_id: 'sub_native', stripe_checkout_session_id: 'sub_native',
    stripe_payment_intent_id: 'pi_first', stripe_customer_id: 'cus_native',
    stripe_client_secret: 'seti_native_secret_fake', stripe_ephemeral_key: 'ek_fake',
    status: 'pending', entitlement_active: false, trial_days: null, trial_started_at: null,
    current_period_end: null, canceled_at: null, cancel_at_period_end: false, last_error: null,
    idempotency_key: 'sub-client-key', created_at: new Date(),
    ...over,
  });
  let live: any = {
    id: 'sub_native', status: 'active', default_payment_method: 'pm_card',
    current_period_end: NOW + 30 * 86400,
  };
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    setSubscriptionDefaultPaymentMethod: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_first', status: 'paid', paid: true })),
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
  const svc = new CheckoutWebhookHandlerService(
    prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, firstPayment,
  );
  return {
    svc, prisma, stripe, fanout, dunning, splits,
    row: () => prisma._purchases[0],
    canonical: (patch: Record<string, unknown>) => { live = { ...live, ...patch }; },
  };
}

const subEvent = (id: string, status: string, patch: Record<string, unknown> = {}) => ({
  id, type: 'customer.subscription.updated',
  created: NOW - 100,
  data: { object: {
    id: 'sub_native', status, current_period_end: NOW + 30 * 86400,
    default_payment_method: 'pm_card', ...patch,
  } },
});
const deletion = () => ({
  id: 'evt_deleted', type: 'customer.subscription.deleted', created: NOW,
  data: { object: { id: 'sub_native', status: 'canceled', canceled_at: NOW } },
});
const invoicePaid = () => ({
  id: 'evt_paid', type: 'invoice.paid', created: NOW,
  data: { object: {
    id: 'in_first', subscription: 'sub_native', amount_paid: 4900, charge: 'ch_first',
    paid: true, status: 'paid', status_transitions: { paid_at: NOW },
  } },
});
const invoiceFailed = () => ({
  id: 'evt_old_failed', type: 'invoice.payment_failed', created: NOW - 100,
  data: { object: {
    id: 'in_first', subscription: 'sub_native', amount_due: 4900,
    billing_reason: 'subscription_create',
    attempt_count: 1, status: 'open', paid: false,
    last_payment_error: { message: 'Your card was declined.' },
  } },
});
const setupSucceeded = () => ({
  id: 'evt_setup', type: 'setup_intent.succeeded',
  data: { object: {
    id: 'seti_native', status: 'succeeded', customer: 'cus_native', payment_method: 'pm_card',
  } },
});

describe('independent native webhook authority and ordering', () => {
  it('control: chronological paid activation then deletion revokes access and drops', async () => {
    const h = setup();
    await h.svc.handle(subEvent('evt_active', 'active'), h.prisma);
    expect(h.row().entitlement_active).toBe(true);
    await h.svc.handle(deletion(), h.prisma);
    expect(h.row().status).toBe('canceled');
    expect(h.row().entitlement_active).toBe(false);
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledTimes(1);
  });

  it('acceptance: a deleted paid subscription cannot be resurrected by an older active snapshot', async () => {
    const h = setup({ status: 'active', entitlement_active: true });
    h.canonical({ status: 'canceled' });
    await h.svc.handle(deletion(), h.prisma);
    h.fanout.onPurchaseEntitled.mockClear();
    await h.svc.handle(subEvent('evt_late_active', 'active'), h.prisma);
    expect(h.row().entitlement_active).toBe(false);
    expect(h.row().status).toBe('canceled');
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('acceptance: older incomplete creation cannot revoke the first invoice already paid', async () => {
    const h = setup();
    const paid = invoicePaid();
    await h.svc.handle(paid, h.prisma, await h.svc.prefetchForOuterTx(paid));
    const created = subEvent('evt_older_created', 'incomplete', { default_payment_method: null });
    created.type = 'customer.subscription.created';
    await h.svc.handle(created, h.prisma);
    expect(h.row().entitlement_active).toBe(true);
    expect(h.row().status).toBe('active');
  });

  it('acceptance: a decline delivered after payment of that same first invoice cannot open dunning', async () => {
    const h = setup();
    const paid = invoicePaid();
    await h.svc.handle(paid, h.prisma, await h.svc.prefetchForOuterTx(paid));
    await h.svc.handle(invoiceFailed(), h.prisma);
    expect(h.row().status).toBe('active');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('acceptance: an expired never-entitled attempt cannot enter renewal dunning on a late decline', async () => {
    const h = setup();
    await h.svc.handle(deletion(), h.prisma);
    expect(h.row().status).toBe('expired');
    await h.svc.handle(invoiceFailed(), h.prisma);
    expect(h.row().status).toBe('expired');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: a live renewal decline is still a failure, not a first checkout attempt', async () => {
    const h = setup({ status: 'active', entitlement_active: true });
    const failed = invoiceFailed();
    failed.data.object.billing_reason = 'subscription_cycle';
    await h.svc.handle(failed, h.prisma);
    expect(h.row().status).toBe('past_due');
    expect(h.row().entitlement_active).toBe(true);
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: a pending first-invoice decline stays an attempt without dunning', async () => {
    const h = setup();
    const result = await h.svc.handle(invoiceFailed(), h.prisma);
    expect(result.reason).toBe('first_attempt_declined');
    expect(h.row().status).toBe('pending');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: the subscription first PaymentIntent never settles through the one-time path', async () => {
    const h = setup();
    await h.svc.handle({
      id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_first' } },
    }, h.prisma);
    expect(h.row().entitlement_active).toBe(false);
    expect(h.row().status).toBe('pending');
    expect(h.splits.onChargeSucceeded).not.toHaveBeenCalled();
  });

  it('control: first invoice without provider prefetch rejects for redelivery', async () => {
    const h = setup();
    h.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('provider unavailable'));
    const event = invoicePaid();
    await expect(h.svc.handle(event, h.prisma, await h.svc.prefetchForOuterTx(event)))
      .rejects.toThrow(/retry/);
    expect(h.row().entitlement_active).toBe(false);
  });

  it('control: first entitlement fanout failure propagates inside the supplied transaction', async () => {
    const h = setup();
    h.fanout.onPurchaseEntitled.mockRejectedValueOnce(new Error('resolver unavailable'));
    await expect(h.svc.handle(subEvent('evt_fanout', 'active'), h.prisma))
      .rejects.toThrow('resolver unavailable');
  });
});

describe('independent first-payment financial truth', () => {
  const originalFlag = process.env.FEATURE_ROMAN_FIRST_PAYMENT;
  beforeEach(() => { process.env.FEATURE_ROMAN_FIRST_PAYMENT = 'true'; });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_ROMAN_FIRST_PAYMENT;
    else process.env.FEATURE_ROMAN_FIRST_PAYMENT = originalFlag;
  });
  function moneySetup(over: Record<string, unknown> = {}) {
    const notifications: any = { createNotification: jest.fn(async () => undefined) };
    const service = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));
    const h = setup(over, service);
    h.prisma.coachFirstPaymentNotification = {
      create: jest.fn(async ({ data }: any) => ({ id: 'first-payment-ledger', ...data })),
    };
    return { ...h, notifications };
  }

  it('acceptance: saving a free trial card is not a $49 first payment', async () => {
    const h = moneySetup({ trial_days: 7 });
    await h.svc.handle(subEvent('evt_trial_card', 'trialing'), h.prisma);
    expect(h.row().entitlement_active).toBe(true);
    expect(h.notifications.createNotification).not.toHaveBeenCalled();
    expect(h.prisma.coachFirstPaymentNotification.create).not.toHaveBeenCalled();
  });

  it('acceptance: actual first paid conversion after a trial records and notifies the paid amount', async () => {
    const h = moneySetup({
      trial_days: 7, trial_started_at: new Date(), status: 'trialing', entitlement_active: true,
    });
    const event = invoicePaid();
    await h.svc.handle(event, h.prisma, await h.svc.prefetchForOuterTx(event));
    expect(h.prisma.coachFirstPaymentNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 4900 }),
    });
  });

  it('acceptance: combo first invoice reports the actual $148 paid, not the $49 renewal snapshot', async () => {
    const h = moneySetup();
    const event = invoicePaid();
    event.data.object.amount_paid = 14800;
    await h.svc.handle(event, h.prisma, await h.svc.prefetchForOuterTx(event));
    expect(h.prisma.coachFirstPaymentNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 14800 }),
    });
  });
});

describe('independent one-trial persistence across reordered lifecycle deliveries', () => {
  it('acceptance: paid-conversion-first delivery must still consume the client/coach trial', async () => {
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
      coach_id: COACH, name: 'Coaching', amount_cents: 4900, currency: 'usd',
      billing_type: 'recurring', interval: 'month', interval_count: 1,
      recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
      recurring_stripe_price_id: null, stripe_price_id: 'price_trial', trial_days: 7,
      is_active: true, archived_at: null, published_at: new Date(),
    };
    prisma._packages.push({ ...pkg, id: PKG }, { ...pkg, id: PKG2 });
    prisma._accounts.push({
      coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true,
      deauthorized_at: null,
    });
    const packages: any = {
      getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id)),
    };
    const fee: any = { planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_id: null })) };
    const checkout = new SubscriptionCheckoutService(
      prisma, stripe, packages, { ready: true } as any, fee, makeCheckoutHelpers(prisma) as any,
    );
    const handler = new CheckoutWebhookHandlerService(prisma, stripe);
    const oldKey = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_audit';
    try {
      const first = await checkout.createSubscriptionIntent(CLIENT, {
        package_id: PKG, idempotency_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      stripe._saveTrialCard(first.subscription_id);
      // Trial card update was generated but not yet delivered. Conversion
      // delivery wins; Stripe's canonical subscription is now active.
      const live = stripe._subs.get(first.subscription_id);
      Object.assign(live, {
        status: 'active', default_payment_method: 'pm_card',
        trial_start: NOW - 7 * 86400, trial_end: NOW,
      });
      await handler.handle({
        id: 'evt_conversion_first', type: 'customer.subscription.updated',
        data: { object: { ...live } },
      }, prisma);
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      await handler.handle({
        id: 'evt_conversion_deleted', type: 'customer.subscription.deleted',
        data: { object: { id: first.subscription_id, canceled_at: NOW } },
      }, prisma);
      await checkout.createSubscriptionIntent(CLIENT, {
        package_id: PKG2, idempotency_key: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      });
      expect(stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBeUndefined();
      expect(prisma._purchases[0].trial_started_at).toBeInstanceOf(Date);
    } finally {
      if (oldKey === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
      else process.env.STRIPE_PUBLISHABLE_KEY = oldKey;
    }
  });
});

describe('independent canaries at all three new handler diagnostic sinks', () => {
  const spies: Array<jest.SpyInstance> = [];
  beforeEach(() => {
    for (const method of ['warn', 'log', 'error'] as const) {
      spies.push(jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined));
    }
  });
  afterEach(() => { spies.splice(0).forEach((spy) => spy.mockRestore()); });
  const logged = () => JSON.stringify(spies.map((spy) => spy.mock.calls));
  const secretError = () => Object.assign(new Error(CANARY), {
    name: CANARY, code: 'audit_person_example_test',
  });

  it('lookup failure logs only the fixed error label and asks for redelivery', async () => {
    const h = setup();
    h.prisma.clientPurchase.findFirst.mockRejectedValueOnce(secretError());
    const event = setupSucceeded();
    const pre = await h.svc.prefetchForOuterTx(event);
    await expect(h.svc.handle(event, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(logged()).toContain('lookup failed');
    expect(logged()).not.toContain(CANARY);
    expect(logged()).not.toContain('audit_person_example_test');
  });

  it('card attach failure logs only the fixed error label and asks for redelivery', async () => {
    const h = setup({ trial_days: 7, status: 'trialing' });
    h.canonical({ status: 'trialing', default_payment_method: null });
    h.stripe.setSubscriptionDefaultPaymentMethod.mockRejectedValueOnce(secretError());
    const event = setupSucceeded();
    const pre = await h.svc.prefetchForOuterTx(event);
    await expect(h.svc.handle(event, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(logged()).toContain('trial card attach failed');
    expect(logged()).not.toContain(CANARY);
    expect(logged()).not.toContain('audit_person_example_test');
  });

  it('no-transaction fanout failure logs only the fixed error label', async () => {
    const h = setup();
    h.fanout.onPurchaseEntitled.mockRejectedValueOnce(secretError());
    await h.svc.handle(subEvent('evt_fanout_no_tx', 'active'));
    expect(logged()).toContain('no-tx subscription path');
    expect(logged()).not.toContain(CANARY);
    expect(logged()).not.toContain('audit_person_example_test');
  });
});
