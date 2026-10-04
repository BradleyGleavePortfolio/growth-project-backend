import { Logger } from '@nestjs/common';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

// Audit-only exact-D3-head probes; no D4 controller/webhook dependencies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (value: unknown): any => value;
const NOW = new Date('2026-10-16T16:00:00.000Z');
const OLD = new Date(NOW.getTime() - 11 * 86400000);

function world(reason = 'declined') {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const stripe = new FakeStripeBilling();
  stripe.customers.set('cus_client', { id: 'cus_client', default_payment_method: 'pm_old' });
  stripe.subs.set('sub_client', {
    id: 'sub_client', status: 'past_due', customer: 'cus_client',
    current_period_end: Math.floor(NOW.getTime() / 1000) + 20 * 86400,
    default_payment_method: 'pm_old', cancel_at_period_end: false, latest_invoice: null,
  });
  stripe.addCard('pm_old', 'decline', '0002');
  stripe.addCard('pm_ok', 'ok', '4242');
  stripe.addInvoice({ id: 'in_renewal', subscription: 'sub_client', amount_due: 15000 });
  fake.seed('user', { id: 'client', name: 'Synthetic Client', role: 'student' });
  fake.seed('user', { id: 'coach', name: 'Synthetic Coach', role: 'coach' });
  fake.seed('coachPackage', { id: 'package', billing_type: 'recurring', price_cents: 15000 });
  fake.seed('connectCustomer', { id: 'customer', client_user_id: 'client', stripe_customer_id: 'cus_client' });
  fake.seed('clientPurchase', {
    id: 'purchase', client_user_id: 'client', coach_user_id: 'coach', package_id: 'package',
    billing_type: 'recurring', status: 'past_due', entitlement_active: false,
    stripe_subscription_id: 'sub_client', amount_cents: 15000, currency: 'usd',
    created_at: OLD, current_period_end: OLD, access_expires_at: OLD,
  });
  fake.seed('dunningState', {
    id: 'state', purchase_id: 'purchase', status: 'active', last_failure_reason: reason,
    locked_out_at: OLD, entered_at: OLD, client_canceled_at: null,
    step_index: 3, last_failed_amount_cents: 15000,
  });
  const v1 = new DunningService(prisma, stub(stripe));
  const v2 = new DunningV2Service(prisma, new DunningV2Telemetry(), undefined, stub(stripe));
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2);
  return { fake, prisma, stripe, v1, v2, billing };
}

async function setup(w: ReturnType<typeof world>) {
  const si = await w.billing.createCardSetup('client', '00000000-0000-4000-8000-000000000001');
  w.stripe.confirmSetupIntentInSheet(si.setup_intent_id, 'pm_ok');
  const quote = await w.billing.getPaymentQuote('client');
  const approved = quote.lines.map(l => ({
    invoice_id: l.invoice_id, currency: l.currency, amount_cents: l.amount_cents,
  }));
  return { id: si.setup_intent_id, approved };
}

function seedObligation(w: ReturnType<typeof world>, status = 'needs_response') {
  w.fake.seed('dunningDisputeObligation', {
    id: 'obligation', purchase_id: 'purchase', stripe_dispute_id: 'dp_old',
    stripe_charge_id: 'ch_old', status, closed_at: status === 'lost' ? NOW : null,
  });
}

async function lostReceipt(w: ReturnType<typeof world>) {
  const make = w.fake.client.bind(w.fake);
  let armed = true;
  jest.spyOn(w.fake, 'client').mockImplementation((viaTx = false) => {
    const client = make(viaTx);
    if (viaTx) {
      const update = client.clientBillingOperation.update;
      client.clientBillingOperation.update = async (args: unknown) => {
        if (armed && w.stripe.charges.length > 0) {
          armed = false;
          throw new Error('synthetic receipt transaction failure');
        }
        return update(args);
      };
    }
    return client;
  });
  const si = await setup(w);
  await w.billing.confirmCardUpdate('client', si.id, si.approved);
  expect(w.stripe.charges).toHaveLength(1);
  expect(w.fake.find('clientBillingOperation', { setup_intent_id: si.id })?.lines)
    .toEqual([expect.objectContaining({ result: 'paying' })]);
  return si;
}

describe('AUD-SOL-D34-118 #689 prior controls and new interleavings', () => {
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

  it('control: a marked dispute cycle remains active after card payment', async () => {
    const w = world('charge_disputed');
    seedObligation(w);
    const si = await setup(w);
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0].dispute_open).toBe(true);
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('active');
    expect(w.stripe.charges).toHaveLength(1);
  });

  it('B-689-1: an open dispute recorded during a payment cycle survives a successful card update', async () => {
    const w = world();
    seedObligation(w);
    expect(await w.v2.isDisputeCycleOpen('purchase')).toBe(true);
    const si = await setup(w);
    await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('active');
  });

  it('B-689-1: a dispute that arrives while pay is awaiting the provider is not cleared', async () => {
    const w = world();
    const si = await setup(w);
    w.stripe.beforePay = () => { seedObligation(w); };
    await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('active');
  });

  it('B-689-2: provider diagnostics never cross the billing log boundary', async () => {
    const w = world();
    const sentinel = 'SYNTHETIC-person@tgp.invalid Bearer SYNTHETIC_TOKEN body=SYNTHETIC_MESSAGE';
    jest.spyOn(w.stripe, 'createSetupIntent').mockRejectedValueOnce(
      new StripeConnectApiError(sentinel, 503, 'request_timeout', 'api_error'),
    );
    await expect(w.billing.createCardSetup('client', '00000000-0000-4000-8000-000000000002'))
      .rejects.toMatchObject({ response: { code: 'STRIPE_UNAVAILABLE' } });
    const logs = JSON.stringify(stub(Logger.prototype.warn).mock.calls);
    expect(logs).not.toContain(sentinel);
  });

  it('B-689-3: an initial 503 before pay executes cannot credit a concurrent Stripe retry to this update', async () => {
    const w = world();
    const si = await setup(w);
    w.stripe.beforePay = id => {
      w.stripe.beforePay = undefined;
      expect(w.stripe.stripeRetry(id)).toBe('paid');
      throw new StripeConnectApiError('synthetic upstream failure before pay execution', 503, 'request_timeout', 'api_error');
    };
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(w.stripe.charges).toEqual([expect.objectContaining({ by: 'stripe_retry', amount: 15000 })]);
    // The invoice is paid, but there is no operation-authoritative receipt
    // saying this card-update pay collected it; reconcile the same key.
    expect(res.plans[0].outcome).toBe('uncertain');
    expect(w.fake.find('clientBillingOperation', { setup_intent_id: si.id })?.completed_at ?? null).toBeNull();
  });

  it('B-689-4: canceling a dispute-only dunning cycle ends access now, not at an apparent paid invoice period end', async () => {
    const w = world('charge_disputed');
    seedObligation(w);
    const inv = w.stripe.invoices.get('in_renewal')!;
    // A disputed payment remains a paid invoice in the provider model:
    // charge/dispute obligations, not invoice status, represent its reversal.
    inv.status = 'paid'; inv.amount_paid = 15000; inv.amount_remaining = 0;
    w.stripe.subs.get('sub_client')!.status = 'active';
    expect(await w.v2.isDisputeCycleOpen('purchase')).toBe(true);
    const res = await w.billing.cancelPlan('client', 'purchase');
    expect(res.outcome).toBe('ended');
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    expect(w.fake.find('clientPurchase', { id: 'purchase' })?.entitlement_active).toBe(false);
  });

  it.each(['foreground', 'background'])('B-628-11 closure control: %s retains an unreplayed 400 then recovers 15000 cents', async mode => {
    const w = world();
    const si = await lostReceipt(w);
    w.stripe.payErrors.push(new StripeConnectApiError('synthetic unrecognized parameter', 400, 'parameter_unknown', 'invalid_request_error'));
    const op = () => w.fake.find('clientBillingOperation', { setup_intent_id: si.id });
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60000));
    if (mode === 'foreground') {
      const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
      expect(res.outcome).toBe('payment_uncertain');
    } else {
      await w.billing.reconcile();
    }
    expect(op()?.completed_at ?? null).toBeNull();
    expect(op()?.lines).toEqual([expect.objectContaining({ result: 'paying', amount_paid_cents: 0 })]);
    jest.setSystemTime(new Date(NOW.getTime() + 80 * 60000));
    if (mode === 'foreground') {
      const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
      expect(res.amount_paid_cents).toBe(15000);
    } else {
      await w.billing.reconcile();
    }
    expect(op()?.lines).toEqual([expect.objectContaining({ result: 'paid', amount_paid_cents: 15000 })]);
    expect(w.stripe.charges).toHaveLength(1);
  });

  it('C-628-14 closure control: first-call 429 cannot credit another collector', async () => {
    const w = world();
    const si = await setup(w);
    w.stripe.beforePay = id => {
      w.stripe.beforePay = undefined;
      expect(w.stripe.stripeRetry(id)).toBe('paid');
      throw new StripeConnectApiError('synthetic rate limit', 429, 'rate_limit', 'invalid_request_error');
    };
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.plans[0].invoices[0]).toMatchObject({ result: 'already_paid', amount_paid_cents: 0 });
  });

  it('D3 residual B-689-1: a dispute arriving after the locked check but before v1 survives', async () => {
    const w = world();
    const si = await setup(w);
    const resolve = w.v1.recordResolution.bind(w.v1);
    jest.spyOn(w.v1, 'recordResolution').mockImplementation(async id => {
      await w.v2.handleLateReversal({
        purchaseId: id, reversedChargeAt: NOW, now: NOW,
        disputeId: 'dp_after_locked_check', chargeId: 'ch_after_locked_check',
      });
      expect(await w.v2.isDisputeCycleOpen(id)).toBe(true);
      return resolve(id);
    });
    await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('active');
    expect(await w.v2.isDisputeCycleOpen('purchase')).toBe(true);
  });

  it('D3 residual B-689-4: a dispute arriving during the period lookup makes cancel immediate', async () => {
    const w = world();
    const inv = w.stripe.invoices.get('in_renewal')!;
    Object.assign(inv, { status: 'paid', amount_paid: 15000, amount_remaining: 0 });
    w.stripe.subs.get('sub_client')!.status = 'active';
    const read = w.stripe.retrieveSubscription.bind(w.stripe);
    jest.spyOn(w.stripe, 'retrieveSubscription').mockImplementationOnce(async id => {
      seedObligation(w);
      return read(id);
    });
    const result = await w.billing.cancelPlan('client', 'purchase');
    expect(result.outcome).toBe('ended');
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    expect(w.fake.find('clientPurchase', { id: 'purchase' })?.entitlement_active).toBe(false);
  });

  it('D3 out-of-band 2A: an active-provider status does not hide an unresolved dispute cycle', async () => {
    const w = world('charge_disputed');
    seedObligation(w);
    const inv = w.stripe.invoices.get('in_renewal')!;
    Object.assign(inv, { status: 'paid', amount_paid: 15000, amount_remaining: 0 });
    w.stripe.subs.get('sub_client')!.status = 'active';
    Object.assign(w.fake.find('clientPurchase', { id: 'purchase' })!, {
      status: 'active', entitlement_active: true, cancel_at_period_end: true,
    });
    await w.billing.reconcile();
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    expect(w.fake.find('clientPurchase', { id: 'purchase' })?.status).toBe('canceled');
  });

  it('D3 lock order: paid restoration takes the cycle lock before the purchase write', async () => {
    const w = world('charge_disputed');
    seedObligation(w);
    const si = await setup(w);
    const trace: string[] = [];
    const make = w.fake.client.bind(w.fake);
    jest.spyOn(w.fake, 'client').mockImplementation((viaTx = false) => {
      const tx = make(viaTx);
      if (viaTx) {
        const write = tx.clientPurchase.updateMany;
        tx.clientPurchase.updateMany = async (args: unknown) => {
          trace.push('purchase_write');
          return write(args);
        };
        tx.$queryRaw = async (parts: TemplateStringsArray) => {
          if (parts.join('').includes('DunningState')) trace.push('cycle_lock');
          return [];
        };
      }
      return tx;
    });
    await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(trace).toContain('purchase_write');
    expect(trace).toContain('cycle_lock');
    // D2 favorable closure already locks DunningState before updating ClientPurchase.
    expect(trace.indexOf('cycle_lock')).toBeLessThan(trace.indexOf('purchase_write'));
  });

  it('C-628-15 closure control: first-call 409 preserves uncertainty', async () => {
    const w = world();
    const si = await setup(w);
    w.stripe.payErrors.push(new StripeConnectApiError('synthetic key in use', 409, 'idempotency_key_in_use', 'invalid_request_error'));
    const res = await w.billing.confirmCardUpdate('client', si.id, si.approved);
    expect(res.outcome).toBe('payment_uncertain');
    expect(res.message).not.toMatch(/nothing was charged/i);
  });
});
