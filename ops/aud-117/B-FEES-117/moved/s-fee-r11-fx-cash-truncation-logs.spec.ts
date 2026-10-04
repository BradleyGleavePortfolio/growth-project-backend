import { Logger, type NotFoundException } from '@nestjs/common';
import { Prisma, type ClientPurchase } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CronLeaseService } from '../src/checkout/cron-lease.service';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import type { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { SettlementSweepCron } from '../src/checkout/settlement-sweep.cron';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import type { EmailService } from '../src/email/email.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

// Round 11 (B-F34-116). B-683-1/2/3 test F3 code; they live in this F4 piece because F3 is at
// its 3,000-line limit and F4 already carries the wired services they run through.
const CANARY = 'CANARY_body_contact_at_example_invalid';

function setup(opts: { currency?: string; amount?: number } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  Object.assign(prisma, {
    reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }),
    user: new Table([{ id: 'coach_1', email: 'coach@example.invalid', name: null }], {
      prefix: 'u',
    }),
  });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  // One typed stub for the notification and email boundaries.
  type Sent = { status: string; error?: string };
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]): Promise<{ id: string } | null> => ({ id: 'n_1' })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]): Promise<Sent> => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const notifications = stub as NotificationsService;
  const email = stub as EmailService;
  const notices = new PayoutNoticeService(asPrisma(prisma), notifications, email);
  const readiness = new PayoutReadinessService(asPrisma(prisma), stripe);
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma), stripe, ledger, transfers, readiness, notifications,
    undefined, undefined, settlements, notices,
  );
  const amount = opts.amount ?? 4_900;
  const purchase = {
    id: 'cp_1', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: amount, currency: opts.currency ?? 'usd', status: 'paid', source: null,
    entitlement_active: true, billing_type: 'one_time', stripe_payment_intent_id: null,
    stripe_subscription_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount, fee: 172 }));
  const reconciliation = new ReconciliationService(asPrisma(prisma), stripe);
  return {
    prisma, db, stripe, transfers, settlements, notices, fns, refunds, purchase, reconciliation,
  };
}

// A CAD 100 charge settled as USD 80 with a USD 2 processing fee: the coach's net is USD 76.40.
function fxCharge(ctx: ReturnType<typeof setup>, amountRefunded: number) {
  const base = makeCharge({ id: 'ch_1', amount: 10_000, fee: 200 });
  ctx.stripe.charges.set('ch_1', {
    ...base, currency: 'cad', amount_refunded: amountRefunded,
    balance_transaction: { id: 'txn_1', amount: 8_000, fee: 200, net: 7_800, currency: 'usd' },
  });
}
const refund = (id: string, usd: number, status = 'succeeded') => ({
  id, status, balance_transaction: { id: `txn_${id}`, amount: -usd, currency: 'usd' },
});
// Stripe's refund list (GET /refunds?charge=), stubbed by assignment so this spec also runs
// unchanged against the pre-fix code (failing-before).
type RefundPage = { data: Array<ReturnType<typeof refund>>; has_more: boolean };
function stubRefundList(stripe: FakeStripe, impl: (after: string | null) => Promise<RefundPage>) {
  const fn = jest.fn(async (_charge: string, after: string | null) => impl(after));
  Object.assign(stripe, { listChargeRefunds: fn });
  return fn;
}
const logged = (...spies: jest.SpyInstance[]) =>
  spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');

afterEach(() => jest.restoreAllMocks());

describe('B-683-1: a converted charge is refunded in its settlement currency', () => {
  it('refund before settlement: the USD 20 debit, not CAD 25, comes off the coach', async () => {
    const ctx = setup({ currency: 'cad', amount: 10_000 });
    fxCharge(ctx, 2_500);
    stubRefundList(ctx.stripe, async () => ({ data: [refund('re_1', 2_000)], has_more: false }));
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
    expect(ctx.stripe.netTo('acct_1')).toBe(5_640);
    const rec = await ctx.reconciliation.reconcilePurchase('cp_1');
    expect(rec).toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it('late refunds at a changed rate over two pages: each debit counts once', async () => {
    const ctx = setup({ currency: 'cad', amount: 10_000 });
    fxCharge(ctx, 0);
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.stripe.netTo('acct_1')).toBe(7_640);
    fxCharge(ctx, 5_000);
    stubRefundList(ctx.stripe, async (after) =>
      after === null
        ? { data: [refund('re_2', 2_100)], has_more: true }
        : { data: [refund('re_1', 2_000), refund('re_x', 999, 'failed')], has_more: false },
    );
    // The caller's 5000 is CAD presentment cents: ignored for a converted charge.
    const input = { purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 5_000 };
    await ctx.settlements.applyAdjustments(input);
    await ctx.settlements.applyAdjustments(input);
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_100);
    expect(ctx.stripe.netTo('acct_1')).toBe(3_540);
  });

  it('refund state unreadable: nothing moves, the settlement is flagged by a closed code', async () => {
    const ctx = setup({ currency: 'cad', amount: 10_000 });
    fxCharge(ctx, 0);
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    fxCharge(ctx, 2_500);
    stubRefundList(ctx.stripe, async () => {
      throw new StripeConnectApiError(CANARY, 503, CANARY, CANARY);
    });
    const input = { purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 2_500 };
    await expect(ctx.settlements.applyAdjustments(input))
      .rejects.toThrow(/^SFEE_REFUND_STATE_UNAVAILABLE charge=ch_1 kind=stripe http=503 /);
    expect(ctx.stripe.netTo('acct_1')).toBe(7_640);
    expect(ctx.db.settlements[0].reconcile_reason)
      .toBe('SFEE_REFUND_STATE_UNAVAILABLE charge=ch_1 kind=stripe http=503 type=other code=other');
  });

  it('control: a same-currency refund never lists refunds and moves the USD amount', async () => {
    const ctx = setup();
    const list = stubRefundList(ctx.stripe, async () => ({ data: [], has_more: false }));
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    const input = { purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 2_000 };
    await ctx.settlements.applyAdjustments(input);
    expect(ctx.stripe.netTo('acct_1')).toBe(2_630);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('B-683-2: reconciliation attests only transfers Stripe executed', () => {
  it('never-sent pending transfer: unknown, no cash, the pending amount noted', async () => {
    const ctx = setup();
    ctx.stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError('outage', 503, null, 'api_error'),
    );
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.db.transfers[0]).toMatchObject({ status: 'pending', stripe_transfer_id: null });
    const rec = await ctx.reconciliation.reconcilePurchase('cp_1');
    expect(rec).toMatchObject({ status: 'unknown', drift_cents: 0 });
    expect(rec.stripe.transfers_cents).toBe(0);
    expect(rec.notes).toContain('transfers_pending_cents=4630');
  });

  it('uncertain create stays unknown until its receipt is recovered, then ok', async () => {
    const ctx = setup();
    // Stripe executes the create, the response is lost and the lookup is unavailable.
    ctx.stripe.transferResponsesLost = 1;
    ctx.stripe.failListTransfers = true;
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.db.transfers[0].status).toBe('pending');
    expect(ctx.stripe.netTo('acct_1')).toBe(4_630);
    expect((await ctx.reconciliation.reconcilePurchase('cp_1')).status).toBe('unknown');
    ctx.stripe.failListTransfers = false;
    ctx.db.transfers[0].next_attempt_at = new Date(0);
    const t = ctx.db.transfers[0];
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    await ctx.settlements.attemptTransferUnderLock({
      id: String(t.id),
      source_stripe_charge_id: str(t.source_stripe_charge_id),
      settlement_id: str(t.settlement_id),
    });
    expect(ctx.db.transfers[0].status).toBe('succeeded');
    const rec = await ctx.reconciliation.reconcilePurchase('cp_1');
    expect(rec).toMatchObject({ status: 'ok', drift_cents: 0 });
    expect(rec.stripe.transfers_cents).toBe(4_630);
    expect(ctx.stripe.netTo('acct_1')).toBe(4_630);
  });
});

describe('C-683-3: reconciliation covers every settled charge of a purchase', () => {
  it('drift on the oldest of thirteen renewals is reported', async () => {
    const ctx = setup();
    for (let k = 0; k < 13; k += 1) {
      ctx.stripe.charges.set(`ch_r${k}`, makeCharge({ id: `ch_r${k}`, amount: 4_900, fee: 172 }));
      await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: `ch_r${k}` });
      ctx.db.settlements[k].created_at = new Date(Date.UTC(2026, 0, k + 1));
    }
    expect((await ctx.reconciliation.reconcilePurchase('cp_1')).status).toBe('ok');
    // A refund Stripe recorded on the oldest charge that never reached the settlement.
    ctx.stripe.charges.set('ch_r0', makeCharge({ id: 'ch_r0', amount: 4_900, fee: 172, amount_refunded: 1_000 }));
    expect((await ctx.reconciliation.reconcilePurchase('cp_1')).status).toBe('drift');
  });
});

describe('B-683-3 / B-684-2: logs carry closed codes and ids only', () => {
  it('a failed notice write and failed Stripe read log no free text', async () => {
    const ctx = setup();
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    // A rejected write whose message carries the attempted input (the notice body).
    ctx.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(
      new Prisma.PrismaClientValidationError(CANARY, { clientVersion: 'test' }),
    );
    const input = { purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 2_000 };
    await ctx.settlements.applyAdjustments(input);
    expect(ctx.stripe.netTo('acct_1')).toBe(2_630);
    ctx.db.purchases.push({ ...ctx.purchase, id: 'cp_2' } as Row);
    ctx.stripe.retrieveCharge.mockRejectedValueOnce(new Error(CANARY));
    const p2 = { ...ctx.purchase, id: 'cp_2' };
    await ctx.settlements.settleCharge({ purchase: p2, charge_id: 'ch_2' });
    expect(logged(errors, warns)).toMatch(/SFEE_NOTICE_FAILED .*kind=db_validation/);
    expect(logged(errors, warns)).not.toContain(CANARY);
    expect(JSON.stringify(ctx.db.settlements)).not.toContain(CANARY);
  });

  it('in-app, push and email failures and a deferred dispatch log no free text', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    const input = { purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 2_000 };
    await ctx.settlements.applyAdjustments(input);
    ctx.fns.createNotification.mockRejectedValueOnce(new Error(CANARY));
    ctx.fns.pushToUser.mockRejectedValueOnce(new Error(CANARY));
    ctx.fns.send.mockResolvedValueOnce({ status: 'failed', error: CANARY });
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await ctx.refunds.deliverPayoutNotices('ch_1');
    expect(ctx.db.notices?.[0]).toMatchObject({ inapp_status: 'failed', push_status: 'failed' });
    ctx.prisma.payoutAdjustmentNotice.findMany.mockRejectedValueOnce(new Error(CANARY));
    await ctx.refunds.deliverPayoutNotices('ch_1');
    const text = logged(warns);
    for (const code of ['INAPP', 'PUSH', 'EMAIL']) expect(text).toContain(`SFEE_NOTICE_${code}_FAILED`);
    expect(text).toContain('SFEE_NOTICE_DISPATCH_DEFERRED charge=ch_1: kind=unknown');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('coach@example.invalid');
    expect(text).not.toContain(String(ctx.db.notices?.[0].body));
  });

  it('the sweep cron logs no free text from the lease or the sweep', async () => {
    const leaseStub: object = {
      tryAcquire: jest.fn(async () => ({ acquired: true })),
      release: jest.fn(async () => { throw new Error(CANARY); }),
    };
    const splitsStub: object = { runTransferSweeper: jest.fn(async () => { throw new Error(CANARY); }) };
    const lease = leaseStub as CronLeaseService;
    const cron = new SettlementSweepCron(lease, splitsStub as PurchaseSplitHandlerService);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(cron.runOnce()).resolves.toEqual({ ran: true, ok: false });
    expect(logged(errors, warns)).toContain('SFEE_SWEEP_FAILED');
    expect(logged(errors, warns)).not.toContain(CANARY);
  });
});

describe('B-684-1: a refund list truncated to the latest ten still converges', () => {
  const event = (id: string, refundedCents: number, rows: Row[], hasMore: boolean) => ({
    id, type: 'charge.refunded',
    data: { object: {
      id: 'ch_1', amount: 4_900, amount_refunded: refundedCents, refunded: refundedCents >= 4_900,
      refunds: { data: rows, has_more: hasMore },
    } },
  });
  const recent = Array.from({ length: 10 }, (_, i) => ({
    id: `re_recent_${i}`, amount: 400, status: 'succeeded',
  }));

  it('eleven refunds, ten embedded: the settlement reaches 4900 on the first delivery', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    const e = event('evt_1', 4_900, recent, true);
    await ctx.refunds.handle(e);
    await ctx.refunds.handle(e);
    expect(ctx.db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_900);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
    expect(ctx.db.recoveries.map((r) => r.amount_cents)).toEqual([270]);
  });

  it('every embedded row already applied: a later delivery still converges once', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_000 }));
    await ctx.refunds.handle(event('evt_1', 4_000, recent, false));
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_000);
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(event('evt_2', 4_900, recent, true));
    await ctx.refunds.handle(event('evt_2', 4_900, recent, true));
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_900);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
    expect(ctx.db.recoveries.map((r) => r.amount_cents)).toEqual([270]);
  });

  it('control: a complete list converges a full refund exactly once', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    const e = event('evt_1', 4_900, [{ id: 're_full', amount: 4_900, status: 'succeeded' }], false);
    await ctx.refunds.handle(e);
    await ctx.refunds.handle(e);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
    expect(ctx.stripe.reversals).toHaveLength(1);
    expect(ctx.db.recoveries.map((r) => r.amount_cents)).toEqual([270]);
  });
});

describe('C-684-2: the live held amount does not depend on the page size', () => {
  it('an older notice on page 2 carries no live amount and needs no attention once read', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    await ctx.settlements.applyAdjustments({ purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 2_000 });
    ctx.stripe.failReversals = true;
    await ctx.settlements.applyAdjustments({ purchase: ctx.purchase, charge_id: 'ch_1', refunded_cents: 4_900 });
    const page1 = await ctx.notices.listForPayee('coach_1', { limit: 1 });
    expect(page1.notices[0].held_now_open_cents).toBeGreaterThan(0);
    const page2 = await ctx.notices.listForPayee('coach_1', { cursor: page1.next_cursor, limit: 1 });
    await ctx.notices.acknowledge('coach_1', page2.notices[0].id);
    const again = await ctx.notices.listForPayee('coach_1', { cursor: page1.next_cursor, limit: 1 });
    expect(again.notices[0]).toMatchObject({ held_now_open_cents: 0, needs_attention: false });
  });
});

describe('C-684-1: payout copy has no first person, exclamation mark or emoji', () => {
  const BANNED = /\b(we|our|us)\b|!|\p{Extended_Pictographic}/iu;
  it('the payout adjustment email', () => {
    const hbs = readFileSync(
      join(__dirname, '../src/email/templates/coach-payout-adjustment.hbs'), 'utf8',
    );
    expect(hbs).toContain('It comes out of your next payout, and out of the ones after it');
    expect(hbs.replace(/<[^>]*>/g, ' ')).not.toMatch(BANNED);
  });

  it('the unknown-notice answer', async () => {
    const ctx = setup();
    const err = (await ctx.notices.acknowledge('coach_1', 'pan_missing').catch((e) => e)) as NotFoundException;
    expect(err.getResponse()).toEqual({
      code: 'PAYOUT_NOTICE_NOT_FOUND',
      message: 'That payout notice is not on this account. Refresh Money to see the current notices.',
    });
    expect(JSON.stringify(err.getResponse())).not.toMatch(BANNED);
  });
});
