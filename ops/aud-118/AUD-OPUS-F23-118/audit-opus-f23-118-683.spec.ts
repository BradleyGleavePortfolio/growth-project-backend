// AUD-OPUS-F23-118 probe (Claude Opus 5.5 lens, agent 118) — growth-project-backend#683 @ 438d29e6.
// Independent edge cases around the round-15 fixes (Sol B-683-1 currency switch, Sol B-683-5 flag).
// P1-P3, P5, P6 assert the intended money behaviour; P4 asserts the behaviour C-683-7 asks for and
// is expected to FAIL at 438d29e6 (it documents the gap, not a B).
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
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

type Refund = { id: string; status: string; amount: number; currency: string; debit?: number };

// CAD 100.00 settles as USD 80.00 with a USD 2.00 fee and 2% TGP (160): coach net 7,640.
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
    currency: 'cad',
    status: 'active',
    source: null,
    billing_type: 'recurring',
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_coach' });
  const charge = (refunded: number, bt = true) => {
    const c = makeCharge({ id: 'ch_1', amount: 10_000, fee: 320, currency: 'cad', amount_refunded: refunded });
    if (!bt) return { ...c, balance_transaction: null };
    const usd = { id: 'txn_1', amount: 8_000, fee: 200, net: 7_800, currency: 'usd' };
    return { ...c, balance_transaction: usd };
  };
  const refunds = (...list: Refund[]) => stripe.refundsByCharge.set('ch_1', list);
  const refund = (debit: number, status = 'succeeded', id = 're_1', amount = 2_500): Refund => ({
    id,
    status,
    amount,
    currency: 'cad',
    debit,
  });
  const localRefund = (id: string, amount: number) =>
    db.refunds.push({
      id: `rf_${id}`,
      stripe_refund_id: id,
      stripe_charge_id: 'ch_1',
      status: 'succeeded',
      amount_cents: amount,
      currency: 'cad',
    });
  const settle = () => svc.settleCharge({ purchase, charge_id: 'ch_1' });
  const adjust = (cents = 2_500) =>
    svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: cents });
  const reconcile = () =>
    new ReconciliationService(asPrisma(prisma), stripe).reconcilePurchase('cp_1');
  const recovered = () =>
    db.recoveries
      .filter((r) => r.payee_user_id === 'coach_1')
      .reduce((n, r) => n + Number(r.amount_cents ?? 0), 0);
  // The fee is unknown: first settle and a CAD refund are deferred on the awaiting row.
  const defer = async (cents = 2_500) => {
    stripe.charges.set('ch_1', charge(cents, false));
    expect((await settle()).status).toBe('awaiting_fee');
    localRefund('re_1', cents);
    expect(await adjust(cents)).toBe('deferred');
    expect(db.settlements[0]).toMatchObject({ status: 'awaiting_fee', currency: 'cad', refunded_cents: cents });
  };
  return { db, prisma, stripe, svc, charge, refunds, refund, localRefund, settle, adjust, reconcile, recovered, defer };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('AUD-OPUS-F23-118 #683 round 15 probes', () => {
  it('P1 control: awaiting row already in USD (no payout account yet) keeps its USD refund at settle', async () => {
    const c = setup();
    const account = c.db.accounts.splice(0)[0];
    c.stripe.charges.set('ch_1', c.charge(0));
    expect((await c.settle()).status).toBe('awaiting_fee');
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd' });
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    c.localRefund('re_1', 2_500);
    expect(await c.adjust()).toBe('deferred');
    expect(c.db.settlements[0]).toMatchObject({ status: 'awaiting_fee', currency: 'usd', refunded_cents: 2_000 });
    c.db.accounts.push(account);
    expect((await c.settle()).status).toBe('settled');
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it('P2 terminal: a deferred FULL converted refund books USD 80.00, the coach owes 360, nothing sent', async () => {
    const c = setup();
    await c.defer(10_000);
    c.stripe.charges.set('ch_1', c.charge(10_000));
    c.refunds(c.refund(8_000, 'succeeded', 're_1', 10_000));
    expect((await c.settle()).status).toBe('settled');
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 8_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(0);
    expect(c.recovered()).toBe(360);
    expect(await c.adjust(10_000)).toBe('unchanged');
    expect(c.recovered()).toBe(360);
    expect(await c.reconcile()).toMatchObject({ drift_cents: 0 });
  });

  it('P3 a succeeded converted refund without its balance transaction keeps the row awaiting, nothing moves', async () => {
    const c = setup();
    await c.defer();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(Number.NaN));
    expect((await c.settle()).status).toBe('awaiting_fee');
    expect(c.db.settlements[0]).toMatchObject({ status: 'awaiting_fee', currency: 'cad', refunded_cents: 2_500 });
    expect(c.stripe.netTo('acct_coach')).toBe(0);
    c.refunds(c.refund(2_000));
    expect((await c.settle()).status).toBe('settled');
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
  });

  it('P4 (C-683-7, expected FAIL at 438d29e6): notice write and flag write both fail -> delivery fails or flag kept', async () => {
    const c = setup();
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.settle();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    c.localRefund('re_1', 2_500);
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    const table = c.prisma.chargeSettlement;
    const real = table.updateMany.getMockImplementation();
    let failed = false;
    table.updateMany.mockImplementation(async (args: { where: Row; data: Row }) => {
      if (!failed && args.data.reconcile_requested_at instanceof Date) {
        failed = true;
        throw new Error('flag write failed');
      }
      if (!real) throw new Error('no implementation');
      return real(args);
    });
    const outcome = await c.adjust().then(
      () => 'resolved',
      () => 'rejected',
    );
    expect(failed).toBe(true);
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(c.db.notices).toHaveLength(0);
    const retried = outcome === 'rejected' || c.db.settlements[0].reconcile_requested_at instanceof Date;
    expect({ outcome, retried }).toEqual({ outcome: expect.any(String), retried: true });
  });

  it('P5 a later refund after a deferred converted settle adds its own debit and notice names both totals', async () => {
    const c = setup();
    await c.defer();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    expect((await c.settle()).status).toBe('settled');
    c.stripe.charges.set('ch_1', c.charge(3_500));
    c.refunds(c.refund(800, 'succeeded', 're_2', 1_000), c.refund(2_000));
    c.localRefund('re_2', 1_000);
    expect(await c.adjust(3_500)).toBe('adjusted');
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_800 });
    expect(c.stripe.netTo('acct_coach')).toBe(4_840);
    const notices = c.db.notices ?? [];
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[notices.length - 1]).toMatchObject({
      currency: 'usd',
      customer_refunded_cents: 2_800,
      client_currency: 'cad',
      client_refunded_cents: 3_500,
    });
    expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it('P6 two workers: sweeper settle and webhook adjust race on the deferred converted row', async () => {
    const c = setup();
    await c.defer();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    await Promise.allSettled([c.settle(), c.adjust(), c.settle()]);
    await c.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
    await c.adjust();
    expect(c.db.settlements[0]).toMatchObject({ status: 'settled', currency: 'usd', refunded_cents: 2_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(c.stripe.transfers.filter((t) => t.destination === 'acct_coach')).toHaveLength(1);
    expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
  });
});
