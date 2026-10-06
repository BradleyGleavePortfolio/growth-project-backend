// B-674-13 / B-674-14 (B-CM5-119): a head-coach transfer reversal is sent
// only on proof that is still true at the moment of the send.
// - B-674-13: the refund sweep admits each resend against the time of that
//   send (run start plus elapsed time), never against the run's start alone,
//   so a key Stripe forgot during a long run is never replayed.
// - B-674-14: a Stripe reversal list is complete only after has_more=false.
//   An empty or repeated page that still says has_more is incomplete: nothing
//   is sent, the obligation stays owed and the error code is closed.
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful double (refund-reversal-harness).
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  HOUR,
  harness,
  refundRow,
  seedPurchase,
  staleOwedRefund,
} from './support/refund-reversal-harness';

type Row = Record<string, unknown>;
const MIN = 60_000;
const timeout = () =>
  new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_connection_error');

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function fakeClock(at: Date): void {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(at);
}

// Row A is swept first and its provider call takes `slowMs`. Row B's first
// attempt was `bAgeMs` before the run; Stripe made that reversal (122) and the
// answer was lost. Stripe forgets B's key once B is 24 h old at a send.
async function longSweep(slowMs: number, bAgeMs: number) {
  const T0 = new Date('2027-04-10T12:00:00.000Z');
  fakeClock(T0);
  const h = harness();
  seedPurchase(h.db, 'p-a', new Date(T0.getTime() - 3 * HOUR));
  h.db.state.chargeRefund.push(
    refundRow('rf-a', 'p-a', new Date(T0.getTime() - HOUR), {
      transfer_reversal_amount_cents: 122,
    }),
  );
  const bFirst = new Date(T0.getTime() - bAgeMs);
  seedPurchase(h.db, 'p-b', new Date(bFirst.getTime() - HOUR));
  h.db.state.chargeRefund.push(
    refundRow('rf-b', 'p-b', bFirst, {
      transfer_reversal_amount_cents: 122,
      transfer_reversal_last_attempt_at: new Date(T0.getTime() - 15 * MIN),
    }),
  );
  await h.reverseTransfer({
    transfer_id: 'tr_p-b',
    amount: 122,
    idempotencyKey: 'tgp-tr-rev-refund-rf-b',
    metadata: { tgp_charge_refund_id: 'rf-b' },
  });
  const provider = h.reverseTransfer.getMockImplementation()!;
  h.reverseTransfer.mockClear();
  h.reverseTransfer.mockImplementation(async (args) => {
    if (args.transfer_id === 'tr_p-a') {
      jest.setSystemTime(Date.now() + slowMs);
      throw timeout();
    }
    if (Date.now() - bFirst.getTime() >= 24 * HOUR) h.expireKeys();
    return provider(args);
  });
  const result = await h.svc.retryPendingTransferReversals();
  const sendsB = h.reverseTransfer.mock.calls.filter(([a]) => a.transfer_id === 'tr_p-b').length;
  return { h, result, sendsB, T0 };
}

describe('B-674-13: refund sweep admission reads the clock at each send', () => {
  it('a key that ages past the window during the run moves to review and is never resent', async () => {
    const { h, result, sendsB, T0 } = await longSweep(61 * MIN, 23 * HOUR - MIN);
    expect({
      stripe_b: h.stripeTotal('tr_p-b'),
      local_b: h.headCoach('p-b'),
      sends_b: sendsB,
      review_b: h.refund('rf-b').transfer_reversal_review_at,
    }).toEqual({
      stripe_b: 122,
      local_b: 0,
      sends_b: 0,
      // Dated at the send-time clock, not the run start.
      review_b: new Date(T0.getTime() + 61 * MIN),
    });
    expect(result.needs_review).toBe(1);
  });

  it('crossing the window by one second between selection and send is enough to stop the send', async () => {
    const { h, sendsB } = await longSweep(2_000, 23 * HOUR - 1_000);
    expect([h.stripeTotal('tr_p-b'), sendsB]).toEqual([122, 0]);
    expect(h.refund('rf-b').transfer_reversal_review_at).toBeInstanceOf(Date);
  });

  it('control: elapsed time inside the window still admits the attempt; Stripe\'s reversal is recorded, never a second', async () => {
    const { h, sendsB, T0 } = await longSweep(30 * MIN, 22 * HOUR);
    expect({
      stripe_b: h.stripeTotal('tr_p-b'),
      local_b: h.headCoach('p-b'),
      sends_b: sendsB,
      review_b: h.refund('rf-b').transfer_reversal_review_at,
    }).toEqual({ stripe_b: 122, local_b: 122, sends_b: 0, review_b: null });
    // The attempt stamp is the send time, so later pages of this run skip it.
    expect(h.refund('rf-b').transfer_reversal_last_attempt_at).toEqual(
      new Date(T0.getTime() + 30 * MIN),
    );
  });

  it('a row stamped during the run is not swept twice by a later page', async () => {
    const T0 = new Date('2027-04-10T12:00:00.000Z');
    fakeClock(T0);
    const h = harness();
    for (const id of ['r1', 'r2', 'r3']) {
      seedPurchase(h.db, `p-${id}`, new Date(T0.getTime() - 2 * HOUR));
      h.db.state.chargeRefund.push(refundRow(id, `p-${id}`, new Date(T0.getTime() - HOUR)));
    }
    h.reverseTransfer.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 10_000);
      throw timeout();
    });
    const result = await h.svc.retryPendingTransferReversals(undefined, 1);
    expect(result.retried).toBe(3);
    expect(h.reverseTransfer).toHaveBeenCalledTimes(3);
  });
});

describe('B-674-14: an incomplete Stripe reversal list never authorizes a send', () => {
  // A lost chargeback whose first head-coach reversal Stripe made (122) but
  // whose answer was lost 25 h ago; the dispute key has expired.
  async function owedLostDispute() {
    const h = harness();
    const first = new Date(Date.now() - 25 * HOUR);
    seedPurchase(h.db, 'p-d', first);
    h.db.state.chargeDispute.push({
      id: 'cd-1',
      stripe_dispute_id: 'dp_1',
      purchase_id: 'p-d',
      stripe_charge_id: 'ch_p-d',
      amount_cents: 2450,
      status: 'lost',
      ledger_reversed: true,
      closed_at: first,
      transfer_reversal_amount_cents: 122,
      transfer_reversal_first_attempt_at: first,
      transfer_reversal_last_attempt_at: null,
      transfer_reversed_at: null,
      transfer_reversal_stripe_id: null,
      created_at: first,
      updated_at: first,
    });
    await h.reverseTransfer({
      transfer_id: 'tr_p-d',
      amount: 122,
      idempotencyKey: 'tgp-tr-rev-dispute-cd-1',
      metadata: { tgp_charge_dispute_id: 'cd-1' },
    });
    h.expireKeys();
    h.reverseTransfer.mockClear();
    const list = (Reflect.get(h.svc, 'stripe') as { listTransferReversals: jest.Mock })
      .listTransferReversals;
    return { h, list, made: h.reversals[0] };
  }
  const dispute = (h: ReturnType<typeof harness>) => h.db.state.chargeDispute[0] as Row;

  it('has_more with an empty page: no send, still owed, closed code in the log', async () => {
    const { h, list } = await owedLostDispute();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    list.mockResolvedValue({ data: [], has_more: true });
    await h.svc.retryPendingTransferReversals();
    expect({
      sends: h.reverseTransfer.mock.calls.length,
      stripe: h.stripeTotal('tr_p-d'),
      local: h.headCoach('p-d'),
      owed: dispute(h).transfer_reversed_at == null,
    }).toEqual({ sends: 0, stripe: 122, local: 0, owed: true });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('code=TRANSFER_REVERSALS_LIST_INCOMPLETE'))).toBe(true);
  });

  it('a non-empty page followed by no progress (same page again, has_more) sends nothing', async () => {
    const { h, list } = await owedLostDispute();
    const other = { id: 'trr_other', transfer: 'tr_p-d', amount: 10, metadata: {} };
    list.mockResolvedValue({ data: [other], has_more: true });
    await h.svc.retryPendingTransferReversals();
    expect(list).toHaveBeenCalledTimes(2);
    expect([h.reverseTransfer.mock.calls.length, h.stripeTotal('tr_p-d')]).toEqual([0, 122]);
    expect(dispute(h).transfer_reversed_at).toBeNull();
  });

  it('control: a complete list across two pages records the reversal Stripe holds, no send', async () => {
    const { h, list, made } = await owedLostDispute();
    const other = { id: 'trr_other', transfer: 'tr_p-d', amount: 10, metadata: {} };
    list
      .mockResolvedValueOnce({ data: [other], has_more: true })
      .mockResolvedValueOnce({ data: [made], has_more: false });
    await h.svc.retryPendingTransferReversals();
    expect(list.mock.calls[1][1]).toMatchObject({ starting_after: 'trr_other' });
    expect({
      sends: h.reverseTransfer.mock.calls.length,
      stripe: h.stripeTotal('tr_p-d'),
      local: h.headCoach('p-d'),
      bound: dispute(h).transfer_reversal_stripe_id,
    }).toEqual({ sends: 0, stripe: 122, local: 122, bound: made.id });
  });

  it('control: a complete empty list (has_more false) still lets the retry send once', async () => {
    const { h, list } = await owedLostDispute();
    list.mockResolvedValue({ data: [], has_more: false });
    await h.svc.retryPendingTransferReversals();
    expect([h.reverseTransfer.mock.calls.length, h.headCoach('p-d')]).toEqual([1, 122]);
  });

  it('owner reconcile on an incomplete list answers a closed 503 and sends nothing', async () => {
    const h = await staleOwedRefund();
    (h.refund('r-late') as Row).transfer_reversal_review_at = new Date();
    const list = (Reflect.get(h.svc, 'stripe') as { listTransferReversals: jest.Mock })
      .listTransferReversals;
    list.mockResolvedValue({ data: [], has_more: true });
    const err = await h.svc.reconcileTransferReversal('r-late').then(
      () => null,
      (e: { getStatus: () => number; getResponse: () => Row }) => e,
    );
    expect(err?.getStatus()).toBe(503);
    expect(err?.getResponse()).toMatchObject({ code: 'TRANSFER_REVERSALS_LIST_INCOMPLETE' });
    expect(String(err?.getResponse().message)).not.toMatch(/\b(we|our|us)\b/i);
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.refund('r-late').transfer_reversed).toBe(false);
  });
});
