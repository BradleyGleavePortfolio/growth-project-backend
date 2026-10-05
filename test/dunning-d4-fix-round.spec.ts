import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BillingService } from '../src/billing/billing.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningLockoutScheduler } from '../src/checkout/dunning-v2/dunning-lockout.scheduler';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { renderBillingUpdateCardPage } from '../src/public-pages/public-pages.html';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

/**
 * B-D34-116 fix round on dunning D4 (#690): B-690-1 (a live subscription
 * update never resurrects a 2A cancel), B-690-2 (a failed dispute check
 * fails the delivery, never resolves), B-690-3 (dispute effects are awaited
 * and a failure is redelivered, not deduplicated), B-690-4 (closed codes in
 * logs), B-690-5 (unpaid keeps the Days 0-9 grace), Opus C-690-1 (a late
 * payment_failed never reopens an ended plan) and the card page copy. Each
 * case failed on f72668c2.
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
  stripe.addInvoice({ id: 'in_renewal', subscription: 'sub_client', amount_due: 15000 });
  fake.seed('coachPackage', { id: 'package', billing_type: 'recurring', price_cents: 15000 });
  fake.seed('user', { id: 'client', name: 'Synthetic Client', role: 'student' });
  fake.seed('user', { id: 'coach', name: 'Synthetic Coach', role: 'coach' });
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
  const refundDispute = stub({
    handle: jest.fn(async () => ({ claimed: true, purchase_id: 'purchase' })),
  });
  const handler = new CheckoutWebhookHandlerService(
    prisma,
    stub(stripe),
    undefined,
    v1,
    refundDispute,
    undefined,
    undefined,
    v2,
  );
  const billing = new ClientBillingService(prisma, stub(stripe), v1, v2);
  const outer = new BillingService(
    prisma,
    stub({ capture: jest.fn() }),
    stub({ log: jest.fn() }),
    undefined,
    handler,
  );
  const purchase = () => fake.find('clientPurchase', { id: 'purchase' });
  const state = () => fake.find('dunningState', { id: 'state' });
  return { fake, prisma, stripe, v1, v2, handler, billing, outer, purchase, state };
}
type World = ReturnType<typeof world>;

const event = (id: string, type: string, object: Record<string, unknown>) => ({
  id,
  type,
  created: Math.floor(NOW.getTime() / 1000),
  data: { object },
});
const paid = (id: string) =>
  event(id, 'invoice.paid', { id: 'in_paid', subscription: 'sub_client', amount_paid: 15000 });
const updated = (id: string, status: string) =>
  event(id, 'customer.subscription.updated', {
    id: 'sub_client',
    status,
    current_period_end: Math.floor(NOW.getTime() / 1000) + 20 * 86400,
  });
const context = () =>
  stub({
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'client', role: 'student' } }) }),
    getHandler: () => context,
    getClass: () => ClientEntitlementGuard,
  });
const guard = (w: World) =>
  new ClientEntitlementGuard(w.prisma, new Reflector()).canActivate(context());
const logged = () =>
  JSON.stringify([
    stub(Logger.prototype.warn).mock.calls,
    stub(Logger.prototype.error).mock.calls,
    stub(Logger.prototype.log).mock.calls,
  ]);

/** Pauses the webhook at its package read (after the cancel checks ran). */
function barrier(w: World) {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (entered = r));
  const lookup = w.prisma.coachPackage.findUnique;
  w.prisma.coachPackage.findUnique = async (args: unknown) => {
    entered();
    await gate;
    return lookup(args);
  };
  return { reached, release: () => release() };
}

function graceDay7(w: World, status: string) {
  Object.assign(w.purchase()!, { status, entitlement_active: true });
  Object.assign(w.state()!, {
    locked_out_at: null,
    entered_at: new Date(NOW.getTime() - 7 * 86400000),
  });
}

describe('B-D34-116 dunning D4 fix round (#690)', () => {
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

  it('B-690-1: a subscription update in flight cannot resurrect a 2A cancel that completed meanwhile', async () => {
    const w = world();
    const b = barrier(w);
    const pending = w.handler.handle(updated('evt_inflight', 'active'));
    await b.reached;
    expect((await w.billing.cancelPlan('client', 'purchase')).outcome).toBe('ended');
    b.release();
    // Main's B-680-1 lock check sees the ended plan first (same outcome).
    await expect(pending).resolves.toMatchObject({ reason: 'subscription_already_ended' });
    expect(w.purchase()).toMatchObject({ status: 'canceled', entitlement_active: false });
  });

  it('B-690-1: a 2A intent recorded while the update is in flight blocks the live write', async () => {
    const w = world();
    const b = barrier(w);
    const pending = w.handler.handle(updated('evt_pending', 'active'));
    await b.reached;
    w.fake.seed('clientBillingOperation', {
      id: 'op_cancel',
      purchase_id: 'purchase',
      kind: 'cancel',
      completed_at: null,
    });
    b.release();
    await expect(pending).resolves.toMatchObject({ reason: 'stale_after_cancel' });
    expect(w.purchase()).toMatchObject({ status: 'past_due', entitlement_active: false });
  });

  it('B-690-1 control: a live update with no cancel applies (paid meanwhile)', async () => {
    const w = world();
    await w.handler.handle(updated('evt_live', 'active'));
    expect(w.purchase()).toMatchObject({ status: 'active', entitlement_active: true });
  });

  it('B-690-2: a failed dispute check fails the delivery; the redelivery keeps the dispute cycle', async () => {
    const w = world('charge_disputed');
    w.stripe.subs.get('sub_client')!.status = 'active';
    const err = Object.assign(new Error(SENTINEL), { code: 'P2024' });
    jest.spyOn(w.v2, 'isDisputeCycleOpen').mockRejectedValueOnce(err);
    await expect(w.handler.handle(paid('evt_paid'))).rejects.toThrow(
      'DUNNING_DISPUTE_CHECK_FAILED',
    );
    expect(w.state()).toMatchObject({ status: 'active', locked_out_at: OLD });
    await w.handler.handle(paid('evt_paid'));
    expect(w.state()).toMatchObject({
      status: 'active',
      locked_out_at: OLD,
      last_failure_reason: 'charge_disputed',
    });
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('B-690-3: a failed dispute closure is redelivered (no processed row) and the retry applies it', async () => {
    const w = world('charge_disputed');
    Object.assign(w.purchase()!, { status: 'active' });
    w.fake.seed('connectTransfer', {
      id: 'tr_old',
      source_stripe_charge_id: 'ch_old',
      purchase_id: 'purchase',
    });
    w.fake.seed('dunningDisputeObligation', {
      id: 'obligation',
      purchase_id: 'purchase',
      stripe_dispute_id: 'dp_old',
      stripe_charge_id: 'ch_old',
      status: 'needs_response',
      closed_at: null,
    });
    const closure = jest.spyOn(w.v2, 'onDisputeClosed').mockRejectedValueOnce(new Error(SENTINEL));
    const won = event('evt_won', 'charge.dispute.closed', {
      id: 'dp_old',
      charge: 'ch_old',
      status: 'won',
    });
    await expect(w.outer.handleEvent(stub(won))).rejects.toThrow('DUNNING_DISPUTE_EFFECT_FAILED');
    expect(w.fake.rows('stripeProcessedEvent')).toHaveLength(0);
    await expect(w.outer.handleEvent(stub(won))).resolves.toMatchObject({ processed: true });
    expect(closure).toHaveBeenCalledTimes(2);
    // D2c (R-DISPUTE-PAUSE): a closed dispute keeps the plan paused until the
    // coach restarts it; the retry pauses billing at Stripe.
    expect(w.state()).toMatchObject({ status: 'active', locked_out_at: expect.any(Date) });
    expect(w.stripe.calls.map((c) => c.op)).toContain('pauseSubscriptionCollection');
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('B-690-4: sweep, dispute-effect and resolution failures log closed codes only', async () => {
    const w = world();
    jest.spyOn(w.v2, 'runSweep').mockRejectedValueOnce(new Error(SENTINEL));
    await new DunningLockoutScheduler(w.v2).handleCron();
    jest.spyOn(w.v2, 'detectAndHandleLateReversal').mockRejectedValueOnce(new TypeError(SENTINEL));
    await expect(
      w.handler.handle(
        stub(event('evt_dp', 'charge.dispute.created', { id: 'dp_new', charge: 'ch_new' })),
      ),
    ).rejects.toThrow('DUNNING_DISPUTE_EFFECT_FAILED');
    jest.spyOn(w.v2, 'applyImmediateClear').mockRejectedValueOnce(new Error(SENTINEL));
    await w.handler.handle(paid('evt_paid_clear'));
    expect(
      stub(Logger.prototype.error).mock.calls.length +
        stub(Logger.prototype.warn).mock.calls.length,
    ).toBeGreaterThan(2);
    expect(logged()).not.toContain('SYNTHETIC');
  });

  it('B-690-5: an unpaid plan in an active unlocked cycle keeps Days 0-9 access; Day 10 locks', async () => {
    const w = world();
    graceDay7(w, 'unpaid');
    await expect(guard(w)).resolves.toBe(true);
    w.state()!.locked_out_at = NOW;
    await expect(guard(w)).rejects.toMatchObject({ status: 402 });
  });

  it('B-690-5: subscription.updated to unpaid keeps the grace entitlement; a locked cycle does not', async () => {
    const w = world();
    graceDay7(w, 'past_due');
    await w.handler.handle(updated('evt_unpaid', 'unpaid'));
    expect(w.purchase()).toMatchObject({ status: 'unpaid', entitlement_active: true });
    await expect(guard(w)).resolves.toBe(true);
    const locked = world();
    graceDay7(locked, 'past_due');
    locked.state()!.locked_out_at = NOW;
    await locked.handler.handle(updated('evt_unpaid_locked', 'unpaid'));
    expect(locked.purchase()).toMatchObject({ status: 'unpaid', entitlement_active: false });
  });

  it('B-690-5 control: past_due keeps Day-7 access', async () => {
    const w = world();
    graceDay7(w, 'past_due');
    await expect(guard(w)).resolves.toBe(true);
  });

  it('C-690-1 (Opus): a late payment_failed after a 2A cancel leaves the ended plan as is; last_error is a code', async () => {
    const w = world();
    expect((await w.billing.cancelPlan('client', 'purchase')).outcome).toBe('ended');
    const failed = (id: string) =>
      event(id, 'invoice.payment_failed', {
        id: 'in_retry',
        subscription: 'sub_client',
        amount_due: 15000,
        billing_reason: 'subscription_cycle',
        last_payment_error: { code: 'card_declined', message: SENTINEL },
      });
    await w.handler.handle(failed('evt_late'));
    expect(w.purchase()).toMatchObject({ status: 'canceled', entitlement_active: false });
    const live = world();
    Object.assign(live.purchase()!, { status: 'active', entitlement_active: true });
    await live.handler.handle(failed('evt_live_fail'));
    expect(live.purchase()).toMatchObject({ status: 'past_due', last_error: 'card_declined' });
  });

  it('C-690-3: the card page copy has no first person and promises access only after payment', () => {
    const html = renderBillingUpdateCardPage();
    expect(html).not.toMatch(/\b(our|we|us)\b/i);
    expect(html).not.toContain('access stays on');
    expect(html).toContain('once that payment goes through');
  });
});
