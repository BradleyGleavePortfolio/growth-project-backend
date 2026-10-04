// S-FEE round 3 — B-627-1: a renewal whose invoice.paid webhook was lost is
// still paid to the coach.
//
// Round 2's sweeper only backfilled purchases with NO settlement
// (`settlements: { none: {} }`, 14 days), so a missed renewal on a
// subscription whose first charge had settled was never paid out. The sweep
// now walks Stripe's paid invoices (35 days, resumable cursor) and settles
// every invoice CHARGE that has no ChargeSettlement row, matched by charge id.
// It also keeps a provisional row when the first Stripe read fails, and
// alerts on money that has waited over an hour. No live Stripe.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import {
  BACKFILL_WINDOW_DAYS,
  ChargeSettlementService,
  INVOICE_BACKFILL_CURSOR,
  SETTLEMENT_LOG_CODES,
} from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import {
  FakeStripe,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const NOW = new Date('2026-10-02T04:00:00Z');
const secondsAgo = (days: number) => Math.floor((NOW.getTime() - days * 86_400_000) / 1000);

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
    created_at: new Date('2026-08-20T12:00:00Z'),
    ...overrides,
  };
  return base as ClientPurchase;
}

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  const purchase = purchaseRow();
  db.purchases.push(purchase as Row);
  const invoice = (id: string, charge: string, daysAgo: number, subscription = 'sub_1') =>
    stripe.paidInvoices.push({
      id,
      charge,
      subscription,
      amount_paid: 4_900,
      created: secondsAgo(daysAgo),
    });
  const cursor = () => db.leases?.find((l) => l.name === INVOICE_BACKFILL_CURSOR)?.cursor ?? null;
  return { prisma, db, stripe, svc, purchase, invoice, cursor };
}

let warnLog: jest.SpyInstance;
let errorLog: jest.SpyInstance;
beforeEach(() => {
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

describe('B-627-1: missed renewals are matched by charge id', () => {
  it('a renewal on a purchase that already has a settlement is found and paid once', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_first', makeCharge({ id: 'ch_first', amount: 4_900, fee: 172 }));
    await ctx.svc.settleCharge({
      purchase: ctx.purchase,
      charge_id: 'ch_first',
      invoice_id: 'in_1',
    });
    // Renewal 30 days later; its invoice.paid webhook never arrived.
    ctx.stripe.charges.set('ch_renew', makeCharge({ id: 'ch_renew', amount: 4_900, fee: 172 }));
    ctx.invoice('in_1', 'ch_first', 31);
    ctx.invoice('in_2', 'ch_renew', 1);

    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary).toMatchObject({ invoices_scanned: 2, invoices_backfilled: 1, settled: 1 });
    const renewal = ctx.db.settlements.find((s) => s.stripe_charge_id === 'ch_renew');
    expect(renewal).toMatchObject({
      status: 'settled',
      stripe_invoice_id: 'in_2',
      purchase_id: 'cp-1',
      target_coach_net_cents: 4_630,
    });
    expect(ctx.stripe.netTo('acct_coach')).toBe(9_260);
    expect(lines(warnLog).join('\n')).toContain(
      `${SETTLEMENT_LOG_CODES.invoiceBackfill} invoice=in_2 charge=ch_renew`,
    );
    // End of the window reached: the cursor resets to the newest invoice.
    expect(ctx.cursor()).toBeNull();

    // Idempotent: the next run finds nothing new and pays nobody twice.
    const again = await ctx.svc.runSettlementSweep(NOW);
    expect(again).toMatchObject({ invoices_scanned: 2, invoices_backfilled: 0 });
    expect(ctx.stripe.netTo('acct_coach')).toBe(9_260);
    expect(ctx.db.transfers).toHaveLength(2);
  });

  it('reads 35 days of paid invoices (the round 2 window was 14)', async () => {
    const ctx = setup();
    await ctx.svc.runSettlementSweep(NOW);
    expect(BACKFILL_WINDOW_DAYS).toBe(35);
    expect(ctx.stripe.listPaidInvoices).toHaveBeenCalledWith({
      created_gte: secondsAgo(35),
      starting_after: null,
      limit: 100,
    });
  });

  it('a window larger than one run is covered across runs through the saved cursor', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_first', makeCharge({ id: 'ch_first', amount: 4_900, fee: 172 }));
    await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_first' });
    // 450 newer paid invoices of other platforms' subscriptions (no purchase
    // here), then the missed renewal, oldest.
    for (let i = 0; i < 450; i += 1) {
      ctx.invoice(
        `in_other_${String(i).padStart(3, '0')}`,
        `ch_other_${i}`,
        1 + i / 1000,
        `sub_other_${i}`,
      );
    }
    ctx.stripe.charges.set('ch_renew', makeCharge({ id: 'ch_renew', amount: 4_900, fee: 172 }));
    ctx.invoice('in_renew', 'ch_renew', 20);

    const first = await ctx.svc.runSettlementSweep(NOW);
    // Four pages of 100 per run.
    expect(first).toMatchObject({ invoices_scanned: 400, invoices_backfilled: 0 });
    expect(ctx.cursor()).not.toBeNull();

    const second = await ctx.svc.runSettlementSweep(NOW);
    expect(second).toMatchObject({ invoices_scanned: 51, invoices_backfilled: 1, settled: 1 });
    expect(ctx.stripe.netTo('acct_coach')).toBe(9_260);
    expect(ctx.cursor()).toBeNull();
    // Stripe's paid-invoice list was never asked to retrieve unrelated charges.
    expect(ctx.stripe.retrieveCharge.mock.calls.map((c) => c[0])).toEqual(['ch_first', 'ch_renew']);
  });

  it('bounded: at most `limit` backfills per run; the rest resume from the cursor', async () => {
    const ctx = setup();
    for (const [i, id] of ['in_a', 'in_b', 'in_c'].entries()) {
      ctx.stripe.charges.set(`ch_${id}`, makeCharge({ id: `ch_${id}`, amount: 4_900, fee: 172 }));
      ctx.invoice(id, `ch_${id}`, 3 - i);
    }
    // The first charge settled normally so the purchase is S-FEE.
    await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_in_a' });
    ctx.stripe.charges.set('ch_d', makeCharge({ id: 'ch_d', amount: 4_900, fee: 172 }));
    ctx.invoice('in_d', 'ch_d', 0.5);

    const first = await ctx.svc.runSettlementSweep(NOW, 2);
    expect(first.invoices_backfilled).toBe(2);
    expect(ctx.cursor()).toBe('in_c');
    const second = await ctx.svc.runSettlementSweep(NOW, 2);
    expect(second.invoices_backfilled).toBe(1);
    expect(ctx.db.settlements.filter((s) => s.status === 'settled')).toHaveLength(4);
    expect(ctx.stripe.netTo('acct_coach')).toBe(4 * 4_630);
  });

  it('legacy destination subscriptions (ledger rows, no settlement) are left to the legacy flow', async () => {
    const ctx = setup();
    ctx.db.ledger.push({
      id: 'le-legacy',
      purchase_id: 'cp-1',
      kind: 'destination',
      amount_cents: 4_802,
      reversed_cents: 0,
      status: 'posted',
    });
    ctx.invoice('in_legacy', 'ch_legacy', 2);
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary).toMatchObject({ invoices_scanned: 1, invoices_backfilled: 0 });
    expect(ctx.stripe.retrieveCharge).not.toHaveBeenCalled();
    expect(ctx.db.settlements).toHaveLength(0);
  });

  it('a subscription with no settlement yet (first invoice lost too) is backfilled by charge id', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_first', makeCharge({ id: 'ch_first', amount: 4_900, fee: 172 }));
    ctx.invoice('in_first', 'ch_first', 2);
    // The purchase-level orphan pass runs first and settles the subscription's
    // latest charge; the invoice pass then finds that charge already settled.
    ctx.purchase.created_at = new Date(NOW.getTime() - 2 * 86_400_000);
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(ctx.db.settlements.filter((s) => s.stripe_charge_id === 'ch_first')).toHaveLength(1);
    expect(summary.settled).toBeGreaterThanOrEqual(1);
    expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
  });

  it('a Stripe failure listing invoices keeps the cursor and logs a specific code', async () => {
    const ctx = setup();
    ctx.stripe.listPaidInvoices.mockRejectedValueOnce(new Error('Stripe API timed out'));
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary.invoices_scanned).toBe(0);
    expect(lines(warnLog).join('\n')).toContain(SETTLEMENT_LOG_CODES.invoiceBackfillFailed);
  });
});

describe('B-627-1: a charge we were told about is never lost', () => {
  it('first Stripe read fails: a provisional awaiting_fee row is kept and the sweeper settles it', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    ctx.stripe.retrieveCharge.mockRejectedValueOnce(new Error('Stripe API timed out'));
    const outcome = await ctx.svc.settleCharge({
      purchase: ctx.purchase,
      charge_id: 'ch_1',
      invoice_id: 'in_1',
    });
    expect(outcome.status).toBe('awaiting_fee');
    expect(ctx.db.settlements).toHaveLength(1);
    expect(ctx.db.settlements[0]).toMatchObject({
      status: 'awaiting_fee',
      stripe_invoice_id: 'in_1',
      gross_cents: 4_900,
    });
    expect(String(ctx.db.settlements[0].last_error)).toContain(
      SETTLEMENT_LOG_CODES.stripeUnavailable,
    );
    ctx.db.settlements[0].updated_at = new Date(NOW.getTime() - 120_000);
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary).toMatchObject({ retried: 1, settled: 1 });
    expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
  });

  it('settling while another worker holds the charge lock leaves an awaiting row for the sweeper', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    ctx.svc.chargeLock.waitMs = 10;
    let release: () => void = () => undefined;
    const holding = ctx.svc.withChargeLock('ch_1', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 1));
    const outcome = await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(outcome.status).toBe('awaiting_fee');
    expect(String(ctx.db.settlements[0].last_error)).toContain(SETTLEMENT_LOG_CODES.lockBusy);
    release();
    await holding;
    ctx.db.settlements[0].updated_at = new Date(NOW.getTime() - 120_000);
    await ctx.svc.runSettlementSweep(NOW);
    expect(ctx.stripe.netTo('acct_coach')).toBe(4_630);
  });

  it('a provisional row for a charge that turns out to be $0 is removed', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_zero', makeCharge({ id: 'ch_zero', amount: 0, fee: 0 }));
    ctx.stripe.retrieveCharge.mockRejectedValueOnce(new Error('Stripe API timed out'));
    await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_zero' });
    expect(ctx.db.settlements).toHaveLength(1);
    const outcome = await ctx.svc.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_zero' });
    expect(outcome.status).toBe('skipped_free');
    expect(ctx.db.settlements).toHaveLength(0);
  });
});

describe('B-627-1: stale money raises an alert', () => {
  it('awaiting_fee rows and pending transfers older than an hour log alert=true', async () => {
    const ctx = setup();
    ctx.db.settlements.push({
      id: 'cs-stale',
      purchase_id: 'cp-missing',
      stripe_charge_id: 'ch_stale',
      status: 'awaiting_fee',
      created_at: new Date(NOW.getTime() - 2 * 3_600_000),
      updated_at: new Date(NOW.getTime() - 30_000),
      refunded_cents: 0,
      dispute_withdrawn_cents: 0,
      dispute_fee_cents: 0,
    });
    ctx.db.transfers.push({
      id: 'ct-stale',
      settlement_id: 'cs-other',
      status: 'pending',
      amount_cents: 100,
      created_at: new Date(NOW.getTime() - 2 * 3_600_000),
    });
    ctx.db.transfers.push({
      id: 'ct-fresh',
      settlement_id: 'cs-other',
      status: 'pending',
      amount_cents: 100,
      created_at: new Date(NOW.getTime() - 60_000),
    });
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary).toMatchObject({ stale_awaiting: 1, stale_transfers: 1 });
    const errors = lines(errorLog).join('\n');
    expect(errors).toContain(
      `${SETTLEMENT_LOG_CODES.staleAwaiting} alert=true 1 charge settlement`,
    );
    expect(errors).toContain(`${SETTLEMENT_LOG_CODES.staleTransfers} alert=true 1 coach transfer`);
  });

  it('no alert when nothing has waited an hour', async () => {
    const ctx = setup();
    const summary = await ctx.svc.runSettlementSweep(NOW);
    expect(summary).toMatchObject({ stale_awaiting: 0, stale_transfers: 0 });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
