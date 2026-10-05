// B-CM6-1 (#674 main refresh): two legacy reversals of one transfer that
// overlap. The second one read the transfer row before the first one took
// the reversal slot. Its base and cap must come from the row under the slot,
// so the absolute completion (max(recorded, base + amount)) never drops the
// first one's cents. Live proof: refund-reversal-concurrency.live (ledger
// slices race, mwb-3-live-tests).
import 'reflect-metadata';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';

type Row = Record<string, any>;
type H = ReturnType<typeof harness>;

const reverseOf = (h: H, key: string, amount: number) =>
  h.transfers.reverse({
    transfer_row_id: 'tr-p-s',
    amount_cents: amount,
    idempotency_key: key,
    purpose: 'legacy',
  });

// r-a's reversal, with its Stripe answer held until `release()`.
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
    first = reverseOf(h, 'tgp-tr-rev-refund-r-a', 122);
    while (h.reverseTransfer.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
  };
  return { sent, release: async () => (answer(), first) };
}

// r-b's first read of the transfer row happens after r-a took the slot and
// sent (r-b's pending check ran before r-a's operation existed). `after` runs
// between that read and r-b's slot.
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

describe('B-CM6-1 — a reversal that read the transfer before another one finished', () => {
  it('the other reversal finished before the slot: both count (122 + 50)', async () => {
    const h = harness();
    seedPurchase(h.db, 'p-s', new Date(Date.now() - HOUR));
    const a = heldFirst(h);
    readDuringFirst(h, a, () => a.release());
    await reverseOf(h, 'tgp-tr-rev-refund-r-b', 50);
    expect({ stripe: h.stripeTotal('tr_p-s'), local: h.headCoach('p-s') }).toEqual({
      stripe: 172,
      local: 172,
    });
  });

  it('the other reversal is still pending at the slot: nothing is sent, a retry counts both', async () => {
    const h = harness();
    seedPurchase(h.db, 'p-s', new Date(Date.now() - HOUR));
    const a = heldFirst(h);
    readDuringFirst(h, a, async () => undefined);
    const second = await reverseOf(h, 'tgp-tr-rev-refund-r-b', 50).catch((e: unknown) => e);
    const sentWhilePending = h.reverseTransfer.mock.calls.length;
    await a.release();
    await reverseOf(h, 'tgp-tr-rev-refund-r-b', 50);
    expect({
      uncertain: second instanceof ReversalUncertainError,
      sentWhilePending,
      stripe: h.stripeTotal('tr_p-s'),
      local: h.headCoach('p-s'),
    }).toEqual({ uncertain: true, sentWhilePending: 1, stripe: 172, local: 172 });
  });
});
