// S-FEE round 13 (B-FEES-117, agent 117): failing-before tests for the open findings at
// #683 35a18539 / #684 e9ee033d. Every amount is exact.
//   Sol B-683-4   an incomplete refund page set is never a complete refund total
//   Sol B-683-1   a converted charge's refund notice keeps the client's own currency and amount
//   Opus B-684-3  async (pending) refunds: money moves only when a refund reports succeeded
//   C-684-4       a refund that fails after its money was applied: alert + flag, no re-credit
//   Sol B-684-1   every refund identity of a charge is kept, beyond the embedded latest ten
//   Sol B-684-3   notice delivery keeps the sweep deadline
//   G12           purchase-split-handler logs a closed code, never an error's text
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import * as settlementModule from '../src/connect/fees/charge-settlement.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import type { EmailService } from '../src/email/email.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const CANARY = 'AUDIT_CANARY client@example.invalid body="Your refund"';
type RefundFixture = { id: string; status: string; amount: number; currency: string } & Row;

function setup(opts: { fx?: boolean } = {}) {
  const { prisma, db } = makeSettlementPrisma();
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
    undefined,
    undefined,
    settlements,
    notices,
  );
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: opts.fx ? 10_000 : 4_900,
    currency: opts.fx ? 'cad' : 'usd',
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
  const charge = (amount_refunded = 0) =>
    opts.fx
      ? {
          ...makeCharge({ id: 'ch_1', amount: 10_000, fee: 200, currency: 'cad', amount_refunded }),
          balance_transaction: {
            id: 'txn_ch_1',
            amount: 8_000,
            fee: 200,
            net: 7_800,
            currency: 'usd',
          },
        }
      : makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded });
  stripe.charges.set('ch_1', charge());
  const listRefunds = (pages: Array<{ data: RefundFixture[]; has_more: boolean }>) => {
    const fn = jest.fn(async () => pages[Math.min(fn.mock.calls.length - 1, pages.length - 1)]);
    Object.assign(stripe, { listChargeRefunds: fn });
    return fn;
  };
  return { prisma, db, stripe, settlements, refunds, notices, purchase, fns, charge, listRefunds };
}

const usd = (id: string, amount: number, status = 'succeeded'): RefundFixture => ({
  id,
  status,
  amount,
  currency: 'usd',
  charge: 'ch_1',
});
const refundedEvent = (amountRefunded: number, data: Row[], hasMore = false) => ({
  id: `evt_refunded_${amountRefunded}_${data.length}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4_900,
      amount_refunded: amountRefunded,
      refunded: amountRefunded >= 4_900,
      refunds: { data, has_more: hasMore },
    },
  },
});
const refundUpdated = (status: string, id = 're_ach', amount = 4_900) => ({
  id: `evt_updated_${id}_${status}`,
  type: 'charge.refund.updated',
  data: { object: { id, charge: 'ch_1', amount, status, failure_reason: null } },
});

afterEach(() => jest.restoreAllMocks());

describe('Sol B-683-4: only a validated terminal page completes the refund list', () => {
  // Resolved at run time: on 35a18539 the reader does not exist yet (convertedRefundedCents).
  const read = (stripe: FakeStripe) =>
    (
      settlementModule as unknown as Record<
        string,
        (s: StripeConnectApiService, c: string, cur: string | null) => Promise<unknown>
      >
    ).chargeRefundsFromStripe(stripe, 'ch_1', 'usd');

  it.each([
    ['has_more=true with no refunds (no cursor)', [{ data: [], has_more: true }]],
    [
      'a refund without an id',
      [{ data: [{ status: 'succeeded', amount: 400, currency: 'usd' }], has_more: false }],
    ],
    [
      'a refund without an amount',
      [{ data: [{ id: 're_1', status: 'succeeded', currency: 'usd' }], has_more: false }],
    ],
    ['a page without has_more', [{ data: [usd('re_1', 400)] }]],
    ['a cursor that does not advance', [{ data: [usd('re_1', 400)], has_more: true }]],
  ])('%s is unavailable, never a partial total', async (_label, pages) => {
    const c = setup();
    Object.assign(c.stripe, {
      listChargeRefunds: jest.fn(async () => pages[0]),
    });
    await expect(read(c.stripe)).rejects.toThrow('SFEE_REFUND_STATE_UNAVAILABLE');
  });

  it('an incomplete page on a converted charge moves nothing and is retried, not settled at zero', async () => {
    const c = setup({ fx: true });
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    expect(c.stripe.netTo('acct_1')).toBe(7_640);
    c.listRefunds([{ data: [], has_more: true }]);
    await expect(
      c.settlements.applyAdjustments({
        purchase: c.purchase,
        charge_id: 'ch_1',
        refunded_cents: 2_500,
      }),
    ).rejects.toThrow('SFEE_REFUND_STATE_UNAVAILABLE');
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(7_640);
    expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
    expect(String(c.db.settlements[0].reconcile_reason)).toMatch(/^SFEE_REFUND_STATE_UNAVAILABLE /);
  });

  it('two complete pages are summed exactly (control)', async () => {
    const c = setup();
    c.listRefunds([
      { data: [usd('re_3', 300), usd('re_2', 200)], has_more: true },
      { data: [usd('re_1', 100), usd('re_0', 50, 'pending')], has_more: false },
    ]);
    await expect(read(c.stripe)).resolves.toMatchObject({
      succeeded_debit_cents: 600,
      succeeded_client_cents: 600,
    });
  });
});

describe('Sol B-683-1: a converted refund notice names what the client got back', () => {
  const cadRefund = (id: string, cad: number, usdDebit: number): RefundFixture => ({
    id,
    status: 'succeeded',
    amount: cad,
    currency: 'cad',
    balance_transaction: { id: `txn_${id}`, amount: -usdDebit, currency: 'usd' },
  });

  it('CAD 25 back at a USD 20 debit: the money uses USD 20, the notice keeps CAD 25', async () => {
    const c = setup({ fx: true });
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    c.listRefunds([{ data: [cadRefund('re_1', 2_500, 2_000)], has_more: false }]);
    await c.settlements.applyAdjustments({
      purchase: c.purchase,
      charge_id: 'ch_1',
      refunded_cents: 2_500,
    });
    expect(c.stripe.netTo('acct_1')).toBe(5_640);
    const notice = (c.db.notices ?? [])[0];
    expect(notice).toMatchObject({
      currency: 'usd',
      customer_refunded_cents: 2_000,
      client_currency: 'cad',
      client_refunded_cents: 2_500,
    });
    expect(String(notice.body)).toMatch(
      /^A client got 25\.00 CAD back, \$20\.00 after conversion\./,
    );
  });

  it('a later full refund at a changed rate updates both amounts exactly', async () => {
    const c = setup({ fx: true });
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    c.listRefunds([
      { data: [cadRefund('re_2', 7_500, 6_300), cadRefund('re_1', 2_500, 2_000)], has_more: false },
    ]);
    await c.settlements.applyAdjustments({
      purchase: c.purchase,
      charge_id: 'ch_1',
      refunded_cents: 10_000,
    });
    const all = c.db.notices ?? [];
    const notice = all[all.length - 1];
    expect(notice).toMatchObject({ customer_refunded_cents: 8_300, client_refunded_cents: 10_000 });
    expect(String(notice.body)).toMatch(
      /^A client got 100\.00 CAD back, \$83\.00 after conversion\./,
    );
  });

  it('same-currency control: the notice and its wording are unchanged', async () => {
    const c = setup();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    c.stripe.charges.set('ch_1', c.charge(2_000));
    await c.refunds.handle(refundedEvent(2_000, [usd('re_1', 2_000)]));
    const notice = (c.db.notices ?? [])[0];
    expect(notice).toMatchObject({ currency: 'usd', customer_refunded_cents: 2_000 });
    expect(notice.client_currency ?? null).toBeNull();
    expect(notice.client_refunded_cents ?? null).toBeNull();
    expect(String(notice.body)).toMatch(/^A client got \$20\.00 back\./);
  });
});

describe('Opus B-684-3: money moves only when a refund reports succeeded', () => {
  async function settled() {
    const c = setup();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    return c;
  }

  it('P1 a pending refund (amount_refunded counts it) moves no money', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(4_900));
    c.listRefunds([{ data: [usd('re_ach', 4_900, 'pending')], has_more: false }]);
    await c.refunds.handle(refundedEvent(4_900, [usd('re_ach', 4_900, 'pending')]));
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('P2 the pending refund then fails: the coach keeps the 4,630 sale', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(4_900));
    c.listRefunds([{ data: [usd('re_ach', 4_900, 'pending')], has_more: false }]);
    await c.refunds.handle(refundedEvent(4_900, [usd('re_ach', 4_900, 'pending')]));
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.refunds.handle(refundUpdated('failed'));
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('P3 pending at charge.refunded (amount_refunded excludes it), then succeeded: converges once', async () => {
    const c = await settled();
    await c.refunds.handle(refundedEvent(0, [usd('re_ach', 4_900, 'pending')]));
    c.stripe.charges.set('ch_1', c.charge(4_900));
    await c.refunds.handle(refundUpdated('succeeded'));
    await c.refunds.handle(refundUpdated('succeeded'));
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('P4 pending at charge.refunded (amount_refunded counts it), then succeeded: converges once', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(4_900));
    await c.refunds.handle(refundedEvent(4_900, [usd('re_ach', 4_900, 'pending')]));
    await c.refunds.handle(refundUpdated('succeeded'));
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('P5 control: a succeeded card refund delivered twice converges once', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(4_900));
    await c.refunds.handle(refundedEvent(4_900, [usd('re_card', 4_900)]));
    await c.refunds.handle(refundedEvent(4_900, [usd('re_card', 4_900)]));
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('C-684-4 a refund that fails after its money was applied raises an alert and a flag, no re-credit', async () => {
    const c = await settled();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    c.stripe.charges.set('ch_1', c.charge(2_000));
    await c.refunds.handle(refundedEvent(2_000, [usd('re_card', 2_000)]));
    expect(c.stripe.netTo('acct_1')).toBe(2_630);
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.refunds.handle(refundUpdated('failed', 're_card', 2_000));
    expect(c.stripe.netTo('acct_1')).toBe(2_630);
    expect(c.db.settlements[0]).toMatchObject({
      refunded_cents: 2_000,
      reconcile_reason: 'SFEE_REFUND_FAILED_AFTER_APPLY',
    });
    expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^SFEE_REFUND_FAILED_AFTER_APPLY alert=true charge=ch_1 refund=re_card status=failed: /,
      ),
    );
  });
});

describe('Sol B-684-1: every refund identity of the charge is kept', () => {
  it('eleven refunds, ten embedded: all eleven rows (USD 49) and the settlement agree', async () => {
    const c = setup();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    const recent = Array.from({ length: 10 }, (_, i) => usd(`re_recent_${i}`, 400));
    const older = usd('re_older', 900);
    c.listRefunds([{ data: [...recent, older], has_more: false }]);
    c.stripe.charges.set('ch_1', c.charge(4_900));
    const event = refundedEvent(4_900, recent, true);
    await c.refunds.handle(event);
    await c.refunds.handle(event);
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.db.refunds.map((r) => r.stripe_refund_id).sort()).toEqual(
      [...recent, older].map((r) => r.id).sort(),
    );
    expect(c.db.refunds.reduce((n, r) => n + Number(r.amount_cents), 0)).toBe(4_900);
    expect(c.db.refunds.every((r) => r.status === 'succeeded' && r.ledger_reversed === true)).toBe(
      true,
    );
    await expect(
      c.refunds.handle(refundUpdated('succeeded', 're_older', 900)),
    ).resolves.toMatchObject({
      claimed: true,
      purchase_id: 'cp_1',
    });
    expect(c.stripe.reversals.reduce((n, r) => n + r.amount, 0)).toBe(4_630);
  });

  it('an unreadable complete list fails the delivery (Stripe redelivers) and moves nothing', async () => {
    const c = setup();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    c.listRefunds([{ data: [], has_more: true }]);
    c.stripe.charges.set('ch_1', c.charge(4_900));
    const recent = Array.from({ length: 10 }, (_, i) => usd(`re_recent_${i}`, 400));
    await expect(c.refunds.handle(refundedEvent(4_900, recent, true))).rejects.toThrow(
      'SFEE_REFUND_STATE_UNAVAILABLE',
    );
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    expect(c.db.refunds).toHaveLength(0);
  });
});

describe('Sol B-684-3: notice delivery keeps the sweep deadline', () => {
  function sweepWith(pushMs: number) {
    const c = setup();
    jest.spyOn(c.settlements, 'runSettlementSweep').mockResolvedValue({
      retried: 0,
      backfilled: 0,
      settled: 0,
      invoices_scanned: 0,
      invoices_backfilled: 0,
      stale_awaiting: 0,
      stale_transfers: 0,
      reversals_resolved: 0,
      reconciled: 0,
      open_recovery_payees: 0,
    });
    const started = Date.now();
    let clock = started;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    c.fns.pushToUser.mockImplementation(async () => {
      clock += pushMs;
      return { delivered: true, code: 'delivered' };
    });
    const stub: object = c.fns;
    const service = new PayoutNoticeService(asPrisma(c.prisma), stub as NotificationsService);
    // The deadline argument, typed here so this spec also runs on e9ee033d (failing-before).
    const dispatch = service.dispatchPending.bind(service) as (
      now: Date,
      limit: number,
      deadlineAt: number,
    ) => Promise<number>;
    return { c, started, service, dispatch, now: () => clock };
  }

  async function seed(c: ReturnType<typeof setup>, started: number, n: number) {
    for (let i = 0; i < n; i += 1) {
      await c.prisma.payoutAdjustmentNotice.create({
        data: {
          id: `pan_${i}`,
          idempotency_key: `budget_${i}`,
          payee_user_id: 'coach_1',
          settlement_id: `cs_${i}`,
          stripe_charge_id: `ch_${i}`,
          purchase_id: 'cp_1',
          title: 'A client was refunded',
          body: 'A client got $1.00 back.',
          event: 'refund',
          created_at: new Date(started - 120_000),
          email_status: 'disabled',
        },
      });
    }
  }

  it('30-second pushes: 16 notices start inside the 8-minute budget, the rest stay pending', async () => {
    const { c, started, service, now } = sweepWith(30_000);
    await seed(c, started, 25);
    const splits = new PurchaseSplitHandlerService(
      asPrisma(c.prisma),
      c.stripe,
      new FeePolicyService(asPrisma(c.prisma)),
      new SplitLedgerService(asPrisma(c.prisma)),
      new TransferOrchestratorService(
        asPrisma(c.prisma),
        c.stripe,
        new SplitLedgerService(asPrisma(c.prisma)),
      ),
      c.settlements,
      service,
    );
    const out = await splits.runTransferSweeper(new Date(started), {
      deadlineAt: started + 8 * 60_000,
    });
    expect(c.fns.pushToUser).toHaveBeenCalledTimes(16);
    expect(now() - started).toBe(8 * 60_000);
    expect(out).toMatchObject({ deadline_reached: true, notices_delivered: 16 });
    const rows = c.db.notices ?? [];
    expect(rows.filter((r) => r.dispatched_at != null)).toHaveLength(16);
    expect(rows.filter((r) => r.dispatched_at == null && r.push_status === 'pending')).toHaveLength(
      9,
    );
    // The next run resumes with the nine left, and never repeats a sent channel.
    await splits.runTransferSweeper(new Date(now()), { deadlineAt: now() + 8 * 60_000 });
    expect(c.fns.pushToUser).toHaveBeenCalledTimes(25);
    expect(rows.filter((r) => r.dispatched_at != null)).toHaveLength(25);
  });

  it('a budget already spent by settlement work starts no notice and says so', async () => {
    const { c, started, dispatch } = sweepWith(30_000);
    await seed(c, started, 3);
    const out = await dispatch(new Date(started), 25, started - 1);
    expect(out).toBe(0);
    expect(c.fns.pushToUser).not.toHaveBeenCalled();
    expect(c.fns.createNotification).not.toHaveBeenCalled();
  });

  it('a notice whose push started before the deadline does not start its email after it', async () => {
    const { c, started, dispatch } = sweepWith(60_000);
    await seed(c, started, 1);
    (c.db.notices ?? [])[0].email_status = 'pending';
    await dispatch(new Date(started), 25, started + 30_000);
    expect(c.fns.pushToUser).toHaveBeenCalledTimes(1);
    expect(c.fns.send).not.toHaveBeenCalled();
    expect((c.db.notices ?? [])[0]).toMatchObject({ push_status: 'sent', email_status: 'pending' });
    expect((c.db.notices ?? [])[0].dispatched_at ?? null).toBeNull();
  });
});

describe('G12: purchase-split-handler logs closed codes only', () => {
  it('a failed PaymentIntent read logs no error text', async () => {
    const c = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    c.stripe.retrievePaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error(CANARY), { name: CANARY, code: CANARY }),
    );
    const splits = new PurchaseSplitHandlerService(
      asPrisma(c.prisma),
      c.stripe,
      new FeePolicyService(asPrisma(c.prisma)),
      new SplitLedgerService(asPrisma(c.prisma)),
      new TransferOrchestratorService(
        asPrisma(c.prisma),
        c.stripe,
        new SplitLedgerService(asPrisma(c.prisma)),
      ),
      c.settlements,
    );
    await expect(
      splits.resolveChargeIdForPurchase({ ...c.purchase, stripe_payment_intent_id: 'pi_1' }),
    ).resolves.toBeNull();
    const line = warn.mock.calls.map((call) => String(call[0])).find((l) => l.includes('pi_1'));
    expect(line).toMatch(/^resolveChargeIdForPurchase failed pi=pi_1: /);
    expect(line).not.toContain('AUDIT_CANARY');
    expect(line).not.toContain('example.invalid');
  });
});
