import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_x',
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
  return { id: `evt_fp_${seq}`, type, data: { object } };
};
const invoicePaid = (amount: number, reason: string) =>
  ev('invoice.paid', {
    id: `in_${seq + 1}`, subscription: 'sub_x', amount_paid: amount, currency: 'usd', charge: amount > 0 ? 'ch_1' : null,
    billing_reason: reason,
  });

// The purchase rows each path writes. Native: the in-app subscription
// (session id = subscription id). Web trial: GC-3's conversion (the
// SetupIntent in the PaymentIntent slot, sentinel `guest_pi_<seti>`). Web
// sale: the conversion of a paid web subscription (`guest_pi_<pi>`), which
// claimed at conversion. Hosted: an in-app Checkout Session subscription.
const ROWS: Record<string, Record<string, unknown>> = {
  native: { stripe_checkout_session_id: 'sub_x', stripe_payment_intent_id: 'pi_first' },
  webTrial: { stripe_checkout_session_id: 'guest_pi_seti_webtrial01', stripe_payment_intent_id: 'seti_webtrial01' },
  webSale: { stripe_checkout_session_id: 'guest_pi_pi_websale01', stripe_payment_intent_id: 'pi_websale01' },
  hosted: { stripe_checkout_session_id: 'cs_hosted01', stripe_payment_intent_id: null },
};
const TRIALING = { trial_days: 7, trial_started_at: new Date(), status: 'trialing', entitlement_active: true, card_on_file: true };

// LO-1181R3 lens probe (agent 199): a web trial's whole life, in order and
// out of order, with a ledger that remembers. Claims once, at the first paid
// invoice, for what Stripe collected.
function life(row: Record<string, unknown>, live: Record<string, unknown>) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push({
    id: 'cp_x', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
    stripe_subscription_id: 'sub_x', stripe_customer_id: 'cus_1',
    status: 'pending', entitlement_active: false, cancel_at_period_end: false,
    current_period_end: null, canceled_at: null, trial_days: null, trial_started_at: null,
    last_error: null, idempotency_key: 'k-x', created_at: new Date(), ...row,
  });
  const cur: any = { ...live };
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...cur })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...cur })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_1', status: 'paid' })),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const dunning: any = { recordFailure: jest.fn(async () => ({})), recordResolution: jest.fn(async () => null), terminate: jest.fn(async () => null) };
  const fanout: any = { onPurchaseEntitled: jest.fn(async () => undefined), cancelPendingForPurchase: jest.fn(async () => 0) };
  const notifications: any = { createNotification: jest.fn(async () => undefined), sendPush: jest.fn(async () => null) };
  const firstPayment = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));
  const rows: Array<Record<string, unknown>> = [];
  const ledger = {
    findUnique: jest.fn(async (a: any) => rows.find((r) => r.coachId === a.where.coachId) ?? null),
    createMany: jest.fn(async (a: any) => {
      let count = 0;
      for (const d of a.data) if (!rows.find((r) => r.coachId === d.coachId)) { rows.push(d); count += 1; }
      return { count };
    }),
  };
  prisma.coachFirstPaymentNotification = ledger;
  const svc = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, firstPayment);
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return { deliver, rows, cur, notifications };
}

const WEB_TRIAL = { stripe_checkout_session_id: 'guest_pi_seti_webtrial01', stripe_payment_intent_id: 'seti_webtrial01',
  trial_days: 7, trial_started_at: new Date(), status: 'trialing', entitlement_active: true, card_on_file: true };

describe('LO-1181R3 probe: a web trial life claims once, at the first paid invoice', () => {
  it('in order: $0 trial invoice, trialing update, paid invoice, its redelivery, next cycle -> one claim of 14900', async () => {
    const w = life(WEB_TRIAL, sub('trialing', { trial_start: NOW }));
    await w.deliver(invoicePaid(0, 'subscription_create'));
    await w.deliver(ev('customer.subscription.updated', sub('trialing', { trial_start: NOW })));
    expect(w.rows).toHaveLength(0);
    Object.assign(w.cur, sub('active'));
    await w.deliver(ev('customer.subscription.updated', sub('active')));
    expect(w.rows).toHaveLength(0);
    const first = invoicePaid(14900, 'subscription_cycle');
    await w.deliver(first);
    await w.deliver(first);
    await w.deliver(invoicePaid(14900, 'subscription_cycle'));
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ coachId: 'coach', amount: 14900 });
  });
  it('out of order: the paid invoice before the active update; a late $0 invoice claims nothing more', async () => {
    const w = life(WEB_TRIAL, sub('active'));
    await w.deliver(invoicePaid(14900, 'subscription_cycle'));
    await w.deliver(ev('customer.subscription.updated', sub('active')));
    await w.deliver(invoicePaid(0, 'subscription_create'));
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ amount: 14900 });
  });
  it('a web trial cancelled in its trial never claims', async () => {
    const w = life(WEB_TRIAL, sub('canceled'));
    await w.deliver(invoicePaid(0, 'subscription_create'));
    await w.deliver(ev('customer.subscription.deleted', sub('canceled')));
    expect(w.rows).toHaveLength(0);
  });
});
