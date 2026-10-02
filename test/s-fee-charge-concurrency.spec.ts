// S-FEE round 3 — B-627-2: concurrent or duplicate adjustments on one charge
// must never over-reverse the coach, and the ledger must never count a
// reversal twice.
//
// This is the Opus probe (handoffs/op-7c52cefa/aud-opus/probe_627_concurrency
// .spec.ts) turned into assertions. At head 606b4760 the probe showed, on a
// $49 charge settled at $46.30:
//   - refunds of $20 and $30 processed together reversed 1960 + 2940 (4900 on a
//     4630 transfer; the target position is 1690);
//   - the same refund delivered twice left the ledger at 3920 reversed against
//     1960 actually reversed.
// Fix: every money movement on a charge runs under that charge's lock
// (ChargeLock, a CronLease row), targets come from the cumulative refunded
// total (sum of the charge's succeeded ChargeRefund rows, one per Stripe
// refund id), and ledger slices record the absolute leg position.
//
// The fakes model Stripe faithfully where it matters here: a transfer can never
// be reversed past its amount (Stripe returns 400), and transfers / reversals
// collapse on the Idempotency-Key. No live Stripe calls.
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
  CHARGE_LOCK_BUSY_CODE,
  CHARGE_LOCK_PREFIX,
  ChargeLock,
  ChargeLockBusyError,
} from '../src/connect/fees/charge-lock';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
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
const HEAD = 'head-1';

const asNotifications = (m: object): NotificationsService => m as NotificationsService;
const asPayoutReadiness = (m: object): PayoutReadinessService => m as PayoutReadinessService;

function purchaseRow(overrides: Partial<ClientPurchase> = {}): ClientPurchase {
  const base: Row = {
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
    created_at: new Date('2026-10-01T12:00:00Z'),
    ...overrides,
  };
  return base as ClientPurchase;
}

function setup(opts: { headCoach?: boolean } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  if (opts.headCoach) {
    db.assignments.push({
      sub_coach_id: COACH,
      head_coach_id: HEAD,
      archived_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    db.accounts.push({ coach_user_id: HEAD, stripe_account_id: 'acct_head' });
  }
  const purchase = purchaseRow(opts.headCoach ? { amount_cents: 10_000 } : {});
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
  const reversalTotal = () => [...stripe.reversalsByKey.values()].reduce((n, r) => n + r.amount, 0);
  const dbReversed = () => db.transfers.reduce((n, t) => n + (t.reversed_amount_cents ?? 0), 0);
  const ledgerReversed = (kind: string) =>
    db.ledger
      .filter((e) => e.kind === kind && e.stripe_charge_id === 'ch_1')
      .reduce((n, e) => n + e.reversed_cents, 0);
  const openRecoveries = () =>
    db.recoveries
      .filter((r) => r.status === 'open')
      .reduce((n, r) => n + (r.amount_cents - r.collected_cents), 0);
  return {
    prisma,
    db,
    stripe,
    svc,
    handler,
    purchase,
    notifications,
    settlementFor,
    identity,
    reversalTotal,
    dbReversed,
    ledgerReversed,
    openRecoveries,
  };
}

async function settled49(ctx: ReturnType<typeof setup>) {
  ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
  expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
}

function refundEvent(id: string, refunds: Array<{ id: string; amount: number }>) {
  const total = refunds.reduce((n, r) => n + r.amount, 0);
  return {
    id,
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_1',
        amount: 4_900,
        amount_refunded: total,
        refunded: total >= 4_900,
        refunds: { data: refunds.map((r) => ({ ...r, status: 'succeeded', reason: null })) },
      },
    },
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('B-627-2 probe, now a regression test: concurrent adjustments on one charge', () => {
  it('two different refund states processed together converge to the cumulative target, once', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 3_000 }),
    );
    await Promise.all([
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 3_000,
      }),
    ]);
    const s = ctx.settlementFor('ch_1');
    // $30 refunded of $49: coach keeps 1900 - 172 fee - 38 TGP = 1690.
    expect(s).toMatchObject({ refunded_cents: 3_000, target_coach_net_cents: 1_690 });
    expect(ctx.stripe.netTo('acct_coach')).toBe(1_690);
    expect(ctx.reversalTotal()).toBe(2_940);
    expect(ctx.dbReversed()).toBe(2_940);
    expect(ctx.ledgerReversed('destination')).toBe(2_940);
    expect(ctx.openRecoveries()).toBe(0);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 38, notes: [] });
    // The probe's failure mode: never more reversed than was transferred.
    expect(ctx.reversalTotal()).toBeLessThanOrEqual(4_630);
  });

  it('the same refund state delivered twice together moves money once and the ledger counts it once', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    const outcomes = await Promise.all([
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ]);
    expect([...outcomes].sort()).toEqual(['adjusted', 'unchanged']);
    expect([...ctx.stripe.reversalsByKey.values()].map((r) => r.amount)).toEqual([1_960]);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_670);
    expect(ctx.dbReversed()).toBe(1_960);
    // Probe at 606b4760: 3920 here.
    expect(ctx.ledgerReversed('destination')).toBe(1_960);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 58, notes: [] });
  });

  it('three refund states racing in any order end at the cumulative target', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }),
    );
    await Promise.all(
      [4_900, 1_000, 3_000].map((refunded_cents) =>
        ctx.svc.applyAdjustments({ purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents }),
      ),
    );
    // Full refund: the transfer is fully reversed and the coach owes the
    // non-returned $1.72 fee; TGP nets exactly 0.
    expect(ctx.reversalTotal()).toBe(4_630);
    expect(ctx.stripe.netTo('acct_coach')).toBe(0);
    expect(ctx.openRecoveries()).toBe(172);
    expect(ctx.ledgerReversed('destination')).toBe(4_630);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 0, notes: [] });
  });

  it('head-coach sale: both legs reverse exactly once under concurrent refunds', async () => {
    const ctx = setup({ headCoach: true });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 10_000, fee: 320 }));
    await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.stripe.netTo('acct_coach')).toBe(8_980);
    expect(ctx.stripe.netTo('acct_head')).toBe(500);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 10_000, fee: 320, amount_refunded: 5_000 }),
    );
    await Promise.all([
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 5_000,
      }),
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 5_000,
      }),
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_500,
      }),
    ]);
    const s = ctx.settlementFor('ch_1');
    expect(ctx.stripe.netTo('acct_coach')).toBe(s.target_coach_net_cents);
    expect(ctx.stripe.netTo('acct_head')).toBe(s.target_head_coach_cents);
    expect(ctx.identity('ch_1').drift_cents).toBe(0);
    expect(ctx.identity('ch_1').platform_net_cents).toBeGreaterThanOrEqual(0);
  });
});

describe('B-627-2 through the refund handler (refund ids)', () => {
  it('an admin refund racing its own charge.refunded webhook applies the refund once', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    const input = {
      purchase: ctx.purchase,
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      amount_cents: 2_000,
      status: 'succeeded',
      reason: null,
    };
    const [a, b] = await Promise.all([
      ctx.handler.upsertAndApplyRefund(input),
      ctx.handler.upsertAndApplyRefund(input),
    ]);
    expect([a.ledger_just_reversed, b.ledger_just_reversed].filter(Boolean)).toHaveLength(1);
    expect(ctx.db.refunds).toHaveLength(1);
    expect(ctx.db.refunds[0]).toMatchObject({ ledger_reversed: true });
    expect(ctx.reversalTotal()).toBe(1_960);
    expect(ctx.ledgerReversed('destination')).toBe(1_960);
    expect(ctx.identity('ch_1').drift_cents).toBe(0);
  });

  it('two refunds of one charge delivered together: each refund id is applied once, cumulative target reached', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 3_000 }),
    );
    // Stripe sends one charge.refunded per refund, each carrying the refunds
    // list so far; they can be processed concurrently.
    await Promise.all([
      ctx.handler.handle(refundEvent('evt_1', [{ id: 're_1', amount: 2_000 }])),
      ctx.handler.handle(
        refundEvent('evt_2', [
          { id: 're_1', amount: 2_000 },
          { id: 're_2', amount: 1_000 },
        ]),
      ),
    ]);
    expect(ctx.db.refunds.map((r) => [r.stripe_refund_id, r.ledger_reversed]).sort()).toEqual([
      ['re_1', true],
      ['re_2', true],
    ]);
    expect(ctx.reversalTotal()).toBe(2_940);
    expect(ctx.stripe.netTo('acct_coach')).toBe(1_690);
    expect(ctx.ledgerReversed('destination')).toBe(2_940);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 38, notes: [] });
    // One coach alert per refund id, never per delivery.
    expect(ctx.notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it('a waiter that gives up (CHARGE_LOCK_BUSY) loses nothing: the holder applies its refund before releasing', async () => {
    const ctx = setup();
    await settled49(ctx);
    ctx.svc.chargeLock.waitMs = 30;
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 3_000 }),
    );
    // Hold the first reversal at Stripe until the second refund has given up.
    let releaseStripe: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseStripe = resolve;
    });
    const realReverse = ctx.stripe.reverseTransfer.getMockImplementation()!;
    ctx.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      await gate;
      return realReverse(args);
    });
    const first = ctx.handler.upsertAndApplyRefund({
      purchase: ctx.purchase,
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      amount_cents: 2_000,
      status: 'succeeded',
      reason: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = ctx.handler.upsertAndApplyRefund({
      purchase: ctx.purchase,
      stripe_refund_id: 're_2',
      stripe_charge_id: 'ch_1',
      amount_cents: 1_000,
      status: 'succeeded',
      reason: null,
    });
    await expect(second).rejects.toMatchObject({ code: CHARGE_LOCK_BUSY_CODE });
    releaseStripe();
    await first;
    // The holder drained re_2 before releasing: the coach is at the $30 target.
    expect(ctx.stripe.netTo('acct_coach')).toBe(1_690);
    expect(ctx.reversalTotal()).toBe(2_940);
    // Stripe redelivers the failed webhook: it marks re_2 applied, moves nothing.
    const redelivered = await ctx.handler.upsertAndApplyRefund({
      purchase: ctx.purchase,
      stripe_refund_id: 're_2',
      stripe_charge_id: 'ch_1',
      amount_cents: 1_000,
      status: 'succeeded',
      reason: null,
    });
    expect(redelivered.ledger_just_reversed).toBe(true);
    expect(ctx.reversalTotal()).toBe(2_940);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 38, notes: [] });
    // The lock row is gone after release.
    expect(ctx.db.leases?.filter((l) => String(l.name).startsWith(CHARGE_LOCK_PREFIX))).toEqual([]);
  });

  it('settle racing a refund on a not-yet-settled charge pays the post-refund target, once', async () => {
    const ctx = setup();
    ctx.stripe.charges.set(
      'ch_1',
      makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
    );
    await Promise.all([
      ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' }),
      ctx.svc.applyAdjustments({
        purchase: ctx.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_000,
      }),
    ]);
    expect(ctx.db.transfers).toHaveLength(1);
    expect(ctx.stripe.netTo('acct_coach')).toBe(2_670);
    expect(ctx.reversalTotal()).toBe(0);
    // The slice records the target, so the reported net is $26.70, not $46.30.
    expect(ctx.ledgerReversed('destination')).toBe(1_960);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 58, notes: [] });
  });
});

describe('B-627-2 disputes: an older event processed late cannot undo a newer outcome', () => {
  it('created, won, then the created event redelivered: the coach stays paid back', async () => {
    const ctx = setup();
    await settled49(ctx);
    const created = [{ id: 'txn_dp_1', amount: -4_900, fee: 1_500 }];
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: created });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(0);
    // Won: Stripe reinstates the $49; the $15 fee is kept.
    ctx.stripe.disputes.set('dp_1', {
      id: 'dp_1',
      balance_transactions: [...created, { id: 'txn_dp_2', amount: 4_900, fee: 0 }],
    });
    await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 0, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
    // A late redelivery of charge.dispute.created carries the old payload.
    const late = await ctx.svc.applyAdjustments({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
      dispute_id: 'dp_1',
    });
    expect(late).toBe('unchanged');
    expect(ctx.stripe.netTo('acct_coach')).toBe(3_130);
    // Ledger slice: 4630 paid, 1500 (the kept dispute fee) reversed net.
    expect(ctx.ledgerReversed('destination')).toBe(1_500);
    expect(ctx.identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 98, notes: [] });
  });
});

describe('ChargeLock', () => {
  function lockWith(rows: Row[] = [], opts: ConstructorParameters<typeof ChargeLock>[1] = {}) {
    const cronLease = new Table(rows, { prefix: 'lease', unique: ['name'] });
    return { lock: new ChargeLock(asPrisma({ cronLease }), opts), rows };
  }

  it('excludes concurrent critical sections on the same charge, not on different charges', async () => {
    const { lock } = lockWith();
    let active = 0;
    let maxActive = 0;
    const section = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all([
      lock.run('ch_a', section),
      lock.run('ch_a', section),
      lock.run('ch_a', section),
    ]);
    expect(maxActive).toBe(1);
    maxActive = 0;
    await Promise.all([lock.run('ch_a', section), lock.run('ch_b', section)]);
    expect(maxActive).toBe(2);
  });

  it('is re-entrant within one call chain', async () => {
    const { lock } = lockWith();
    const inner = await lock.run('ch_a', () => lock.run('ch_a', async () => 'nested'));
    expect(inner).toBe('nested');
  });

  it('a busy lock throws SFEE_CHARGE_LOCK_BUSY after the wait budget; nothing ran', async () => {
    const { lock } = lockWith([], { waitMs: 25 });
    let release: () => void = () => undefined;
    const holding = lock.run('ch_a', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 1));
    const ran = jest.fn(async () => undefined);
    await expect(lock.run('ch_a', ran)).rejects.toBeInstanceOf(ChargeLockBusyError);
    expect(ran).not.toHaveBeenCalled();
    release();
    await holding;
    await lock.run('ch_a', ran);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("a crashed holder's expired lease is taken over; a live one is not", async () => {
    const now = new Date('2026-10-02T03:00:00Z');
    const rows: Row[] = [
      {
        name: `${CHARGE_LOCK_PREFIX}ch_dead`,
        holder: 'crashed-machine',
        lease_until: new Date(now.getTime() - 1),
        acquired_at: new Date(now.getTime() - 120_001),
      },
      {
        name: `${CHARGE_LOCK_PREFIX}ch_live`,
        holder: 'live-machine',
        lease_until: new Date(now.getTime() + 60_000),
        acquired_at: now,
      },
    ];
    const { lock } = lockWith(rows, { waitMs: 10, now: () => now });
    await expect(lock.run('ch_dead', async () => 'ok')).resolves.toBe('ok');
    await expect(lock.run('ch_live', async () => 'ok')).rejects.toMatchObject({
      code: CHARGE_LOCK_BUSY_CODE,
    });
    // Released rows are deleted; the live holder's row is untouched.
    expect(rows.map((r) => r.holder)).toEqual(['live-machine']);
  });
});
