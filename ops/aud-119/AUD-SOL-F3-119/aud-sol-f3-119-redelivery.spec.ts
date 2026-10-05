import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { isRetryableMoneyError } from '../src/connect/fees/money-errors';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { asPrisma, FakeStripe, makeCharge, makeSettlementPrisma } from './utils/settlement-fakes';

// AUD-SOL-F3-119: candidate runtime is untouched. Two real service/lock instances share
// synthetic provider/delegates; no fake unconditional sweep repair (SQL NULL is not <= date).
function fixture(currency = 'usd') {
  const { prisma, db } = makeSettlementPrisma();
  const find = prisma.chargeSettlement.findMany.getMockImplementation();
  if (!find) throw new Error('missing table implementation');
  prisma.chargeSettlement.findMany.mockImplementation(async (args = {}) => {
    const rows = await find(args);
    return args.where?.reconcile_requested_at?.lte
      ? rows.filter((r) => r.reconcile_requested_at instanceof Date)
      : rows;
  });
  const stripe = new FakeStripe();
  const createService = () => {
    const ledger = new SplitLedgerService(asPrisma(prisma));
    const policy = new FeePolicyService(asPrisma(prisma));
    jest.spyOn(policy, 'resolveHeadCoachId').mockResolvedValue('head119');
    jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
      platform_application_fee_bps: 200, head_coach_split_bps: 500, source: 'default',
    });
    const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
    return new ChargeSettlementService(asPrisma(prisma), stripe, policy, ledger, transfers);
  };
  const a = createService();
  const b = createService();
  const purchase = {
    id: 'cp119', coach_user_id: 'coach119', client_user_id: 'client119',
    package_id: 'pkg119', amount_cents: 10_000, currency, status: 'active',
    source: null, billing_type: 'recurring', stripe_subscription_id: 'sub119',
    stripe_payment_intent_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase);
  db.accounts.push(
    { coach_user_id: 'coach119', stripe_account_id: 'acct_coach119' },
    { coach_user_id: 'head119', stripe_account_id: 'acct_head119' },
  );
  const charge = (refunded = 0) => makeCharge({
    id: 'ch119', amount: 10_000, fee: 320, currency, amount_refunded: refunded,
  });
  stripe.charges.set('ch119', charge());
  const settle = () => a.settleCharge({ purchase, charge_id: 'ch119' });
  const refund = () => {
    stripe.charges.set('ch119', charge(2_500));
    db.refunds.push({
      id: 'rf119', stripe_refund_id: 're119', stripe_charge_id: 'ch119',
      status: 'succeeded', amount_cents: 2_500, currency,
    });
  };
  const adjust = (svc = a) => svc.applyAdjustments({
    purchase, charge_id: 'ch119', refunded_cents: 2_500,
  });
  const withdrawn = [{ amount: -10_000, fee: 1_500 }];
  const won = [...withdrawn, { amount: 10_000, fee: -1_500 }];
  const state = (status: string) => stripe.disputes.set('dp119', {
    id: 'dp119', charge: 'ch119', status,
    balance_transactions: status === 'won' ? won : withdrawn,
  });
  const dispute = (svc = a, hint: 'dispute_lost' | null = null) => svc.applyAdjustments({
    purchase, charge_id: 'ch119', dispute_id: 'dp119', notice_event: hint,
  });
  const events = () => (db.notices ?? []).map((n) => `${n.role}:${n.event}`).sort();
  const money = () => JSON.stringify({
    reversals: stripe.reversals, transfers: stripe.transfers, recoveries: db.recoveries,
  });
  const sweep = (svc = b) => svc.runSettlementSweep(new Date(Date.now() + 10 * 60_000));
  return { prisma, db, stripe, purchase, a, b, settle, refund, adjust, state, dispute, events, money, sweep };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each(['throw', 'zero-count'])(
  'dual notice/flag failure (%s) rejects, second worker redelivery changes no money',
  async (mode) => {
    const c = fixture();
    await c.settle();
    c.refund();
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('notice unavailable'));
    const update = c.prisma.chargeSettlement.updateMany.getMockImplementation();
    if (!update) throw new Error('missing table implementation');
    let down = true;
    c.prisma.chargeSettlement.updateMany.mockImplementation(async (args) => {
      if (down && args.data.reconcile_requested_at instanceof Date) {
        if (mode === 'throw') throw new Error('flag unavailable');
        return { count: 0 };
      }
      return update(args);
    });
    const err = await c.adjust().catch((e: unknown) => e);
    expect(isRetryableMoneyError(err)).toBe(true);
    expect(String(err)).toContain('SFEE_NOTICE_UNRECORDED');
    expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
    const before = c.money();
    down = false;
    await c.sweep();
    expect(c.events()).toEqual([]);
    await Promise.all([c.adjust(c.a), c.adjust(c.b)]);
    await c.sweep();
    expect(c.events()).toEqual(['coach:refund', 'head_coach:refund']);
    expect(c.money()).toBe(before);
    expect(c.stripe.netTo('acct_coach119') + c.stripe.netTo('acct_head119')).toBe(6_980);
    expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
  },
);

it.each(['lost', 'won'])(
  'partial %s terminal notice (head leg failure) is recovered once by competing workers',
  async (terminal) => {
    const c = fixture();
    await c.settle();
    c.state('needs_response');
    await c.dispute();
    c.state(terminal);
    const insert = c.prisma.payoutAdjustmentNotice.create.getMockImplementation();
    if (!insert) throw new Error('missing table implementation');
    let fail = true;
    const event = terminal === 'lost' ? 'dispute_lost' : 'dispute_won';
    c.prisma.payoutAdjustmentNotice.create.mockImplementation(async (args) => {
      if (fail && args.data.role === 'head_coach' && args.data.event === event) {
        fail = false;
        throw new Error('second payee write unavailable');
      }
      return insert(args);
    });
    await c.dispute();
    expect(c.db.settlements[0].reconcile_dispute_id).toBe('dp119');
    expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
    expect(c.events().filter((e) => e.endsWith(`:${event}`))).toEqual([`coach:${event}`]);
    const before = c.money();
    await Promise.all([c.sweep(c.b), c.dispute(c.a)]);
    await c.dispute(c.b);
    expect(c.events()).toEqual([
      'coach:chargeback', `coach:${event}`, 'head_coach:chargeback', `head_coach:${event}`,
    ].sort());
    expect(c.money()).toBe(before);
    expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
  },
);

it('lost event with neither durable write recovers from canonical state on redelivery without a hint', async () => {
  const c = fixture();
  await c.settle();
  c.state('needs_response');
  await c.dispute();
  c.state('lost');
  c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('notice unavailable'));
  const update = c.prisma.chargeSettlement.updateMany.getMockImplementation();
  if (!update) throw new Error('missing table implementation');
  let down = true;
  c.prisma.chargeSettlement.updateMany.mockImplementation(async (args) => {
    if (down && args.data.reconcile_requested_at instanceof Date) throw new Error('flag unavailable');
    return update(args);
  });
  const err = await c.dispute(c.a, 'dispute_lost').catch((e: unknown) => e);
  expect(isRetryableMoneyError(err)).toBe(true);
  const before = c.money();
  down = false;
  await c.dispute(c.b);
  await c.dispute(c.a, 'dispute_lost');
  expect(c.events()).toEqual([
    'coach:chargeback', 'coach:dispute_lost', 'head_coach:chargeback', 'head_coach:dispute_lost',
  ]);
  expect(c.money()).toBe(before);
});

it('lost retry survives an intervening canonical-read outage with no fallback money movement', async () => {
  const c = fixture();
  await c.settle();
  c.state('needs_response');
  await c.dispute();
  c.state('lost');
  c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('notice unavailable'));
  await c.dispute();
  const before = c.money();
  c.stripe.retrieveDispute.mockRejectedValueOnce(new Error('provider unavailable'));
  await c.sweep();
  expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
  expect(c.events()).toEqual(['coach:chargeback', 'head_coach:chargeback']);
  expect(c.money()).toBe(before);
  await c.sweep();
  expect(c.events()).toContain('coach:dispute_lost');
  expect(c.events()).toContain('head_coach:dispute_lost');
  expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
  expect(c.money()).toBe(before);
});

it.each(['canceled', 'refunded', 'disputed', 'chargeback_lost'])(
  'delivery recovery preserves terminal purchase state %s and one notice per payee',
  async (status) => {
    const c = fixture();
    await c.settle();
    c.purchase.status = status;
    c.refund();
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('notice unavailable'));
    await c.adjust();
    const before = c.money();
    await c.sweep();
    await c.adjust(c.b);
    expect(c.purchase.status).toBe(status);
    expect(c.events()).toEqual(['coach:refund', 'head_coach:refund']);
    expect(c.money()).toBe(before);
  },
);

it('JPY minor-unit recovery records exact amounts and no invented decimal fraction', async () => {
  const c = fixture('jpy');
  await c.settle();
  c.refund();
  c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('notice unavailable'));
  await c.adjust();
  const before = c.money();
  await c.sweep();
  expect(c.events()).toEqual(['coach:refund', 'head_coach:refund']);
  expect(c.db.notices?.[0]).toMatchObject({ currency: 'jpy', customer_refunded_cents: 2_500 });
  expect(c.db.notices?.[0].body).not.toContain('2,500.00');
  expect(c.money()).toBe(before);
});

it('canonical won position defeats a stale lost hint without a lost notice', async () => {
  const c = fixture();
  await c.settle();
  c.state('needs_response');
  await c.dispute();
  c.state('won');
  await c.dispute(c.b, 'dispute_lost');
  expect(c.events()).toEqual([
    'coach:chargeback', 'coach:dispute_won', 'head_coach:chargeback', 'head_coach:dispute_won',
  ]);
  const before = c.money();
  await c.dispute(c.a, 'dispute_lost');
  expect(c.money()).toBe(before);
});
