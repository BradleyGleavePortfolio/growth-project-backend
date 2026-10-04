// AUDIT PROBE (AUD-OPUS-CM-118, Claude Opus 5.5) — backend#674 @ f9e21a87.
// Never merge. Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the PR's stateful double and synthetic
// Stripe (test/support/refund-reversal-harness.ts).
//
// Candidate C-674-12: upsertAndApplyRefund passes the refund's posted_at to
// the head-coach posting only from the delivery that claimed the ledger
// (ledgerJustReversed). Two overlapping succeeded deliveries of one refund
// (charge.refunded and charge.refund.updated land together): A claims the
// ledger and its Stripe call is slow; B (no ledger claim) gets Stripe's
// answer first and wins the transfer record claim, so the head-coach
// posting is dated at B's record time, not at the refund's posted_at.
// Controls: money stays exact (Stripe = transfer = slice), one reversal.
import 'reflect-metadata';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;

function teamSale(h: ReturnType<typeof harness>, id: string, at: Date) {
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
}

describe('AUD-OPUS-CM-118 #674 — overlapping first-success deliveries of one refund', () => {
  afterEach(() => jest.useRealTimers());

  async function race() {
    const t0 = new Date('2027-03-31T23:59:59.999Z');
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(t0);
    const h = harness();
    teamSale(h, 'p-r', new Date(t0.getTime() - 5 * HOUR));
    h.db.state.chargeRefund.push(
      refundRow('rf-1', 'p-r', t0, {
        status: 'pending',
        posted_at: null,
        ledger_reversed: false,
        transfer_reversal_first_attempt_at: null,
        amount_cents: 980,
      }),
    );
    // A's Stripe call is held until B has finished; B's returns at once.
    const made = h.reverseTransfer.getMockImplementation()!;
    let enterA!: () => void;
    const aAtStripe = new Promise<void>((r) => (enterA = r));
    let releaseA!: () => void;
    const aGo = new Promise<void>((r) => (releaseA = r));
    let calls = 0;
    h.reverseTransfer.mockImplementation(async (args: any) => {
      calls += 1;
      if (calls === 1) {
        enterA();
        await aGo;
      }
      return made(args);
    });
    const refunded = (id: string) => ({
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
    const a = h.svc.handle(refunded('evt_a'));
    await aAtStripe; // A elected posted_at = t0, claimed the ledger, is at Stripe
    jest.setSystemTime(t0.getTime() + 1); // April 1, 00:00:00.000
    await h.svc.handle(refunded('evt_b')); // B: no ledger claim, wins the record
    releaseA();
    await a;
    const refund = (h.db.state.chargeRefund as Row[])[0];
    const postings = (h.db.state.splitLedgerReversal as Row[]).filter(
      (p) => p.source_id === refund.id,
    );
    return { h, t0, refund, postings };
  }

  it('C-674-12 (expected red): every posting of the refund carries its posted_at', async () => {
    const { t0, refund, postings } = await race();
    expect(refund.posted_at).toEqual(t0);
    expect(
      postings.map((p) => `${p.entry_id}@${new Date(p.posted_at).toISOString()}`).sort(),
    ).toEqual(
      ['p-r-application_fee', 'p-r-destination', 'p-r-head'].map((e) => `${e}@${t0.toISOString()}`),
    );
  });

  it('control (expected green): money exact, one Stripe reversal, one record', async () => {
    const { h, postings } = await race();
    const slice = (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === 'p-r-head')!;
    expect({
      stripe: h.stripeTotal('tr_p-r'),
      reversals: h.reversals.length,
      transfer: h.headCoach('p-r'),
      slice: slice.reversed_cents,
      head_postings: postings.filter((p) => p.entry_id === 'p-r-head').map((p) => p.cents),
    }).toEqual({ stripe: 49, reversals: 1, transfer: 49, slice: 49, head_postings: [49] });
  });
});
