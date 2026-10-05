// AUD-OPUS-CM10-121 probe (never merge). #674 @ 3a07a0de, FIX ROUND 6 delta:
//   B-674-15  owner reconcile records the refund's own operation before it
//             computes what is owed: the `-review` operation too (not only the
//             refund key), when another driver completed it and filled the
//             transfer; two owners at once record it once.
//   B-674-1   the sweep's found-reversal record (reversalStripeHolds ->
//             recordFoundReversal) publishes the head slice in the same
//             transaction: a failed slice write leaves no operation, no
//             transfer total and no slice; the next sweep records it once.
//   B-674-16  a re-drive of an existing operation whose Stripe listing is
//             down is stamped with the sweep clock; the row still reaches
//             review at the window and the owner records it once Stripe reads.
import 'reflect-metadata';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type H = ReturnType<typeof harness>;
type Row = Record<string, any>;
const KEY = (rid: string) => `tgp-tr-rev-refund-${rid}`;

// A 4,900-cent sale whose 245-cent head-coach transfer mirrors slice `<pid>-head`.
function teamSale(pid: string, at = new Date(Date.now() - 27 * HOUR)): H {
  const h = harness();
  seedPurchase(h.db, pid, at);
  const fee = (h.db.state.splitLedgerEntry as Row[]).find(
    (s) => s.purchase_id === pid && s.kind === 'application_fee',
  )!;
  h.db.state.splitLedgerEntry.push({
    ...fee,
    id: `${pid}-head`,
    kind: 'head_coach_split',
    payee_user_id: 'head-1',
    amount_cents: 245,
    reversed_cents: 0,
  });
  transferOf(h, pid).ledger_entry_id = `${pid}-head`;
  return h;
}
const transferOf = (h: H, pid: string) =>
  (h.db.state.connectTransfer as Row[]).find((t) => t.purchase_id === pid)!;
const slice = (h: H, pid: string) =>
  (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === `${pid}-head`)!.reversed_cents;
const postings = (h: H, pid: string, source?: string) =>
  (h.db.state.splitLedgerReversal as Row[])
    .filter((r) => r.entry_id === `${pid}-head` && (!source || r.source_id === source))
    .map((r) => r.cents);
const money = (h: H, pid: string) => ({
  stripe: h.stripeTotal(`tr_${pid}`),
  transfer: h.headCoach(pid),
  slice: slice(h, pid),
});
const opRow = (over: Row): Row => ({
  base_reversed_cents: 0,
  purpose: 'legacy',
  attempts: 1,
  last_error: null,
  stripe_reversal_id: null,
  resolved_at: null,
  created_at: new Date(Date.now() - 2 * HOUR),
  updated_at: new Date(Date.now() - 2 * HOUR),
  last_attempt_at: new Date(Date.now() - 2 * HOUR),
  ...over,
});

describe('AUD-OPUS-CM10-121 B-674-15: the -review operation is recorded first too', () => {
  it('a -review operation a sibling re-drove (transfer now full) is recorded with its posting, not nothing_owed', async () => {
    const h = teamSale('p-r');
    const t = transferOf(h, 'p-r');
    h.db.state.chargeRefund.push(
      refundRow('r-a', 'p-r', new Date(Date.now() - 26 * HOUR), {
        amount_cents: 2450,
        transfer_reversal_amount_cents: 122,
        transfer_reversal_review_at: new Date(Date.now() - HOUR),
      }),
    );
    // The sweep's operation under the refund key was refused (balance too low);
    // the owner's first reconcile sent `-review`, Stripe made it, the answer was lost.
    t.reversal_seq = 2;
    h.db.state.transferReversalOp.push(
      opRow({ id: 'op-a', transfer_id: t.id, seq: 1, idempotency_key: KEY('r-a'), amount_cents: 122, status: 'refused', resolved_at: new Date() }),
      opRow({ id: 'op-a-review', transfer_id: t.id, seq: 2, idempotency_key: `${KEY('r-a')}-review`, amount_cents: 122, status: 'pending' }),
    );
    await h.reverseTransfer({
      transfer_id: 'tr_p-r',
      amount: 122,
      idempotencyKey: `${KEY('r-a')}-review`,
      metadata: { tgp_reversal_op: `${KEY('r-a')}-review`, tgp_purpose: 'legacy' },
    });
    h.reverseTransfer.mockClear();
    // A second refund of the sale (125 share, capped at the 123 left), first attempt now:
    // its reverse() re-drives the pending -review operation first, then fills the transfer.
    h.db.state.chargeRefund.push(
      refundRow('r-b', 'p-r', new Date(), { amount_cents: 2500, transfer_reversal_first_attempt_at: null }),
    );
    await h.svc.retryPendingTransferReversals(new Date());
    expect(money(h, 'p-r')).toEqual({ stripe: 245, transfer: 245, slice: 245 });
    const out = await h.svc.reconcileTransferReversal('r-a');
    expect({
      outcome: out.outcome,
      amount: out.amount_cents,
      id: out.stripe_transfer_reversal_id,
      bound: h.refund('r-a').transfer_reversal_stripe_id,
      reversed: h.refund('r-a').transfer_reversed,
      postings: { a: postings(h, 'p-r', 'r-a'), b: postings(h, 'p-r', 'r-b') },
      money: money(h, 'p-r'),
      sends: h.reverseTransfer.mock.calls.map(([a]) => a.amount),
    }).toEqual({
      outcome: 'recorded_from_stripe',
      amount: 122,
      id: 'trr_1',
      bound: 'trr_1',
      reversed: true,
      postings: { a: [122], b: [123] },
      money: { stripe: 245, transfer: 245, slice: 245 },
      sends: [123],
    });
  });

  it('two owners reconcile at once a refund whose own operation the sweep completed: one record, one posting', async () => {
    const h = teamSale('p-2');
    const t = transferOf(h, 'p-2');
    h.db.state.chargeRefund.push(
      refundRow('r-2', 'p-2', new Date(Date.now() - 26 * HOUR), {
        amount_cents: 4900,
        transfer_reversal_amount_cents: 245,
        transfer_reversal_review_at: new Date(Date.now() - HOUR),
      }),
    );
    t.reversal_seq = 1;
    h.db.state.transferReversalOp.push(
      opRow({ id: 'op-2', transfer_id: t.id, seq: 1, idempotency_key: KEY('r-2'), amount_cents: 245, status: 'pending' }),
    );
    await h.reverseTransfer({
      transfer_id: 'tr_p-2',
      amount: 245,
      idempotencyKey: KEY('r-2'),
      metadata: { tgp_reversal_op: KEY('r-2'), tgp_purpose: 'legacy' },
    });
    h.reverseTransfer.mockClear();
    await h.transfers.resolvePendingReversals(t.id);
    const settled = await Promise.allSettled([
      h.svc.reconcileTransferReversal('r-2'),
      h.restart().reconcileTransferReversal('r-2'),
    ]);
    const outcomes = settled
      .map((s) =>
        s.status === 'fulfilled'
          ? s.value.outcome
          : ((s.reason as any)?.response?.code ?? String(s.reason)),
      )
      .sort();
    expect(outcomes[1]).toBe('recorded_from_stripe');
    expect(['already_recorded', 'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED']).toContain(outcomes[0]);
    expect({
      postings: postings(h, 'p-2'),
      bound: h.refund('r-2').transfer_reversal_stripe_id,
      money: money(h, 'p-2'),
      sends: h.reverseTransfer.mock.calls.length,
    }).toEqual({
      postings: [245],
      bound: 'trr_1',
      money: { stripe: 245, transfer: 245, slice: 245 },
      sends: 0,
    });
  });
});

describe('AUD-OPUS-CM10-121 B-674-1: the sweep found-record publishes the slice in its transaction', () => {
  it('a failed slice write leaves nothing recorded; the next sweep records 122/122/122 once, no send', async () => {
    const h = teamSale('p-h', new Date(Date.now() - 2 * HOUR));
    // Attempt stamped, then a stop before the operation; Stripe holds a legacy reversal for it.
    h.db.state.chargeRefund.push(
      refundRow('r-h', 'p-h', new Date(Date.now() - HOUR), {
        amount_cents: 2450,
        transfer_reversal_amount_cents: 122,
      }),
    );
    h.reversals.push({ id: 'trr_found_h', transfer: 'tr_p-h', amount: 122, metadata: { tgp_charge_refund_id: 'r-h' } });
    const real = h.db.splitLedgerEntry.update.bind(h.db.splitLedgerEntry);
    let armed = true;
    h.db.splitLedgerEntry.update = jest.fn(async (a: Row) => {
      if (armed && a?.where?.id === 'p-h-head') {
        armed = false;
        throw new Error('synthetic database write failure');
      }
      return real(a);
    });
    const now1 = new Date();
    await h.svc.retryPendingTransferReversals(now1);
    expect({
      armed,
      ops: (h.db.state.transferReversalOp as Row[]).length,
      money: money(h, 'p-h'),
      postings: postings(h, 'p-h'),
      reversed: h.refund('r-h').transfer_reversed,
    }).toEqual({
      armed: false,
      ops: 0,
      money: { stripe: 122, transfer: 0, slice: 0 },
      postings: [],
      reversed: false,
    });
    await h.svc.retryPendingTransferReversals(new Date(now1.getTime() + 60_000));
    expect({
      ops: (h.db.state.transferReversalOp as Row[]).map((o) => [o.idempotency_key, o.status, o.stripe_reversal_id]),
      money: money(h, 'p-h'),
      postings: postings(h, 'p-h', 'r-h'),
      reversed: h.refund('r-h').transfer_reversed,
      bound: h.refund('r-h').transfer_reversal_stripe_id,
      sends: h.reverseTransfer.mock.calls.length,
    }).toEqual({
      ops: [[KEY('r-h'), 'succeeded', 'trr_found_h']],
      money: { stripe: 122, transfer: 122, slice: 122 },
      postings: [122],
      reversed: true,
      bound: 'trr_found_h',
      sends: 0,
    });
  });
});

describe('AUD-OPUS-CM10-121 B-674-16: a re-drive with Stripe unreadable is stamped and still reaches review', () => {
  it('stamped at the sweep clock, moved to review at the window, then the owner records it once Stripe reads', async () => {
    const h = teamSale('p-u', new Date(Date.now() - 2 * HOUR));
    const t = transferOf(h, 'p-u');
    h.db.state.chargeRefund.push(
      refundRow('r-u', 'p-u', new Date(Date.now() - HOUR), {
        amount_cents: 2450,
        transfer_reversal_amount_cents: 122,
        transfer_reversal_last_attempt_at: null,
      }),
    );
    t.reversal_seq = 1;
    h.db.state.transferReversalOp.push(
      opRow({ id: 'op-u', transfer_id: t.id, seq: 1, idempotency_key: KEY('r-u'), amount_cents: 122, status: 'pending' }),
    );
    await h.reverseTransfer({
      transfer_id: 'tr_p-u',
      amount: 122,
      idempotencyKey: KEY('r-u'),
      metadata: { tgp_reversal_op: KEY('r-u'), tgp_purpose: 'legacy' },
    });
    h.reverseTransfer.mockClear();
    const list = (h.svc as any).stripe.listTransferReversals as jest.Mock;
    const realList = list.getMockImplementation()!;
    list.mockImplementation(async () => {
      throw new Error('stripe unavailable');
    });
    const now1 = new Date();
    const first = await h.svc.retryPendingTransferReversals(now1);
    const stamp = h.refund('r-u').transfer_reversal_last_attempt_at as Date | null;
    expect({
      retried: first.retried,
      stamped: stamp instanceof Date && stamp.getTime() >= now1.getTime(),
      money: money(h, 'p-u'),
      sends: h.reverseTransfer.mock.calls.length,
    }).toEqual({ retried: 1, stamped: true, money: { stripe: 122, transfer: 0, slice: 0 }, sends: 0 });
    // A second pass inside the same run window pages past it (stamp >= now1).
    const again = await h.svc.retryPendingTransferReversals(now1);
    expect(again.retried).toBe(0);
    const later = await h.svc.retryPendingTransferReversals(new Date(now1.getTime() + 24 * HOUR));
    expect([later.needs_review, later.in_review, !!h.refund('r-u').transfer_reversal_review_at]).toEqual([1, 1, true]);
    await expect(h.svc.reconcileTransferReversal('r-u')).rejects.toMatchObject({
      response: { code: 'TRANSFER_REVERSAL_UNCERTAIN' },
    });
    expect([h.refund('r-u').transfer_reversed, postings(h, 'p-u')]).toEqual([false, []]);
    list.mockImplementation(realList);
    const out = await h.svc.reconcileTransferReversal('r-u');
    expect({
      outcome: out.outcome,
      amount: out.amount_cents,
      bound: h.refund('r-u').transfer_reversal_stripe_id,
      postings: postings(h, 'p-u', 'r-u'),
      money: money(h, 'p-u'),
      sends: h.reverseTransfer.mock.calls.length,
    }).toEqual({
      outcome: 'recorded_from_stripe',
      amount: 122,
      bound: 'trr_1',
      postings: [122],
      money: { stripe: 122, transfer: 122, slice: 122 },
      sends: 0,
    });
  });
});
