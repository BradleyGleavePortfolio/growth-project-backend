// FIX-1181 (b#1181 fix round 2, agent 199) — class-first: every Stripe
// invoice / subscription event that can claim the coach's once-ever
// first-payment notice claims it once, only when money is first paid.
// Owner #198-E9 (1181-WT "op 1"): a trial's card save never claims it; the
// first paid invoice after the trial does — web trials as in the app.
// The conversion side (web pay page sale claims at conversion; a web trial's
// conversion claims nothing) is in test/first-pay-web.spec.ts and
// test/fix-1181-main-web-trial-first-pay.spec.ts. Harness as in
// test/b-recur3-117-webhook-order.spec.ts (BillingService order: prefetch
// out of the transaction, then handle on it).
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
const PAID = { status: 'active', entitlement_active: true };

function harness(row: Record<string, unknown>, live: Record<string, unknown>, alreadySent: boolean) {
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
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_1', status: 'paid' })),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const fanout: any = { onPurchaseEntitled: jest.fn(async () => undefined), cancelPendingForPurchase: jest.fn(async () => 0) };
  const notifications: any = { createNotification: jest.fn(async () => undefined), sendPush: jest.fn(async () => null) };
  const firstPayment = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));
  const ledger = {
    findUnique: jest.fn(async () => (alreadySent ? { id: 'fp_1' } : null)),
    createMany: jest.fn(async (_args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => ({ count: 1 })),
  };
  prisma.coachFirstPaymentNotification = ledger;
  const svc = new CheckoutWebhookHandlerService(
    prisma, stripe, splits, dunning, undefined, fanout, undefined, undefined, firstPayment,
  );
  const deliver = async (e: ReturnType<typeof ev>) => svc.handle(e, prisma, await svc.prefetchForOuterTx(e));
  return { deliver, ledger };
}

type Case = {
  name: string;
  row: Record<string, unknown>;
  live: Record<string, unknown>;
  event: () => ReturnType<typeof ev>;
  alreadySent?: boolean;
  claims: number | null; // the amount claimed, or null for no claim
};

const CASES: Case[] = [
  // In-app native subscription with a trial.
  { name: 'in-app trial: card save (subscription trialing) claims nothing', row: { ...ROWS.native, trial_days: 7 },
    live: sub('trialing', { trial_start: NOW }), event: () => ev('customer.subscription.updated', sub('trialing', { trial_start: NOW })), claims: null },
  { name: "in-app trial: the trial's $0 invoice claims nothing", row: { ...ROWS.native, trial_days: 7 },
    live: sub('trialing', { trial_start: NOW }), event: () => invoicePaid(0, 'subscription_create'), claims: null },
  { name: 'in-app trial: the first paid invoice after the trial claims what Stripe collected', row: { ...ROWS.native, ...TRIALING },
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_cycle'), claims: 14900 },
  { name: 'in-app subscription, no trial: the first paid invoice claims', row: ROWS.native,
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_create'), claims: 14900 },
  // Web trial (GC-3): the conversion claimed nothing (FIX-1181).
  { name: 'web trial: card save (subscription trialing) claims nothing', row: { ...ROWS.webTrial, ...TRIALING },
    live: sub('trialing', { trial_start: NOW }), event: () => ev('customer.subscription.updated', sub('trialing', { trial_start: NOW })), claims: null },
  { name: "web trial: the trial's $0 invoice claims nothing", row: { ...ROWS.webTrial, ...TRIALING },
    live: sub('trialing', { trial_start: NOW }), event: () => invoicePaid(0, 'subscription_create'), claims: null },
  { name: '(failed before) web trial: the first paid invoice after the trial claims what Stripe collected', row: { ...ROWS.webTrial, ...TRIALING },
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_cycle'), claims: 14900 },
  { name: 'web trial: a later paid invoice once the coach has the notice claims nothing', row: { ...ROWS.webTrial, ...PAID },
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_cycle'), alreadySent: true, claims: null },
  // Paths that claim elsewhere: their invoices never claim a second time.
  { name: 'web pay page subscription sale: its invoices claim nothing (the conversion claimed)', row: { ...ROWS.webSale, ...PAID },
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_cycle'), claims: null },
  { name: 'in-app hosted checkout subscription: its invoices claim nothing (checkout.session.completed claimed)', row: { ...ROWS.hosted, ...PAID },
    live: sub('active'), event: () => invoicePaid(14900, 'subscription_cycle'), claims: null },
];

describe('FIX-1181 class-first: the first-payment notice is claimed once, only when money is first paid', () => {
  const FLAG = 'FEATURE_ROMAN_FIRST_PAYMENT';
  const before = process.env[FLAG];
  beforeEach(() => { process.env[FLAG] = 'true'; });
  afterAll(() => {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  });

  it.each(CASES)('$name', async ({ row, live, event, alreadySent, claims }) => {
    const h = harness(row, live, alreadySent === true);
    await h.deliver(event());
    if (claims === null) {
      expect(h.ledger.createMany).not.toHaveBeenCalled();
    } else {
      expect(h.ledger.createMany).toHaveBeenCalledTimes(1);
      expect(h.ledger.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ coachId: 'coach', amount: claims, currency: 'usd' })],
        skipDuplicates: true,
      });
    }
  });

  it('flag off: no path claims', async () => {
    process.env[FLAG] = 'false';
    for (const c of CASES) {
      const h = harness(c.row, c.live, false);
      await h.deliver(c.event());
      expect(h.ledger.createMany).not.toHaveBeenCalled();
    }
  });
});
