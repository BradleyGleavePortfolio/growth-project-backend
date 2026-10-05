// B-CM7-120 ADAPTED REPLAY (never merge): minimal changes to run the original probe's intent on the
// op engine; every change is marked 'B-CM7-120 adaptation'.
// AUDIT PROBE (AUD-OPUS-CM-118, Claude Opus 5.5) — backend#674 @ f9e21a87.
// Never merge. Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the PR's stateful double; Stripe is the
// harness's synthetic provider with key retention (expireKeys = Stripe forgot
// the keys, as it may after 24 h). Independent re-proof of two findings first
// reported by the Sol lens (B-674-13, B-674-14), derived here from source.
//
// B-674-13: retryPendingTransferReversals takes one `now` at the start of the
//   run and admits every refund against it (:743, :797, :687). A run of up to
//   1,000 refund rows with a 10 s provider timeout can last far longer than the
//   1 h margin between the 23 h retry window and Stripe's 24 h key retention.
// B-674-14: listAllTransferReversals returns success on `has_more: true` with
//   an empty page (:1082), and the dispute retry (:1221-1242) then resends.
import 'reflect-metadata';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;
const timeout = () =>
  new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_connection_error');
afterEach(() => jest.useRealTimers());

describe('AUD-OPUS-CM-118 #674 — refund sweep admission uses the time of the send', () => {
  it('B-674-13 (expected red): a refund whose key ages past 24 h during a long run is moved to review, never resent', async () => {
    const T0 = new Date('2027-04-10T12:00:00.000Z');
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(T0);
    const h = harness();
    // Row A: owed, first tried 1 h ago, never stamped by the sweep: swept first.
    seedPurchase(h.db, 'p-a', new Date(T0.getTime() - 3 * HOUR));
    h.db.state.chargeRefund.push(
      refundRow('rf-a', 'p-a', new Date(T0.getTime() - HOUR), { transfer_reversal_amount_cents: 122 }),
    );
    // Row B: first attempt 22 h 59 m before the run; Stripe made that reversal
    // and the answer was lost; every retry since failed; last tried 15 min ago.
    const bFirst = new Date(T0.getTime() - 23 * HOUR + 60_000);
    seedPurchase(h.db, 'p-b', new Date(bFirst.getTime() - HOUR));
    h.db.state.chargeRefund.push(
      refundRow('rf-b', 'p-b', bFirst, {
        transfer_reversal_amount_cents: 122,
        transfer_reversal_last_attempt_at: new Date(T0.getTime() - 15 * 60_000),
      }),
    );
    await h.reverseTransfer({
      transfer_id: 'tr_p-b',
      amount: 122,
      idempotencyKey: 'tgp-tr-rev-refund-rf-b',
      metadata: { tgp_charge_refund_id: 'rf-b' },
    });
    const made = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockClear();
    h.reverseTransfer.mockImplementation(async (args) => {
      if (args.transfer_id === 'tr_p-a') {
        // Stands for ~370 earlier provider timeouts of 10 s in the same run.
        jest.setSystemTime(Date.now() + 61 * 60_000);
        h.expireKeys(); // B's key is now 24 h 00 m old.
        throw timeout();
      }
      return made(args);
    });
    await h.svc.retryPendingTransferReversals();
    const sentB = h.reverseTransfer.mock.calls.filter(([a]) => a.transfer_id === 'tr_p-b').length;
    expect({
      stripe_b: h.stripeTotal('tr_p-b'),
      sends_b: sentB,
      review_b: Boolean(h.refund('rf-b').transfer_reversal_review_at),
    }).toEqual({ stripe_b: 122, sends_b: 0, review_b: true });
  });

  it('control (expected green): the same run without elapsed time retries row B under its key, one reversal', async () => {
    const T0 = new Date('2027-04-10T12:00:00.000Z');
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(T0);
    const h = harness();
    const bFirst = new Date(T0.getTime() - 23 * HOUR + 60_000);
    seedPurchase(h.db, 'p-b', new Date(bFirst.getTime() - HOUR));
    h.db.state.chargeRefund.push(
      refundRow('rf-b', 'p-b', bFirst, {
        transfer_reversal_amount_cents: 122,
        transfer_reversal_last_attempt_at: new Date(T0.getTime() - 15 * 60_000),
      }),
    );
    await h.reverseTransfer({
      transfer_id: 'tr_p-b',
      amount: 122,
      idempotencyKey: 'tgp-tr-rev-refund-rf-b',
      metadata: { tgp_charge_refund_id: 'rf-b' },
    });
    await h.svc.retryPendingTransferReversals();
    expect({ stripe_b: h.stripeTotal('tr_p-b'), local_b: h.headCoach('p-b') }).toEqual({
      stripe_b: 122,
      local_b: 122,
    });
  });
});

describe('AUD-OPUS-CM-118 #674 — an incomplete Stripe list never authorizes a resend', () => {
  function lostDisputeAnswerLost() {
    const at = new Date(Date.now() - 2 * HOUR);
    const h = harness();
    seedPurchase(h.db, 'p-d', at);
    const fee = (h.db.state.splitLedgerEntry as Row[]).find(
      (s) => s.purchase_id === 'p-d' && s.kind === 'application_fee',
    )!;
    h.db.state.splitLedgerEntry.push({
      ...fee,
      id: 'p-d-head',
      kind: 'head_coach_split',
      payee_user_id: 'head-1',
      amount_cents: 245,
    });
    (h.db.state.connectTransfer as Row[]).find((t) => t.purchase_id === 'p-d')!.ledger_entry_id =
      'p-d-head';
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
    h.reverseTransfer.mockImplementationOnce(async (args) => {
      await made(args);
      throw timeout();
    });
    const list = (Reflect.get(h.svc, 'stripe') as { listTransferReversals: jest.Mock })
      .listTransferReversals;
    return { h, list };
  }
  const closed = { id: 'evt_d', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', status: 'lost' } } };

  it('B-674-14 (expected red): has_more with an empty page leaves the reversal owed and sends nothing', async () => {
    const { h, list } = lostDisputeAnswerLost();
    // B-CM7-120 adaptation: the op engine lists Stripe right after the lost answer, so the list is
    // incomplete from the first pass (otherwise the first pass already records the held reversal).
    const complete = list.getMockImplementation()!;
    list.mockResolvedValue({ data: [], has_more: true });
    await h.svc.handle(closed);
    h.expireKeys();
    h.reverseTransfer.mockClear();
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 25 * HOUR));
    expect({
      stripe: h.stripeTotal('tr_p-d'),
      sends_after_list: h.reverseTransfer.mock.calls.length,
      still_owed: (h.db.state.chargeDispute[0] as Row).transfer_reversed_at == null,
    }).toEqual({ stripe: 245, sends_after_list: 0, still_owed: true });
    // B-CM7-120 adaptation: once the list is complete, the held reversal is recorded once, no send.
    list.mockImplementation(complete);
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 50 * HOUR));
    expect({
      stripe: h.stripeTotal('tr_p-d'),
      local: h.headCoach('p-d'),
      sends_after_list: h.reverseTransfer.mock.calls.length,
      still_owed: (h.db.state.chargeDispute[0] as Row).transfer_reversed_at == null,
    }).toEqual({ stripe: 245, local: 245, sends_after_list: 0, still_owed: false });
  });

  it('control (expected green): a complete list records the reversal Stripe holds, no second send', async () => {
    const { h } = lostDisputeAnswerLost();
    await h.svc.handle(closed);
    h.expireKeys();
    h.reverseTransfer.mockClear();
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 25 * HOUR));
    expect({
      stripe: h.stripeTotal('tr_p-d'),
      local: h.headCoach('p-d'),
      sends_after_list: h.reverseTransfer.mock.calls.length,
    }).toEqual({ stripe: 245, local: 245, sends_after_list: 0 });
  });
});
