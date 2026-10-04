import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { asPrisma, FakeStripe, makeCharge, makeSettlementPrisma } from './utils/settlement-fakes';

// Real money/notice/lock services; only provider objects and delegate failures are synthetic.
function fixture() {
  const { prisma, db } = makeSettlementPrisma();
  // SQL NULL never satisfies "<= timestamp". The shared string-comparison fake does.
  // Preserve the query/results otherwise; this prevents a fake-only unconditional notice repair.
  const find = prisma.chargeSettlement.findMany.getMockImplementation();
  if (!find) throw new Error('fixture implementation absent');
  prisma.chargeSettlement.findMany.mockImplementation(async (args = {}) => {
    const rows = await find(args);
    return args.where?.reconcile_requested_at?.lte
      ? rows.filter((row) => row.reconcile_requested_at instanceof Date)
      : rows;
  });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const policy = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, policy, ledger, transfers);
  const purchase = {
    id: 'cp_notice', coach_user_id: 'coach_notice', client_user_id: 'client_notice',
    package_id: 'pkg_notice', amount_cents: 10_000, currency: 'usd', status: 'active',
    source: null, billing_type: 'recurring', stripe_subscription_id: 'sub_notice',
    stripe_payment_intent_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase);
  db.accounts.push({ coach_user_id: 'coach_notice', stripe_account_id: 'acct_notice' });
  const charge = (refunded: number) => makeCharge({
    id: 'ch_notice', amount: 10_000, fee: 320, currency: 'usd', amount_refunded: refunded,
  });
  const settle = () => svc.settleCharge({ purchase, charge_id: 'ch_notice' });
  const adjust = () => svc.applyAdjustments({
    purchase, charge_id: 'ch_notice', refunded_cents: 2_500,
  });
  const refund = () => {
    stripe.charges.set('ch_notice', charge(2_500));
    db.refunds.push({
      id: 'rf_notice', stripe_refund_id: 're_notice', stripe_charge_id: 'ch_notice',
      status: 'succeeded', amount_cents: 2_500, currency: 'usd',
    });
  };
  stripe.charges.set('ch_notice', charge(0));
  return { prisma, db, stripe, svc, purchase, settle, adjust, refund };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each(['notice insert', 'notice history read'])(
  'a failed %s plus failed retry persistence must not acknowledge the delivery',
  async (failure) => {
    const c = fixture();
    await c.settle();
    c.refund();
    if (failure === 'notice insert') {
      c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('synthetic outage'));
    } else {
      c.prisma.payoutAdjustmentNotice.findMany.mockRejectedValueOnce(new Error('synthetic outage'));
    }
    const update = c.prisma.chargeSettlement.updateMany.getMockImplementation();
    if (!update) throw new Error('fixture implementation absent');
    let rejectFlag = true;
    c.prisma.chargeSettlement.updateMany.mockImplementation(async (args) => {
      if (rejectFlag && args.data.reconcile_requested_at instanceof Date) {
        rejectFlag = false;
        throw new Error('synthetic retry-flag outage');
      }
      return update(args);
    });
    let failedDelivery = false;
    let result = '';
    try {
      result = await c.adjust();
    } catch {
      failedDelivery = true;
    }
    const durableRetry = c.db.settlements[0].reconcile_requested_at instanceof Date;
    const reversals = c.stripe.reversals.length;
    // Both transient failures are gone now. A real sweeper can only find durable work.
    const sweep1 = await c.svc.runSettlementSweep(new Date(Date.now() + 2 * 60_000));
    const sweep2 = await c.svc.runSettlementSweep(new Date(Date.now() + 20 * 60_000));
    console.log('AUD118_NOTICE_RECOVERY', {
      failure, result, failedDelivery, durableRetry, noticeCount: c.db.notices?.length,
      reconciled: [sweep1.reconciled, sweep2.reconciled],
      paid: c.stripe.netTo('acct_notice'), reversals: c.stripe.reversals.length,
    });
    expect(c.stripe.netTo('acct_notice')).toBe(6_980);
    expect(c.stripe.reversals).toHaveLength(reversals);
    // Recovery authority must be either a failed delivery or a persisted retry, not a log.
    expect(failedDelivery || durableRetry).toBe(true);
    // Provider redelivery, if requested, must converge without another reversal.
    if (failedDelivery) await c.adjust();
    expect(c.db.notices).toHaveLength(1);
  },
);

it('control: notice insert failure with a successful retry write is repaired by one sweep', async () => {
  const c = fixture();
  await c.settle();
  c.refund();
  c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('synthetic outage'));
  expect(await c.adjust()).toBe('adjusted');
  expect(c.db.notices).toHaveLength(0);
  expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
  const reversals = c.stripe.reversals.length;
  await c.svc.runSettlementSweep(new Date(Date.now() + 2 * 60_000));
  expect(c.db.notices).toHaveLength(1);
  expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
  expect(c.stripe.reversals).toHaveLength(reversals);
  expect(c.stripe.netTo('acct_notice')).toBe(6_980);
});

it('control: successful notice recording clears an old retry and replay is idempotent', async () => {
  const c = fixture();
  await c.settle();
  c.refund();
  c.db.settlements[0].reconcile_requested_at = new Date(Date.now() - 60_000);
  expect(await c.adjust()).toBe('adjusted');
  expect(c.db.notices).toHaveLength(1);
  expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
  const reversals = c.stripe.reversals.length;
  expect(await c.adjust()).toBe('unchanged');
  expect(c.db.notices).toHaveLength(1);
  expect(c.stripe.reversals).toHaveLength(reversals);
});

it('a failed lost-dispute notice retains its terminal event across the flagged sweep', async () => {
  const c = fixture();
  await c.settle();
  c.stripe.disputes.set('dp_notice', {
    id: 'dp_notice',
    balance_transactions: [{ id: 'txn_dispute', amount: -10_000, fee: 1_500 }],
  });
  const change = (lost = false) => c.svc.applyAdjustments({
    purchase: c.purchase, charge_id: 'ch_notice', dispute_id: 'dp_notice',
    notice_event: lost ? 'dispute_lost' : null,
  });
  await change();
  expect(c.db.notices?.map((n) => n.event)).toEqual(['chargeback']);
  Object.assign(c.stripe.disputes.get('dp_notice')!, { status: 'lost' });
  c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('synthetic outage'));
  await change(true);
  expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
  const reversals = c.stripe.reversals.length;
  await c.svc.runSettlementSweep(new Date(Date.now() + 2 * 60_000));
  console.log('AUD118_TERMINAL_NOTICE_RETRY', {
    events: c.db.notices?.map((n) => n.event),
    flag: c.db.settlements[0].reconcile_requested_at,
    disputeId: c.db.settlements[0].reconcile_dispute_id,
    paid: c.stripe.netTo('acct_notice'),
    reversals: c.stripe.reversals.length,
  });
  expect(c.stripe.reversals).toHaveLength(reversals);
  expect(c.db.notices?.map((n) => n.event)).toEqual(['chargeback', 'dispute_lost']);
  await c.svc.runSettlementSweep(new Date(Date.now() + 20 * 60_000));
  expect(c.db.notices).toHaveLength(2);
});

it('control: a successfully recorded lost-dispute event is distinct and replay-idempotent', async () => {
  const c = fixture();
  await c.settle();
  c.stripe.disputes.set('dp_notice', {
    id: 'dp_notice',
    balance_transactions: [{ id: 'txn_dispute', amount: -10_000, fee: 1_500 }],
  });
  const input = { purchase: c.purchase, charge_id: 'ch_notice', dispute_id: 'dp_notice' };
  await c.svc.applyAdjustments(input);
  Object.assign(c.stripe.disputes.get('dp_notice')!, { status: 'lost' });
  await c.svc.applyAdjustments({ ...input, notice_event: 'dispute_lost' });
  expect(c.db.notices?.map((n) => n.event)).toEqual(['chargeback', 'dispute_lost']);
  const reversals = c.stripe.reversals.length;
  await c.svc.applyAdjustments({ ...input, notice_event: 'dispute_lost' });
  expect(c.db.notices).toHaveLength(2);
  expect(c.stripe.reversals).toHaveLength(reversals);
});
