// S-FEE round 17 (B-FEES18-119, agent 119): failing-before tests for the open findings at
// #684 6b13af56. Every amount is exact (4,900 charge, 172 Stripe fee, coach net 4,630).
//   Sol B-684-4 / Opus B-684-7  refund.updated reaches the refund handler through the production
//                               checkout router, and its charge gets the payout-notice handoff
//   Sol B-684-5                 a succeeded async full refund ends access, not just money
//   Opus B-684-8                a refund status only moves forward; stale events move nothing
//   Sol B-684-3                 notice channels start only with a live claim inside the deadline
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { EmailService } from '../src/email/email.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import type { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import type { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

type RefundFixture = { id: string; status: string; amount: number; currency: string } & Row;

function setup(opts: { purchaseCents?: number } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const user = new Table([{ id: 'coach_1', email: 'payee@example.invalid', name: null }], {
    prefix: 'u',
  });
  Object.assign(prisma, { user, emailSendLog: new Table([], { prefix: 'em' }) });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]): Promise<{ id: string } | null> => ({
      id: 'n_1',
    })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const fanoutFns = { cancelPendingForPurchase: jest.fn(async (..._a: unknown[]) => 0) };
  const decisionFns = { onPartialRefund: jest.fn(async (..._a: unknown[]) => undefined) };
  const fanout: object = fanoutFns;
  const decisions: object = decisionFns;
  const notices = new PayoutNoticeService(
    asPrisma(prisma),
    stub as NotificationsService,
    stub as EmailService,
  );
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma),
    stripe,
    ledger,
    transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe),
    stub as NotificationsService,
    fanout as PurchaseFanoutService,
    decisions as PartialRefundDecisionService,
    settlements,
    notices,
  );
  const router = new CheckoutWebhookHandlerService(
    asPrisma(prisma),
    stripe,
    undefined,
    undefined,
    refunds,
  );
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: opts.purchaseCents ?? 4_900,
    currency: 'usd',
    status: 'paid',
    source: null,
    entitlement_active: true,
    billing_type: 'one_time',
    stripe_payment_intent_id: null,
    stripe_subscription_id: null,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  const list = (data: RefundFixture[]) => stripe.refundsByCharge.set('ch_1', data);
  return {
    prisma,
    db,
    stripe,
    settlements,
    notices,
    refunds,
    router,
    fns,
    fanoutFns,
    decisionFns,
    list,
    user,
  };
}

const usd = (id: string, amount: number, status = 'succeeded'): RefundFixture => ({
  id,
  status,
  amount,
  currency: 'usd',
});
const refunded = (data: RefundFixture[]) => ({
  id: `evt_refunded_${data.map((r) => `${r.id}_${r.status}`).join('_')}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4_900,
      amount_refunded: data.reduce((n, r) => n + (r.status === 'succeeded' ? r.amount : 0), 0),
      refunds: { data, has_more: false },
    },
  },
});
const update = (type: string, status: string, id = 're_1', amount = 4_900) => ({
  id: `evt_${type}_${id}_${status}`,
  type,
  data: { object: { id, object: 'refund', charge: 'ch_1', amount, status, failure_reason: null } },
});

async function settledWithPending(c: ReturnType<typeof setup>, id = 're_1', amount = 4_900) {
  await c.settlements.settleCharge({
    purchase: c.db.purchases[0] as ClientPurchase,
    charge_id: 'ch_1',
  });
  expect(c.stripe.netTo('acct_1')).toBe(4_630);
  c.list([usd(id, amount, 'pending')]);
  await c.router.handle(refunded([usd(id, amount, 'pending')]));
  expect(c.db.settlements[0].refunded_cents).toBe(0);
}

afterEach(() => jest.restoreAllMocks());

describe('Sol B-684-4 / Opus B-684-7: refund.updated through the production checkout router', () => {
  it('a succeeded refund.updated is claimed, moves the coach 4,630 back once and delivers its notice', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    const out = await c.router.handle(update('refund.updated', 'succeeded'));
    expect(out).toMatchObject({ claimed: true, purchase_id: 'cp_1' });
    expect(c.db.refunds[0]).toMatchObject({ status: 'succeeded', ledger_reversed: true });
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.db.notices?.[0]).toMatchObject({ inapp_status: 'sent' });
  });

  it('inside the webhook transaction the refund.updated charge is handed off for post-commit delivery', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    const out = await c.router.handle(update('refund.updated', 'succeeded'), asPrisma(c.prisma));
    expect(out).toMatchObject({ claimed: true, deferredPayoutNoticeChargeId: 'ch_1' });
    expect(c.db.notices?.[0]).toMatchObject({ inapp_status: 'pending' });
    await c.refunds.deliverPayoutNotices('ch_1');
    expect(c.db.notices?.[0]).toMatchObject({ inapp_status: 'sent' });
  });

  it('both refund events for one transition (Stripe sends both while charge.refund.updated lives) apply once', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('charge.refund.updated', 'succeeded'));
    await c.router.handle(update('refund.updated', 'succeeded'));
    expect(c.stripe.reversals).toHaveLength(1);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.db.notices).toHaveLength(1);
  });

  it('a failed refund.updated through the router records failed and moves nothing', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    await c.router.handle(update('refund.updated', 'failed'));
    expect(c.db.refunds[0].status).toBe('failed');
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });
});

describe('Sol B-684-5: a succeeded async refund converges access with the money', () => {
  it('pending full refund, then succeeded: the purchase is refunded, access ends and drops are canceled', async () => {
    const c = setup();
    await settledWithPending(c);
    expect(c.db.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('charge.refund.updated', 'succeeded'));
    expect(c.db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(c.fanoutFns.cancelPendingForPurchase).toHaveBeenCalledWith(
      'cp_1',
      'refund',
      expect.anything(),
    );
    expect(c.decisionFns.onPartialRefund).not.toHaveBeenCalled();
  });

  it('pending then failed or canceled: access stays, nothing moves', async () => {
    for (const status of ['failed', 'canceled']) {
      const c = setup();
      await settledWithPending(c);
      c.list([usd('re_1', 4_900, status)]);
      await c.router.handle(update('refund.updated', status));
      expect(c.db.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
      expect(c.stripe.netTo('acct_1')).toBe(4_630);
    }
  });

  it('a partial succeeded refund keeps access with a decision; the partial that completes the charge ends it', async () => {
    const c = setup();
    await settledWithPending(c, 're_a', 2_000);
    c.list([usd('re_a', 2_000)]);
    await c.router.handle(update('refund.updated', 'succeeded', 're_a', 2_000));
    expect(c.db.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(c.decisionFns.onPartialRefund).toHaveBeenCalledTimes(1);
    c.list([usd('re_b', 2_900, 'pending'), usd('re_a', 2_000)]);
    await c.router.handle(update('refund.updated', 'pending', 're_b', 2_900));
    c.list([usd('re_b', 2_900), usd('re_a', 2_000)]);
    await c.router.handle(update('refund.updated', 'succeeded', 're_b', 2_900));
    expect(c.db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(c.decisionFns.onPartialRefund).toHaveBeenCalledTimes(1);
    expect(c.stripe.netTo('acct_1')).toBe(0);
  });

  it('a charge is judged on its own amount (a renewal invoice below the plan price)', async () => {
    const c = setup({ purchaseCents: 9_900 });
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('refund.updated', 'succeeded'));
    expect(c.db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
  });

  it('an unreadable refund list fails the delivery before anything moves (Stripe redelivers)', async () => {
    const c = setup();
    await settledWithPending(c);
    c.stripe.failListRefunds = true;
    await expect(c.router.handle(update('refund.updated', 'succeeded'))).rejects.toMatchObject({
      code: 'SFEE_REFUND_STATE_UNAVAILABLE',
    });
    expect(c.db.refunds[0].status).toBe('pending');
    expect(c.db.refunds[0].ledger_reversed).not.toBe(true);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    expect(c.db.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
  });
});

describe('Opus B-684-8: a refund status only moves forward', () => {
  it('failed processed, then the older succeeded redelivered: the row stays failed and the coach keeps 4,630', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    await c.router.handle(update('charge.refund.updated', 'failed'));
    await c.router.handle(update('charge.refund.updated', 'succeeded'));
    await c.router.handle(update('refund.updated', 'succeeded'));
    expect(c.db.refunds[0].status).toBe('failed');
    expect(c.stripe.reversals).toHaveLength(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    expect(c.db.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('a late charge.refunded snapshot that still says succeeded never re-applies a failed refund', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    await c.router.handle(update('refund.updated', 'failed'));
    await c.router.handle(refunded([usd('re_1', 4_900)]));
    expect(c.db.refunds[0].status).toBe('failed');
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('a stale pending snapshot never moves an applied refund back to pending', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('refund.updated', 'succeeded'));
    await c.router.handle(refunded([usd('re_1', 4_900, 'pending')]));
    expect(c.db.refunds[0]).toMatchObject({ status: 'succeeded', ledger_reversed: true });
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('a failure written while the apply waits for the lock: the apply re-reads it and moves nothing', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    const realLock = c.settlements.withChargeLock.bind(c.settlements);
    jest.spyOn(c.settlements, 'withChargeLock').mockImplementation(async (id, fn) => {
      // Another worker records the refund's failure just before this worker gets the lock.
      c.db.refunds[0].status = 'failed';
      return realLock(id, fn);
    });
    await c.router.handle(update('refund.updated', 'succeeded'));
    expect(c.db.refunds[0].status).toBe('failed');
    expect(c.db.refunds[0].ledger_reversed).not.toBe(true);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('applied, then failed: one alert under the lock, the settlement is flagged, nothing re-credited', async () => {
    const c = setup();
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('refund.updated', 'succeeded'));
    c.list([usd('re_1', 4_900, 'failed')]);
    await c.router.handle(update('refund.updated', 'failed'));
    const alerts = errors.mock.calls.filter((a) =>
      String(a[0]).startsWith('SFEE_REFUND_FAILED_AFTER_APPLY'),
    );
    expect(alerts).toHaveLength(1);
    expect(c.db.settlements[0].reconcile_reason).toBe('SFEE_REFUND_FAILED_AFTER_APPLY');
    expect(c.stripe.netTo('acct_1')).toBe(0);
  });
});

describe('Sol B-684-3: a notice channel starts only with a live claim inside the run deadline', () => {
  async function notice(c: ReturnType<typeof setup>, started: number, patch: Row = {}) {
    await c.prisma.payoutAdjustmentNotice.create({
      data: {
        id: 'pan_1',
        idempotency_key: 'pan_key_1',
        payee_user_id: 'coach_1',
        settlement_id: 'cs_1',
        stripe_charge_id: 'ch_1',
        purchase_id: 'cp_1',
        event: 'refund',
        title: 'A client was refunded',
        body: 'A client got $1.00 back.',
        created_at: new Date(started - 120_000),
        ...patch,
      },
    });
  }

  it('a claim and re-read that use up the budget start no in-app row; the claim is released, the attempt not counted', async () => {
    const c = setup();
    const started = Date.now();
    let clock = started;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    await notice(c, started, { push_status: 'off', email_status: 'disabled' });
    const real = c.prisma.payoutAdjustmentNotice.findUnique.getMockImplementation()!;
    c.prisma.payoutAdjustmentNotice.findUnique.mockImplementation(async (args) => {
      clock = started + 480_001;
      return real(args);
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.fns.createNotification).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({
      dispatched_at: null,
      dispatch_claimed_at: null,
      dispatch_attempts: 0,
      inapp_status: 'pending',
    });
  });

  it('a slow push gate starts no push after the deadline; the push stays pending for the next run', async () => {
    const c = setup();
    const started = Date.now();
    let clock = started;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
    c.fns.channelGate.mockImplementation(async () => {
      clock = started + 660_000;
      return 'enabled';
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.fns.pushToUser).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({ push_status: 'pending', dispatched_at: null });
    c.fns.channelGate.mockImplementation(async () => 'enabled');
    await c.notices.dispatchPending(new Date(clock), 25, clock + 480_000);
    expect(c.fns.pushToUser).toHaveBeenCalledTimes(1);
    expect(c.db.notices?.[0].push_status).toBe('sent');
  });

  it('a slow address read starts no email after the deadline', async () => {
    const c = setup();
    const started = Date.now();
    let clock = started;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    await notice(c, started, { inapp_status: 'sent', push_status: 'off' });
    c.user.findUnique.mockImplementation(async () => {
      clock = started + 660_000;
      return { id: 'coach_1', email: 'payee@example.invalid', name: null };
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.fns.send).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({ email_status: 'pending', email_attempts: 0 });
  });

  it('a push row created just before the claim runs low is kept and reused, the push itself waits', async () => {
    const c = setup();
    const started = Date.now();
    let clock = started;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
    c.fns.createNotification.mockImplementationOnce(async () => {
      clock = started + 240_001; // under 60 s left on the 5-minute claim
      return { id: 'n_push' };
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 3_600_000);
    expect(c.fns.pushToUser).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({
      push_status: 'pending',
      push_notification_id: 'n_push',
    });
  });

  it('a later batch row is claimed at the time it is taken, so a second worker cannot push it too', async () => {
    const c = setup();
    const started = Date.now();
    jest.useFakeTimers({ now: started });
    try {
      await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
      jest.setSystemTime(started + 360_000); // earlier rows used six minutes of this sweep
      let entered = false;
      c.fns.pushToUser.mockImplementation(async () => {
        if (!entered) {
          entered = true;
          await c.notices.dispatchForCharge('ch_1');
        }
        return { delivered: true, code: 'delivered' };
      });
      await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
      expect(c.fns.pushToUser).toHaveBeenCalledTimes(1);
      expect(c.db.notices?.[0].dispatch_claimed_at).toEqual(new Date(started + 360_000));
    } finally {
      jest.useRealTimers();
    }
  });
});
