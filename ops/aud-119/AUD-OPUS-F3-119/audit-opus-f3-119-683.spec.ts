// AUD-OPUS-F3-119 (agent 119) probe for #683 @ cc183e0a — round 16 delta (B-683-7 / B-683-8).
// Real settlement, orchestrator, ledger and charge lock on the repo fakes. Probe only; never merge.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { isRetryableMoneyError } from '../src/connect/fees/money-errors';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import {
  asPrisma,
  FakeStripe,
  makeCharge,
  makeSettlementPrisma,
  Table,
  type Row,
} from './utils/settlement-fakes';

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  Object.assign(prisma, {
    reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }),
  });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const policy = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, policy, ledger, transfers);
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: 10_000,
    currency: 'usd',
    status: 'active',
    source: null,
    billing_type: 'recurring',
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_coach' });
  db.accounts.push({ coach_user_id: 'head_1', stripe_account_id: 'acct_head' });
  jest.spyOn(policy, 'resolveHeadCoachId').mockResolvedValue('head_1');
  jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
    platform_application_fee_bps: 200,
    head_coach_split_bps: 500,
    source: 'default',
  });
  stripe.charges.set(
    'ch_1',
    makeCharge({ id: 'ch_1', amount: 10_000, fee: 320, currency: 'usd', amount_refunded: 0 }),
  );
  // SQL NULL never satisfies `lte` (the shared fake's compare does): flagged rows only.
  const find = prisma.chargeSettlement.findMany.getMockImplementation();
  prisma.chargeSettlement.findMany.mockImplementation(async (args: any = {}) => {
    const rows = find ? await find(args) : [];
    const lte = args.where?.reconcile_requested_at?.lte;
    return lte ? rows.filter((r: Row) => r.reconcile_requested_at instanceof Date) : rows;
  });
  const settle = () => svc.settleCharge({ purchase, charge_id: 'ch_1' });
  const change = (notice_event: 'dispute_lost' | null, dispute_id: string | null = 'dp_1') =>
    svc.applyAdjustments({ purchase, charge_id: 'ch_1', dispute_id, notice_event });
  const events = () => (db.notices ?? []).map((n: Row) => `${n.role}:${n.event}`).sort();
  const money = () => [
    stripe.reversals.length,
    JSON.stringify(db.recoveries ?? []),
    stripe.netTo('acct_coach'),
    stripe.netTo('acct_head'),
  ];
  const sweep = (min: number) => svc.runSettlementSweep(new Date(Date.now() + min * 6e4));
  const flagDown = () => {
    const update = prisma.chargeSettlement.updateMany.getMockImplementation();
    const s = { down: true };
    prisma.chargeSettlement.updateMany.mockImplementation(async (args: any) => {
      if (s.down && args.data?.reconcile_requested_at instanceof Date) {
        throw new Error('flag write failed');
      }
      return update ? update(args) : { count: 0 };
    });
    return s;
  };
  const dispute = (status: string, bts: Array<{ id: string; amount: number; fee: number }>) =>
    stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: bts, status } as never);
  return { db, prisma, stripe, svc, settle, change, events, money, sweep, flagDown, dispute };
}

const WITHDRAWN = [{ id: 'txn_dp', amount: -10_000, fee: 1_500 }];
const lostBoth = ['coach:dispute_lost', 'head_coach:dispute_lost'];

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('AUD-OPUS-F3-119 #683 round 16 delta', () => {
  it('Q1 lost-dispute notice and every flag write fail: delivery fails; redelivery writes dispute_lost once, no money moves', async () => {
    const c = setup();
    await c.settle();
    c.dispute('needs_response', WITHDRAWN);
    await c.change(null);
    expect(c.events()).toEqual(['coach:chargeback', 'head_coach:chargeback']);
    const before = c.money();
    c.dispute('lost', WITHDRAWN);
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    const s = c.flagDown();
    const err = await c.change('dispute_lost').catch((e: unknown) => e);
    expect(isRetryableMoneyError(err)).toBe(true);
    expect(String(err)).toContain('SFEE_NOTICE_UNRECORDED charge=ch_1');
    expect(c.db.settlements[0].reconcile_requested_at ?? null).toBeNull();
    expect(c.money()).toEqual(before);
    s.down = false;
    expect(await c.change('dispute_lost')).toBe('unchanged'); // Stripe redelivers dispute.closed
    expect(c.events()).toEqual(
      ['coach:chargeback', 'head_coach:chargeback', ...lostBoth].sort(),
    );
    await c.change('dispute_lost');
    await c.change(null);
    await c.sweep(20);
    expect(c.events()).toEqual(
      ['coach:chargeback', 'head_coach:chargeback', ...lostBoth].sort(),
    );
    expect(c.money()).toEqual(before);
  });

  it('Q2 first observation already lost (late created, no intent): one dispute_lost per leg; closed redelivery adds nothing; money once', async () => {
    const c = setup();
    await c.settle();
    c.dispute('lost', WITHDRAWN);
    await c.change(null);
    const once = c.money();
    expect(c.events()).toEqual(lostBoth);
    await c.change('dispute_lost');
    await c.change(null);
    expect(c.events()).toEqual(lostBoth);
    expect(c.money()).toEqual(once);
  });

  it('Q3 after a flagged lost retry, a caller with no dispute id (transfer.reversed sync) re-reads the sticky dispute and adds nothing', async () => {
    const c = setup();
    await c.settle();
    c.dispute('needs_response', WITHDRAWN);
    await c.change(null);
    c.dispute('lost', WITHDRAWN);
    c.prisma.payoutAdjustmentNotice.findMany.mockRejectedValueOnce(new Error('read failed'));
    expect(await c.change('dispute_lost')).toBe('unchanged');
    expect(c.db.settlements[0].reconcile_dispute_id).toBe('dp_1');
    const before = c.money();
    const reads = c.stripe.retrieveDispute.mock.calls.length;
    expect(await c.change(null, null)).toBe('unchanged');
    expect(c.stripe.retrieveDispute.mock.calls.length).toBe(reads + 1);
    expect(c.events()).toEqual(
      ['coach:chargeback', 'head_coach:chargeback', ...lostBoth].sort(),
    );
    expect(c.db.settlements[0].reconcile_requested_at ?? null).toBeNull();
    await c.sweep(20);
    expect(c.events()).toHaveLength(4);
    expect(c.money()).toEqual(before);
  });

  it('Q4 the sweep itself hits notice + flag failure: the sweep resolves, the old flag survives, the next sweep writes the notice once', async () => {
    const c = setup();
    await c.settle();
    c.dispute('needs_response', WITHDRAWN);
    await c.change(null);
    c.dispute('lost', WITHDRAWN);
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    expect(await c.change('dispute_lost')).toBe('unchanged'); // flag saved (B-683-5 path)
    const flag = c.db.settlements[0].reconcile_requested_at;
    expect(flag).toBeInstanceOf(Date);
    const before = c.money();
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    const s = c.flagDown();
    await expect(c.sweep(2)).resolves.toBeDefined();
    expect(c.db.settlements[0].reconcile_requested_at).toEqual(flag); // not cleared
    expect(c.events()).toEqual(['coach:chargeback', 'head_coach:chargeback']);
    s.down = false;
    await c.sweep(5);
    expect(c.events()).toEqual(
      ['coach:chargeback', 'head_coach:chargeback', ...lostBoth].sort(),
    );
    expect(c.db.settlements[0].reconcile_requested_at ?? null).toBeNull();
    expect(c.money()).toEqual(before);
  });

  it('Q5 won control: a reinstated dispute (status won) writes dispute_won, never dispute_lost', async () => {
    const c = setup();
    await c.settle();
    c.dispute('needs_response', WITHDRAWN);
    await c.change(null);
    c.dispute('won', [...WITHDRAWN, { id: 'txn_rn', amount: 10_000, fee: 0 }]);
    await c.change(null);
    await c.sweep(20);
    expect(c.events()).toEqual(
      ['coach:chargeback', 'coach:dispute_won', 'head_coach:chargeback', 'head_coach:dispute_won'].sort(),
    );
  });

  it('Q6 two workers after NoticeUnrecorded: closed redelivery and sweep race; one dispute_lost per leg, no extra reversal', async () => {
    const c = setup();
    await c.settle();
    c.dispute('needs_response', WITHDRAWN);
    await c.change(null);
    c.dispute('lost', WITHDRAWN);
    const before = c.money();
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    const s = c.flagDown();
    s.down = true;
    // first attempt and the outer retry both fail: delivery fails
    await expect(c.change('dispute_lost')).rejects.toBeDefined();
    s.down = false;
    // a different fault leaves a saved flag for the sweeper, then both workers run at once
    c.prisma.payoutAdjustmentNotice.findMany.mockRejectedValueOnce(new Error('read failed'));
    await c.change(null, null);
    await Promise.allSettled([c.change('dispute_lost'), c.sweep(5)]);
    await c.sweep(30);
    expect(c.events()).toEqual(
      ['coach:chargeback', 'head_coach:chargeback', ...lostBoth].sort(),
    );
    expect(c.money()).toEqual(before);
  });
});
