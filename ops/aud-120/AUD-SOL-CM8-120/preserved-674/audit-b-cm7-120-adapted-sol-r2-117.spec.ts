// B-CM7-120 ADAPTED REPLAY (never merge): minimal changes to run the original probe's intent on the
// op engine; every change is marked 'B-CM7-120 adaptation'.
import 'reflect-metadata';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function team(h: ReturnType<typeof harness>, id: string, at: Date) {
  seedPurchase(h.db, id, at);
  const fee = h.db.state.splitLedgerEntry.find((s) => s.purchase_id === id && s.kind === 'application_fee')!;
  h.db.state.splitLedgerEntry.push({
    ...fee, id: `${id}-head`, kind: 'head_coach_split', payee_user_id: 'head-1',
    amount_cents: 245,
  });
  h.db.state.connectTransfer.find((t) => t.purchase_id === id)!.ledger_entry_id = `${id}-head`;
}
function dispute(h: ReturnType<typeof harness>, id: string, purchase: string, at: Date, attempted = false) {
  h.db.state.chargeDispute.push({
    id, stripe_dispute_id: `dp_${id}`, purchase_id: purchase, stripe_charge_id: `ch_${purchase}`,
    amount_cents: 2450, status: attempted ? 'lost' : 'needs_response',
    ledger_reversed: attempted, closed_at: attempted ? at : null,
    transfer_reversal_amount_cents: attempted ? 122 : null,
    transfer_reversal_first_attempt_at: attempted ? at : null,
    transfer_reversed_at: null, transfer_reversal_stripe_id: null,
    created_at: at, updated_at: at,
  });
}
const closed = (id: string, event: string) => ({
  id: event, type: 'charge.dispute.closed', data: { object: { id: `dp_${id}`, status: 'lost' } },
});
afterEach(() => jest.useRealTimers());

describe('Sol R2 agent 117 — independent new dispute boundaries', () => {
  it('new lost-dispute paging must reach recoverable work across bounded sweeps', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 21; i++) {
      const id = String(i).padStart(3, '0');
      team(h, `p-${id}`, at);
      dispute(h, `d-${id}`, `p-${id}`, at, true);
    }
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (args) => {
      if (args.transfer_id !== 'tr_p-020') throw new Error('synthetic persistent provider failure');
      return provider(args);
    });
    const first = await h.svc.retryPendingTransferReversals(new Date(), 1);
    const second = await h.svc.retryPendingTransferReversals(new Date(Date.now() + HOUR), 1);
    const result = {
      first, second,
      reached: h.reverseTransfer.mock.calls.map(([a]) => a.transfer_id),
      recoverableStripe: h.stripeTotal('tr_p-020'),
      recoverableLocal: h.headCoach('p-020'),
    };
    console.log('AUDIT_R2_DISPUTE_FAIRNESS', JSON.stringify(result));
    expect(result.recoverableStripe).toBe(122);
    expect(result.recoverableLocal).toBe(122);
  });

  it('overlapping first-close snapshots must preserve one canonical closed_at and posting time', async () => {
    const t0 = new Date('2027-03-20T23:59:59.999Z');
    const t1 = new Date(t0.getTime() + 1);
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(t0);
    const h = harness();
    team(h, 'p-clock', new Date(t0.getTime() - HOUR));
    dispute(h, 'd-clock', 'p-clock', new Date(t0.getTime() - HOUR));
    const enteredA = gate(), enteredB = gate(), allowA = gate(), allowB = gate();
    const update = h.db.chargeDispute.update.bind(h.db.chargeDispute);
    let closes = 0;
    h.db.chargeDispute.update = jest.fn(async (args) => {
      if (args.data.closed_at) {
        if (++closes === 1) { enteredA.resolve(); await allowA.promise; }
        else { enteredB.resolve(); await allowB.promise; }
      }
      return update(args);
    });
    const a = h.svc.handle(closed('d-clock', 'evt_a'));
    await enteredA.promise; // A has read closed_at=null and prepared its T0 update.
    jest.setSystemTime(t1);
    const b = h.svc.handle(closed('d-clock', 'evt_b'));
    await enteredB.promise; // B also read null before A wrote; its update carries T1.
    allowA.resolve();
    await a; // A posts all three slices at T0 and completes entitlement.
    allowB.resolve();
    await b; // Stale B writes T1 even though the event was already posted at T0.
    const result = {
      closed_at: (h.db.state.chargeDispute[0] as Row).closed_at.toISOString(),
      posting_times: h.db.state.splitLedgerReversal.map((r) => (r.posted_at as Date).toISOString()),
      stripe: h.stripeTotal('tr_p-clock'),
    };
    console.log('AUDIT_R2_DISPUTE_CLOSE_CLOCK', JSON.stringify(result));
    expect(result.stripe).toBe(122);
    expect(result.posting_times).toEqual(Array(3).fill(t0.toISOString()));
    expect(result.closed_at).toBe(t0.toISOString());
  });

  it('Stripe success plus head-posting commit failure must recover from the same receipt once', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    team(h, 'p-commit', at);
    dispute(h, 'd-commit', 'p-commit', at);
    const create = h.db.splitLedgerReversal.create.bind(h.db.splitLedgerReversal);
    let fail = true;
    h.db.splitLedgerReversal.create = jest.fn(async (args) => {
      if (fail && args.data.entry_id === 'p-commit-head') {
        fail = false;
        throw new Error('synthetic local record failure');
      }
      return create(args);
    });
    await h.svc.handle(closed('d-commit', 'evt_first'));
    // B-CM7-120 adaptation: the op records the transfer total (= Stripe) before the claim + posting tx;
    // the failed posting leaves the dispute owed and no head-coach posting.
    expect([h.stripeTotal('tr_p-commit'), h.headCoach('p-commit')]).toEqual([122, 122]);
    expect((h.db.state.chargeDispute as any[]).find((d) => d.id === 'd-commit').transfer_reversed_at).toBeNull();
    expect(h.db.state.splitLedgerReversal.filter((p: any) => p.entry_id === 'p-commit-head')).toHaveLength(0);
    await h.svc.handle(closed('d-commit', 'evt_retry'));
    expect([h.stripeTotal('tr_p-commit'), h.headCoach('p-commit')]).toEqual([122, 122]);
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(h.db.state.splitLedgerReversal.filter((p) => p.entry_id === 'p-commit-head')).toHaveLength(1);
  });
});
