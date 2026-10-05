// AUDIT PROBE (AUD-OPUS-CM1-117, Claude Opus 5.5) — backend#674 @ d9327546.
// Never merge. Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the PR's stateful double and synthetic
// Stripe (test/support/refund-reversal-harness.ts).
//
// After B-674-3 (b) the transfer.reversed webhook only observes. The refund
// path has an owner for a reversal Stripe made but the client never heard
// about (the sweep replays the refund-scoped key). The lost-chargeback
// head-coach reversal (applyHeadCoachReversal) has no claim, no key per
// dispute and no sweep: does anything record it?
import 'reflect-metadata';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;

describe('AUD-OPUS-CM1-117 #674 — lost chargeback head-coach reversal that Stripe made but the client timed out on', () => {
  it('ends with the local transfer and head-coach slice equal to Stripe', async () => {
    const h = harness();
    h.db.model('chargeDispute', [['id'], ['stripe_dispute_id']], () => ({
      ledger_reversed: false,
      closed_at: null,
    }));
    const at = new Date(Date.now() - 2 * HOUR);
    seedPurchase(h.db, 'p-d', at);
    const fee = (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === 'p-d-application_fee')!;
    h.db.state.splitLedgerEntry.push({
      ...fee,
      id: 'p-d-head',
      kind: 'head_coach_split',
      payee_user_id: 'head-1',
      amount_cents: 245,
    });
    (h.db.state.connectTransfer as Row[]).find((t) => t.id === 'tr-p-d')!.ledger_entry_id = 'p-d-head';
    h.db.state.chargeDispute.push({
      id: 'cd-1',
      stripe_dispute_id: 'dp_1',
      purchase_id: 'p-d',
      stripe_charge_id: 'ch_p-d',
      amount_cents: 4900,
      status: 'needs_response',
      ledger_reversed: false,
      closed_at: null,
      created_at: at,
      updated_at: at,
    });
    const made = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementationOnce(async (args: any) => {
      await made(args);
      throw new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_connection_error');
    });
    const closed = {
      id: 'evt_d',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost' } },
    };
    // Fix-agnostic: a fix may fail the delivery so Stripe redelivers it.
    await h.svc.handle(closed).catch(() => undefined);
    await h.svc.handle(closed).catch(() => undefined);
    // Stripe's transfer.reversed lands; then the 15-minute sweep runs.
    await h.svc.handle({
      id: 'evt_tr',
      type: 'transfer.reversed',
      data: { object: { id: 'tr_p-d', amount_reversed: h.stripeTotal('tr_p-d'), reversed: true } },
    });
    await h.svc.retryPendingTransferReversals();
    const slice = (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === 'p-d-head')!;
    expect({
      stripe_reversed: h.stripeTotal('tr_p-d'),
      local_transfer_reversed: h.headCoach('p-d'),
      head_slice_reversed: slice.reversed_cents,
      dispute_ledger_reversed: (h.db.state.chargeDispute as Row[])[0].ledger_reversed,
    }).toEqual({
      stripe_reversed: 245,
      local_transfer_reversed: 245,
      head_slice_reversed: 245,
      dispute_ledger_reversed: true,
    });
  });
});
