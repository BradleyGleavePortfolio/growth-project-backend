import 'reflect-metadata';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type H = ReturnType<typeof harness>;
function team(h: H, id: string) {
  const at = new Date(Date.now() - HOUR);
  seedPurchase(h.db, id, at);
  const fee = h.db.state.splitLedgerEntry.find((s) => s.purchase_id === id)!;
  h.db.state.splitLedgerEntry.push({
    ...fee, id: `${id}-head`, kind: 'head_coach_split', payee_user_id: 'head-1',
    amount_cents: 245, reversed_cents: 0,
  });
  h.db.state.connectTransfer.find((t) => t.purchase_id === id)!.ledger_entry_id = `${id}-head`;
}
function snapshot(h: H, id: string) {
  return {
    stripe: h.stripeTotal(`tr_${id}`),
    transfer: h.headCoach(id),
    slice: h.db.state.splitLedgerEntry.find((s) => s.id === `${id}-head`)!.reversed_cents,
    postings: h.db.state.splitLedgerReversal.filter((s) => s.entry_id === `${id}-head`).map((s) => s.cents),
    refunds: h.db.state.chargeRefund.filter((r) => r.purchase_id === id).map((r) => r.transfer_reversed),
  };
}
function refund(h: H, id: string) {
  return h.svc.upsertAndApplyRefund({
    purchase: h.db.state.clientPurchase.find((p) => p.id === id) as any,
    stripe_refund_id: `re_${id}`,
    stripe_charge_id: `ch_${id}`,
    amount_cents: 2450, status: 'succeeded', reason: null,
  });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('Sol CM8 — operation/ledger recovery and durable refund fairness', () => {
  it('a head-slice write failure must not become terminal with stale money after redelivery', async () => {
    const h = harness();
    team(h, 'mirror-fail');
    const update = h.db.splitLedgerEntry.update.bind(h.db.splitLedgerEntry);
    let fail = true;
    h.db.splitLedgerEntry.update = jest.fn(async (args) => {
      if (fail && args.where.id === 'mirror-fail-head' && args.data.reversed_cents === 122) {
        fail = false;
        throw new Error('synthetic database write failure');
      }
      return update(args);
    });
    await refund(h, 'mirror-fail');
    const afterFailure = snapshot(h, 'mirror-fail');
    await refund(h, 'mirror-fail');
    const afterRetry = snapshot(h, 'mirror-fail');
    console.log('AUDIT_CM8_MIRROR_FAILURE', JSON.stringify({ afterFailure, afterRetry, sends: h.reverseTransfer.mock.calls.length }));
    expect(afterFailure.refunds).toEqual([false]);
    expect(afterRetry).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122], refunds: [true] });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
  });

  it('a completed older operation may not overwrite the newer ledger mirror after its await', async () => {
    const h = harness();
    team(h, 'mirror-order');
    const entered = gate(), release = gate();
    const update = h.db.splitLedgerEntry.update.bind(h.db.splitLedgerEntry);
    let held = false;
    h.db.splitLedgerEntry.update = jest.fn(async (args) => {
      if (!held && args.where.id === 'mirror-order-head' && args.data.reversed_cents === 100) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return update(args);
    });
    const reverse = (key: string, amount: number) => h.transfers.reverse({
      transfer_row_id: 'tr-mirror-order', amount_cents: amount,
      idempotency_key: key, purpose: 'legacy',
    });
    const first = reverse('tgp-tr-rev-refund-order-a', 100);
    await entered.promise;
    await reverse('tgp-tr-rev-refund-order-b', 50);
    const beforeRelease = snapshot(h, 'mirror-order');
    release.resolve();
    await first;
    const afterRelease = snapshot(h, 'mirror-order');
    console.log('AUDIT_CM8_MIRROR_ORDER', JSON.stringify({ beforeRelease, afterRelease }));
    expect(beforeRelease.slice).toBe(150);
    expect(afterRelease).toMatchObject({ stripe: 150, transfer: 150, slice: 150 });
  });

  it('bounded restarted sweeps must advance past existing pending refund operations', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 21; i++) {
      const id = String(i).padStart(3, '0'), p = `fair-${id}`, r = `r-${id}`;
      seedPurchase(h.db, p, at);
      h.db.state.chargeRefund.push(refundRow(r, p, at, {
        transfer_reversal_last_attempt_at: new Date(at.getTime() + i),
        transfer_reversal_amount_cents: 122,
      }));
      h.db.state.transferReversalOp.push({
        id: `op-${id}`, transfer_id: `tr-${p}`, seq: 1,
        idempotency_key: `tgp-tr-rev-refund-${r}`, amount_cents: 122,
        base_reversed_cents: 0, purpose: 'legacy', status: 'pending',
        attempts: 1, last_attempt_at: at, stripe_reversal_id: null,
        created_at: at, resolved_at: null, last_error: null,
      });
      h.db.state.connectTransfer.find((t) => t.purchase_id === p)!.reversal_seq = 1;
    }
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (args) => {
      if (args.transfer_id !== 'tr_fair-020') throw new Error('synthetic persistent provider outage');
      return provider(args);
    });
    const first = await h.svc.retryPendingTransferReversals(new Date(), 1);
    const second = await h.restart().retryPendingTransferReversals(new Date(Date.now() + 15 * 60_000), 1);
    const result = {
      first, second,
      reached: [...new Set(h.reverseTransfer.mock.calls.map(([a]) => a.transfer_id))],
      recoverableStripe: h.stripeTotal('tr_fair-020'),
      recoverableLocal: h.headCoach('fair-020'),
      firstLastAttempt: h.refund('r-000').transfer_reversal_last_attempt_at,
    };
    console.log('AUDIT_CM8_REFUND_FAIRNESS', JSON.stringify(result));
    expect(result.recoverableStripe).toBe(122);
    expect(result.recoverableLocal).toBe(122);
    expect(h.refund('r-020').transfer_reversed).toBe(true);
  });

  it('control: an ordinary successful reversal mirrors and posts the head share once', async () => {
    const h = harness();
    team(h, 'control');
    await refund(h, 'control');
    await refund(h, 'control');
    expect(snapshot(h, 'control')).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122], refunds: [true] });
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
  });
});
