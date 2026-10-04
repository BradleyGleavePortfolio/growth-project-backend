/**
 * AUDIT PROBE (AUD-OPUS-D34-118, Claude Opus 5.5 lens) - never merge.
 * Target: backend #689 (D3) @ bb992fedf0095446f916f3261742bd262c3d94da.
 * Replays the 116 probes (C1, P1, P1b, P2) at the new head and adds P3.
 *
 *  P1  dispute recorded during a payment cycle -> Day-10 lock -> card update
 *      pays the renewal: the dispute cycle survives (B-689-1, Opus).
 *  P1b the dispute closed lost before the card update: still kept.
 *  P2  cancel during a dispute cycle ends access now (2A ruling) and the reply
 *      never says the reversed payment went through (B-689-4 / C-689-1).
 *  P3  the reversed amount shown (quote disputes[].amount_cents and the card
 *      result copy) is the disputed charge, never the last failed renewal.
 *  C1  control: plain payment cycle -> lock -> card update unlocks.
 */
import { DunningService } from '../src/checkout/dunning.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { effectiveLock } from '../src/checkout/dunning-v2/dunning-effective-access';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = new Date('2026-10-05T16:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

function world() {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripe = new FakeStripeBilling();
  stripe.customers.set('cus_dv2_client', { id: 'cus_dv2_client', default_payment_method: 'pm_old' });
  stripe.subs.set('sub_dv2_client', {
    id: 'sub_dv2_client',
    status: 'active',
    customer: 'cus_dv2_client',
    current_period_end: sec(at(30 * DAY)),
    default_payment_method: 'pm_old',
    cancel_at_period_end: false,
    latest_invoice: null,
  });
  stripe.addCard('pm_old', 'decline', '0341');
  stripe.addCard('pm_new_ok', 'ok', '4242');
  const notifications = {
    pushToUser: jest.fn(async () => true),
    pushToCoach: jest.fn(async () => true),
    createNotification: jest.fn(async (n: Record<string, unknown>) =>
      fake.seed('notification', { ...n, read_at: null, created_at: new Date() }),
    ),
  };
  const telemetry = new DunningV2Telemetry();
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    telemetry,
    stub(notifications),
    stub({ send: jest.fn(async () => ({ ok: true })) }),
    stub({ emit: jest.fn(async () => undefined) }),
  );
  const v2 = new DunningV2Service(prisma, telemetry, dispatcher, stub(stripe));
  const v1 = new DunningService(prisma, stub(stripe));
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2, undefined);
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
    stripe_customer_id: 'cus_dv2_client',
    default_payment_method_id: 'pm_old',
  });
  fake.seed('notificationPreferences', { id: 'np-1', user_id: 'client-1', timezone: 'America/Los_Angeles' });
  fake.seed('clientPurchase', {
    id: 'purchase-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'active',
    entitlement_active: true,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_dv2_client',
    access_expires_at: at(0),
    current_period_end: at(0),
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: at(-60 * DAY),
  });
  const purchase = () => fake.find('clientPurchase', { id: 'purchase-1' })!;
  const state = () => fake.find('dunningState', { purchase_id: 'purchase-1' });
  return { fake, prisma, stripe, v1, v2, billing, purchase, state };
}

type W = ReturnType<typeof world>;

/** Day 0: renewal fails (what the D4 webhook does: past_due + v1 + v2 claim). */
async function failRenewal(w: W, invoiceId: string, when: Date): Promise<void> {
  jest.setSystemTime(when);
  w.stripe.addInvoice({ id: invoiceId, subscription: 'sub_dv2_client', amount_due: 15000, created: sec(when) });
  w.stripe.subs.get('sub_dv2_client')!.status = 'past_due';
  w.purchase().status = 'past_due';
  await w.v1.recordFailure({
    purchase: stub(w.purchase()),
    stripe_invoice_id: invoiceId,
    amount_due_cents: 15000,
    attempt_number: 1,
    reason: 'Your card was declined.',
  });
  await w.v2.recordPaymentFailed('purchase-1', when);
  await flush();
}

async function cardUpdate(w: W, n: number) {
  const setup = await w.billing.createCardSetup('client-1', UUID(n));
  w.stripe.confirmSetupIntentInSheet(setup.setup_intent_id, 'pm_new_ok');
  const quote = await w.billing.getPaymentQuote('client-1');
  const res = await w.billing.confirmCardUpdate(
    'client-1',
    setup.setup_intent_id,
    quote.lines.map((l) => ({ invoice_id: l.invoice_id, amount_cents: l.amount_cents, currency: l.currency })),
  );
  return { quote, res };
}

describe('AUDIT PROBE 118 #689: card update / cancel never settle a disputed payment', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'pk_test_probe';
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
    if (prevPk === undefined) delete process.env['STRIPE_PUBLISHABLE_KEY'];
    else process.env['STRIPE_PUBLISHABLE_KEY'] = prevPk;
  });

  it('C1 control: payment cycle -> Day-10 lock -> card update pays and unlocks', async () => {
    const w = world();
    await failRenewal(w, 'in_r1', T0);
    const lockAt = at(10 * DAY + 7 * MIN);
    jest.setSystemTime(lockAt);
    expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
    expect((await effectiveLock(w.prisma, 'client-1')).locked).toBe(true);
    jest.setSystemTime(at(11 * DAY));
    const { res } = await cardUpdate(w, 1);
    expect(res.outcome).toBe('paid');
    expect(w.state()?.status).toBe('resolved');
    expect((await effectiveLock(w.prisma, 'client-1')).locked).toBe(false);
  });

  it('P1: a dispute recorded during a payment cycle survives the in-app card update that pays the renewal', async () => {
    const w = world();
    await failRenewal(w, 'in_r1', T0);
    jest.setSystemTime(at(2 * DAY));
    w.fake.seed('chargeDispute', {
      id: 'dp-9',
      purchase_id: 'purchase-1',
      stripe_dispute_id: 'dp_9',
      stripe_charge_id: 'ch_0',
      amount_cents: 15000,
      currency: 'usd',
      status: 'needs_response',
      created_at: at(2 * DAY),
    });
    const r = await w.v2.handleLateReversal({
      purchaseId: 'purchase-1',
      reversedChargeAt: at(2 * DAY),
      disputeId: 'dp_9',
      chargeId: 'ch_0',
      now: at(2 * DAY),
    });
    expect(r).toMatchObject({ opened: false, reason: 'cycle_already_active' });
    // D2's durable predicate (FIX ROUND 8): the dispute is open.
    expect(await w.v2.isDisputeCycleOpen('purchase-1')).toBe(true);
    const lockAt = at(10 * DAY + 7 * MIN);
    jest.setSystemTime(lockAt);
    expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
    expect((await effectiveLock(w.prisma, 'client-1')).locked).toBe(true);

    jest.setSystemTime(at(11 * DAY));
    const { quote, res } = await cardUpdate(w, 2);
    const observed = {
      quote_disputes: quote.disputes.length,
      plan_dispute_open: res.plans[0]?.dispute_open,
      plan_access: res.plans[0]?.access,
      state_status: w.state()?.status,
      state_reason: w.state()?.last_failure_reason,
      still_locked: (await effectiveLock(w.prisma, 'client-1')).locked,
      dispute_cycle_open: await w.v2.isDisputeCycleOpen('purchase-1'),
      message: res.message,
    };
    // eslint-disable-next-line no-console
    console.log(`PROBE P1 observed ${JSON.stringify(observed)}`);
    // Expected: the renewal is paid (money truth), the dispute cycle is kept.
    expect(res.amount_paid_cents).toBe(15000);
    expect(observed).toMatchObject({
      quote_disputes: 1,
      plan_dispute_open: true,
      state_status: 'active',
      still_locked: true,
      dispute_cycle_open: true,
    });
  });

  it('P1b (operator lead, D2 predicate + D3 path): the dispute closes lost before the card update; the cycle must still not be settled', async () => {
    const w = world();
    await failRenewal(w, 'in_r1', T0);
    jest.setSystemTime(at(2 * DAY));
    w.fake.seed('chargeDispute', {
      id: 'dp-9',
      purchase_id: 'purchase-1',
      stripe_dispute_id: 'dp_9',
      stripe_charge_id: 'ch_0',
      amount_cents: 15000,
      currency: 'usd',
      status: 'needs_response',
      created_at: at(2 * DAY),
    });
    await w.v2.handleLateReversal({
      purchaseId: 'purchase-1',
      reversedChargeAt: at(2 * DAY),
      disputeId: 'dp_9',
      chargeId: 'ch_0',
      now: at(2 * DAY),
    });
    jest.setSystemTime(at(5 * DAY));
    w.fake.find('chargeDispute', { id: 'dp-9' })!.status = 'lost';
    await w.v2.onDisputeClosed({ chargeId: 'ch_0', disputeId: 'dp_9', status: 'lost', now: at(5 * DAY) });
    const lockAt = at(10 * DAY + 7 * MIN);
    jest.setSystemTime(lockAt);
    expect((await w.v2.runSweep(lockAt)).locked).toBe(1);
    jest.setSystemTime(at(11 * DAY));
    const { res } = await cardUpdate(w, 3);
    const observed = {
      plan_dispute_open: res.plans[0]?.dispute_open,
      state_status: w.state()?.status,
      still_locked: (await effectiveLock(w.prisma, 'client-1')).locked,
    };
    // eslint-disable-next-line no-console
    console.log(`PROBE P1b observed ${JSON.stringify(observed)}`);
    expect(observed).toMatchObject({ plan_dispute_open: true, state_status: 'active', still_locked: true });
  });

  it('P2: a cancel during a dispute cycle does not resolve the dispute cycle or claim the reversed payment went through', async () => {
    const w = world();
    // The renewal failed, then Stripe's retry paid it (cycle resolved).
    await failRenewal(w, 'in_r1', T0);
    jest.setSystemTime(at(DAY));
    w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
    expect(w.stripe.stripeRetry('in_r1')).toBe('paid');
    Object.assign(w.purchase(), { status: 'active', entitlement_active: true, current_period_end: at(30 * DAY) });
    await w.v1.recordResolution('purchase-1');
    await w.v2.applyImmediateClear('purchase-1', 'retry');
    expect(w.state()?.status).toBe('resolved');
    // Day 12: the client disputes that cleared payment -> compressed cycle.
    jest.setSystemTime(at(12 * DAY));
    w.fake.seed('chargeDispute', {
      id: 'dp-1',
      purchase_id: 'purchase-1',
      stripe_dispute_id: 'dp_1',
      stripe_charge_id: 'ch_1',
      amount_cents: 15000,
      currency: 'usd',
      status: 'needs_response',
      created_at: at(12 * DAY),
    });
    const opened = await w.v2.handleLateReversal({
      purchaseId: 'purchase-1',
      reversedChargeAt: at(12 * DAY),
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      now: at(12 * DAY),
    });
    expect(opened.opened).toBe(true);
    expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });

    // Day 13: the client taps "End my plan".
    jest.setSystemTime(at(13 * DAY));
    const res = await w.billing.cancelPlan('client-1', 'purchase-1');
    const lockAt = at(19 * DAY + 10 * MIN);
    jest.setSystemTime(lockAt);
    const sweep = await w.v2.runSweep(lockAt);
    const observed = {
      outcome: res.outcome,
      paid_period_kept: res.paid_period_kept,
      says_payment_went_through: /payment went through/.test(res.message),
      state_status: w.state()?.status,
      dispute_cycle_open: await w.v2.isDisputeCycleOpen('purchase-1'),
      locked_on_dispute_day: sweep.locked,
      entitlement_active: w.purchase().entitlement_active,
      access_expires_at: (w.purchase().access_expires_at as Date | null)?.toISOString() ?? null,
    };
    // eslint-disable-next-line no-console
    console.log(`PROBE P2 observed ${JSON.stringify({ ...observed, message: res.message })}`);
    // Expected: the dispute cycle is not settled by a cancel, and the reply
    // never says the reversed payment went through.
    expect(observed).toMatchObject({
      says_payment_went_through: false,
      paid_period_kept: false,
    });
    expect(observed.state_status === 'active' || observed.outcome === 'ended').toBe(true);
  });
  it('P3: the reversed amount shown is the disputed charge, not the last failed renewal', async () => {
    const w = world();
    // Day 0: the $150.00 renewal fails; Day 1: Stripe's retry pays it (resolved).
    await failRenewal(w, 'in_r1', T0);
    jest.setSystemTime(at(DAY));
    w.stripe.subs.get('sub_dv2_client')!.default_payment_method = 'pm_new_ok';
    expect(w.stripe.stripeRetry('in_r1')).toBe('paid');
    Object.assign(w.purchase(), { status: 'active', entitlement_active: true, current_period_end: at(30 * DAY) });
    await w.v1.recordResolution('purchase-1');
    await w.v2.applyImmediateClear('purchase-1', 'retry');
    expect(w.state()?.status).toBe('resolved');
    // Day 12: the bank reverses an earlier $99.00 charge (the first month,
    // billed before the price moved to $150.00). The dispute ledger has it.
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
    const { quote, res } = await cardUpdate(w, 4);
    const observed = {
      ledger_amount_cents: 9900,
      state_last_failed_amount_cents: w.state()?.last_failed_amount_cents ?? null,
      quote_dispute_amount_cents: quote.disputes[0]?.amount_cents ?? null,
      reply_names_150: res.message.includes('$150.00'),
      message: res.message,
    };
    // eslint-disable-next-line no-console
    console.log(`PROBE P3 observed ${JSON.stringify(observed)}`);
    // Expected: the disputed charge's amount (9900) or no amount at all.
    expect([9900, null]).toContain(observed.quote_dispute_amount_cents);
    expect(observed.reply_names_150).toBe(false);
  });
});

