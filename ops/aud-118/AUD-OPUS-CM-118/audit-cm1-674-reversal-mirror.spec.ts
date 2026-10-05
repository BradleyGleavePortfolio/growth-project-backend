// AUDIT PROBE (AUD-OPUS-CM1-116, Claude Opus 5.5) — backend#674 @ 9a512028.
// Never merge. Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the PR's own stateful Prisma double and
// synthetic Stripe (test/support/refund-reversal-harness.ts).
//
// Part 1 (B-674-1): Stripe's transfer.reversed webhook (a required event,
// .env.example "head-coach reversal mirror") writes Stripe's CUMULATIVE
// amount_reversed into ConnectTransfer.reversed_amount_cents, while every
// local record path added by this PR (retry after a timed-out request, owner
// reconcile recorded_from_stripe) ADDS the same reversal again.
//
// Part 2 (B-641-12, carried): recordReversal / SplitLedgerService.applyReversal
// read a row and write an absolute value. A reversal of ANOTHER refund that
// commits between that read and that write (READ COMMITTED, plain SELECT, no
// row lock) is overwritten. The hook below lands that committed write between
// the read and the write, exactly as Postgres allows.

import 'reflect-metadata';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, refundRow, seedPurchase, staleOwedRefund } from './support/refund-reversal-harness';

type Row = Record<string, any>;

function transferReversed(transferId: string, amountReversed: number, fully: boolean) {
  return {
    id: `evt_${transferId}_${amountReversed}`,
    type: 'transfer.reversed',
    data: { object: { id: transferId, amount_reversed: amountReversed, reversed: fully } },
  };
}

// Stripe makes the reversal, but the client sees a timeout (the request
// reached Stripe; the response never came back).
function timeOutAfterStripeMadeIt(h: ReturnType<typeof harness>): void {
  const made = h.reverseTransfer.getMockImplementation()!;
  h.reverseTransfer.mockImplementationOnce(async (args: any) => {
    await made(args);
    throw new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_connection_error');
  });
}

function refundBy(h: ReturnType<typeof harness>, stripeRefundId: string): Row {
  return h.db.state.chargeRefund.find((r: Row) => r.stripe_refund_id === stripeRefundId) as Row;
}

describe('B-674-1 — webhook mirror plus local record count one Stripe reversal twice', () => {
  it('owner reconcile recorded_from_stripe after the transfer.reversed webhook records the reversal once', async () => {
    const h = await staleOwedRefund(); // Stripe holds trr_1 (122) for r-late; key expired
    await h.svc.handle(transferReversed('tr_p-late', 122, false));
    const mirrorBefore = h.headCoach('p-late'); // 122: the mirror equals Stripe
    await h.svc.retryPendingTransferReversals();
    const out = await h.svc.reconcileTransferReversal('r-late');
    expect({
      mirror_before_reconcile: mirrorBefore,
      outcome: out.outcome,
      stripe_total: h.stripeTotal('tr_p-late'),
      local_reversed: h.headCoach('p-late'),
    }).toEqual({
      mirror_before_reconcile: 122,
      outcome: 'recorded_from_stripe',
      stripe_total: 122,
      local_reversed: 122,
    });
  });

  it('a timed-out reversal retried after its webhook is counted once, and the next refund is reversed in full', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-t', at);
    const purchase = h.db.state.clientPurchase.find((p: Row) => p.id === 'p-t') as any;
    timeOutAfterStripeMadeIt(h);
    await h.svc.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: 're_t1',
      stripe_charge_id: 'ch_p-t',
      amount_cents: 2450,
      status: 'succeeded',
      reason: null,
    });
    await h.svc.handle(transferReversed('tr_p-t', h.stripeTotal('tr_p-t'), false));
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 60_000));
    const afterFirst = { stripe_total: h.stripeTotal('tr_p-t'), local_reversed: h.headCoach('p-t') };
    // The client is refunded the other half a little later.
    await h.svc.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: 're_t2',
      stripe_charge_id: 'ch_p-t',
      amount_cents: 2450,
      status: 'succeeded',
      reason: null,
    });
    const total = h.stripeTotal('tr_p-t');
    await h.svc.handle(transferReversed('tr_p-t', total, total >= 245));
    expect({
      after_first_refund: afterFirst,
      after_second_refund: { stripe_total: h.stripeTotal('tr_p-t'), local_reversed: h.headCoach('p-t') },
    }).toEqual({
      // Each half refund owes floor(245 * 2450 / 4900) = 122 back from the head coach.
      after_first_refund: { stripe_total: 122, local_reversed: 122 },
      after_second_refund: { stripe_total: 244, local_reversed: 244 },
    });
  });

  it('a full refund whose timed-out reversal lands by webhook still reverses the head-coach ledger slice', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-f', at);
    h.db.state.splitLedgerEntry.push({
      id: 'p-f-head_coach_split',
      purchase_id: 'p-f',
      kind: 'head_coach_split',
      payee_user_id: 'head-coach-1',
      amount_cents: 245,
      reversed_cents: 0,
      currency: 'usd',
      status: 'posted',
      stripe_charge_id: 'ch_p-f',
      posted_at: at,
      reversed_at: null,
      created_at: at,
      updated_at: at,
    });
    (h.db.state.connectTransfer.find((t: Row) => t.purchase_id === 'p-f') as Row).ledger_entry_id =
      'p-f-head_coach_split';
    const purchase = h.db.state.clientPurchase.find((p: Row) => p.id === 'p-f') as any;
    timeOutAfterStripeMadeIt(h);
    await h.svc.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: 're_f1',
      stripe_charge_id: 'ch_p-f',
      amount_cents: 4900,
      status: 'succeeded',
      reason: null,
    });
    await h.svc.handle(transferReversed('tr_p-f', h.stripeTotal('tr_p-f'), true));
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 60_000));
    const slice = h.db.state.splitLedgerEntry.find((e: Row) => e.id === 'p-f-head_coach_split') as Row;
    expect({
      stripe_total: h.stripeTotal('tr_p-f'),
      local_transfer_reversed: h.headCoach('p-f'),
      head_coach_slice_reversed_cents: slice.reversed_cents,
      refund_transfer_reversed: refundBy(h, 're_f1').transfer_reversed,
    }).toEqual({
      stripe_total: 245,
      local_transfer_reversed: 245,
      head_coach_slice_reversed_cents: 245,
      refund_transfer_reversed: true,
    });
  });

  it('control: the same timed-out reversal with no webhook in between is recorded once', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-c', at);
    const purchase = h.db.state.clientPurchase.find((p: Row) => p.id === 'p-c') as any;
    timeOutAfterStripeMadeIt(h);
    await h.svc.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: 're_c1',
      stripe_charge_id: 'ch_p-c',
      amount_cents: 2450,
      status: 'succeeded',
      reason: null,
    });
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 60_000));
    expect({ stripe_total: h.stripeTotal('tr_p-c'), local_reversed: h.headCoach('p-c') }).toEqual({
      stripe_total: 122,
      local_reversed: 122,
    });
  });
});

describe('B-641-12 (carried) — a reversal of another refund committed between read and write is lost', () => {
  it('ConnectTransfer.reversed_amount_cents keeps both reversals', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-x', at);
    h.db.state.chargeRefund.push(
      refundRow('r-a', 'p-x', at, { transfer_reversal_first_attempt_at: null }),
    );
    let concurrentCommitted = false;
    const made = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementationOnce(async (args: any) => {
      const out = await made(args);
      // Refund B's own reversal (100) commits while A's record transaction
      // sits between its SELECT of the transfer row and its UPDATE.
      h.db.onFirst('connectTransfer', 'findUnique', async () => {
        await Promise.resolve();
        const rows = h.db.state.connectTransfer;
        const i = rows.findIndex((t: Row) => t.id === 'tr-p-x');
        rows[i] = { ...rows[i], reversed_amount_cents: rows[i].reversed_amount_cents + 100 };
        concurrentCommitted = true;
      });
      return out;
    });
    await h.svc.retryPendingTransferReversals();
    expect({ concurrentCommitted, local_reversed: h.headCoach('p-x') }).toEqual({
      concurrentCommitted: true,
      local_reversed: 222, // 100 (refund B) + 122 (refund A)
    });
  });

  it('SplitLedgerEntry.reversed_cents keeps both refunds', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-y', at);
    const purchase = h.db.state.clientPurchase.find((p: Row) => p.id === 'p-y') as any;
    let concurrentCommitted = false;
    // The first ledger row refund A reads is application_fee (kind asc).
    h.db.onFirst('splitLedgerEntry', 'findUnique', async () => {
      await Promise.resolve();
      const rows = h.db.state.splitLedgerEntry;
      const i = rows.findIndex((e: Row) => e.id === 'p-y-application_fee');
      rows[i] = { ...rows[i], reversed_cents: rows[i].reversed_cents + 40 }; // refund B's fee share
      concurrentCommitted = true;
    });
    await h.svc.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: 're_a',
      stripe_charge_id: 'ch_p-y',
      amount_cents: 2450,
      status: 'succeeded',
      reason: null,
    });
    const fee = h.db.state.splitLedgerEntry.find((e: Row) => e.id === 'p-y-application_fee') as Row;
    expect({ concurrentCommitted, fee_reversed_cents: fee.reversed_cents }).toEqual({
      concurrentCommitted: true,
      fee_reversed_cents: 89, // 40 (refund B) + floor(98 * 2450 / 4900) = 49 (refund A)
    });
  });
});
