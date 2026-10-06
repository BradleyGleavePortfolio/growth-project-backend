// B-RECUR5B-117 — #680 fix round 5. A Stripe read taken before the webhook
// transaction is authority only until a newer purchase write lands; each
// case below lets such a write land between the read and the locked write
// (the lens probes of 8e05ad0e, rebuilt here) and asserts the newer state
// wins, or the event is redelivered and the redelivery settles it. `deliver`
// is the BillingService order: prefetch out of the transaction, then handle
// on it. Cases marked "(failed before)" fail on #680 @ 8e05ad0e.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const PERIOD = NOW + 30 * DAY;

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_a', status, customer: 'cus_a', current_period_end: PERIOD,
  cancel_at_period_end: false, default_payment_method: 'pm_card', ...over,
});
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_r5_${seq}`, type, data: { object } };
};
const paid = (over: Record<string, unknown> = {}) =>
  ev('invoice.paid', {
    id: 'in_r', subscription: 'sub_a', amount_paid: 4900, currency: 'usd', charge: 'ch_r',
    billing_reason: 'subscription_cycle', ...over,
  });
const declined = (over: Record<string, unknown> = {}) =>
  ev('invoice.payment_failed', {
    id: 'in_r', subscription: 'sub_a', amount_due: 4900, attempt_count: 1,
    billing_reason: 'subscription_cycle', last_payment_error: { message: 'Your card was declined.' }, ...over,
  });

function harness(over: Record<string, unknown> = {}, withMoney = false) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_a', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    stripe_checkout_session_id: 'sub_a', stripe_subscription_id: 'sub_a',
    stripe_payment_intent_id: 'pi_first', stripe_customer_id: 'cus_a',
    stripe_client_secret: 'pi_first_secret_x', stripe_ephemeral_key: 'ek_x',
    status: 'active', entitlement_active: true, cancel_at_period_end: false,
    current_period_end: new Date(PERIOD * 1000), canceled_at: null, trial_days: null,
    trial_started_at: null, last_error: null, idempotency_key: 'sub-client-a',
    // Older than any write below, so every write moves the version.
    created_at: new Date(Date.now() - 60_000), updated_at: new Date(Date.now() - 60_000), ...over,
  });
  let live: Record<string, unknown> = sub('active');
  let invoice: Record<string, unknown> = { id: 'in_r', status: 'open' };
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
  const notifications: any = { createNotification: jest.fn(async () => undefined) };
  const ledger = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'fp_r5', ...data })),
  };
  prisma.coachFirstPaymentNotification = ledger;
  const firstPayment = withMoney
    ? new CoachFirstPaymentService(new FirstPaymentEmitter(notifications))
    : undefined;
  const svc = new CheckoutWebhookHandlerService(
    prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, firstPayment,
  );
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return {
    svc, prisma, stripe, dunning, fanout, ledger, deliver,
    row: () => prisma._purchases[0],
    setLive: (s: Record<string, unknown>) => { live = s; },
    setInvoice: (i: Record<string, unknown>) => { invoice = i; },
  };
}

describe('B-680-1: invoice.paid never overwrites a purchase write newer than its Stripe read', () => {
  it('(failed before) a newer unpaid revocation: redeliver, no re-grant; the redelivery keeps it unpaid', async () => {
    const h = harness();
    const payment = paid();
    const pre = await h.svc.prefetchForOuterTx(payment);
    h.setLive(sub('unpaid'));
    await h.deliver(ev('customer.subscription.updated', sub('unpaid')));
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    await expect(h.svc.handle(payment, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    await h.deliver(payment);
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('(failed before) a newer renewal period written meanwhile is never rolled back to the older one', async () => {
    const h = harness();
    const payment = paid();
    const pre = await h.svc.prefetchForOuterTx(payment);
    h.setLive(sub('active', { current_period_end: PERIOD + 30 * DAY }));
    await h.deliver(ev('customer.subscription.updated', sub('active', { current_period_end: PERIOD + 30 * DAY })));
    await expect(h.svc.handle(payment, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(h.row().current_period_end).toEqual(new Date((PERIOD + 30 * DAY) * 1000));
  });

  it('(failed before) without an outer tx, the in-handler Stripe read is fenced the same way', async () => {
    const h = harness();
    h.stripe.retrieveSubscription.mockImplementationOnce(async () => {
      Object.assign(h.row(), { status: 'unpaid', entitlement_active: false, updated_at: new Date() });
      return sub('active');
    });
    await h.svc.handle(paid());
    expect(h.row()).toMatchObject({ status: 'unpaid', entitlement_active: false });
  });

  it('control: a cancellation written meanwhile matches the paid state: claimed, kept, the charge settles', async () => {
    const h = harness();
    const payment = paid();
    const pre = await h.svc.prefetchForOuterTx(payment);
    Object.assign(h.row(), { cancel_at_period_end: true, updated_at: new Date() });
    const result = await h.svc.handle(payment, h.prisma, pre);
    expect(result).toMatchObject({ claimed: true, deferredSplit: { charge_id: 'ch_r', invoice_amount_cents: 4900 } });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, cancel_at_period_end: true });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
  });
});

describe('B-680-2: a decline read before a payment never reopens dunning', () => {
  it('(failed before) the retry paid the invoice after the decline read: redeliver, then settled; no dunning', async () => {
    const h = harness({ status: 'past_due', last_error: 'Your card was declined.' });
    const decline = declined({ attempt_count: 2 });
    const pre = await h.svc.prefetchForOuterTx(decline);
    h.setInvoice({ id: 'in_r', status: 'paid' });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    await expect(h.svc.handle(decline, h.prisma, pre)).rejects.toThrow(/redeliver/);
    await expect(h.deliver(decline)).resolves.toMatchObject({ reason: 'invoice_already_settled' });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) a paid invoice that rewrites the active plan with the same values still supersedes the read', async () => {
    const h = harness();
    const decline = declined();
    const pre = await h.svc.prefetchForOuterTx(decline);
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    await expect(h.svc.handle(decline, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) a first-invoice decline never writes its text after a concurrent grant (invoice path)', async () => {
    const h = harness({ status: 'pending', entitlement_active: false, current_period_end: null });
    const read = h.prisma.clientPurchase.findUnique.getMockImplementation();
    h.prisma.clientPurchase.findUnique.mockImplementationOnce(async (args: unknown) => {
      const old = await read(args);
      await h.deliver(paid({ billing_reason: 'subscription_create' }));
      return old;
    });
    await h.svc.handle(declined({ billing_reason: 'subscription_create' }), h.prisma, { failedInvoiceStatus: 'open' });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
  });

  it('(failed before) a first-invoice decline never writes its text after a concurrent grant (PaymentIntent path)', async () => {
    const h = harness({ status: 'pending', entitlement_active: false, current_period_end: null });
    const read = h.prisma.clientPurchase.findFirst.getMockImplementation();
    h.prisma.clientPurchase.findFirst.mockImplementationOnce(async (args: unknown) => {
      const old = await read(args);
      await h.deliver(paid({ billing_reason: 'subscription_create' }));
      return old;
    });
    await h.svc.handle(ev('payment_intent.payment_failed', {
      id: 'pi_first', last_payment_error: { message: 'Your card was declined.' },
    }), h.prisma);
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true, last_error: null });
  });

  it('(failed before) a decline of an invoice that is no longer the latest: no past_due, no dunning', async () => {
    const h = harness();
    h.setLive(sub('active', { latest_invoice: 'in_newer' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ reason: 'invoice_superseded' });
    expect(h.row()).toMatchObject({ status: 'active', last_error: null });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(failed before) a decline read after Stripe ended the subscription: no past_due, no dunning', async () => {
    const h = harness();
    h.setLive(sub('canceled', { canceled_at: NOW, latest_invoice: 'in_r' }));
    await expect(h.deliver(declined({ attempt_count: 4 }))).resolves.toMatchObject({ reason: 'subscription_already_ended' });
    expect(h.row().status).toBe('active');
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('control: the past_due update Stripe sends with the decline lands first: one redelivery, then dunning opens once', async () => {
    const h = harness();
    h.setLive(sub('past_due', { latest_invoice: 'in_r' }));
    const decline = declined();
    const pre = await h.svc.prefetchForOuterTx(decline);
    await h.deliver(ev('customer.subscription.updated', sub('past_due')));
    // B-680-2 (R119) — no write is exempt from the fence.
    await expect(h.svc.handle(decline, h.prisma, pre)).rejects.toThrow(/redeliver/);
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    await expect(h.deliver(decline)).resolves.toMatchObject({ claimed: true });
    // D4 (C-690-1): last_error is a decline code, never Stripe's message.
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true, last_error: 'invoice_payment_failed' });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: an open latest-invoice decline with nothing in between enters dunning', async () => {
    const h = harness();
    h.setLive(sub('past_due', { latest_invoice: { id: 'in_r' } }));
    await h.deliver(declined());
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('B-680-3 / C-680-10: a paid invoice is never acknowledged without its effects', () => {
  const flag = process.env.FEATURE_ROMAN_FIRST_PAYMENT;
  beforeEach(() => { process.env.FEATURE_ROMAN_FIRST_PAYMENT = 'true'; });
  afterEach(() => {
    if (flag === undefined) delete process.env.FEATURE_ROMAN_FIRST_PAYMENT;
    else process.env.FEATURE_ROMAN_FIRST_PAYMENT = flag;
  });

  it('(failed before) an entitled trial converts while Stripe is unreadable: redeliver; the redelivery records $148 and the charge', async () => {
    const h = harness({ status: 'trialing', trial_days: 7, trial_started_at: new Date() }, true);
    h.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('stripe down'));
    const conversion = paid({ amount_paid: 14800 });
    await expect(h.deliver(conversion)).rejects.toThrow(/retry/);
    expect(h.ledger.create).not.toHaveBeenCalled();
    const result = await h.deliver(conversion);
    expect(h.ledger.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 14800, currency: 'usd' }) });
    expect(result.deferredSplit).toMatchObject({ charge_id: 'ch_r', invoice_amount_cents: 14800 });
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('(failed before) a past_due plan whose retry paid while Stripe is unreadable keeps dunning open until the redelivery resolves it', async () => {
    const h = harness({ status: 'past_due' });
    h.stripe.retrieveSubscription.mockRejectedValueOnce(new Error('stripe down'));
    const retry = paid();
    await expect(h.deliver(retry)).rejects.toThrow(/retry/);
    expect(h.dunning.recordResolution).not.toHaveBeenCalled();
    await h.deliver(retry);
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    expect(h.row().status).toBe('active');
  });
});

describe('Opus R12 decision 2: a trial starts only on the card its own SetupIntent saved', () => {
  it('control: a customer-level default card (billing portal) never starts the trial; the attempt card does', async () => {
    const h = harness({ status: 'pending', entitlement_active: false, trial_days: 7, current_period_end: null });
    const portalOnly = sub('trialing', { default_payment_method: null, trial_start: NOW, invoice_settings: { default_payment_method: 'pm_portal' } });
    h.setLive(portalOnly);
    await h.deliver(ev('customer.subscription.updated', portalOnly));
    await h.deliver(paid({ amount_paid: 0, billing_reason: 'subscription_create' }));
    expect(h.row()).toMatchObject({ entitlement_active: false, trial_started_at: null });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    h.setLive(sub('trialing', { default_payment_method: 'pm_attempt', trial_start: NOW }));
    await h.deliver(ev('customer.subscription.updated', sub('trialing', { default_payment_method: 'pm_attempt' })));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
  });
});
