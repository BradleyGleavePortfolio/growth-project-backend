import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Telemetry } from '../src/checkout/dunning-v2/dunning-v2.telemetry';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { PackagesService } from '../src/packages/packages.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';
import { FakeStripeBilling } from './support/fake-stripe-billing';

// Synthetic fixtures only. No provider requests, database connections or timers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (value: unknown): any => value;

function world() {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const row = fake.seed('clientPurchase', {
    id: 'purchase', package_id: 'package', coach_user_id: 'coach',
    client_user_id: 'client', billing_type: 'recurring', amount_cents: 1000,
    currency: 'usd', status: 'active', entitlement_active: true,
    stripe_subscription_id: 'sub_plan', stripe_payment_intent_id: 'pi_first',
    cancel_at_period_end: false, current_period_end: new Date('2026-11-01'),
  });
  fake.seed('coachPackage', { id: 'package', coach_id: 'coach', archived_at: null });
  fake.seed('user', { id: 'coach', name: 'Synthetic Coach' });
  fake.seed('user', { id: 'client', name: 'Synthetic Client' });
  const billingStripe = new FakeStripeBilling();
  billingStripe.subs.set('sub_plan', {
    id: 'sub_plan', status: 'active', customer: 'cus_client',
    current_period_end: 1793491200, default_payment_method: 'pm_card',
    cancel_at_period_end: false, latest_invoice: null,
  });
  const refunds: Array<{ id: string; amount: number; currency: string; status: string }> = [];
  const cancellationAnswers = new Map<string, unknown>();
  const originalCancel = billingStripe.setCancelAtPeriodEnd.bind(billingStripe);
  billingStripe.setCancelAtPeriodEnd = async (args) => {
    if (cancellationAnswers.has(args.idempotencyKey)) {
      billingStripe.calls.push({ op: 'setCancelAtPeriodEnd', key: args.idempotencyKey, args });
      return stub(cancellationAnswers.get(args.idempotencyKey));
    }
    const answer = await originalCancel(args);
    cancellationAnswers.set(args.idempotencyKey, answer);
    return answer;
  };
  let latestCharge = 'ch_renewal';
  let chargeAmount = 1000;
  const stripe = Object.assign(billingStripe, {
    resumeSubscriptionCollection: jest.fn(async (args: { subscriptionId: string; idempotencyKey: string }) => {
      billingStripe.calls.push({ op: 'resumeSubscriptionCollection', key: args.idempotencyKey, args });
      return { ...billingStripe.subs.get(args.subscriptionId)! };
    }),
    retrievePaymentIntent: jest.fn(async () => ({ id: 'pi_first', latest_charge: 'ch_first' })),
    retrieveCharge: jest.fn(async (id: string) => ({
      id, amount: chargeAmount, payment_intent: 'pi_first',
    })),
    listChargeRefunds: jest.fn(async () => ({ data: refunds, has_more: false })),
    createRefund: jest.fn(async (args: { amount?: number }) => {
      const refund = {
        id: `re_${refunds.length + 1}`, amount: args.amount ?? chargeAmount,
        currency: 'usd', status: 'succeeded',
      };
      refunds.push(refund);
      return refund;
    }),
  });
  const fanout = { cancelPendingForPurchase: jest.fn(async () => undefined) };
  const notifications = { createNotification: jest.fn(async () => undefined) };
  const v2 = new DunningV2Service(prisma, new DunningV2Telemetry(), undefined, stub(stripe));
  const settlements = {
    purchaseIdForCharge: jest.fn(async () => row.id),
    latestChargeIdForPurchase: jest.fn(async () => latestCharge),
    applyAdjustments: jest.fn(async () => undefined),
  };
  prisma.splitLedgerEntry = { findFirst: jest.fn(async () => ({ purchase_id: row.id })) };
  prisma.guestCheckout = { updateMany: jest.fn(async () => ({ count: 0 })) };
  // Preserve the extra delegates on tx views used by the refund handler.
  const transaction = prisma.$transaction;
  prisma.$transaction = async (cb: (tx: unknown) => unknown) => transaction(
    (tx: object) => cb(Object.assign(tx, { guestCheckout: prisma.guestCheckout })),
  );
  const service = new RefundDisputeHandlerService(
    prisma, stub(stripe), stub({}), stub({}), stub({}), stub(notifications),
    stub(fanout), undefined, stub(settlements),
  );
  Object.assign(service, { dunningV2: v2 });
  jest.spyOn(service, 'upsertAndApplyRefund').mockImplementation(async (args) => ({
    row: stub({
      id: args.stripe_refund_id, purchase_id: row.id, amount_cents: args.amount_cents,
      status: args.status, ledger_reversed: args.status === 'succeeded',
    }),
    ledger_just_reversed: args.status === 'succeeded',
  }));
  const refundEvent = (status = 'succeeded', amount = 1000) => ({
    id: 'evt_refund', type: 'charge.refunded',
    data: { object: {
      id: latestCharge, amount, amount_refunded: amount,
      refunds: { data: [{ id: 're_webhook', amount, status }], has_more: false },
    } },
  });
  return {
    fake, prisma, row, stripe, service, v2, notifications, fanout, refundEvent,
    setCharge: (id: string, amount = 1000) => { latestCharge = id; chargeAmount = amount; },
  };
}

describe('MONEY-REFUND-124 ordinary billing lifecycle', () => {
  const flag = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => { process.env.FEATURE_DUNNING_V2 = 'true'; });
  afterAll(() => {
    if (flag === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = flag;
  });

  it('B1: cancel, keep plan, cancel again sends a new Stripe action', async () => {
    const h = world();
    const billing = new ClientBillingService(h.prisma, stub(h.stripe));
    await billing.cancelPlan('client', 'purchase');
    await h.stripe.resumeSubscriptionCollection({ subscriptionId: 'sub_plan', idempotencyKey: 'resume' });
    // Native Keep plan also clears cancel_at_period_end.
    h.stripe.subs.get('sub_plan')!.cancel_at_period_end = false;
    h.row.cancel_at_period_end = false;
    await billing.cancelPlan('client', 'purchase');
    const calls = h.stripe.callsOf('setCancelAtPeriodEnd');
    expect(calls).toHaveLength(2);
    expect(calls[0].key).not.toBe(calls[1].key);
    expect(h.stripe.subs.get('sub_plan')!.cancel_at_period_end).toBe(true);
  });

  it('B2: refunding a renewal selects the renewal, not the initial PaymentIntent', async () => {
    const h = world();
    await h.service.createAdminRefund({
      purchase_id: 'purchase', amount_cents: 100, initiated_by_user_id: 'owner',
    });
    expect(h.stripe.createRefund).toHaveBeenCalledWith(expect.objectContaining({ charge_id: 'ch_renewal' }));
  });

  it('B2: refunds of equal amounts on different renewal charges have different keys', async () => {
    const h = world();
    const args = { purchase_id: 'purchase', amount_cents: 100, initiated_by_user_id: 'owner' };
    await h.service.createAdminRefund(args);
    h.setCharge('ch_next_renewal');
    await h.service.createAdminRefund(args);
    const keys = h.stripe.createRefund.mock.calls.map(([call]) => stub(call).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('B3: full refund pauses Stripe billing and exposes the existing coach restart', async () => {
    const h = world();
    await h.service.handle(h.refundEvent());
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(1);
    expect(h.row.entitlement_active).toBe(false);
    expect(h.fake.find('dunningState', { purchase_id: 'purchase' })).toMatchObject({
      status: 'active', last_failure_reason: 'charge_refunded',
    });
    const restarted = await h.v2.restartAfterDisputePause({ coachUserId: 'coach', purchaseId: 'purchase' });
    expect(restarted.restarted).toBe(true);
    expect(h.row.entitlement_active).toBe(true);
    expect(h.stripe.callsOf('resumeSubscriptionCollection')).toHaveLength(1);
  });

  it('B-776-1: with FEATURE_DUNNING_V2 off (production today) the coach restarts a full-refund pause', async () => {
    delete process.env.FEATURE_DUNNING_V2;
    const h = world();
    await h.service.handle(h.refundEvent());
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(1);
    expect(h.row.entitlement_active).toBe(false);
    const restarted = await h.v2.restartAfterDisputePause({ coachUserId: 'coach', purchaseId: 'purchase' });
    expect(restarted).toEqual({ restarted: true, reason: 'restarted' });
    expect(h.row.entitlement_active).toBe(true);
    expect(h.stripe.callsOf('resumeSubscriptionCollection')).toHaveLength(1);
  });

  it('B-776-1: with the flag off, another coach still cannot restart the refund pause', async () => {
    delete process.env.FEATURE_DUNNING_V2;
    const h = world();
    await h.service.handle(h.refundEvent());
    const refused = await h.v2.restartAfterDisputePause({ coachUserId: 'other-coach', purchaseId: 'purchase' });
    expect(refused).toEqual({ restarted: false, reason: 'not_found' });
    expect(h.row.entitlement_active).toBe(false);
    expect(h.stripe.callsOf('resumeSubscriptionCollection')).toHaveLength(0);
  });

  it('B-776-1: with the flag off, a dispute pause keeps the rollout gate', async () => {
    delete process.env.FEATURE_DUNNING_V2;
    const h = world();
    h.row.entitlement_active = false;
    h.fake.seed('dunningState', {
      id: 'ds-dispute', purchase_id: 'purchase', status: 'active', failure_count: 0,
      reversal_count: 1, step_index: 0, last_failure_reason: 'charge_disputed',
      entered_at: new Date('2026-10-01'), locked_out_at: new Date('2026-10-01'),
    });
    const refused = await h.v2.restartAfterDisputePause({ coachUserId: 'coach', purchaseId: 'purchase' });
    expect(refused).toEqual({ restarted: false, reason: 'flag_off' });
    expect(h.stripe.callsOf('resumeSubscriptionCollection')).toHaveLength(0);
  });

  it('B3: a Stripe pause failure cannot report the full refund lifecycle complete', async () => {
    const h = world();
    jest.spyOn(h.stripe, 'pauseSubscriptionCollection').mockRejectedValueOnce(new Error('test outage'));
    await expect(h.service.handle(h.refundEvent())).rejects.toThrow();
  });

  it('B3: a pending full refund does not remove paid access or pause billing', async () => {
    const h = world();
    await h.service.handle(h.refundEvent('pending'));
    expect(h.row.entitlement_active).toBe(true);
    expect(h.row.status).toBe('active');
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(0);
  });

  it('B3: two partial refunds that finish the charge use the full-refund lifecycle', async () => {
    const h = world();
    await h.service.createAdminRefund({ purchase_id: 'purchase', amount_cents: 400, initiated_by_user_id: 'owner' });
    await h.service.createAdminRefund({ purchase_id: 'purchase', amount_cents: 600, initiated_by_user_id: 'owner' });
    expect(h.row.entitlement_active).toBe(false);
    expect(h.fanout.cancelPendingForPurchase).toHaveBeenCalledWith('purchase', 'refund', expect.anything());
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(1);
  });

  it('B3: a full refund of a lower-priced renewal uses that charge amount', async () => {
    const h = world();
    h.setCharge('ch_lower_renewal', 500);
    await h.service.createAdminRefund({ purchase_id: 'purchase', initiated_by_user_id: 'owner' });
    expect(h.row.entitlement_active).toBe(false);
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(1);
  });

  it('B3: full refund of a recurring guest pauses billing before the guest mirror ends access', async () => {
    const h = world();
    const guest = {
      id: 'guest', stripe_subscription_id: 'sub_plan', status: 'paid',
      package: { coach_id: 'coach' },
    };
    h.prisma.guestCheckout.findUnique = jest.fn(async () => guest);
    h.prisma.guestCheckout.updateMany = jest.fn(async () => ({ count: 1 }));
    const service = new GuestCheckoutService(
      h.prisma, stub(h.stripe), stub({}), stub({}), stub(h.notifications),
      stub({}), stub({}),
    );
    await service.handleChargeRefunded('pi_first', 1000, 1000);
    expect(h.stripe.callsOf('pauseSubscriptionCollection')).toHaveLength(1);
  });

  it('B4: deleted coach collects a guest subscription before account conversion', async () => {
    const h = world();
    const guest = {
      created_user_id: null, stripe_subscription_id: 'sub_guest',
      package: { coach_id: 'coach' },
    };
    const tx = {
      coachSubscription: { findMany: jest.fn(async () => []) },
      clientPurchase: { findMany: jest.fn(async () => []) },
      guestCheckout: { findMany: jest.fn(async ({ where }: { where: { OR?: Array<{ package?: { coach_id?: string } }> } }) =>
        (where.OR?.some((part: { package?: { coach_id?: string } }) => part.package?.coach_id === 'coach')
          ? [guest] : []),
      ) },
    };
    const service = new AccountDeletionBillingService(stub({}));
    await expect(service.collectSubscriptionIds(stub(tx), 'coach')).resolves.toContain('sub_guest');
  });

  it('B5: archive refuses a live recurring contract even while access is off', async () => {
    const h = world();
    Object.assign(h.row, { entitlement_active: false, status: 'unpaid' });
    h.prisma.guestCheckout.count = jest.fn(async () => 0);
    const packages = new PackagesService(h.prisma, stub({ getHeadCoachIdForSubCoach: async () => null }));
    await expect(packages.archive('coach', 'package')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS' }),
    });
  });

  it('B5: archive refuses a recurring guest who has not converted yet', async () => {
    const h = world();
    Object.assign(h.row, { entitlement_active: false, status: 'canceled' });
    h.prisma.guestCheckout.count = jest.fn(async () => 1);
    const packages = new PackagesService(h.prisma, stub({ getHeadCoachIdForSubCoach: async () => null }));
    await expect(packages.archive('coach', 'package')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PACKAGE_HAS_ACTIVE_SUBSCRIBERS' }),
    });
  });
});
