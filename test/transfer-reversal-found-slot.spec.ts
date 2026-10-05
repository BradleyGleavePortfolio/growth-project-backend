// B-CM7-1 (#674, after B-CM6-1): recording a reversal Stripe already holds
// (owner reconcile, or a stamped attempt with no operation) while another
// reversal of the same transfer is in flight. The found reversal's base must
// come from the row under the slot, and nothing is recorded while the other
// operation is still pending, so the absolute total never drops cents that
// Stripe holds.
import 'reflect-metadata';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;
type H = ReturnType<typeof harness>;

// r-a's reversal (122), with its Stripe answer held until `release()`.
function heldFirst(h: H) {
  const provider = h.reverseTransfer.getMockImplementation()!;
  let answer!: () => void;
  const held = new Promise<void>((r) => (answer = r));
  h.reverseTransfer.mockImplementationOnce(async (args) => {
    const receipt = await provider(args);
    await held;
    return receipt;
  });
  let first!: Promise<unknown>;
  const sent = async () => {
    first = h.transfers.reverse({
      transfer_row_id: 'tr-p-s',
      amount_cents: 122,
      idempotency_key: 'tgp-tr-rev-refund-r-a',
      purpose: 'legacy',
    });
    while (h.reverseTransfer.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
  };
  return { sent, release: async () => (answer(), first) };
}

// A 50-cent reversal Stripe holds for refund r-b with no operation for it.
function stripeHoldsFound(h: H) {
  h.reversals.push({
    id: 'trr_found_b',
    transfer: 'tr_p-s',
    amount: 50,
    metadata: { tgp_charge_refund_id: 'r-b' },
  });
}

const recordFound = (h: H) =>
  h.transfers.recordFoundReversal({
    transfer_row_id: 'tr-p-s',
    stripe_reversal_id: 'trr_found_b',
    amount_cents: 50,
    idempotency_key: 'tgp-tr-rev-refund-r-b',
  });

// The found record's first read of the transfer row happens after r-a took
// the slot and sent (its pending check ran before r-a's operation existed).
// `after` runs between that read and the record's slot.
function readDuringFirst(h: H, a: ReturnType<typeof heldFirst>, after: () => Promise<unknown>) {
  const model = h.db.connectTransfer as Row;
  const read = model.findUniqueOrThrow.bind(model);
  let fired = false;
  model.findUniqueOrThrow = jest.fn(async (args: Row) => {
    if (fired) return read(args);
    fired = true;
    await a.sent();
    const row = await read(args);
    await after();
    return row;
  });
}

describe('B-CM7-1 — a found reversal recorded while another reversal of the transfer runs', () => {
  it('the other reversal finished before the slot: both count (122 + 50)', async () => {
    const h = harness();
    seedPurchase(h.db, 'p-s', new Date(Date.now() - HOUR));
    stripeHoldsFound(h);
    const a = heldFirst(h);
    readDuringFirst(h, a, () => a.release());
    await recordFound(h);
    expect({ stripe: h.stripeTotal('tr_p-s'), local: h.headCoach('p-s') }).toEqual({
      stripe: 172,
      local: 172,
    });
  });

  it('the other reversal is still pending at the slot: nothing is recorded, a retry counts both', async () => {
    const h = harness();
    seedPurchase(h.db, 'p-s', new Date(Date.now() - HOUR));
    stripeHoldsFound(h);
    const a = heldFirst(h);
    readDuringFirst(h, a, async () => undefined);
    const second = await recordFound(h).catch((e: unknown) => e);
    await a.release();
    await recordFound(h);
    expect({
      uncertain: second instanceof ReversalUncertainError,
      sent: h.reverseTransfer.mock.calls.length,
      stripe: h.stripeTotal('tr_p-s'),
      local: h.headCoach('p-s'),
    }).toEqual({ uncertain: true, sent: 1, stripe: 172, local: 172 });
  });

  it('control: nothing else in flight, the found reversal is added once (50), a repeat is a no-op', async () => {
    const h = harness();
    seedPurchase(h.db, 'p-s', new Date(Date.now() - HOUR));
    stripeHoldsFound(h);
    await recordFound(h);
    await recordFound(h);
    expect({
      sent: h.reverseTransfer.mock.calls.length,
      stripe: h.stripeTotal('tr_p-s'),
      local: h.headCoach('p-s'),
    }).toEqual({ sent: 0, stripe: 50, local: 50 });
  });
});
