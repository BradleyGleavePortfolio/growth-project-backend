// S-FEE round 4 — audit findings at 2c57cc41 (Sol + Opus):
//   B-627-2  a 120 s lease admits a second live holder: fencing token on every
//            money step; a stale holder is refused; a holder paused inside a
//            Stripe call collapses onto the same keyed reversal.
//   B-627-3  recoveries are an unsecured receivable: reinstatements netted,
//            cash reported separately from receivables, open-recovery alerts.
//            Round 5 (owner decision OR-111-1) removed round 4's clawback of
//            the payee's other transfers: recovery is forward netting only.
//   B-627-4  a stale dispute event moved money after a failed canonical read:
//            refuse, flag, retry.
//   B-627-5  an uncertain reversal became a second recovery: durable keyed
//            reversal operation, reconcile by the Stripe reversal object.
// Each test below fails on 2c57cc41 (no fence, event-position fallback, any
// reversal error -> recovery, no cash split). No live Stripe or DB.
import type {
  ChargeSettlement,
  ClientPurchase,
  ConnectTransfer,
  PayeeRecovery,
  SplitLedgerEntry,
} from '@prisma/client';
import { Logger } from '@nestjs/common';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import {
  CHARGE_LOCK_PREFIX,
  ChargeLock,
  ChargeLockLostError,
} from '../src/connect/fees/charge-lock';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import {
  DisputeStateUnavailableError,
  ReversalUncertainError,
} from '../src/connect/fees/money-errors';
import type { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { settlementIdentityDrift } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const asNotifications = (m: object): NotificationsService => m as NotificationsService;
const asPayoutReadiness = (m: object): PayoutReadinessService => m as PayoutReadinessService;

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  const purchase = {
    id: 'cp-1',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4_900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    entitlement_active: true,
    source: null,
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date(),
  } as Row as ClientPurchase;
  db.purchases.push(purchase as Row);
  const notifications = { createNotification: jest.fn(async () => undefined) };
  const handler = new RefundDisputeHandlerService(
    asPrisma(prisma),
    stripe,
    ledger,
    transfers,
    asPayoutReadiness({}),
    asNotifications(notifications),
    undefined,
    undefined,
    svc,
  );
  const settlementFor = (chargeId: string) =>
    db.settlements.find((s) => s.stripe_charge_id === chargeId)!;
  const identity = (chargeId: string) => {
    const s = settlementFor(chargeId);
    const charge = stripe.charges.get(chargeId)!;
    const bt = charge.balance_transaction as { amount: number; fee: number };
    return settlementIdentityDrift({
      settlement: s as ChargeSettlement,
      ledger: db.ledger as SplitLedgerEntry[],
      transfers: db.transfers.filter((t) => t.settlement_id === s.id) as ConnectTransfer[],
      recoveries: db.recoveries.filter((r) => r.settlement_id === s.id) as PayeeRecovery[],
      stripe: {
        gross_cents: bt.amount,
        fee_cents: bt.fee,
        refunded_cents: charge.amount_refunded ?? 0,
      },
    });
  };
  const openRecoveries = () =>
    db.recoveries
      .filter((r) => r.status === 'open')
      .reduce((n, r) => n + (r.amount_cents - r.collected_cents), 0);
  const reversalKeysSent = () =>
    stripe.reverseTransfer.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
  const expireChargeLeases = () => {
    for (const l of db.leases ?? []) {
      if (String(l.name).startsWith(CHARGE_LOCK_PREFIX)) l.lease_until = new Date(Date.now() - 1);
    }
  };
  return {
    prisma,
    db,
    stripe,
    svc,
    transfers,
    handler,
    purchase,
    notifications,
    settlementFor,
    identity,
    openRecoveries,
    reversalKeysSent,
    expireChargeLeases,
  };
}
type Ctx = ReturnType<typeof setup>;

// $49 sale, Stripe fee 172 (2.9% + 30c), TGP 2% = 98, coach 4630.
async function settle(ctx: Ctx, chargeId = 'ch_1') {
  ctx.stripe.charges.set(chargeId, makeCharge({ id: chargeId, amount: 4_900, fee: 172 }));
  await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: chargeId });
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('B-627-2 fencing: a lease that expires under a live holder', () => {
  function lockWith(opts: ConstructorParameters<typeof ChargeLock>[1] = {}) {
    const rows: Row[] = [];
    const cronLease = new Table(rows, { prefix: 'lease', unique: ['name'] });
    return { lock: new ChargeLock(asPrisma({ cronLease }), opts), rows };
  }

  it('after a takeover only the new holder passes the fence (Sol probe: 2 live holders -> 1 can move money)', async () => {
    let clock = 1_000_000;
    const { lock } = lockWith({ now: () => new Date(clock), maxHoldMs: 10 * 60_000 });
    const bStart = gate();
    const bAcquired = gate();
    const bFinish = gate();
    let bFence: 'ok' | 'refused' | null = null;
    // Created outside A's call chain, like a second worker.
    const b = (async () => {
      await bStart.opened;
      return lock.run('ch_a', async () => {
        bAcquired.open();
        await bFinish.opened;
        await lock.fence('ch_a').then(
          () => (bFence = 'ok'),
          () => (bFence = 'refused'),
        );
      });
    })();
    await lock.run('ch_a', async () => {
      await lock.fence('ch_a'); // A owns it
      clock += 120_001; // A pauses past the TTL
      bStart.open();
      await bAcquired.opened; // B took the expired lease: two live callbacks
      await expect(lock.fence('ch_a')).rejects.toMatchObject({ why: 'taken_over' });
    });
    bFinish.open();
    await b;
    expect(bFence).toBe('ok');
  });

  it('a holder past its wall-clock budget is refused at its next fence', async () => {
    let clock = 0;
    const { lock } = lockWith({ now: () => new Date(clock), maxHoldMs: 60_000 });
    await lock.run('ch_a', async () => {
      await lock.fence('ch_a');
      clock += 60_001;
      await expect(lock.fence('ch_a')).rejects.toMatchObject({ why: 'budget_exceeded' });
    });
  });

  it('a stale holder cannot move money: its adjustment is refused before Stripe, no op, no recovery', async () => {
    const ctx = setup();
    await settle(ctx);
    const bStart = gate();
    const bAcquired = gate();
    const bGo = gate();
    const b = (async () => {
      await bStart.opened;
      return ctx.svc.withChargeLock('ch_1', async () => {
        bAcquired.open();
        await bGo.opened;
        return ctx.svc.applyAdjustments({
          purchase: ctx.purchase,
          charge_id: 'ch_1',
          refunded_cents: 2_000,
        });
      });
    })();
    await ctx.svc.withChargeLock('ch_1', async () => {
      ctx.expireChargeLeases(); // A paused past the TTL
      bStart.open();
      await bAcquired.opened;
      // A resumes and tries to apply the $20 refund.
      await expect(
        ctx.svc.applyAdjustments({
          purchase: ctx.purchase,
          charge_id: 'ch_1',
          refunded_cents: 2_000,
        }),
      ).rejects.toBeInstanceOf(ChargeLockLostError);
      expect(ctx.stripe.reverseTransfer).not.toHaveBeenCalled();
      expect(ctx.db.reversalOps).toHaveLength(0);
      expect(ctx.openRecoveries()).toBe(0);
      expect(ctx.settlementFor('ch_1').refunded_cents).toBe(0);
    });
    bGo.open();
    await expect(b).resolves.toBe('adjusted');
    // B, the only owner, moved the money once: 4630 -> 2630.
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.reversalKeysSent()).toEqual([`tgp-tr-rev-${ctx.db.transfers[0].id}-op1`]);
  });

  it('a holder paused inside its Stripe call, a takeover and a resume reverse the same cents once', async () => {
    const ctx = setup();
    await settle(ctx);
    const real = ctx.stripe.reverseTransfer.getMockImplementation()!;
    const bStart = gate();
    // B (another worker) applies the cumulative $30 refund state.
    const b = (async () => {
      await bStart.opened;
      return ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 3_000,
      });
    })();
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 3_000 }),
    );
    let paused = false;
    ctx.stripe.reverseTransfer.mockImplementation(async (args) => {
      if (!paused) {
        paused = true;
        // A's request is in flight; A stalls past the TTL and B takes over.
        ctx.expireChargeLeases();
        bStart.open();
        await b;
      }
      return real(args);
    });
    // A applies the $20 refund state.
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    // Target for $30 refunded (OR-111-1: TGP keeps its 98): coach 1900 - 172 - 98 = 1630.
    expect(ctx.stripe.netTo('acct_coach')).toBe(1_630);
    expect([...ctx.stripe.reversalsByKey.values()].map((r) => r.amount)).toEqual([2_000, 1_000]);
    // A's op1 and B's re-drive of op1 share one key and one amount; op2 once.
    const sent = ctx.stripe.reverseTransfer.mock.calls.map(
      (c) => c[0] as { idempotencyKey: string; amount: number },
    );
    expect(sent.filter((c) => c.idempotencyKey.endsWith('-op1')).map((c) => c.amount)).toEqual([
      2_000, 2_000,
    ]);
    expect(sent.filter((c) => c.idempotencyKey.endsWith('-op2')).map((c) => c.amount)).toEqual([
      1_000,
    ]);
    expect(ctx.db.transfers[0].reversed_amount_cents).toBe(3_000);
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.identity('ch_1')).toMatchObject({
      drift_cents: 0,
      platform_net_cents: 98,
      platform_cash_cents: 98,
    });
  });
});

describe('B-627-5 an uncertain reversal never becomes a second recovery', () => {
  it('Stripe committed, response lost: reconciled by the Stripe reversal object; no recovery; redelivery and a new sale move nothing extra', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.reversalResponsesLost = 1;
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.db.recoveries).toHaveLength(0);
    const op = ctx.db.reversalOps![0];
    expect(op).toMatchObject({
      status: 'succeeded',
      amount_cents: 2_000,
      stripe_reversal_id: 'trr_1',
    });
    // Duplicate delivery: nothing moves.
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.reversalKeysSent()).toEqual([`tgp-tr-rev-${ctx.db.transfers[0].id}-op1`]);
    // The coach's next sale is paid in full (nothing netted).
    await settle(ctx, 'ch_2');
    const next = ctx.db.transfers.find((t) => t.source_stripe_charge_id === 'ch_2')!;
    expect(next).toMatchObject({
      amount_cents: 4_630,
      netted_recovery_cents: 0,
      status: 'succeeded',
    });
    expect(ctx.identity('ch_1')).toMatchObject({
      drift_cents: 0,
      platform_net_cents: 98,
      platform_cash_cents: 98,
    });
  });

  it('Stripe succeeded but the DB receipt failed: the retry finds the reversal at Stripe and does not re-send', async () => {
    const ctx = setup();
    await settle(ctx);
    const realUpdateMany = ctx.prisma.transferReversalOp.updateMany.getMockImplementation()!;
    // The receipt write after Stripe's success fails once.
    let failures = 1;
    ctx.prisma.transferReversalOp.updateMany.mockImplementation(async (args) => {
      const data = (args as { data: Row }).data;
      if (failures > 0 && data.status === 'succeeded') {
        failures -= 1;
        throw new Error('connection terminated unexpectedly');
      }
      return realUpdateMany(args);
    });
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toThrow('connection terminated');
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.db.recoveries).toHaveLength(0);
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
    // Durable retry flag for the sweeper.
    expect(ctx.settlementFor('ch_1').reconcile_requested_at).toBeInstanceOf(Date);
    // Redelivery: reconcile by Stripe object first, no second request.
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.reversalKeysSent()).toEqual([`tgp-tr-rev-${ctx.db.transfers[0].id}-op1`]);
    expect(ctx.db.reversalOps![0]).toMatchObject({
      status: 'succeeded',
      stripe_reversal_id: 'trr_1',
    });
    expect(ctx.db.transfers[0].reversed_amount_cents).toBe(2_000);
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.settlementFor('ch_1').reconcile_requested_at).toBeNull();
  });

  it('outcome unknown and not visible at Stripe: retryable error, op pending, no recovery; the sweeper re-drives the same key', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.reversalNetworkFailures = 1;
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.db.recoveries).toHaveLength(0);
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'pending', amount_cents: 2_000 });
    expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
    await ctx.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
    const key = `tgp-tr-rev-${ctx.db.transfers[0].id}-op1`;
    expect(ctx.reversalKeysSent()).toEqual([key, key]);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.settlementFor('ch_1').reconcile_requested_at).toBeNull();
  });

  it('through the refund webhook: an unknown outcome fails the delivery (Stripe redelivers) and the refund is applied once', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.reversalNetworkFailures = 1;
    const refund = {
      purchase: ctx.purchase,
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      amount_cents: 2_000,
      status: 'succeeded',
      reason: null,
    };
    await expect(ctx.handler.upsertAndApplyRefund(refund)).rejects.toBeInstanceOf(
      ReversalUncertainError,
    );
    expect(ctx.db.refunds[0].ledger_reversed).toBeFalsy();
    const redelivered = await ctx.handler.upsertAndApplyRefund(refund);
    expect(redelivered.ledger_just_reversed).toBe(true);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.db.recoveries).toHaveLength(0);
  });

  it('a transfer.reversed event re-converges the charge (receipt lost, Stripe listing down at the time)', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.reversalResponsesLost = 1;
    ctx.stripe.failListReversals = true;
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.db.recoveries).toHaveLength(0);
    ctx.stripe.failListReversals = false;
    await ctx.handler.handle({
      id: 'evt_tr_rev',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_1', amount_reversed: 2_000, reversed: false } },
    });
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'succeeded' });
    expect(ctx.db.transfers[0].reversed_amount_cents).toBe(2_000);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.openRecoveries()).toBe(0);
  });

  it('a definitive Stripe refusal (4xx) is the only path to a recovery', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.failReversals = true;
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'refused' });
    expect(ctx.openRecoveries()).toBe(2_000);
  });
});

describe('B-627-4 a stale dispute event after a failed canonical read moves nothing', () => {
  const created = [{ id: 'txn_dp_1', amount: -4_900, fee: 1_500 }];
  const won = [...created, { id: 'txn_dp_2', amount: 4_900, fee: 0 }];

  async function wonDispute(ctx: Ctx) {
    await settle(ctx);
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: created });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: won });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 0, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
  }

  it('won -> late created + Stripe read failure: refused, flagged, coach stays at 3130; the sweeper converges', async () => {
    const ctx = setup();
    await wonDispute(ctx);
    ctx.stripe.retrieveDispute.mockRejectedValueOnce(new Error('Stripe API 500 on /disputes/dp_1'));
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
        dispute_id: 'dp_1',
      }),
    ).rejects.toBeInstanceOf(DisputeStateUnavailableError);
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
    const s = ctx.settlementFor('ch_1');
    expect(s.dispute_withdrawn_cents).toBe(0);
    expect(s).toMatchObject({ reconcile_dispute_id: 'dp_1' });
    expect(s.reconcile_requested_at).toBeInstanceOf(Date);
    await ctx.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
    expect(ctx.settlementFor('ch_1').reconcile_requested_at).toBeNull();
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
    expect(ctx.identity('ch_1')).toMatchObject({ drift_cents: 0, platform_net_cents: 98 });
  });

  it('a malformed canonical response (no balance_transactions) is refused, not trusted', async () => {
    const ctx = setup();
    await wonDispute(ctx);
    // Stripe answers without the dispute's balance transactions.
    ctx.stripe.retrieveDispute.mockResolvedValueOnce({
      id: 'dp_1',
      amount: 4_900,
      currency: 'usd',
      status: 'won',
      balance_transactions: undefined,
    });
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
        dispute_id: 'dp_1',
      }),
    ).rejects.toBeInstanceOf(DisputeStateUnavailableError);
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
  });

  it('reverse order (won event processed before created): both read Stripe, final state is won', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: won });
    for (const dispute of [
      { withdrawn_cents: 0, fee_cents: 1_500 },
      { withdrawn_cents: 4_900, fee_cents: 1_500 },
    ]) {
      await ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        dispute,
        dispute_id: 'dp_1',
      });
    }
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
  });

  it('through the webhook: the read failure fails the delivery (non-2xx) instead of being swallowed; the coach alert still goes out', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.retrieveDispute.mockRejectedValueOnce(new Error('Stripe API 503'));
    await expect(
      ctx.handler.handle({
        id: 'evt_dp_created',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_1',
            charge: 'ch_1',
            status: 'needs_response',
            amount: 4_900,
            currency: 'usd',
            balance_transactions: created,
          },
        },
      }),
    ).rejects.toBeInstanceOf(DisputeStateUnavailableError);
    expect(ctx.notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
  });
});

describe('B-627-3 / OR-111-1 recoveries: forward netting only; cash vs receivable reported honestly', () => {
  it("full refund: the coach's OTHER past transfer is never reversed; the 270 held (2% 98 + fee 172) is netted from the next sale", async () => {
    const ctx = setup();
    await settle(ctx, 'ch_1');
    await settle(ctx, 'ch_2');
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }),
    );
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 4_900,
    });
    expect(ctx.openRecoveries()).toBe(270);
    expect(ctx.identity('ch_1')).toMatchObject({
      platform_net_cents: 98,
      platform_cash_cents: -172,
      receivable_open_cents: 270,
    });
    const ch2Transfer = ctx.db.transfers.find(
      (t) => t.settlement_id === ctx.settlementFor('ch_2').id,
    )!;
    const summary = await ctx.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
    expect(summary).not.toHaveProperty('clawback_cents');
    // Owner decision OR-111-1: no reversal of another sale's transfer.
    expect(ctx.stripe.reversedOn(ch2Transfer.stripe_transfer_id)).toBe(0);
    expect(ctx.db.reversalOps!.every((o) => o.transfer_id !== ch2Transfer.id)).toBe(true);
    expect(ctx.openRecoveries()).toBe(270);
    // The next sale nets it: 4630 - 270 = 4360 transferred.
    await settle(ctx, 'ch_3');
    const ch3Transfer = ctx.db.transfers.find(
      (t) => t.settlement_id === ctx.settlementFor('ch_3').id,
    )!;
    expect(ch3Transfer).toMatchObject({ amount_cents: 4_360, netted_recovery_cents: 270 });
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.identity('ch_1')).toEqual({
      drift_cents: 0,
      platform_net_cents: 98,
      platform_cash_cents: 98,
      receivable_open_cents: 0,
      notes: [],
    });
    expect(ctx.identity('ch_3')).toEqual({
      drift_cents: 0,
      platform_net_cents: 98,
      platform_cash_cents: 98,
      receivable_open_cents: 0,
      notes: [],
    });
    // A second sweep moves nothing.
    const reversalsBefore = ctx.stripe.reverseTransfer.mock.calls.length;
    await ctx.svc.runSettlementSweep(new Date(Date.now() + 10 * 60_000));
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(reversalsBefore);
  });

  it('no other sale and a refused reversal: the residual is reported as negative cash and alerted per coach (owner decision)', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.failReversals = true;
    ctx.stripe.disputes.set('dp_1', {
      id: 'dp_1',
      balance_transactions: [{ id: 'txn_dp_1', amount: -4_900, fee: 1_500 }],
    });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    // Coach target -1770 (2% 98 + fee 172 + dispute fee 1500); TGP has paid 4630 out.
    expect(ctx.openRecoveries()).toBe(4_630 + 1_770);
    expect(ctx.identity('ch_1')).toMatchObject({
      drift_cents: 0,
      platform_net_cents: 98,
      platform_cash_cents: -6_302,
      receivable_open_cents: 6_400,
      notes: ['platform_cash_negative: -6302 (receivable_open 6400)'],
    });
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const summary = await ctx.svc.runSettlementSweep(new Date(Date.now() + 25 * 60 * 60_000));
    expect(summary.open_recovery_payees).toBe(1);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(
        /^SFEE_RECOVERY_OPEN alert=true payee=coach-1 currency=usd open_cents=6400 recoveries=1/,
      ),
    );
  });

  it('a won-dispute reinstatement is netted against what the coach owes on another charge', async () => {
    const ctx = setup();
    await settle(ctx, 'ch_1');
    await settle(ctx, 'ch_2');
    // Full refund on ch_1 with the reversal refused: the coach owes 4630 + 270.
    ctx.stripe.failReversals = true;
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 4_900,
    });
    expect(ctx.openRecoveries()).toBe(4_900);
    ctx.stripe.failReversals = false;
    // ch_2 is disputed (coach reversed to 0, owes 1770) and then won (owed back 3130).
    const created = [{ id: 'txn_dp_1', amount: -4_900, fee: 1_500 }];
    ctx.stripe.disputes.set('dp_2', { id: 'dp_2', balance_transactions: created });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_2',
      dispute_id: 'dp_2',
    });
    ctx.stripe.disputes.set('dp_2', {
      id: 'dp_2',
      balance_transactions: [...created, { id: 'txn_dp_2', amount: 4_900, fee: 0 }],
    });
    const netBefore = ctx.stripe.netTo('acct_coach');
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_2',
      dispute_id: 'dp_2',
    });
    const reinstate = ctx.db.transfers.find((t) => t.kind === 'coach_reinstate')!;
    // Won: target 3130 from -1770. The 1770 owed on ch_2 is released first;
    // the 3130 paid back is netted in full against the 4900 owed on ch_1, so
    // nothing leaves TGP while the coach owes it more than that.
    expect(reinstate).toMatchObject({
      amount_cents: 0,
      netted_recovery_cents: 3_130,
      status: 'netted',
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(netBefore);
    expect(ctx.openRecoveries()).toBe(4_900 - 3_130);
  });
});

// S-FEE round 6 (Sol B-627-5 at 9d6351b0, Opus C-627-4): an aged pending
// reversal op whose Stripe lookup is unknown (listing outage, incomplete
// listing) must not be re-sent. The fake keeps Stripe's durable reversal
// objects apart from its expiring idempotency-key cache, so a re-send after
// the key expired would create a second reversal (a second debit).
describe('B-627-5 round 6: an unknown reversal lookup never re-sends', () => {
  async function lostResponse(ctx: Ctx) {
    await settle(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    // Stripe executes the $20 reversal; the response is lost and the
    // listing is down, so the op stays pending (attempts 1).
    ctx.stripe.reversalResponsesLost = 1;
    ctx.stripe.failListReversals = true;
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.stripe.reversals).toHaveLength(1);
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
    // A day later Stripe has forgotten the request key.
    ctx.stripe.expireIdempotencyKeys();
  }

  it('listing outage after key expiry: stays uncertain, sends nothing, reverses once', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    const sentBefore = ctx.stripe.reverseTransfer.mock.calls.length;
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    await expect(
      ctx.transfers.resolvePendingReversals(ctx.db.transfers[0].id as string),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(sentBefore);
    expect(ctx.stripe.reversals).toHaveLength(1);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.db.recoveries).toHaveLength(0);
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'pending' });
    expect(String(ctx.db.reversalOps![0].last_error)).toMatch(/reversal lookup unavailable/);
  });

  it('incomplete listing (has_more never ends) is unknown, not absent', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    ctx.stripe.failListReversals = false;
    ctx.stripe.reversalListAlwaysHasMore = true;
    ctx.stripe.reversalListPageSize = 0;
    const sentBefore = ctx.stripe.reverseTransfer.mock.calls.length;
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(sentBefore);
    expect(ctx.stripe.reversals).toHaveLength(1);
  });

  it('listing recovers: the existing reversal is found on a later page, recorded once, nothing re-sent', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    ctx.stripe.failListReversals = false;
    ctx.stripe.reversalListPageSize = 1;
    const sentBefore = ctx.stripe.reverseTransfer.mock.calls.length;
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(sentBefore);
    expect(ctx.stripe.reversals).toHaveLength(1);
    expect(ctx.db.reversalOps![0]).toMatchObject({
      status: 'succeeded',
      stripe_reversal_id: 'trr_1',
    });
    expect(ctx.db.transfers[0].reversed_amount_cents).toBe(2_000);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.openRecoveries()).toBe(0);
  });

  it('proven absent (request never reached Stripe, full listing read): re-sent once after key expiry', async () => {
    const ctx = setup();
    await settle(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    ctx.stripe.reversalNetworkFailures = 1; // fails before Stripe executes
    await expect(
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(ctx.stripe.reversals).toHaveLength(0);
    ctx.stripe.expireIdempotencyKeys();
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_000,
    });
    expect(ctx.stripe.reversals).toHaveLength(1);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_630);
    expect(ctx.db.reversalOps![0]).toMatchObject({ status: 'succeeded' });
  });
});
