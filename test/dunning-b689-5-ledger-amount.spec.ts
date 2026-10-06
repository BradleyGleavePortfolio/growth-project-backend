/**
 * B-689-5 (Opus, AUD-OPUS-D34-118 probe P3): the reversed amount the client
 * sees (quote disputes[].amount_cents and the card-update reply) comes from
 * the ChargeDispute ledger, or is omitted; never the cycle's last failed
 * renewal amount.
 */
import { DunningService } from '../src/checkout/dunning.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-05T16:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function world() {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripe = new FakeStripeBilling();
  stripe.customers.set('cus_c', { id: 'cus_c', default_payment_method: 'pm_old' });
  stripe.subs.set('sub_c', {
    id: 'sub_c',
    status: 'active',
    customer: 'cus_c',
    current_period_end: sec(at(30 * DAY)),
    default_payment_method: 'pm_old',
    cancel_at_period_end: false,
    latest_invoice: null,
  });
  stripe.addCard('pm_old', 'decline', '0341');
  stripe.addCard('pm_new_ok', 'ok', '4242');
  const v1 = new DunningService(prisma, stub(stripe));
  const v2 = new DunningV2Service(prisma, new DunningV2Telemetry(), undefined, stub(stripe));
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2);
  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid', role: 'coach' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid', role: 'student' });
  fake.seed('coachPackage', {
    id: 'pkg-1',
    coach_user_id: 'coach-1',
    billing_type: 'recurring',
    interval: 'month',
    duration_days: null,
    price_cents: 15000,
  });
  fake.seed('connectCustomer', {
    id: 'cc-1',
    client_user_id: 'client-1',
    stripe_customer_id: 'cus_c',
    default_payment_method_id: 'pm_old',
  });
  fake.seed('clientPurchase', {
    id: 'purchase-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'past_due',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_c',
    access_expires_at: at(0),
    current_period_end: at(0),
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: at(-60 * DAY),
  });
  const purchase = () => fake.find('clientPurchase', { id: 'purchase-1' })!;
  const state = () => fake.find('dunningState', { purchase_id: 'purchase-1' });
  return { fake, stripe, v1, v2, billing, purchase, state };
}

describe('B-689-5: the reversed amount shown is the ledger amount, never the last failed renewal', () => {
  const prior = { ...process.env };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_b689_5';
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...prior };
  });

  it('a $99.00 dispute after a $150.00 renewal failed and was paid: quote and reply never say $150.00', async () => {
    const w = world();
    // Day 0: the $150.00 renewal fails; Day 1: Stripe's retry pays it.
    w.stripe.addInvoice({ id: 'in_r1', subscription: 'sub_c', amount_due: 15000, created: sec(T0) });
    w.stripe.subs.get('sub_c')!.status = 'past_due';
    await w.v1.recordFailure({
      purchase: stub(w.purchase()),
      stripe_invoice_id: 'in_r1',
      amount_due_cents: 15000,
      attempt_number: 1,
      reason: 'Your card was declined.',
    });
    await w.v2.recordPaymentFailed('purchase-1', T0);
    await flush();
    jest.setSystemTime(at(DAY));
    w.stripe.subs.get('sub_c')!.default_payment_method = 'pm_new_ok';
    expect(w.stripe.stripeRetry('in_r1')).toBe('paid');
    Object.assign(w.purchase(), { status: 'active', entitlement_active: true, current_period_end: at(30 * DAY) });
    await w.v1.recordResolution('purchase-1');
    await w.v2.applyImmediateClear('purchase-1', 'retry');
    expect(w.state()?.last_failed_amount_cents).toBe(15000);
    // Day 12: the bank reverses an earlier $99.00 charge; the ledger has it.
    jest.setSystemTime(at(12 * DAY));
    w.fake.seed('chargeDispute', {
      id: 'dp-first',
      purchase_id: 'purchase-1',
      stripe_dispute_id: 'dp_first',
      stripe_charge_id: 'ch_first',
      amount_cents: 9900,
      currency: 'usd',
      status: 'needs_response',
      created_at: at(12 * DAY),
    });
    const opened = await w.v2.handleLateReversal({
      purchaseId: 'purchase-1',
      reversedChargeAt: at(12 * DAY),
      disputeId: 'dp_first',
      chargeId: 'ch_first',
      now: at(12 * DAY),
    });
    expect(opened.opened).toBe(true);
    jest.setSystemTime(at(13 * DAY));
    const setup = await w.billing.createCardSetup('client-1', UUID(4));
    w.stripe.confirmSetupIntentInSheet(setup.setup_intent_id, 'pm_new_ok');
    const quote = await w.billing.getPaymentQuote('client-1');
    expect(quote.disputes[0]?.amount_cents).toBe(9900);
    expect(quote.disputes[0]?.currency).toBe('usd');
    const res = await w.billing.confirmCardUpdate(
      'client-1',
      setup.setup_intent_id,
      quote.lines.map((l) => ({ invoice_id: l.invoice_id, amount_cents: l.amount_cents, currency: l.currency })),
    );
    expect(res.message).not.toContain('$150.00');
  });
});
