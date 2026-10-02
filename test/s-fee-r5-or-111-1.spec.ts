// S-FEE round 5 — owner decision OR-111-1 (2026-10-02):
//   1. On a refund or a chargeback the coach gets an alert (push + Money "needs
//      attention" record + email when the provider is live) with exact
//      amounts: what the customer got back, and what TGP holds from the
//      coach's next sale = TGP's 2% + every Stripe fee on that charge, on top
//      of the next sale's standard fees.
//   2. The coach's share comes back by reversing THAT charge's own transfer;
//      whatever Stripe refuses joins the held amount.
//   3. Recovery is forward-only netting from the coach's next transfer(s)
//      until settled, carried across sales. No reversal of the coach's other
//      past transfers (round 4's 90-day clawback is gone).
//   4. Won disputes / reinstatements net against the open balance. A coach who
//      never sells again keeps an open receivable (SFEE_RECOVERY_OPEN).
// Worked examples from the PR body: $100 full refund; $100 lost dispute with
// a $15 fee; a refused reversal after payout followed by a $49 sale and a
// $100 sale. No live Stripe, DB, push or email.
import type {
  ChargeSettlement,
  ClientPurchase,
  ConnectTransfer,
  PayeeRecovery,
  SplitLedgerEntry,
} from '@prisma/client';
import { Logger, NotFoundException } from '@nestjs/common';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import {
  ChargeSettlementService,
  adjustmentNoticeAmounts,
  noticeEventFor,
} from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { formatMoney, payoutNoticeCopy } from '../src/connect/fees/payout-notice-copy';
import type { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { settlementIdentityDrift } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { EmailService } from '../src/email/email.service';
import { EmailTemplateKey } from '../src/email/email.types';
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
const OTHER_COACH = 'coach-2';
const asNotifications = (m: object): NotificationsService => m as NotificationsService;
const asPayoutReadiness = (m: object): PayoutReadinessService => m as PayoutReadinessService;
const asEmail = (m: object): EmailService => m as EmailService;

function purchaseRow(id: string, amount: number): ClientPurchase {
  const row: Row = {
    id,
    coach_user_id: COACH,
    client_user_id: `client-${id}`,
    package_id: `pkg-${id}`,
    amount_cents: amount,
    currency: 'usd',
    billing_type: 'one_time',
    status: 'paid',
    entitlement_active: true,
    source: null,
    stripe_payment_intent_id: null,
    stripe_subscription_id: null,
    created_at: new Date(),
  };
  return row as ClientPurchase;
}

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const users: Row[] = [
    { id: COACH, email: 'coach@example.com', name: 'Sam' },
    { id: OTHER_COACH, email: 'other@example.com', name: 'Lee' },
  ];
  const withUsers = Object.assign(prisma, {
    user: new Table(users, { prefix: 'u', unique: ['email'] }),
  });
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(withUsers));
  const ledger = new SplitLedgerService(asPrisma(withUsers));
  const transfers = new TransferOrchestratorService(asPrisma(withUsers), stripe, ledger);
  const svc = new ChargeSettlementService(
    asPrisma(withUsers),
    stripe,
    feePolicy,
    ledger,
    transfers,
  );
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  const p100 = purchaseRow('cp-100', 10_000);
  const p49 = purchaseRow('cp-49', 4_900);
  const p100b = purchaseRow('cp-100b', 10_000);
  db.purchases.push(p100 as Row, p49 as Row, p100b as Row);
  const notifications = {
    createNotification: jest.fn(
      async (input: { channel?: string; body?: string }): Promise<{ id: string } | null> => ({
        id: `n-${input.channel ?? 'inapp'}`,
      }),
    ),
    pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' as const })),
  };
  const emails: Array<Record<string, unknown>> = [];
  const email = {
    send: jest.fn(
      async (input: {
        idempotencyKey: string;
      }): Promise<{
        status: string;
        providerMessageId: string | null;
        idempotencyKey: string;
        error?: string;
      }> => {
        emails.push(input);
        return { status: 'logged', providerMessageId: null, idempotencyKey: input.idempotencyKey };
      },
    ),
  };
  const notices = new PayoutNoticeService(
    asPrisma(withUsers),
    asNotifications(notifications),
    asEmail(email),
  );
  const handler = new RefundDisputeHandlerService(
    asPrisma(withUsers),
    stripe,
    ledger,
    transfers,
    asPayoutReadiness({}),
    asNotifications(notifications),
    undefined,
    undefined,
    svc,
    notices,
  );
  const settlementFor = (chargeId: string) =>
    db.settlements.find((s) => s.stripe_charge_id === chargeId)!;
  const transferFor = (chargeId: string) =>
    db.transfers.find(
      (t) => t.settlement_id === settlementFor(chargeId).id && t.kind === 'coach_net',
    )!;
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
  const openHeld = () =>
    db.recoveries
      .filter((r) => r.status === 'open')
      .reduce((n, r) => n + (r.amount_cents - r.collected_cents), 0);
  const sell = async (purchase: ClientPurchase, chargeId: string, amount: number, fee: number) => {
    stripe.charges.set(chargeId, makeCharge({ id: chargeId, amount, fee }));
    await svc.settleCharge({ purchase, charge_id: chargeId });
  };
  // Stripe's charge.refunded lists every refund of the charge so far.
  const refundsByCharge = new Map<string, Array<{ id: string; amount: number; status: string }>>();
  const refundViaWebhook = async (chargeId: string, amount: number, refunded: number) => {
    const list = refundsByCharge.get(chargeId) ?? [];
    const sofar = list.reduce((n, r) => n + r.amount, 0);
    if (refunded > sofar) {
      list.push({
        id: `re_${chargeId}_${list.length + 1}`,
        amount: refunded - sofar,
        status: 'succeeded',
      });
    }
    refundsByCharge.set(chargeId, list);
    stripe.charges.set(
      chargeId,
      makeCharge({
        id: chargeId,
        amount,
        fee: amount === 4_900 ? 172 : 320,
        amount_refunded: refunded,
      }),
    );
    return handler.handle({
      id: `evt_${chargeId}_refund_${refunded}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: chargeId,
          amount,
          amount_refunded: refunded,
          refunded: refunded >= amount,
          refunds: { data: list.map((r) => ({ ...r })) },
        },
      },
    });
  };
  return {
    prisma: withUsers,
    db,
    stripe,
    svc,
    transfers,
    handler,
    notices,
    notifications,
    email,
    emails,
    p100,
    p49,
    p100b,
    settlementFor,
    transferFor,
    identity,
    openHeld,
    sell,
    refundViaWebhook,
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// $100 US card: Stripe fee 320 (2.9% + 30c), TGP 2% = 200, coach net 9480.
describe('OR-111-1 worked example 1: $100 full refund', () => {
  it("reverses that sale's own transfer (94.80), holds 5.20 = TGP 2.00 + Stripe 3.20 from the next sale, and tells the coach exactly", async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    expect(ctx.transferFor('ch_100')).toMatchObject({ amount_cents: 9_480, status: 'succeeded' });

    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);

    expect(ctx.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.reversedOn(ctx.transferFor('ch_100').stripe_transfer_id)).toBe(9_480);
    expect(ctx.settlementFor('ch_100')).toMatchObject({
      target_platform_fee_cents: 200,
      target_coach_net_cents: -520,
    });
    expect(ctx.openHeld()).toBe(520);
    // The Money "needs attention" record, exact integer cents.
    expect(ctx.db.notices).toHaveLength(1);
    expect(ctx.db.notices![0]).toMatchObject({
      payee_user_id: COACH,
      role: 'coach',
      event: 'refund',
      charge_gross_cents: 10_000,
      customer_refunded_cents: 10_000,
      reversed_cents: 9_480,
      held_cents: 520,
      held_tgp_fee_cents: 200,
      held_stripe_fee_cents: 320,
      held_dispute_fee_cents: 0,
      held_not_reversed_cents: 0,
      held_open_cents: 520,
      title: 'A client was refunded',
      body: "A client got $100.00 back. We took $94.80 back from that sale's payout. We will hold $5.20 from your next sale.",
    });
    // Delivered once: in-app + push + email (log transport = provider not live).
    expect(ctx.notifications.pushToUser).toHaveBeenCalledWith(
      COACH,
      'A client was refunded',
      "A client got $100.00 back. We took $94.80 back from that sale's payout. We will hold $5.20 from your next sale.",
      expect.objectContaining({ type: 'payout_adjustment', notice_id: ctx.db.notices![0].id }),
    );
    expect(ctx.emails).toHaveLength(1);
    expect(ctx.emails[0]).toMatchObject({
      to: 'coach@example.com',
      template: EmailTemplateKey.COACH_PAYOUT_ADJUSTMENT,
      idempotencyKey: ctx.db.notices![0].idempotency_key,
    });
    expect((ctx.emails[0].data as { held_lines: unknown }).held_lines).toEqual([
      { code: 'tgp_fee', label: 'TGP fee (2% of the sale)', cents: 200, display: '$2.00' },
      {
        code: 'stripe_fee',
        label: 'Stripe processing fee (Stripe keeps it on refunds)',
        cents: 320,
        display: '$3.20',
      },
    ]);
    expect(ctx.db.notices![0]).toMatchObject({ push_status: 'sent', email_status: 'logged' });
    expect(ctx.db.notices![0].dispatched_at).toBeInstanceOf(Date);
    // One alert, with the real numbers: the generic "Refund processed" line is superseded.
    const bodies = ctx.notifications.createNotification.mock.calls.map((c) => c[0].body ?? '');
    expect(bodies.some((b) => b.startsWith('Refund processed'))).toBe(false);

    // Redelivery: no second reversal, notice or alert.
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    await ctx.svc.applyAdjustments({
      purchase: ctx.p100,
      charge_id: 'ch_100',
      refunded_cents: 10_000,
    });
    expect(ctx.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.db.notices).toHaveLength(1);
    expect(ctx.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(ctx.emails).toHaveLength(1);

    // TGP: 2.00 receivable, cash -3.20 until the next sale nets it.
    expect(ctx.identity('ch_100')).toMatchObject({
      drift_cents: 0,
      platform_net_cents: 200,
      platform_cash_cents: -320,
      receivable_open_cents: 520,
    });
    // Next $100 sale: its standard fees (320 + 200) plus the 520 held.
    await ctx.sell(ctx.p100b, 'ch_next', 10_000, 320);
    expect(ctx.transferFor('ch_next')).toMatchObject({
      amount_cents: 8_960,
      netted_recovery_cents: 520,
    });
    expect(ctx.openHeld()).toBe(0);
    expect(ctx.identity('ch_100')).toEqual({
      drift_cents: 0,
      platform_net_cents: 200,
      platform_cash_cents: 200,
      receivable_open_cents: 0,
      notes: [],
    });
    expect(ctx.identity('ch_next')).toMatchObject({ drift_cents: 0, platform_cash_cents: 200 });
  });
});

describe('OR-111-1 worked example 2: $100 lost dispute with a $15 fee', () => {
  it('reverses 94.80 and holds 20.20 = TGP 2.00 + Stripe 3.20 + dispute fee 15.00; the lost outcome says the hold stands', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    const created = [{ id: 'txn_dp_1', amount: -10_000, fee: 1_500 }];
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: created });
    const dispute = {
      id: 'dp_1',
      charge: 'ch_100',
      amount: 10_000,
      currency: 'usd',
      balance_transactions: created,
    };
    await ctx.handler.handle({
      id: 'evt_dp_created',
      type: 'charge.dispute.created',
      data: { object: { ...dispute, status: 'needs_response' } },
    });
    expect(ctx.stripe.reversedOn(ctx.transferFor('ch_100').stripe_transfer_id)).toBe(9_480);
    expect(ctx.openHeld()).toBe(2_020);
    const chargeback = ctx.db.notices!.find((n) => n.event === 'chargeback')!;
    expect(chargeback).toMatchObject({
      customer_refunded_cents: 10_000,
      reversed_cents: 9_480,
      held_cents: 2_020,
      held_tgp_fee_cents: 200,
      held_stripe_fee_cents: 320,
      held_dispute_fee_cents: 1_500,
      held_not_reversed_cents: 0,
      title: 'A client disputed a charge',
      body: "A client's bank took back $100.00 in a dispute. We took $94.80 back from that sale's payout. We will hold $20.20 from your next sale.",
    });
    expect(ctx.notifications.pushToUser).toHaveBeenCalledTimes(1);

    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: created });
    await ctx.handler.handle({
      id: 'evt_dp_closed',
      type: 'charge.dispute.closed',
      data: { object: { ...dispute, status: 'lost' } },
    });
    // Lost moves no money (Stripe withdrew it at creation) and says the hold stands.
    expect(ctx.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.openHeld()).toBe(2_020);
    const lost = ctx.db.notices!.find((n) => n.event === 'dispute_lost')!;
    expect(lost).toMatchObject({ held_cents: 2_020, held_open_cents: 2_020 });
    expect(lost.body).toBe(
      'The bank decided the dispute on a $100.00 charge for the client. $20.20 is still held from your next sale.',
    );
    expect(ctx.notifications.pushToUser).toHaveBeenCalledTimes(2);
    expect(ctx.identity('ch_100')).toMatchObject({
      drift_cents: 0,
      platform_net_cents: 200,
      receivable_open_cents: 2_020,
    });

    // Netted from the next sale; TGP ends at exactly its 2.00 on the disputed charge.
    await ctx.sell(ctx.p100b, 'ch_next', 10_000, 320);
    expect(ctx.transferFor('ch_next')).toMatchObject({
      amount_cents: 9_480 - 2_020,
      netted_recovery_cents: 2_020,
    });
    expect(ctx.identity('ch_100')).toEqual({
      drift_cents: 0,
      platform_net_cents: 200,
      platform_cash_cents: 200,
      receivable_open_cents: 0,
      notes: [],
    });
  });
});

describe('OR-111-1 worked example 3: refused reversal after payout, then a $49 sale and a $100 sale', () => {
  it('holds 100.00 (2.00 + 3.20 + 94.80 not reversed); the $49 sale nets 46.30 in full; the $100 sale nets the last 53.70 and pays 41.10', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    ctx.stripe.failReversals = true; // the coach was already paid out
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    ctx.stripe.failReversals = false;
    expect(ctx.stripe.reversedOn(ctx.transferFor('ch_100').stripe_transfer_id)).toBe(0);
    expect(ctx.openHeld()).toBe(10_000);
    expect(ctx.db.notices![0]).toMatchObject({
      event: 'refund',
      customer_refunded_cents: 10_000,
      reversed_cents: 0,
      held_cents: 10_000,
      held_tgp_fee_cents: 200,
      held_stripe_fee_cents: 320,
      held_dispute_fee_cents: 0,
      held_not_reversed_cents: 9_480,
      body: 'A client got $100.00 back. We will hold $100.00 from your next sale.',
    });

    // $49 sale: fee 172, TGP 98, coach net 4630 — all of it is netted.
    await ctx.sell(ctx.p49, 'ch_49', 4_900, 172);
    expect(ctx.transferFor('ch_49')).toMatchObject({
      amount_cents: 0,
      netted_recovery_cents: 4_630,
      status: 'netted',
    });
    expect(ctx.openHeld()).toBe(5_370);
    // No reversal of any other past sale: forward netting only.
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(1);

    // $100 sale: coach net 9480, 5370 netted, 4110 transferred; nothing left held.
    await ctx.sell(ctx.p100b, 'ch_100b', 10_000, 320);
    expect(ctx.transferFor('ch_100b')).toMatchObject({
      amount_cents: 4_110,
      netted_recovery_cents: 5_370,
      status: 'succeeded',
    });
    expect(ctx.openHeld()).toBe(0);
    expect(ctx.stripe.reverseTransfer.mock.calls.length).toBe(1);
    // TGP is never net-negative on a settled charge once netting completes.
    for (const ch of ['ch_100', 'ch_49', 'ch_100b']) {
      const id = ctx.identity(ch);
      expect(id.drift_cents).toBe(0);
      expect(id.receivable_open_cents).toBe(0);
      expect(id.platform_cash_cents).toBe(id.platform_net_cents);
      expect(id.platform_cash_cents).toBeGreaterThanOrEqual(0);
    }
    expect(ctx.identity('ch_100').platform_cash_cents).toBe(200);
    expect(ctx.identity('ch_49').platform_cash_cents).toBe(98);
    expect(ctx.identity('ch_100b').platform_cash_cents).toBe(200);

    // Money page: the balance followed each sale; the notice keeps its breakdown.
    const view = await ctx.notices.listForPayee(COACH);
    expect(view.open_balance).toEqual([]);
    expect(view.notices[0]).toMatchObject({
      event: 'refund',
      held_cents: 10_000,
      held_now_open_cents: 0,
      needs_attention: true,
    });
  });
});

describe('OR-111-1 won dispute, Money API and delivery', () => {
  it('a won dispute releases the hold and pays the coach back; the notice says both amounts', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    const created = [{ id: 'txn_dp_1', amount: -10_000, fee: 1_500 }];
    ctx.stripe.disputes.set('dp_1', { id: 'dp_1', balance_transactions: created });
    await ctx.svc.applyAdjustments({ purchase: ctx.p100, charge_id: 'ch_100', dispute_id: 'dp_1' });
    expect(ctx.openHeld()).toBe(2_020);
    ctx.stripe.disputes.set('dp_1', {
      id: 'dp_1',
      balance_transactions: [...created, { id: 'txn_dp_2', amount: 10_000, fee: 0 }],
    });
    await ctx.svc.applyAdjustments({ purchase: ctx.p100, charge_id: 'ch_100', dispute_id: 'dp_1' });
    // Won, fee kept by Stripe: coach target 10000 - 320 - 1500 - 200 = 7980.
    expect(ctx.settlementFor('ch_100').target_coach_net_cents).toBe(7_980);
    expect(ctx.openHeld()).toBe(0);
    const won = ctx.db.notices!.find((n) => n.event === 'dispute_won')!;
    expect(won).toMatchObject({
      reinstated_cents: 7_980,
      held_cents: 0,
      customer_refunded_cents: 0,
    });
    expect(won.body).toBe(
      'You won the dispute on a $100.00 charge. We paid $79.80 back to you and released the $20.20 hold. Nothing is held from your next sale.',
    );
    expect(ctx.identity('ch_100')).toMatchObject({ drift_cents: 0, platform_net_cents: 200 });
  });

  it('GET /v1/coach/payments/adjustments data: open balance per currency, newest notice first, scoped to the caller; acknowledge is scoped too', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    await ctx.refundViaWebhook('ch_100', 10_000, 4_000);
    // $40 partial refund: reverse 40.00, nothing held (TGP keeps its 2.00 from the 54.80 left).
    expect(ctx.db.notices![0]).toMatchObject({
      reversed_cents: 4_000,
      held_cents: 0,
      body: "A client got $40.00 back. We took $40.00 back from that sale's payout. Nothing is held from your next sale.",
    });
    ctx.stripe.failReversals = true;
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    const view = await ctx.notices.listForPayee(COACH, { limit: 1 });
    // Remaining 5480 could not be reversed + 520 fees = 6000 held.
    expect(view.open_balance).toEqual([
      { currency: 'usd', held_cents: 6_000, display: '$60.00', charges: 1 },
    ]);
    expect(view.needs_attention_count).toBe(2);
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0]).toMatchObject({
      held_cents: 6_000,
      held_now_open_cents: 6_000,
      customer_refunded_cents: 10_000,
      reversed_cents: 4_000,
      needs_attention: true,
    });
    expect(view.notices[0].held_breakdown.map((l) => [l.code, l.cents])).toEqual([
      ['tgp_fee', 200],
      ['stripe_fee', 320],
      ['not_reversed', 5_480],
    ]);
    expect(view.next_cursor).toBe(view.notices[0].id);
    const page2 = await ctx.notices.listForPayee(COACH, { cursor: view.next_cursor, limit: 1 });
    expect(page2.notices.map((n) => n.reversed_cents)).toEqual([4_000]);
    expect(page2.next_cursor).toBeNull();

    // Another coach sees nothing and cannot acknowledge this coach's notice.
    const other = await ctx.notices.listForPayee(OTHER_COACH);
    expect(other).toMatchObject({ open_balance: [], notices: [], needs_attention_count: 0 });
    await expect(ctx.notices.acknowledge(OTHER_COACH, view.notices[0].id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await ctx.notices.acknowledge(COACH, page2.notices[0].id);
    const after = await ctx.notices.listForPayee(COACH);
    expect(after.needs_attention_count).toBe(1);
    // Still open money keeps the newest notice in "needs attention" even once read.
    await ctx.notices.acknowledge(COACH, view.notices[0].id);
    const read = await ctx.notices.listForPayee(COACH);
    expect(read.notices[0]).toMatchObject({ needs_attention: true, held_now_open_cents: 6_000 });
    expect(read.notices[1]).toMatchObject({ needs_attention: false });
  });

  it('delivery is claimed once: a failed email is retried by the sweeper, a delivered notice is never sent again', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    ctx.email.send.mockResolvedValueOnce({
      status: 'failed',
      providerMessageId: null,
      idempotencyKey: 'x',
      error: 'provider 503',
    });
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    const n = ctx.db.notices![0];
    expect(n).toMatchObject({ email_status: 'failed', dispatched_at: null, dispatch_attempts: 1 });
    // Too early for the sweeper (claim still fresh): nothing happens.
    expect(await ctx.notices.dispatchPending(new Date(Date.now() + 2 * 60_000))).toBe(0);
    // After the claim expires the sweeper delivers it.
    expect(await ctx.notices.dispatchPending(new Date(Date.now() + 10 * 60_000))).toBe(1);
    expect(ctx.db.notices![0]).toMatchObject({ email_status: 'logged', dispatch_attempts: 2 });
    expect(ctx.db.notices![0].dispatched_at).toBeInstanceOf(Date);
    expect(await ctx.notices.dispatchPending(new Date(Date.now() + 20 * 60_000))).toBe(0);
    expect(await ctx.notices.dispatchForCharge('ch_100')).toEqual({ recorded: 1, sent: 0 });
  });

  it('a push muted by the coach is skipped; the Money record and email still exist', async () => {
    const ctx = setup();
    ctx.notifications.createNotification.mockImplementation(async (input: { channel?: string }) =>
      input.channel === 'push' ? null : { id: 'n-inapp' },
    );
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    expect(ctx.notifications.pushToUser).not.toHaveBeenCalled();
    expect(ctx.db.notices![0]).toMatchObject({ push_status: 'skipped', email_status: 'logged' });
  });
});

describe('OR-111-1 netting race (CAS lease fence + per-recovery CAS)', () => {
  it('a netting that loses its CAS to a concurrent collection re-reads and nets only what is still owed', async () => {
    const ctx = setup();
    await ctx.sell(ctx.p100, 'ch_100', 10_000, 320);
    ctx.stripe.failReversals = true;
    await ctx.refundViaWebhook('ch_100', 10_000, 10_000);
    ctx.stripe.failReversals = false;
    expect(ctx.openHeld()).toBe(10_000);
    const rec = ctx.db.recoveries[0];
    const realUpdateMany = ctx.prisma.payeeRecovery.updateMany.getMockImplementation()!;
    // Another sale's settlement collects 1000 of the same recovery at the same moment.
    ctx.prisma.payeeRecovery.updateMany.mockImplementationOnce(async () => {
      rec.collected_cents += 1_000;
      return { count: 0 };
    });
    ctx.prisma.payeeRecovery.updateMany.mockImplementation(realUpdateMany);
    await ctx.sell(ctx.p100b, 'ch_100b', 10_000, 320);
    expect(ctx.transferFor('ch_100b')).toMatchObject({
      amount_cents: 480,
      netted_recovery_cents: 9_000,
    });
    expect(ctx.db.recoveries[0]).toMatchObject({ collected_cents: 10_000, status: 'collected' });
  });
});

describe('OR-111-1 pure rules', () => {
  it('notice event per adjustment state', () => {
    const adj = (r: number, w: number, f: number) => ({
      refunded_cents: r,
      dispute_withdrawn_cents: w,
      dispute_fee_cents: f,
    });
    expect(noticeEventFor(adj(100, 0, 0), null, null)).toBe('refund');
    expect(noticeEventFor(adj(0, 100, 15), null, null)).toBe('chargeback');
    expect(noticeEventFor(adj(0, 100, 15), 'chargeback', 'dispute_lost')).toBe('dispute_lost');
    expect(noticeEventFor(adj(0, 0, 15), 'chargeback', null)).toBe('dispute_won');
    expect(noticeEventFor(adj(0, 0, 0), 'chargeback', null)).toBe('dispute_won');
    expect(noticeEventFor(adj(0, 0, 0), null, null)).toBeNull();
  });

  it('held parts always sum to the held amount (property over many states)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const gross = 1_999 + rnd(200_000);
      const fee = Math.round(gross * 0.029) + 30;
      const platform = Math.floor(gross * 0.02);
      const refunded = rnd(gross + 1);
      const disputeFee = rnd(3) === 0 ? 1_500 : 0;
      const target = gross - refunded - fee - disputeFee - platform;
      const held = Math.max(0, -target) + rnd(3) * rnd(gross);
      const a = adjustmentNoticeAmounts({
        leg: { leg: 'coach', target_cents: target },
        split: { gross_cents: gross, stripe_fee_cents: fee, platform_fee_cents: platform },
        adj: {
          refunded_cents: refunded,
          dispute_withdrawn_cents: 0,
          dispute_fee_cents: disputeFee,
        },
        currency: 'usd',
        transfers: [],
        recoveries: held > 0 ? [{ status: 'open', amount_cents: held, collected_cents: 0 }] : [],
        previous_held_cents: null,
      });
      expect(
        a.held_tgp_fee_cents +
          a.held_stripe_fee_cents +
          a.held_dispute_fee_cents +
          a.held_not_reversed_cents,
      ).toBe(a.held_cents);
      expect(
        Math.min(a.held_tgp_fee_cents, a.held_stripe_fee_cents, a.held_not_reversed_cents),
      ).toBeGreaterThanOrEqual(0);
      const copy = payoutNoticeCopy('refund', 'coach', a);
      expect(copy.body.length).toBeLessThanOrEqual(160);
      expect(copy.body).not.toMatch(/!/);
    }
  });

  it('money formatting', () => {
    expect(formatMoney(520, 'usd')).toBe('$5.20');
    expect(formatMoney(123_456_78, 'usd')).toBe('$123,456.78');
    expect(formatMoney(2_020, 'eur')).toBe('20.20 EUR');
    expect(formatMoney(1_500, 'jpy')).toBe('1,500 JPY');
  });
});
