import 'reflect-metadata';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type H = ReturnType<typeof harness>;
function team(h: H, id: string, refundAmount: number) {
  const at = new Date(Date.now() - HOUR);
  seedPurchase(h.db, id, at);
  const fee = h.db.state.splitLedgerEntry.find((s) => s.purchase_id === id)!;
  h.db.state.splitLedgerEntry.push({
    ...fee, id: `${id}-head`, kind: 'head_coach_split', payee_user_id: 'head-1',
    amount_cents: 245, reversed_cents: 0,
  });
  h.db.state.connectTransfer.find((t) => t.purchase_id === id)!.ledger_entry_id = `${id}-head`;
  h.db.state.chargeRefund.push(refundRow(`r-${id}`, id, at, {
    amount_cents: refundAmount,
    transfer_reversal_amount_cents: Math.floor(245 * refundAmount / 4900),
    transfer_reversal_review_at: new Date(),
  }));
}
function state(h: H, id: string) {
  return {
    stripe: h.stripeTotal(`tr_${id}`), transfer: h.headCoach(id),
    slice: h.db.state.splitLedgerEntry.find((s) => s.id === `${id}-head`)!.reversed_cents,
    postings: h.db.state.splitLedgerReversal.filter((s) => s.entry_id === `${id}-head`).map((s) => s.cents),
    done: h.refund(`r-${id}`).transfer_reversed,
    receipt: h.refund(`r-${id}`).transfer_reversal_stripe_id,
  };
}
function held(h: H, id: string, amount: number) {
  h.reversals.push({
    id: `trr_found_${id}`, transfer: `tr_${id}`, amount,
    metadata: { tgp_charge_refund_id: `r-${id}` },
  });
}

describe('Sol CM8 — owner found-reversal and final-source recovery', () => {
  it('a found-reversal operation whose mirror write failed must repair the slice before terminal success', async () => {
    const h = harness();
    team(h, 'found-fail', 2450);
    held(h, 'found-fail', 122);
    const update = h.db.splitLedgerEntry.update.bind(h.db.splitLedgerEntry);
    let fail = true;
    h.db.splitLedgerEntry.update = jest.fn(async (args) => {
      if (fail && args.where.id === 'found-fail-head') {
        fail = false;
        throw new Error('synthetic database mirror failure');
      }
      return update(args);
    });
    const first = await h.svc.reconcileTransferReversal('r-found-fail').catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    const afterFailure = state(h, 'found-fail');
    const second = await h.restart().reconcileTransferReversal('r-found-fail');
    const afterRetry = state(h, 'found-fail');
    console.log('AUDIT_CM8_FOUND_MIRROR', JSON.stringify({ afterFailure, second, afterRetry }));
    expect(afterFailure.done).toBe(false);
    expect(afterRetry).toEqual({
      stripe: 122, transfer: 122, slice: 122, postings: [122], done: true, receipt: 'trr_found_found-fail',
    });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(0);
  });

  it('a full found reversal with failed source posting must recover its posting and receipt on owner retry', async () => {
    const h = harness();
    team(h, 'full-post', 4900);
    held(h, 'full-post', 245);
    const create = h.db.splitLedgerReversal.create.bind(h.db.splitLedgerReversal);
    let fail = true;
    h.db.splitLedgerReversal.create = jest.fn(async (args) => {
      if (fail && args.data.entry_id === 'full-post-head') {
        fail = false;
        throw new Error('synthetic source posting failure');
      }
      return create(args);
    });
    const first = await h.svc.reconcileTransferReversal('r-full-post').catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    const afterFailure = state(h, 'full-post');
    const second = await h.restart().reconcileTransferReversal('r-full-post');
    const afterRetry = state(h, 'full-post');
    console.log('AUDIT_CM8_FULL_POST_RECOVERY', JSON.stringify({ afterFailure, second, afterRetry }));
    expect(afterFailure.done).toBe(false);
    expect(second.outcome).toBe('recorded_from_stripe');
    expect(afterRetry).toEqual({
      stripe: 245, transfer: 245, slice: 245, postings: [245], done: true, receipt: 'trr_found_full-post',
    });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(0);
  });

  it('control: ordinary full found reversal records all cents and its receipt without sending', async () => {
    const h = harness();
    team(h, 'full-ok', 4900);
    held(h, 'full-ok', 245);
    const result = await h.svc.reconcileTransferReversal('r-full-ok');
    expect(result.outcome).toBe('recorded_from_stripe');
    expect(state(h, 'full-ok')).toEqual({
      stripe: 245, transfer: 245, slice: 245, postings: [245], done: true, receipt: 'trr_found_full-ok',
    });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(0);
  });
});
