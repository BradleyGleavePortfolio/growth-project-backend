import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BillingService } from '../src/billing/billing.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DunningLockoutScheduler } from '../src/checkout/dunning-v2/dunning-lockout.scheduler';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

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
  stripe.addInvoice({ id: 'in_renewal', subscription: 'sub_client', amount_due: 15000 });
  fake.seed('coachPackage', { id: 'package', billing_type: 'recurring', price_cents: 15000 });
  fake.seed('user', { id: 'client', name: 'Synthetic Client', role: 'student' });
  fake.seed('user', { id: 'coach', name: 'Synthetic Coach', role: 'coach' });
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
  const handler = new CheckoutWebhookHandlerService(
    prisma, stub(stripe), undefined, v1,
    stub({ handle: jest.fn(async () => ({ claimed: true, purchase_id: 'purchase' })) }),
    undefined, undefined, v2,
  );
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2);
  const outer = new BillingService(prisma, stub({ capture: jest.fn() }), stub({ log: jest.fn() }), undefined, handler);
  return { fake, prisma, stripe, v1, v2, handler, billing, outer };
}
const event = (id: string, type: string, object: Record<string, unknown>) => ({ id, type, data: { object } });
async function flush() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }
const context = () => stub({
  switchToHttp: () => ({ getRequest: () => ({ user: { id: 'client', role: 'student' } }) }),
  getHandler: () => context, getClass: () => ClientEntitlementGuard,
});

describe('AUD-SOL-D34-118 #690 prior controls and new interleavings', () => {
  const priorEnv = { ...process.env };
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks(); jest.useRealTimers(); process.env = { ...priorEnv };
  });

  it('control: an already completed cancel rejects a stale active subscription update', async () => {
    const w = world();
    await w.billing.cancelPlan('client', 'purchase');
    await w.handler.handle(event('evt_stale', 'customer.subscription.updated', {
      id: 'sub_client', status: 'active',
    }));
    expect(w.fake.find('clientPurchase', { id: 'purchase' })?.status).toBe('canceled');
  });

  it('B-690-1: a subscription update already in flight cannot resurrect a completed 2A cancel', async () => {
    const w = world();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const lookup = w.prisma.coachPackage.findUnique;
    w.prisma.coachPackage.findUnique = async (args: unknown) => {
      entered(); await gate; return lookup(args);
    };
    const pending = w.handler.handle(event('evt_inflight', 'customer.subscription.updated', {
      id: 'sub_client', status: 'active', current_period_end: Math.floor(NOW.getTime() / 1000) + 20 * 86400,
    }));
    await reached;
    const cancel = await w.billing.cancelPlan('client', 'purchase');
    expect(cancel.outcome).toBe('ended');
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    release(); await pending;
    expect(w.fake.find('clientPurchase', { id: 'purchase' })).toMatchObject({
      status: 'canceled', entitlement_active: false,
    });
  });

  it('control: the renewal webhook preserves a positively identified open dispute cycle', async () => {
    const w = world('charge_disputed');
    w.stripe.subs.get('sub_client')!.status = 'active';
    await w.handler.handle(event('evt_paid', 'invoice.paid', { id: 'in_paid', subscription: 'sub_client', amount_paid: 15000 }));
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('active');
  });

  it('B-690-2: a failed dispute-authority read cannot resolve and unlock a disputed cycle', async () => {
    const w = world('charge_disputed');
    w.stripe.subs.get('sub_client')!.status = 'active';
    jest.spyOn(w.v2, 'isDisputeCycleOpen').mockRejectedValueOnce(new Error('synthetic authority read unavailable'));
    await expect(w.handler.handle(event('evt_paid_unavailable', 'invoice.paid', { id: 'in_paid', subscription: 'sub_client', amount_paid: 15000 })))
      .rejects.toThrow('DUNNING_DISPUTE_CHECK_FAILED');
    expect(w.fake.find('dunningState', { id: 'state' })).toMatchObject({
      status: 'active', locked_out_at: OLD,
    });
  });

  it('B-690-3: failed dispute-closure persistence cannot be acknowledged and dedup-swallowed', async () => {
    const w = world('charge_disputed');
    const closure = jest.spyOn(w.v2, 'onDisputeClosed').mockRejectedValueOnce(new Error('synthetic closure DB unavailable'));
    const won = event('evt_won', 'charge.dispute.closed', { id: 'dp_old', charge: 'ch_old', status: 'won' });
    const first = await w.outer.handleEvent(won).then(result => ({ result }), error => ({ error }));
    await flush();
    const second = await w.outer.handleEvent(won);
    expect(second).toMatchObject({ processed: true });
    expect(closure).toHaveBeenCalledTimes(2);
    // Accepted failure needs either non-ack/retry or a durable retry intent.
    expect(stub(first).result?.processed === true && w.fake.rows('stripeProcessedEvent').length === 1).toBe(false);
  });

  it('B-690-4: newly wired sweep diagnostics never disclose arbitrary provider text', async () => {
    const w = world();
    const sentinel = 'SYNTHETIC-person@tgp.invalid Bearer SYNTHETIC_TOKEN body=SYNTHETIC_MESSAGE';
    jest.spyOn(w.v2, 'runSweep').mockRejectedValueOnce(new Error(sentinel));
    await new DunningLockoutScheduler(w.v2).handleCron();
    expect(JSON.stringify(stub(Logger.prototype.error).mock.calls)).not.toContain(sentinel);
  });

  it('control: past_due active unlocked cycle retains Day-7 access', async () => {
    const w = world();
    const p = w.fake.find('clientPurchase', { id: 'purchase' })!;
    const s = w.fake.find('dunningState', { id: 'state' })!;
    p.entitlement_active = true; s.locked_out_at = null;
    s.entered_at = new Date(NOW.getTime() - 7 * 86400000);
    await expect(new ClientEntitlementGuard(w.prisma, new Reflector()).canActivate(context())).resolves.toBe(true);
  });

  it('D4 residual B-690-1: invoice.paid already prefetched before a 2A cancel never resurrects it', async () => {
    const w = world();
    w.stripe.subs.get('sub_client')!.status = 'active';
    const paid = event('evt_paid_before_cancel', 'invoice.paid', {
      id: 'in_old_paid', subscription: 'sub_client', amount_paid: 15000,
    });
    const prefetched = await w.handler.prefetchForOuterTx(paid);
    // The provider snapshot was active; the event has not yet opened its outer tx.
    expect(prefetched.invoiceSubscription?.status).toBe('active');
    await expect(w.billing.cancelPlan('client', 'purchase')).resolves.toMatchObject({ outcome: 'ended' });
    await w.prisma.$transaction((tx: unknown) => w.handler.handle(paid, stub(tx), prefetched));
    expect(w.stripe.subs.get('sub_client')?.status).toBe('canceled');
    expect(w.fake.find('clientPurchase', { id: 'purchase' })).toMatchObject({
      status: 'canceled', entitlement_active: false,
    });
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('abandoned');
  });

  it('D4: an in-flight invoice.payment_failed cannot reopen a completed 2A cancel', async () => {
    const w = world();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const lookup = w.prisma.clientBillingOperation.findFirst;
    let armed = true;
    w.prisma.clientBillingOperation.findFirst = async (args: unknown) => {
      const result = await lookup(args);
      if (armed) { armed = false; entered(); await gate; }
      return result;
    };
    const pending = w.handler.handle(event('evt_fail_inflight', 'invoice.payment_failed', {
      id: 'in_renewal', subscription: 'sub_client', amount_due: 15000,
      billing_reason: 'subscription_cycle', last_payment_error: { code: 'card_declined' },
    }));
    await reached;
    await w.billing.cancelPlan('client', 'purchase');
    release(); await pending;
    expect(w.fake.find('clientPurchase', { id: 'purchase' })).toMatchObject({
      status: 'canceled', entitlement_active: false,
    });
    expect(w.fake.find('dunningState', { id: 'state' })?.status).toBe('abandoned');
  });

  it('D4 residual B-690-5: invoice.paid resync to unpaid retains the already-entitled grace', async () => {
    const w = world();
    const p = w.fake.find('clientPurchase', { id: 'purchase' })!;
    const s = w.fake.find('dunningState', { id: 'state' })!;
    p.entitlement_active = true;
    s.locked_out_at = null;
    s.entered_at = new Date(NOW.getTime() - 7 * 86400000);
    w.stripe.subs.get('sub_client')!.status = 'unpaid';
    await w.handler.handle(event('evt_older_invoice_paid', 'invoice.paid', {
      id: 'in_older', subscription: 'sub_client', amount_paid: 15000,
    }));
    expect(w.fake.find('clientPurchase', { id: 'purchase' })?.entitlement_active).toBe(true);
    await expect(new ClientEntitlementGuard(w.prisma, new Reflector()).canActivate(context())).resolves.toBe(true);
  });

  it('grace boundary: an unpaid active unlocked cycle retains Day-7 access', async () => {
    const w = world();
    const p = w.fake.find('clientPurchase', { id: 'purchase' })!;
    const s = w.fake.find('dunningState', { id: 'state' })!;
    p.status = 'unpaid'; p.entitlement_active = true; s.locked_out_at = null;
    s.entered_at = new Date(NOW.getTime() - 7 * 86400000);
    await expect(new ClientEntitlementGuard(w.prisma, new Reflector()).canActivate(context())).resolves.toBe(true);
  });
});
