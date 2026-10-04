// S-FEE round 15 (B-FEES15-118, agent 118) — F3 findings at 33a9d83b:
//   Sol B-683-1  a refund deferred while the fee was unknown (awaiting row, presentment CAD
//                cents) was compared with the settlement debit (USD cents) at settle: CAD 25 was
//                booked as USD 25.00 against a USD 20.00 refund debit (coach USD 51.40, not
//                56.40; 500 cents of drift that no later adjustment could lower).
//   Sol B-683-5  a payee notice that failed to record flagged the settlement, and the same run
//                cleared that flag when the clock had not moved (no notice, no retry).
// Real settlement, orchestrator, ledger, reconciliation and charge lock on the repo fakes.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { isRetryableMoneyError } from '../src/connect/fees/money-errors';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  asPrisma,
  FakeStripe,
  makeCharge,
  makeSettlementPrisma,
  Table,
  type Row,
} from './utils/settlement-fakes';

type Refund = { id: string; status: string; amount: number; currency: string; debit?: number };

// CAD 100.00 settles as USD 80.00 with a USD 2.00 fee: coach net 7,640 before any refund.
// Same currency: USD 100.00, USD 3.20 fee, coach net 9,480.
function setup(opts: { fx?: boolean; head?: boolean } = {}) {
  const fx = opts.fx ?? true;
  const { prisma, db } = makeSettlementPrisma();
  Object.assign(prisma, {
    reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }),
  });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const policy = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, policy, ledger, transfers);
  const currency = fx ? 'cad' : 'usd';
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: 10_000,
    currency,
    status: 'active',
    source: null,
    billing_type: 'recurring',
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_coach' });
  if (opts.head) {
    db.accounts.push({ coach_user_id: 'head_1', stripe_account_id: 'acct_head' });
    jest.spyOn(policy, 'resolveHeadCoachId').mockResolvedValue('head_1');
    jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
      platform_application_fee_bps: 200,
      head_coach_split_bps: 500,
      source: 'default',
    });
  }
  const charge = (refunded: number, bt = true) => {
    const c = makeCharge({
      id: 'ch_1',
      amount: 10_000,
      fee: 320,
      currency,
      amount_refunded: refunded,
    });
    if (!bt) return { ...c, balance_transaction: null };
    if (!fx) return c;
    const usd = { id: 'txn_1', amount: 8_000, fee: 200, net: 7_800, currency: 'usd' };
    return { ...c, balance_transaction: usd };
  };
  const refunds = (...list: Refund[]) => stripe.refundsByCharge.set('ch_1', list);
  const refund = (debit: number, status = 'succeeded', id = 're_1', amount = 2_500): Refund => ({
    id,
    status,
    amount,
    currency,
    debit,
  });
  const settle = () => svc.settleCharge({ purchase, charge_id: 'ch_1' });
  const adjust = () => svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: 2_500 });
  const reconcile = () =>
    new ReconciliationService(asPrisma(prisma), stripe).reconcilePurchase('cp_1');
  // The fee is not known yet: the charge's first settle and a refund's adjustment are deferred
  // on the awaiting row (in the purchase currency, as the code stores them).
  const defer = async (how: 'no balance transaction' | 'first Stripe read unavailable') => {
    stripe.charges.set('ch_1', charge(2_500, false));
    if (how === 'first Stripe read unavailable') {
      stripe.retrieveCharge.mockRejectedValueOnce(
        new StripeConnectApiError('down', 503, null, null),
      );
    }
    expect((await settle()).status).toBe('awaiting_fee');
    db.refunds.push({
      id: 'rf_local',
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      status: 'succeeded',
      amount_cents: 2_500,
      currency,
    });
    expect(await adjust()).toBe('deferred');
    expect(db.settlements[0]).toMatchObject({
      status: 'awaiting_fee',
      currency,
      refunded_cents: 2_500,
    });
  };
  return { db, prisma, stripe, svc, charge, refunds, refund, settle, adjust, reconcile, defer };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Sol B-683-1 a deferred refund is settled in the settlement currency', () => {
  it.each(['no balance transaction', 'first Stripe read unavailable'] as const)(
    'CAD 25 refunded before the fee (%s): USD 20.00 booked, coach USD 56.40, zero drift after replay',
    async (how) => {
      const c = setup();
      await c.defer(how);
      c.stripe.charges.set('ch_1', c.charge(2_500));
      c.refunds(c.refund(2_000));
      expect((await c.settle()).status).toBe('settled');
      expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
      expect(c.stripe.netTo('acct_coach')).toBe(5_640);
      // Webhook redelivery and a sweep replay change nothing.
      expect(await c.adjust()).toBe('unchanged');
      expect((await c.settle()).status).toBe('already_settled');
      await c.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
      expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
      expect(c.stripe.netTo('acct_coach')).toBe(5_640);
      expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
    },
  );

  it.each([
    ['a lower rate (USD 19.00)', 1_900, 5_740],
    ['a higher rate (USD 21.00)', 2_100, 5_540],
    ['a rate above 1:1 (USD 26.00, control)', 2_600, 5_040],
  ])('a refund converted at %s books its own debit', async (_n, debit, net) => {
    const c = setup();
    await c.defer('no balance transaction');
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(debit));
    await c.settle();
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: debit });
    expect(c.stripe.netTo('acct_coach')).toBe(net);
    expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it('a stale charge (amount_refunded 0) still reads the list for a deferred converted refund', async () => {
    const c = setup();
    await c.defer('no balance transaction');
    c.stripe.charges.set('ch_1', c.charge(0));
    c.refunds(c.refund(2_000));
    await c.settle();
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
  });

  it.each([0, 2_500])(
    'refund list unreadable (amount_refunded %d): stays awaiting, nothing moves',
    async (seen) => {
      const c = setup();
      await c.defer('no balance transaction');
      c.stripe.charges.set('ch_1', c.charge(seen));
      c.stripe.failListRefunds = true;
      expect((await c.settle()).status).toBe('awaiting_fee');
      expect(c.db.settlements[0]).toMatchObject({
        status: 'awaiting_fee',
        currency: 'cad',
        refunded_cents: 2_500,
      });
      expect(c.stripe.netTo('acct_coach')).toBe(0);
      c.stripe.failListRefunds = false;
      c.refunds(c.refund(2_000));
      expect((await c.settle()).status).toBe('settled');
      expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    },
  );

  it.each(['pending', 'failed'])(
    'a %s second refund moves nothing; the succeeded one books its debit',
    async (status) => {
      const c = setup();
      await c.defer('no balance transaction');
      c.stripe.charges.set('ch_1', c.charge(3_500));
      c.refunds(c.refund(800, status, 're_2', 1_000), c.refund(2_000));
      await c.settle();
      expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
      expect(c.stripe.netTo('acct_coach')).toBe(5_640);
      expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
    },
  );

  it('control: a deferred refund on a same-currency charge keeps its amount', async () => {
    const c = setup({ fx: false });
    await c.defer('no balance transaction');
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_500));
    await c.settle();
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_500 });
    expect(c.stripe.netTo('acct_coach')).toBe(6_980);
    expect(await c.reconcile()).toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it('head coach: the deferred converted refund splits like a late one (5,340 / 300)', async () => {
    const c = setup({ head: true });
    await c.defer('first Stripe read unavailable');
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    await c.settle();
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(5_340);
    expect(c.stripe.netTo('acct_head')).toBe(300);
  });

  it('control: a late converted refund notice still names both amounts', async () => {
    const c = setup({ head: true });
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.settle();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    expect(await c.adjust()).toBe('adjusted');
    expect(c.db.notices).toHaveLength(2);
    for (const n of c.db.notices ?? []) {
      expect(n).toMatchObject({ currency: 'usd', customer_refunded_cents: 2_000 });
      expect(n).toMatchObject({ client_currency: 'cad', client_refunded_cents: 2_500 });
      expect(String(n.body)).toMatch(/^A client got 25\.00 CAD back, \$20\.00 after conversion\./);
    }
  });
});

describe('Sol B-683-5 a run never clears the retry flag it raised', () => {
  // Only Date is frozen: every continuation runs within one wall-clock millisecond.
  const realTimers = ['performance', 'setTimeout', 'clearTimeout', 'setImmediate'] as const;
  const realQueues = ['clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime'] as const;
  const freeze = () => jest.useFakeTimers({ doNotFake: [...realTimers, ...realQueues] });

  it('a notice that fails in the same millisecond keeps its flag; the sweep writes it once', async () => {
    freeze();
    const c = setup();
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.settle();
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('write failed'));
    expect(await c.adjust()).toBe('adjusted');
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(c.db.notices).toHaveLength(0);
    expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
    const reversals = c.stripe.reversals.length;
    jest.setSystemTime(Date.now() + 2 * 60_000);
    await c.svc.runSettlementSweep(new Date());
    expect(c.db.notices).toHaveLength(1);
    expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
    await c.svc.runSettlementSweep(new Date(Date.now() + 5 * 60_000));
    expect(c.db.notices).toHaveLength(1);
    expect(c.stripe.reversals).toHaveLength(reversals);
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
  });

  it('control: a successful run clears a flag raised before it started', async () => {
    const c = setup();
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.settle();
    c.db.settlements[0].reconcile_requested_at = new Date(Date.now() - 10 * 60_000);
    c.db.settlements[0].reconcile_reason = 'SFEE_REFUND_STATE_UNAVAILABLE';
    c.stripe.charges.set('ch_1', c.charge(2_500));
    c.refunds(c.refund(2_000));
    expect(await c.adjust()).toBe('adjusted');
    expect(c.db.notices).toHaveLength(1);
    expect(c.db.settlements[0]).toMatchObject({
      reconcile_requested_at: null,
      reconcile_reason: null,
    });
  });
});

// Round 16 (B-FEES16-118, Sol 5982960241 at 438d29e6):
//   Sol B-683-7  notice and retry-flag writes both failed, yet the run resolved (webhook 2xx).
//   Sol B-683-8  a failed lost-dispute notice was flagged without its dispute id; the sweep re-ran
//                without the terminal intent, saw an unchanged state and cleared the flag.
describe('round 16: a failed notice keeps its retry authority and its terminal event', () => {
  type Ctx = ReturnType<typeof setup>;
  // SQL NULL never satisfies `lte`; the shared fake's string compare does. Flagged rows only.
  const flaggedOnly = (c: Ctx) => {
    const find = c.prisma.chargeSettlement.findMany.getMockImplementation();
    c.prisma.chargeSettlement.findMany.mockImplementation(async (args = {}) => {
      const rows = find ? await find(args) : [];
      const lte = args.where?.reconcile_requested_at?.lte;
      return lte ? rows.filter((r) => r.reconcile_requested_at instanceof Date) : rows;
    });
  };
  const fail = (c: Ctx, what: string) => {
    const notices = c.prisma.payoutAdjustmentNotice;
    const op = what === 'insert' ? notices.create : notices.findMany;
    op.mockRejectedValueOnce(new Error('write failed'));
  };
  const sweep = (c: Ctx, min: number) => c.svc.runSettlementSweep(new Date(Date.now() + min * 6e4));

  it.each([
    ['insert', 'every'],
    ['history read', 'every'],
    ['insert', 'the first'],
    ['history read', 'the first'],
  ])(
    'B-683-7: notice %s and %s flag write fail: delivery fails, one notice',
    async (what, flags) => {
      const c = setup({ fx: false });
      flaggedOnly(c);
      c.stripe.charges.set('ch_1', c.charge(0));
      await c.settle();
      c.stripe.charges.set('ch_1', c.charge(2_500));
      fail(c, what);
      const update = c.prisma.chargeSettlement.updateMany.getMockImplementation();
      let down = true;
      c.prisma.chargeSettlement.updateMany.mockImplementation(async (args) => {
        if (down && args.data.reconcile_requested_at instanceof Date) {
          down = flags === 'every';
          throw new Error('flag write failed');
        }
        return update ? update(args) : { count: 0 };
      });
      const err = await c.adjust().catch((e: unknown) => e);
      expect(isRetryableMoneyError(err)).toBe(true);
      expect(String(err)).toContain('SFEE_NOTICE_UNRECORDED charge=ch_1');
      expect(c.stripe.netTo('acct_coach')).toBe(6_980);
      const flag = c.db.settlements[0].reconcile_requested_at;
      expect(flag instanceof Date).toBe(flags === 'the first');
      const reversals = c.stripe.reversals.length;
      down = false; // the outage ends
      await sweep(c, 2);
      expect(c.db.notices ?? []).toHaveLength(flag ? 1 : 0); // a saved flag alone repairs it
      expect(await c.adjust()).toBe('unchanged'); // Stripe redelivers the failed delivery
      await sweep(c, 20);
      expect(c.db.notices?.map((n) => n.event)).toEqual(['refund']);
      expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
      expect(c.stripe.reversals).toHaveLength(reversals);
      expect(c.stripe.netTo('acct_coach')).toBe(6_980);
    },
  );

  it.each(['insert', 'history read'])(
    'B-683-8: a failed lost-dispute notice %s: the sweep writes it once per leg, no money moves',
    async (what) => {
      const c = setup({ fx: false, head: true });
      flaggedOnly(c);
      c.stripe.charges.set('ch_1', c.charge(0));
      await c.settle();
      const balance_transactions = [{ id: 'txn_dp', amount: -10_000, fee: 1_500 }];
      c.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions });
      const purchase = c.db.purchases[0] as ClientPurchase;
      const change = (notice_event: 'dispute_lost' | null) =>
        c.svc.applyAdjustments({ purchase, charge_id: 'ch_1', dispute_id: 'dp_1', notice_event });
      const events = () => c.db.notices?.map((n) => `${n.role}:${n.event}`).sort();
      await change(null);
      expect(events()).toEqual(['coach:chargeback', 'head_coach:chargeback']);
      Object.assign(c.stripe.disputes.get('dp_1') ?? {}, { status: 'lost' });
      const money = () => [c.stripe.reversals.length, JSON.stringify(c.db.recoveries)];
      const before = money();
      fail(c, what);
      expect(await change('dispute_lost')).toBe('unchanged');
      expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
      await sweep(c, 2);
      const terminal = ['chargeback', 'dispute_lost'].flatMap((e) => [
        `coach:${e}`,
        `head_coach:${e}`,
      ]);
      expect(events()).toEqual(terminal.sort());
      expect(c.db.settlements[0].reconcile_requested_at).toBeNull();
      // Replays: a late `created` (no intent), the closed redelivery and a later sweep add nothing.
      await change(null);
      await change('dispute_lost');
      await sweep(c, 20);
      expect(events()).toEqual(terminal);
      expect(money()).toEqual(before);
    },
  );
});
