// #674 FIX ROUND 6 (B-CM9-120) regressions, over the real handler, ledger and
// orchestrator on the stateful double (only Stripe is synthetic):
//   B-674-1  the head-coach slice is published in the transaction that records
//            the transfer total (failed mirror, held older mirror, found record);
//   B-674-15 owner reconcile records the refund's own operation before anything
//            owed (full refund finished elsewhere, sibling fill, found receipt
//            whose posting rolled back, a receipt another refund holds);
//   B-674-16 a re-drive of an existing operation is stamped, so restarted
//            bounded sweeps reach every owed refund.
import 'reflect-metadata';
import type { ClientPurchase } from '@prisma/client';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type H = ReturnType<typeof harness>;
type Row = Record<string, any>;

// A 4,900-cent sale whose 245-cent head-coach transfer mirrors slice `<id>-head`.
function team(h: H, id: string, at = new Date(Date.now() - HOUR)) {
  seedPurchase(h.db, id, at);
  const fee = (h.db.state.splitLedgerEntry as Row[]).find((s) => s.purchase_id === id)!;
  h.db.state.splitLedgerEntry.push({
    ...fee,
    id: `${id}-head`,
    kind: 'head_coach_split',
    payee_user_id: 'head-1',
    amount_cents: 245,
    reversed_cents: 0,
  });
  transferOf(h, id).ledger_entry_id = `${id}-head`;
}
const transferOf = (h: H, id: string) =>
  (h.db.state.connectTransfer as Row[]).find((t) => t.purchase_id === id)!;
const slice = (h: H, id: string) =>
  (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === `${id}-head`)!.reversed_cents;
const postings = (h: H, id: string, source?: string) =>
  (h.db.state.splitLedgerReversal as Row[])
    .filter((s) => s.entry_id === `${id}-head` && (!source || s.source_id === source))
    .map((s) => s.cents);
const money = (h: H, id: string) => ({
  stripe: h.stripeTotal(`tr_${id}`),
  transfer: h.headCoach(id),
  slice: slice(h, id),
  postings: postings(h, id),
});
const sends = (h: H) => h.reverseTransfer.mock.calls.map(([a]) => a.amount);

function refund(h: H, id: string) {
  return h.svc.upsertAndApplyRefund({
    purchase: (h.db.state.clientPurchase as Row[]).find((p) => p.id === id) as ClientPurchase,
    stripe_refund_id: `re_${id}`,
    stripe_charge_id: `ch_${id}`,
    amount_cents: 2450,
    status: 'succeeded',
    reason: null,
  });
}

// The first write of `model` matching `when` fails, as a database error would.
function failOnce(h: H, model: 'splitLedgerEntry' | 'splitLedgerReversal', op: string, when: (a: Row) => boolean) {
  const real = h.db[model][op].bind(h.db[model]);
  let armed = true;
  h.db[model][op] = jest.fn(async (a: Row) => {
    if (armed && when(a)) {
      armed = false;
      throw new Error('synthetic database write failure');
    }
    return real(a);
  });
}

// Refund `r-<id>` in review; Stripe holds `held` cents for it (legacy metadata).
function inReviewHeld(h: H, id: string, refundCents: number, held: number) {
  h.db.state.chargeRefund.push(
    refundRow(`r-${id}`, id, new Date(Date.now() - HOUR), {
      amount_cents: refundCents,
      transfer_reversal_amount_cents: Math.floor((245 * refundCents) / 4900),
      transfer_reversal_review_at: new Date(),
    }),
  );
  h.reversals.push({
    id: `trr_found_${id}`,
    transfer: `tr_${id}`,
    amount: held,
    metadata: { tgp_charge_refund_id: `r-${id}` },
  });
}

// Refund `rid` in review; its operation under the refund key was sent once and
// Stripe holds it, the answer lost (operation still pending).
async function inReviewSentOp(h: H, pid: string, rid: string, refundCents: number, share: number) {
  const at = new Date(Date.now() - 26 * HOUR);
  h.db.state.chargeRefund.push(
    refundRow(rid, pid, at, {
      amount_cents: refundCents,
      transfer_reversal_amount_cents: share,
      transfer_reversal_review_at: new Date(Date.now() - HOUR),
    }),
  );
  const key = `tgp-tr-rev-refund-${rid}`;
  const t = transferOf(h, pid);
  t.reversal_seq = 1;
  h.db.state.transferReversalOp.push({
    ...{ id: `op-${rid}`, transfer_id: t.id, seq: 1, idempotency_key: key, amount_cents: share },
    ...{ base_reversed_cents: 0, purpose: 'legacy', status: 'pending', attempts: 1 },
    ...{ last_attempt_at: at, last_error: null, stripe_reversal_id: null, resolved_at: null },
    ...{ created_at: at, updated_at: at },
  });
  await h.reverseTransfer({
    transfer_id: t.stripe_transfer_id,
    amount: share,
    idempotencyKey: key,
    metadata: { tgp_reversal_op: key, tgp_purpose: 'legacy' },
  });
  h.reverseTransfer.mockClear();
  return t;
}

describe('B-674-1: the head slice is published with the operation that records it', () => {
  it('a failed slice write rolls the operation back; the redelivery records 122/122/122 once, one send', async () => {
    const h = harness();
    team(h, 'mf');
    failOnce(h, 'splitLedgerEntry', 'update', (a) => a.where.id === 'mf-head' && a.data.reversed_cents === 122);
    await refund(h, 'mf');
    const op = () => (h.db.state.transferReversalOp as Row[])[0];
    const afterFailure = { ...money(h, 'mf'), op: op().status, done: h.db.state.chargeRefund[0].transfer_reversed };
    await refund(h, 'mf');
    expect(afterFailure).toEqual({ stripe: 122, transfer: 0, slice: 0, postings: [], op: 'pending', done: false });
    expect(money(h, 'mf')).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect([op().status, h.db.state.chargeRefund[0].transfer_reversed, sends(h)]).toEqual(['succeeded', true, [122]]);
  });

  it('a held older slice write: the next reversal waits for its transaction, then both count (150/150/150)', async () => {
    const h = harness();
    team(h, 'mo');
    let entered!: () => void;
    let release!: () => void;
    const isEntered = new Promise<void>((r) => (entered = r));
    const released = new Promise<void>((r) => (release = r));
    const update = h.db.splitLedgerEntry.update.bind(h.db.splitLedgerEntry);
    let held = false;
    h.db.splitLedgerEntry.update = jest.fn(async (a: Row) => {
      if (!held && a.where.id === 'mo-head' && a.data.reversed_cents === 100) {
        held = true;
        entered();
        await released;
      }
      return update(a);
    });
    const reverse = (key: string, amount: number) =>
      h.transfers.reverse({ transfer_row_id: 'tr-mo', amount_cents: amount, idempotency_key: key, purpose: 'legacy' });
    const first = reverse('tgp-tr-rev-refund-mo-a', 100);
    await isEntered;
    const second = reverse('tgp-tr-rev-refund-mo-b', 50);
    for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
    const during = { sends: sends(h), slice: slice(h, 'mo') };
    release();
    await Promise.all([first, second]);
    expect(during).toEqual({ sends: [100], slice: 0 });
    expect(money(h, 'mo')).toMatchObject({ stripe: 150, transfer: 150, slice: 150 });
    expect(sends(h)).toEqual([100, 50]);
  });

  it('a found reversal whose slice write failed: the owner retry records 122/122/122 and its receipt, no send', async () => {
    const h = harness();
    team(h, 'ff');
    inReviewHeld(h, 'ff', 2450, 122);
    failOnce(h, 'splitLedgerEntry', 'update', (a) => a.where.id === 'ff-head');
    await expect(h.svc.reconcileTransferReversal('r-ff')).rejects.toThrow('synthetic database write failure');
    const afterFailure = { ...money(h, 'ff'), ops: h.db.state.transferReversalOp.length };
    const out = await h.restart().reconcileTransferReversal('r-ff');
    expect(afterFailure).toEqual({ stripe: 122, transfer: 0, slice: 0, postings: [], ops: 0 });
    expect(out).toMatchObject({ outcome: 'recorded_from_stripe', amount_cents: 122 });
    expect(money(h, 'ff')).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect(h.refund('r-ff')).toMatchObject({ transfer_reversed: true, transfer_reversal_stripe_id: 'trr_found_ff' });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
  });

  it('control: an ordinary refund mirrors and posts the head share once; a redelivery changes nothing', async () => {
    const h = harness();
    team(h, 'ok');
    await refund(h, 'ok');
    await refund(h, 'ok');
    expect(money(h, 'ok')).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect(sends(h)).toEqual([122]);
  });
});

describe('B-674-15: owner reconcile records the refund\'s own operation before anything owed', () => {
  it('a full found reversal whose source posting rolled back: the retry records 245 and its receipt, no send', async () => {
    const h = harness();
    team(h, 'fp');
    inReviewHeld(h, 'fp', 4900, 245);
    failOnce(h, 'splitLedgerReversal', 'create', (a) => a.data.entry_id === 'fp-head');
    await expect(h.svc.reconcileTransferReversal('r-fp')).rejects.toThrow('synthetic database write failure');
    expect(h.refund('r-fp').transfer_reversed).toBe(false);
    const out = await h.restart().reconcileTransferReversal('r-fp');
    expect(out).toEqual({
      charge_refund_id: 'r-fp',
      outcome: 'recorded_from_stripe',
      stripe_transfer_reversal_id: 'trr_found_fp',
      amount_cents: 245,
    });
    expect(money(h, 'fp')).toEqual({ stripe: 245, transfer: 245, slice: 245, postings: [245] });
    expect(h.refund('r-fp')).toMatchObject({ transfer_reversed: true, transfer_reversal_stripe_id: 'trr_found_fp' });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
  });

  it('a full refund whose operation the stuck-reversal sweep completed is recorded with its posting', async () => {
    const h = harness();
    team(h, 'pf', new Date(Date.now() - 27 * HOUR));
    const t = await inReviewSentOp(h, 'pf', 'r-f', 4900, 245);
    await h.transfers.resolvePendingReversals(t.id);
    const out = await h.svc.reconcileTransferReversal('r-f');
    expect([out.outcome, out.amount_cents, h.refund('r-f').transfer_reversal_stripe_id]).toEqual([
      'recorded_from_stripe',
      245,
      'trr_1',
    ]);
    expect(money(h, 'pf')).toEqual({ stripe: 245, transfer: 245, slice: 245, postings: [245] });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
  });

  it('a partial refund whose operation a sibling refund re-drove (transfer now full) is recorded', async () => {
    const h = harness();
    team(h, 'ps', new Date(Date.now() - 27 * HOUR));
    await inReviewSentOp(h, 'ps', 'r-a', 2450, 122);
    h.db.state.chargeRefund.push(
      refundRow('r-b', 'ps', new Date(), { amount_cents: 2500, transfer_reversal_first_attempt_at: null }),
    );
    await h.svc.retryPendingTransferReversals(new Date());
    const out = await h.svc.reconcileTransferReversal('r-a');
    expect([out.outcome, out.amount_cents, h.refund('r-a').transfer_reversal_stripe_id]).toEqual([
      'recorded_from_stripe',
      122,
      'trr_1',
    ]);
    expect({ a: postings(h, 'ps', 'r-a'), b: postings(h, 'ps', 'r-b'), ...money(h, 'ps') }).toMatchObject({
      a: [122],
      b: [123],
      stripe: 245,
      transfer: 245,
      slice: 245,
    });
  });

  it('a found receipt another refund holds is not this refund\'s: the owner records the receipt named now', async () => {
    const h = harness();
    team(h, 'pe');
    inReviewHeld(h, 'pe', 2450, 122);
    h.reversals.length = 0;
    h.reversals.push(
      { id: 'trr_x', transfer: 'tr_pe', amount: 122, metadata: {} },
      { id: 'trr_y', transfer: 'tr_pe', amount: 122, metadata: {} },
    );
    // A recorded trr_x first (its claim then lost to B, which holds trr_x).
    const t = transferOf(h, 'pe');
    Object.assign(t, { reversal_seq: 1, reversed_amount_cents: 122 });
    (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === 'pe-head')!.reversed_cents = 122;
    h.db.state.transferReversalOp.push({
      ...{ id: 'op-x', transfer_id: t.id, seq: 1, idempotency_key: 'tgp-tr-rev-refund-r-pe-found-trr_x' },
      ...{ amount_cents: 122, base_reversed_cents: 0, purpose: 'legacy', status: 'succeeded' },
      ...{ attempts: 0, last_attempt_at: null, stripe_reversal_id: 'trr_x', resolved_at: new Date() },
    });
    h.db.state.chargeRefund.push(
      refundRow('r-pe-b', 'pe', new Date(Date.now() - HOUR), {
        transfer_reversed: true,
        transfer_reversal_stripe_id: 'trr_x',
      }),
    );
    const out = await h.svc.reconcileTransferReversal('r-pe', { stripe_transfer_reversal_id: 'trr_y' });
    expect(out).toMatchObject({ outcome: 'recorded_from_stripe', stripe_transfer_reversal_id: 'trr_y', amount_cents: 122 });
    expect(money(h, 'pe')).toEqual({ stripe: 244, transfer: 244, slice: 244, postings: [122] });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
  });

  it('control: a partial refund completed by the sweep (transfer not full) is recorded once', async () => {
    const h = harness();
    team(h, 'pc', new Date(Date.now() - 27 * HOUR));
    const t = await inReviewSentOp(h, 'pc', 'r-c', 2450, 122);
    await h.transfers.resolvePendingReversals(t.id);
    const out = await h.svc.reconcileTransferReversal('r-c');
    expect([out.outcome, out.amount_cents, postings(h, 'pc', 'r-c')]).toEqual(['recorded_from_stripe', 122, [122]]);
    await expect(h.svc.reconcileTransferReversal('r-c')).rejects.toMatchObject({
      response: { code: 'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED' },
    });
    expect(postings(h, 'pc')).toEqual([122]);
  });

  it('control: an ordinary full found reversal records 245 and its receipt without sending', async () => {
    const h = harness();
    team(h, 'fo');
    inReviewHeld(h, 'fo', 4900, 245);
    const out = await h.svc.reconcileTransferReversal('r-fo');
    expect(out.outcome).toBe('recorded_from_stripe');
    expect(money(h, 'fo')).toEqual({ stripe: 245, transfer: 245, slice: 245, postings: [245] });
    expect(h.refund('r-fo').transfer_reversal_stripe_id).toBe('trr_found_fo');
    expect(h.reverseTransfer).not.toHaveBeenCalled();
  });
});

describe('B-674-16: a re-drive of an existing operation is an attempt the sweep pages past', () => {
  it('21 refunds with failing pending operations, limit 1: two restarted sweeps reach the recoverable 21st', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 21; i++) {
      const n = String(i).padStart(3, '0');
      const p = `fair-${n}`;
      seedPurchase(h.db, p, at);
      h.db.state.chargeRefund.push(
        refundRow(`r-${n}`, p, at, {
          transfer_reversal_last_attempt_at: new Date(at.getTime() + i),
          transfer_reversal_amount_cents: 122,
        }),
      );
      h.db.state.transferReversalOp.push({
        ...{ id: `op-${n}`, transfer_id: `tr-${p}`, seq: 1, idempotency_key: `tgp-tr-rev-refund-r-${n}` },
        ...{ amount_cents: 122, base_reversed_cents: 0, purpose: 'legacy', status: 'pending', attempts: 1 },
        ...{ last_attempt_at: at, stripe_reversal_id: null, created_at: at, resolved_at: null, last_error: null },
      });
      transferOf(h, p).reversal_seq = 1;
    }
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (a) => {
      if (a.transfer_id !== 'tr_fair-020') throw new Error('synthetic persistent provider outage');
      return provider(a);
    });
    const first = await h.svc.retryPendingTransferReversals(new Date(), 1);
    const reached = new Set(h.reverseTransfer.mock.calls.map(([a]) => a.transfer_id));
    await h.restart().retryPendingTransferReversals(new Date(Date.now() + 15 * 60_000), 1);
    expect([first.retried, reached.size]).toEqual([20, 20]);
    const stamped = h.refund('r-000').transfer_reversal_last_attempt_at as Date;
    expect(stamped.getTime()).toBeGreaterThan(at.getTime() + 20);
    expect([h.stripeTotal('tr_fair-020'), h.headCoach('fair-020'), h.refund('r-020').transfer_reversed]).toEqual([
      122,
      122,
      true,
    ]);
  });
});
