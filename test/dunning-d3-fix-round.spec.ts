import { Logger } from '@nestjs/common';
import { ClientBillingReconciler } from '../src/checkout/client-billing.reconciler';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import {
  DUNNING_V2_REVERSAL_REASON,
  DunningV2Service,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

/**
 * B-D34-116 fix round on dunning D3 (#689): B-689-1 (a payment never
 * settles a dispute; obligation-aware authority under the cycle lock on the
 * card, replay, quote and reconcile paths), B-689-2 (closed diagnostic
 * codes only), B-689-3 (a paid invoice is attributed only by the same-key
 * replay), B-689-4 (cancel of a disputed cycle is 2A). Each case failed on
 * 9e77159a.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (value: unknown): any => value;
const NOW = new Date('2026-10-16T16:00:00.000Z');
const OLD = new Date(NOW.getTime() - 11 * 86400000);
const SENTINEL = 'SYNTHETIC-person@tgp.invalid Bearer SYNTHETIC_TOKEN body=SYNTHETIC_MESSAGE';

function world(reason = 'declined') {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripe = new FakeStripeBilling();
  stripe.customers.set('cus_client', { id: 'cus_client', default_payment_method: 'pm_old' });
  stripe.subs.set('sub_client', {
    id: 'sub_client',
    status: 'past_due',
    customer: 'cus_client',
    current_period_end: Math.floor(NOW.getTime() / 1000) + 20 * 86400,
    default_payment_method: 'pm_old',
    cancel_at_period_end: false,
    latest_invoice: null,
  });
  stripe.addCard('pm_old', 'decline', '0002');
  stripe.addCard('pm_ok', 'ok', '4242');
  stripe.addInvoice({ id: 'in_renewal', subscription: 'sub_client', amount_due: 15000 });
  fake.seed('user', { id: 'client', name: 'Synthetic Client', role: 'student' });
  fake.seed('user', { id: 'coach', name: 'Synthetic Coach', role: 'coach' });
  fake.seed('coachPackage', { id: 'package', billing_type: 'recurring', price_cents: 15000 });
  fake.seed('connectCustomer', {
    id: 'customer',
    client_user_id: 'client',
    stripe_customer_id: 'cus_client',
  });
  fake.seed('clientPurchase', {
    id: 'purchase',
    client_user_id: 'client',
    coach_user_id: 'coach',
    package_id: 'package',
    billing_type: 'recurring',
    status: 'past_due',
    entitlement_active: false,
    stripe_subscription_id: 'sub_client',
    amount_cents: 15000,
    currency: 'usd',
    created_at: OLD,
    current_period_end: OLD,
    access_expires_at: OLD,
  });
  fake.seed('dunningState', {
    id: 'state',
    purchase_id: 'purchase',
    status: 'active',
    last_failure_reason: reason,
    locked_out_at: OLD,
    entered_at: OLD,
    client_canceled_at: null,
    step_index: 3,
    last_failed_amount_cents: 15000,
  });
  const v1 = new DunningService(prisma, stub(stripe));
  const v2 = new DunningV2Service(prisma, new DunningV2Telemetry(), undefined, stub(stripe));
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2);
  const state = () => fake.find('dunningState', { id: 'state' });
  const op = (id: string) => fake.find('clientBillingOperation', { setup_intent_id: id });
  return { fake, stripe, v2, billing, state, op };
}
type World = ReturnType<typeof world>;

async function approve(w: World) {
  const si = await w.billing.createCardSetup('client', '00000000-0000-4000-8000-000000000001');
  w.stripe.confirmSetupIntentInSheet(si.setup_intent_id, 'pm_ok');
  const quote = await w.billing.getPaymentQuote('client');
  const approved = quote.lines.map((l) => ({
    invoice_id: l.invoice_id,
    currency: l.currency,
    amount_cents: l.amount_cents,
  }));
  return { id: si.setup_intent_id, approved, quote };
}

function dispute(w: World) {
  w.fake.seed('dunningDisputeObligation', {
    id: 'obligation',
    purchase_id: 'purchase',
    stripe_dispute_id: 'dp_old',
    stripe_charge_id: 'ch_old',
    status: 'needs_response',
    closed_at: null,
  });
  // D2c (R-DISPUTE-PAUSE): recording a dispute marks the active cycle.
  Object.assign(w.state() ?? {}, { last_failure_reason: DUNNING_V2_REVERSAL_REASON });
}

const unavailable = () => new StripeConnectApiError(SENTINEL, 503, 'request_timeout', 'api_error');
const logged = () =>
  JSON.stringify([
    stub(Logger.prototype.warn).mock.calls,
    stub(Logger.prototype.error).mock.calls,
    stub(Logger.prototype.log).mock.calls,
  ]);

describe('B-D34-116 dunning D3 fix round (#689)', () => {
  const priorEnv = { ...process.env };
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = { ...priorEnv };
  });

  it('B-689-1: an open dispute in a payment cycle survives a paid card update and becomes the dispute cycle', async () => {
    const w = world();
    dispute(w);
    const si = await approve(w);
    expect(si.quote.disputes).toEqual([
      expect.objectContaining({ purchase_id: 'purchase', amount_cents: null }),
    ]);
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(w.stripe.charges).toHaveLength(1);
    expect(res.plans[0]).toMatchObject({
      outcome: 'paid',
      dispute_open: true,
      access: 'unchanged',
    });
    expect(res.message).toMatch(/reversed an earlier payment/);
    expect(res.message).not.toMatch(/still updating/);
    expect(w.state()).toMatchObject({
      status: 'active',
      last_failure_reason: 'charge_disputed',
      locked_out_at: OLD,
    });
  });

  it('B-689-1: a dispute recorded while the pay call is in flight is not cleared', async () => {
    const w = world();
    const si = await approve(w);
    w.stripe.beforePay = () => dispute(w);
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0]).toMatchObject({ outcome: 'paid', dispute_open: true });
    expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });
  });

  it('B-689-1: the background reconcile keeps a dispute recorded before the payment settled', async () => {
    const w = world();
    const si = await approve(w);
    w.stripe.loseNextPayReply = 1;
    w.stripe.beforePay = () => {
      w.stripe.beforePay = undefined;
      w.stripe.payErrors.push(unavailable());
    };
    const first = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(first.outcome).toBe('payment_uncertain');
    dispute(w);
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60000));
    await w.billing.reconcile();
    expect(w.op(si.id)?.lines).toEqual([
      expect.objectContaining({ result: 'paid', amount_paid_cents: 15000 }),
    ]);
    expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: 'charge_disputed' });
    expect(w.stripe.charges).toHaveLength(1);
  });

  it('B-689-1 control: with no dispute the paid card update resolves the cycle and restores access', async () => {
    const w = world();
    const si = await approve(w);
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res).toMatchObject({ outcome: 'paid', access_state: 'restored' });
    expect(w.state()).toMatchObject({ status: 'resolved', locked_out_at: null });
  });

  it('B-689-1: an authority read that fails never resolves the cycle (deferred to the webhook)', async () => {
    const w = world();
    const si = await approve(w);
    jest
      .spyOn(w.v2, 'isDisputeCycleOpen')
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error(SENTINEL));
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0]).toMatchObject({ outcome: 'paid', access: 'updating' });
    expect(w.state()).toMatchObject({ status: 'active', locked_out_at: OLD });
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('B-689-1: a dispute that closed lost during the cycle still blocks the card update (needs #688 B-688-5)', async () => {
    const w = world();
    w.fake.seed('dunningDisputeObligation', {
      id: 'obligation',
      purchase_id: 'purchase',
      stripe_dispute_id: 'dp_lost',
      stripe_charge_id: 'ch_old',
      status: 'lost',
      closed_at: new Date(OLD.getTime() + 5 * 86400000),
    });
    // D2c (R-DISPUTE-PAUSE): the dispute marked the cycle; a loss keeps it.
    Object.assign(w.state() ?? {}, { last_failure_reason: DUNNING_V2_REVERSAL_REASON });
    const si = await approve(w);
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0]).toMatchObject({ outcome: 'paid', dispute_open: true });
    expect(w.state()).toMatchObject({ status: 'active', locked_out_at: OLD });
  });

  it('B-689-3: a paid invoice another collector paid during the await is never credited to the update', async () => {
    const w = world();
    const si = await approve(w);
    w.stripe.beforePay = (id) => {
      w.stripe.beforePay = undefined;
      expect(w.stripe.stripeRetry(id)).toBe('paid');
      throw unavailable();
    };
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0]).toMatchObject({ outcome: 'uncertain', amount_paid_cents: 0 });
    expect(w.op(si.id)?.completed_at ?? null).toBeNull();
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60000));
    await w.billing.reconcile();
    expect(w.op(si.id)?.lines).toEqual([
      expect.objectContaining({ result: 'already_paid', amount_paid_cents: 0 }),
    ]);
    expect(w.op(si.id)?.completed_at).toBeTruthy();
    expect(w.stripe.charges).toEqual([
      expect.objectContaining({ by: 'stripe_retry', amount: 15000 }),
    ]);
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('B-689-3 control: our own pay whose reply was lost is credited at once by the same-key replay', async () => {
    const w = world();
    const si = await approve(w);
    w.stripe.loseNextPayReply = 1;
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res).toMatchObject({ outcome: 'paid', amount_paid_cents: 15000 });
    expect(w.stripe.charges).toEqual([expect.objectContaining({ by: 'tgp_pay', amount: 15000 })]);
  });

  it('B-689-4: cancel of a disputed cycle ends access now even when the latest invoice reads paid', async () => {
    const w = world('charge_disputed');
    dispute(w);
    const inv = w.stripe.invoices.get('in_renewal')!;
    Object.assign(inv, { status: 'paid', amount_paid: 15000, amount_remaining: 0 });
    w.stripe.subs.get('sub_client')!.status = 'active';
    const res = await w.billing.cancelPlan('client', 'purchase');
    expect(res).toMatchObject({ outcome: 'ended', paid_period_kept: false });
    expect(res.message).toMatch(/does not settle the payment your bank reversed/);
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    expect(w.fake.find('clientPurchase', { id: 'purchase' })).toMatchObject({
      status: 'canceled',
      entitlement_active: false,
    });
  });

  it.each([
    ['in the app before the lock', null, 'app'],
    ['in the app after the lock', OLD, 'app'],
    ['outside the app', null, 'out_of_band'],
  ])(
    'B-689-4: a disputed cycle canceled %s ends access now and stays unresolved',
    async (_case, lockedAt, via) => {
      const w = world('charge_disputed');
      Object.assign(w.state()!, { locked_out_at: lockedAt });
      const inv = w.stripe.invoices.get('in_renewal')!;
      Object.assign(inv, { status: 'paid', amount_paid: 15000, amount_remaining: 0 });
      w.stripe.subs.get('sub_client')!.status = 'active';
      if (via === 'app') {
        await expect(w.billing.cancelPlan('client', 'purchase')).resolves.toMatchObject({
          outcome: 'ended',
        });
      } else {
        w.fake.find('clientPurchase', { id: 'purchase' })!.cancel_at_period_end = true;
        await w.billing.reconcile();
      }
      expect(w.fake.find('clientPurchase', { id: 'purchase' })).toMatchObject({
        status: 'canceled',
        entitlement_active: false,
      });
      expect(w.state()?.status).not.toBe('resolved');
    },
  );

  it('B-689-4 control: an ordinary cycle paid meanwhile keeps the paid period (option A)', async () => {
    const w = world();
    const inv = w.stripe.invoices.get('in_renewal')!;
    Object.assign(inv, { status: 'paid', amount_paid: 15000, amount_remaining: 0 });
    w.stripe.subs.get('sub_client')!.status = 'active';
    const res = await w.billing.cancelPlan('client', 'purchase');
    expect(res).toMatchObject({ outcome: 'scheduled', paid_period_kept: true });
    expect(w.state()?.status).toBe('resolved');
  });

  it('B-689-2: provider, database and transport diagnostics never reach the logs', async () => {
    const w = world();
    jest.spyOn(w.stripe, 'createSetupIntent').mockRejectedValueOnce(unavailable());
    await expect(
      w.billing.createCardSetup('client', '00000000-0000-4000-8000-000000000002'),
    ).rejects.toMatchObject({
      response: { code: 'STRIPE_UNAVAILABLE' },
    });
    jest
      .spyOn(w.stripe, 'createSetupIntent')
      .mockRejectedValueOnce(new Error(`fetch failed ${SENTINEL}`));
    await expect(
      w.billing.createCardSetup('client', '00000000-0000-4000-8000-000000000003'),
    ).rejects.toBeTruthy();
    jest.spyOn(w.stripe, 'retrieveSubscription').mockRejectedValueOnce(new TypeError(SENTINEL));
    await expect(w.billing.cancelPlan('client', 'purchase')).rejects.toMatchObject({
      response: { code: 'PLAN_CHANGE_RESULT_UNKNOWN' },
    });
    await new ClientBillingReconciler(
      stub({ reconcile: () => Promise.reject(new Error(SENTINEL)) }),
    ).handleCron();
    expect(
      stub(Logger.prototype.error).mock.calls.length +
        stub(Logger.prototype.warn).mock.calls.length,
    ).toBeGreaterThan(2);
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('C-689-2 (Opus): failing operations back off so a healthy one is reconciled', async () => {
    const w = world();
    const at = new Date(NOW.getTime() - 3600000);
    for (let i = 0; i < 100; i += 1) {
      w.fake.seed('clientBillingOperation', {
        id: `op_bad_${i}`,
        purchase_id: `bad_${i}`,
        kind: 'cancel',
        completed_at: null,
        updated_at: at,
      });
    }
    w.fake.seed('clientBillingOperation', {
      id: 'op_ok',
      purchase_id: 'purchase',
      kind: 'cancel',
      completed_at: null,
      updated_at: new Date(at.getTime() + 1000),
    });
    w.fake.find('clientPurchase', { id: 'purchase' })!.status = 'canceled';
    const prisma = stub(w.billing)['prisma'];
    const read = prisma.clientPurchase.findUnique;
    prisma.clientPurchase.findUnique = (args: { where: { id: string } }) =>
      args.where.id.startsWith('bad_') ? Promise.reject(new Error(SENTINEL)) : read(args);
    await w.billing.reconcile();
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60000));
    await w.billing.reconcile();
    expect(w.fake.find('clientBillingOperation', { id: 'op_ok' })?.completed_at).toBeTruthy();
    expect(logged()).not.toContain('SYNTHETIC');
  });
});
