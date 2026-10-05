// C-674-12 (B-CM5-119, same lines as the B-674-13 fix): overlapping deliveries
// of one refund success are one first pass. Whichever delivery wins the
// head-coach record, that posting carries the refund's posted_at, like the
// destination and fee postings. A retry after a failed first attempt still
// posts when it happens (B-676-3).
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful double (refund-reversal-harness).
import 'reflect-metadata';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, unknown>;
const T0 = new Date('2027-03-31T23:59:59.999Z');

afterEach(() => jest.useRealTimers());

function teamSaleWithPendingRefund() {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(T0);
  const h = harness();
  seedPurchase(h.db, 'p-r', new Date(T0.getTime() - 5 * HOUR));
  const fee = (h.db.state.splitLedgerEntry as Row[]).find((s) => s.kind === 'application_fee')!;
  h.db.state.splitLedgerEntry.push({
    ...fee,
    id: 'p-r-head',
    kind: 'head_coach_split',
    payee_user_id: 'head-1',
    amount_cents: 245,
  });
  (h.db.state.connectTransfer as Row[])[0].ledger_entry_id = 'p-r-head';
  h.db.state.chargeRefund.push(
    refundRow('rf-1', 'p-r', T0, {
      status: 'pending',
      posted_at: null,
      ledger_reversed: false,
      transfer_reversal_first_attempt_at: null,
      amount_cents: 980,
    }),
  );
  const refunded = (id: string) =>
    h.svc.handle({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_p-r',
          amount: 4900,
          amount_refunded: 980,
          refunded: false,
          refunds: { data: [{ id: 're_rf-1', amount: 980, status: 'succeeded' }] },
        },
      },
    });
  const postings = () =>
    (h.db.state.splitLedgerReversal as Row[])
      .map((p) => `${String(p.entry_id)}@${new Date(p.posted_at as Date).toISOString()}`)
      .sort();
  return { h, refunded, postings };
}

describe('C-674-12: one first pass dates every posting of a refund at its posted_at', () => {
  it('the delivery without the ledger claim wins the record 1 ms later: still the refund time', async () => {
    const { h, refunded, postings } = teamSaleWithPendingRefund();
    const provider = h.reverseTransfer.getMockImplementation()!;
    let atStripe!: () => void;
    const aAtStripe = new Promise<void>((r) => (atStripe = r));
    let release!: () => void;
    const aGo = new Promise<void>((r) => (release = r));
    h.reverseTransfer.mockImplementationOnce(async (args) => {
      atStripe();
      await aGo;
      return provider(args);
    });
    const a = refunded('evt_a');
    await aAtStripe; // A elected posted_at, claimed the ledger and is at Stripe.
    jest.setSystemTime(T0.getTime() + 1); // April 1, 00:00:00.000
    await refunded('evt_b'); // B: no ledger claim; wins the head-coach record.
    release();
    await a;
    expect(postings()).toEqual(
      ['p-r-application_fee', 'p-r-destination', 'p-r-head'].map((e) => `${e}@${T0.toISOString()}`),
    );
    expect([h.stripeTotal('tr_p-r'), h.headCoach('p-r'), h.reversals.length]).toEqual([49, 49, 1]);
  });

  it('control: a redelivery two hours after a failed first attempt posts the head share then', async () => {
    const { h, refunded, postings } = teamSaleWithPendingRefund();
    h.reverseTransfer.mockImplementationOnce(async () => {
      throw new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', null);
    });
    await refunded('evt_a');
    expect(h.headCoach('p-r')).toBe(0);
    const later = new Date(T0.getTime() + 2 * HOUR);
    jest.setSystemTime(later);
    await refunded('evt_a_redelivered');
    expect(postings()).toEqual([
      `p-r-application_fee@${T0.toISOString()}`,
      `p-r-destination@${T0.toISOString()}`,
      `p-r-head@${later.toISOString()}`,
    ]);
    expect([h.stripeTotal('tr_p-r'), h.headCoach('p-r')]).toEqual([49, 49]);
  });
});
