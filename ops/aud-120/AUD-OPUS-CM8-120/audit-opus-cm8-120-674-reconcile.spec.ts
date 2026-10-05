// AUD-OPUS-CM8-120 probe (never merge). #674 @ e35c37a1: owner reconcile of a
// refund in review whose own reversal operation was completed by another
// driver (main's stuck-reversal sweep, or a sibling refund's reverse() that
// re-drives pending operations first). The operation engine records the
// transfer total; the refund's local record (transfer_reversed + bound
// Stripe id + head-coach slice posting) is a separate transaction. Reconcile
// computes `owed` BEFORE it looks at the refund's own operation, so when that
// operation left the transfer fully reversed (status 'reversed') the refund
// is closed as nothing_owed: no posting, no bound id, owner told 0 cents.
import 'reflect-metadata';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;

function teamSale(id: string, at: Date) {
  const h = harness();
  seedPurchase(h.db, id, at);
  const fee = (h.db.state.splitLedgerEntry as Row[]).find(
    (s) => s.purchase_id === id && s.kind === 'application_fee',
  )!;
  h.db.state.splitLedgerEntry.push({
    ...fee,
    id: `${id}-head`,
    kind: 'head_coach_split',
    payee_user_id: 'head-1',
    amount_cents: 245,
  });
  (h.db.state.connectTransfer as Row[]).find((t) => t.purchase_id === id)!.ledger_entry_id =
    `${id}-head`;
  const postings = (source?: string) =>
    (h.db.state.splitLedgerReversal as Row[])
      .filter((r) => r.entry_id === `${id}-head` && (!source || r.source_id === source))
      .map((r) => r.cents);
  return { ...h, postings };
}

// Refund `rid` in review, its operation under the refund key sent once
// (attempts 1) and held by Stripe, the answer lost (op still pending).
async function inReviewWithSentOp(
  h: ReturnType<typeof teamSale>,
  pid: string,
  rid: string,
  refundCents: number,
  shareCents: number,
) {
  const at = new Date(Date.now() - 26 * HOUR);
  h.db.state.chargeRefund.push(
    refundRow(rid, pid, at, {
      amount_cents: refundCents,
      transfer_reversal_amount_cents: shareCents,
      transfer_reversal_review_at: new Date(Date.now() - HOUR),
    }),
  );
  const key = `tgp-tr-rev-refund-${rid}`;
  const t = (h.db.state.connectTransfer as Row[]).find((x) => x.purchase_id === pid)!;
  t.reversal_seq = 1;
  h.db.state.transferReversalOp.push({
    id: `op-${rid}`,
    transfer_id: t.id,
    seq: 1,
    idempotency_key: key,
    amount_cents: shareCents,
    base_reversed_cents: 0,
    purpose: 'legacy',
    status: 'pending',
    attempts: 1,
    last_attempt_at: at,
    last_error: null,
    stripe_reversal_id: null,
    resolved_at: null,
    created_at: at,
    updated_at: at,
  });
  await h.reverseTransfer({
    transfer_id: t.stripe_transfer_id,
    amount: shareCents,
    idempotencyKey: key,
    metadata: { tgp_reversal_op: key, tgp_purpose: 'legacy' },
  });
  h.reverseTransfer.mockClear();
  return t;
}

describe('AUD-OPUS-CM8-120 — reconcile a refund whose own operation another driver completed', () => {
  it('full refund: the stuck-reversal sweep completes it, then the owner reconcile records it with its posting', async () => {
    const h = teamSale('p-f', new Date(Date.now() - 27 * HOUR));
    const t = await inReviewWithSentOp(h, 'p-f', 'r-f', 4900, 245);
    // charge-settlement resolveStuckReversals: a legacy transfer's op is resolved on its own.
    await h.transfers.resolvePendingReversals(t.id);
    const out = await h.svc.reconcileTransferReversal('r-f');
    expect({
      outcome: out.outcome,
      amount: out.amount_cents,
      bound: h.refund('r-f').transfer_reversal_stripe_id,
      stripe: h.stripeTotal('tr_p-f'),
      transfer: h.headCoach('p-f'),
      postings: h.postings('r-f'),
      sent: h.reverseTransfer.mock.calls.length,
    }).toEqual({
      outcome: 'recorded_from_stripe',
      amount: 245,
      bound: 'trr_1',
      stripe: 245,
      transfer: 245,
      postings: [245],
      sent: 0,
    });
  });

  it('partial refund: a sibling refund re-drives it and fills the transfer, then the owner reconcile records it', async () => {
    const h = teamSale('p-s', new Date(Date.now() - 27 * HOUR));
    await inReviewWithSentOp(h, 'p-s', 'r-a', 2450, 122);
    // A second refund of the sale (125 share, capped at the 123 left), first attempt now.
    h.db.state.chargeRefund.push(
      refundRow('r-b', 'p-s', new Date(), {
        amount_cents: 2500,
        transfer_reversal_first_attempt_at: null,
      }),
    );
    await h.svc.retryPendingTransferReversals(new Date());
    const out = await h.svc.reconcileTransferReversal('r-a');
    expect({
      outcome: out.outcome,
      amount: out.amount_cents,
      bound: h.refund('r-a').transfer_reversal_stripe_id,
      stripe: h.stripeTotal('tr_p-s'),
      transfer: h.headCoach('p-s'),
      postings: { a: h.postings('r-a'), b: h.postings('r-b') },
    }).toEqual({
      outcome: 'recorded_from_stripe',
      amount: 122,
      bound: 'trr_1',
      stripe: 245,
      transfer: 245,
      postings: { a: [122], b: [123] },
    });
  });

  it('control: partial refund completed by the sweep, transfer not full: reconcile records it with its posting', async () => {
    const h = teamSale('p-c', new Date(Date.now() - 27 * HOUR));
    const t = await inReviewWithSentOp(h, 'p-c', 'r-c', 2450, 122);
    await h.transfers.resolvePendingReversals(t.id);
    const out = await h.svc.reconcileTransferReversal('r-c');
    expect({
      outcome: out.outcome,
      amount: out.amount_cents,
      bound: h.refund('r-c').transfer_reversal_stripe_id,
      postings: h.postings('r-c'),
      sent: h.reverseTransfer.mock.calls.length,
    }).toEqual({ outcome: 'recorded_from_stripe', amount: 122, bound: 'trr_1', postings: [122], sent: 0 });
  });
});
