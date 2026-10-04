// B-674-5 (Opus) / B-674-10 (Sol), B-CM-117: a lost chargeback's head-coach
// transfer reversal is sent under one dispute-scoped key with one stamped
// amount, recorded once with its slice posting, and recovered (redelivery or
// the 15-minute sweep) from what Stripe holds. B-676-3 (writer half): every
// posting of one event carries the event's own time. Real handler, ledger and
// orchestrator over the stateful double; only Stripe is synthetic (it keeps
// keys until expireKeys(), as Stripe does for 24 hours). B-CM3-117: B-674-11
// fair sweep claims, B-674-12 one database-elected first close.
import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: jest.fn(),
}));
const captureMessage = jest.mocked(Sentry.captureMessage);
beforeEach(() => captureMessage.mockClear());
afterEach(() => jest.useRealTimers());

type Row = Record<string, any>;
const timeout = () =>
  new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_connection_error');

// A team sale: the 245-cent head-coach transfer is linked to its slice.
function addTeamSale(h: ReturnType<typeof harness>, id: string, at: Date) {
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
function teamSale(id: string, at: Date) {
  const h = harness();
  addTeamSale(h, id, at);
  const postings = (source?: string) =>
    (h.db.state.splitLedgerReversal as Row[]).filter(
      (r) => r.entry_id === `${id}-head` && (!source || r.source_id === source),
    );
  const state = () => ({
    stripe: h.stripeTotal(`tr_${id}`),
    transfer: h.headCoach(id),
    slice: (h.db.state.splitLedgerEntry as Row[]).find((s) => s.id === `${id}-head`)!.reversed_cents,
    postings: postings().map((r) => r.cents),
  });
  return { ...h, postings, state };
}

function lostDispute(amountCents = 4900) {
  const at = new Date(Date.now() - 2 * HOUR);
  const h = teamSale('p-d', at);
  h.db.state.chargeDispute.push({
    id: 'cd-1',
    stripe_dispute_id: 'dp_1',
    purchase_id: 'p-d',
    stripe_charge_id: 'ch_p-d',
    amount_cents: amountCents,
    status: 'needs_response',
    ledger_reversed: false,
    closed_at: null,
    created_at: at,
    updated_at: at,
  });
  const closed = (id = 'evt_d') => ({
    id,
    type: 'charge.dispute.closed',
    data: { object: { id: 'dp_1', status: 'lost' } },
  });
  const keys = () => h.reverseTransfer.mock.calls.map(([a]) => a.idempotencyKey);
  return { ...h, closed, keys, dispute: () => h.db.state.chargeDispute[0] as Row };
}

// Stripe makes the reversal, then the client times out (the answer is lost).
function loseFirstAnswer(h: ReturnType<typeof harness>) {
  const made = h.reverseTransfer.getMockImplementation()!;
  h.reverseTransfer.mockImplementationOnce(async (args) => {
    await made(args);
    throw timeout();
  });
}

describe('B-674-5 / B-674-10 — a lost chargeback reverses the head-coach share once and records it once', () => {
  it('a lost Stripe answer is recorded by the redelivery from Stripe, with no second request', async () => {
    const h = lostDispute();
    loseFirstAnswer(h);
    await h.svc.handle(h.closed());
    expect(h.state()).toEqual({ stripe: 245, transfer: 0, slice: 0, postings: [] });
    expect(h.dispute()).toMatchObject({ ledger_reversed: true, transfer_reversal_amount_cents: 245 });
    await h.svc.handle(h.closed('evt_d_again'));
    await h.svc.retryPendingTransferReversals();
    expect(h.state()).toEqual({ stripe: 245, transfer: 245, slice: 245, postings: [245] });
    expect(h.dispute().transfer_reversal_stripe_id).toBe('trr_1');
    expect(h.keys()).toEqual(['tgp-tr-rev-dispute-cd-1']);
  });

  it('after Stripe forgot the key (24 hours) the sweep records the reversal Stripe holds, never a second one', async () => {
    const h = lostDispute();
    loseFirstAnswer(h);
    await h.svc.handle(h.closed());
    h.expireKeys();
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 25 * HOUR));
    expect(h.state()).toEqual({ stripe: 245, transfer: 245, slice: 245, postings: [245] });
    expect(h.reversals).toHaveLength(1);
  });

  it('a failed call is resent under the same key and amount, and alerts once owed past 23 hours', async () => {
    const h = lostDispute(2450);
    h.reverseTransfer.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout());
    await h.svc.handle(h.closed());
    expect(captureMessage).not.toHaveBeenCalled();
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 24 * HOUR));
    expect(captureMessage).toHaveBeenCalledWith(
      'head-coach transfer reversal for a lost chargeback still owed',
      expect.objectContaining({
        fingerprint: ['dispute-transfer-reversal-stuck', 'cd-1'],
        tags: { code: 'DISPUTE_TRANSFER_REVERSAL_STUCK' },
        extra: {
          charge_dispute_id: 'cd-1',
          purchase_id: 'p-d',
          runbook: 'docs/runbooks/refund-transfer-reversal-review.md',
        },
      }),
    );
    await h.svc.retryPendingTransferReversals();
    expect(h.state()).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect(
      h.reverseTransfer.mock.calls.map(([a]) => [a.idempotencyKey, a.amount, a.metadata?.tgp_charge_dispute_id]),
    ).toEqual(Array(3).fill(['tgp-tr-rev-dispute-cd-1', 122, 'cd-1']));
  });

  it('a rollback after the record (entitlement write fails) never sends or adds the reversal again', async () => {
    const h = lostDispute(2450);
    const update = h.db.clientPurchase.update.bind(h.db.clientPurchase);
    h.db.clientPurchase.update = jest
      .fn()
      .mockRejectedValueOnce(new Error('synthetic entitlement write failure'))
      .mockImplementation(update);
    await expect(h.svc.handle(h.closed())).rejects.toThrow('synthetic entitlement write failure');
    expect(h.dispute().ledger_reversed).toBe(false);
    await h.svc.handle(h.closed('evt_d_retry'));
    expect(h.state()).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect(h.dispute().ledger_reversed).toBe(true);
    expect(h.keys()).toEqual(['tgp-tr-rev-dispute-cd-1']);
  });

  it('overlapping deliveries send one key and record one reversal', async () => {
    const h = lostDispute(2450);
    await Promise.all([h.svc.handle(h.closed('evt_a')), h.svc.handle(h.closed('evt_b'))]);
    expect(h.state()).toEqual({ stripe: 122, transfer: 122, slice: 122, postings: [122] });
    expect(new Set(h.keys())).toEqual(new Set(['tgp-tr-rev-dispute-cd-1']));
  });
});

describe('B-674-11 — the chargeback sweep reaches every owed reversal across bounded runs', () => {
  // `n` lost chargebacks on team sales, first attempted 24 hours ago (amount
  // stamped, Stripe holds nothing), never claimed by the sweep yet.
  function owed(n: number) {
    const h = harness();
    const at = new Date(Date.now() - 24 * HOUR);
    const ids = Array.from({ length: n }, (_, i) => String(i).padStart(3, '0'));
    for (const i of ids) {
      addTeamSale(h, `p-${i}`, at);
      h.db.state.chargeDispute.push({
        id: `d-${i}`,
        stripe_dispute_id: `dp_${i}`,
        purchase_id: `p-${i}`,
        stripe_charge_id: `ch_p-${i}`,
        amount_cents: 2450,
        status: 'lost',
        ledger_reversed: true,
        closed_at: at,
        transfer_reversal_amount_cents: 122,
        transfer_reversal_first_attempt_at: at,
        transfer_reversal_last_attempt_at: null,
        transfer_reversed_at: null,
        transfer_reversal_stripe_id: null,
        created_at: at,
        updated_at: at,
      });
    }
    const made = h.reverseTransfer.getMockImplementation()!;
    // Even-numbered chargebacks fail at Stripe on every attempt.
    h.reverseTransfer.mockImplementation(async (a) => {
      if (Number(a.transfer_id.slice(-3)) % 2 === 0) throw timeout();
      return made(a);
    });
    const tried = () =>
      h.reverseTransfer.mock.calls.map(([a]) => a.metadata!.tgp_charge_dispute_id);
    return { ...h, ids, tried };
  }
  const stuck = () =>
    captureMessage.mock.calls
      .filter(([m]) => m === 'head-coach transfer reversal for a lost chargeback still owed')
      .map(([, ctx]) => (ctx as { extra: { charge_dispute_id: string } }).extra.charge_dispute_id);

  it('45 owed, 20 claims a run: three restarted runs reach all, reverse the recoverable, alert the stuck', async () => {
    const h = owed(45);
    const t = Date.now();
    const perRun: string[][] = [];
    for (let k = 0; k < 3; k++) {
      const before = h.tried().length;
      const svc = k === 0 ? h.svc : h.restart();
      const out = await svc.retryPendingTransferReversals(new Date(t + k * 15 * 60_000), 1);
      expect(out.retried).toBe(20);
      perRun.push(h.tried().slice(before));
    }
    for (const run of perRun) expect(new Set(run).size).toBe(20);
    expect(new Set(perRun.flat())).toEqual(new Set(h.ids.map((i) => `d-${i}`)));
    const odd = h.ids.filter((i) => Number(i) % 2 === 1);
    expect(odd.map((i) => h.headCoach(`p-${i}`))).toEqual(odd.map(() => 122));
    expect(odd.map((i) => h.stripeTotal(`tr_p-${i}`))).toEqual(odd.map(() => 122));
    const even = h.ids.filter((i) => Number(i) % 2 === 0);
    expect(new Set(stuck())).toEqual(new Set(even.map((i) => `d-${i}`)));
  });

  it('two overlapping sweeps claim each chargeback once; a run inside the cooldown claims none', async () => {
    const h = owed(10);
    const now = new Date();
    const runs = await Promise.all([
      h.svc.retryPendingTransferReversals(now, 1),
      h.restart().retryPendingTransferReversals(now, 1),
    ]);
    expect(runs[0].retried + runs[1].retried).toBe(10);
    expect([...h.tried()].sort()).toEqual(h.ids.map((i) => `d-${i}`));
    const soon = await h.svc.retryPendingTransferReversals(new Date(now.getTime() + 5 * 60_000));
    expect(soon.retried).toBe(0);
  });
});

describe('B-674-5 — transfer.reversed alerts on a reversal no refund or chargeback owes', () => {
  const reversed = (cents: number) => ({
    id: 'evt_tr',
    type: 'transfer.reversed',
    data: { object: { id: 'tr_p-o', amount_reversed: cents, reversed: false } },
  });

  it('an owed refund only logs (its retry records it)', async () => {
    const h = teamSale('p-o', new Date(Date.now() - HOUR));
    h.db.state.chargeRefund.push(refundRow('r-1', 'p-o', new Date()));
    await h.svc.handle(reversed(122));
    expect(captureMessage).not.toHaveBeenCalled();
    expect(h.headCoach('p-o')).toBe(0);
  });

  it('a hand-made reversal raises TRANSFER_REVERSAL_UNATTRIBUTED with ids and both totals only', async () => {
    const h = teamSale('p-o', new Date(Date.now() - HOUR));
    await h.svc.handle(reversed(100));
    expect(captureMessage).toHaveBeenCalledWith('head-coach transfer reversal not attributed', {
      level: 'error',
      fingerprint: ['transfer-reversal-unattributed', 'tr-p-o'],
      tags: { code: 'TRANSFER_REVERSAL_UNATTRIBUTED' },
      extra: {
        connect_transfer_id: 'tr-p-o',
        purchase_id: 'p-o',
        stripe_reversed_cents: 100,
        recorded_reversed_cents: 0,
        runbook: 'docs/runbooks/refund-transfer-reversal-review.md',
      },
    });
    expect(h.headCoach('p-o')).toBe(0);
  });
});

describe('B-676-3 (writer) — every posting of one event carries the event time', () => {
  const freeze = (t: Date) => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(t);
  };
  const slow = (h: ReturnType<typeof harness>, ms: number) => {
    const made = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (args) => {
      jest.setSystemTime(Date.now() + ms);
      return made(args);
    });
  };

  it('a lost chargeback: the head-coach posting takes closed_at, and a redelivery keeps closed_at', async () => {
    const t0 = new Date('2027-03-20T10:00:00.000Z');
    freeze(t0);
    const h = lostDispute();
    slow(h, 1000);
    await h.svc.handle(h.closed());
    await h.svc.handle(h.closed('evt_d_again'));
    expect(h.dispute().closed_at).toEqual(t0);
    const times = (h.db.state.splitLedgerReversal as Row[]).map((r) => r.posted_at.toISOString());
    expect(times).toEqual(Array(3).fill(t0.toISOString()));
  });

  it('a refund: the inline head-coach posting takes posted_at; a sweep recovery posts when it happens', async () => {
    const t0 = new Date('2027-03-20T10:00:00.000Z');
    freeze(t0);
    const h = teamSale('p-r', new Date(t0.getTime() - 5 * HOUR));
    slow(h, 1000);
    h.reverseTransfer.mockRejectedValueOnce(timeout());
    const refunded = (refunds: Array<[string, number]>) => ({
      id: `evt_${refunds.length}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_p-r',
          amount: 4900,
          amount_refunded: refunds.reduce((n, [, c]) => n + c, 0),
          refunded: false,
          refunds: { data: refunds.map(([id, amount]) => ({ id, amount, status: 'succeeded' })) },
        },
      },
    });
    await h.svc.handle(refunded([['re_late', 980]]));
    const later = new Date(t0.getTime() + 2 * HOUR);
    jest.setSystemTime(later);
    await h.svc.retryPendingTransferReversals(later);
    const t1 = new Date(Date.now());
    await h.svc.handle(refunded([['re_late', 980], ['re_inline', 980]]));
    const at = (stripeRefundId: string) => {
      const id = (h.db.state.chargeRefund as Row[]).find((r) => r.stripe_refund_id === stripeRefundId)!.id;
      return h.postings(id).map((r) => r.posted_at.toISOString());
    };
    // The recovery is recorded after its 1 s Stripe call; the inline one is
    // dated by its refund although Stripe answered 1 s later.
    expect({ late: at('re_late'), inline: at('re_inline') }).toEqual({
      late: [new Date(later.getTime() + 1000).toISOString()],
      inline: [t1.toISOString()],
    });
    expect(h.state()).toMatchObject({ stripe: 98, transfer: 98, slice: 98 });
  });
});

describe('B-674-12 — overlapping first closes keep one canonical closed_at', () => {
  it('a delivery that read closed_at=null before another wrote it moves neither closed_at nor a posting', async () => {
    const t0 = new Date('2027-03-20T23:59:59.999Z');
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(t0);
    const h = lostDispute(2450);
    const gate = () => {
      let open!: () => void;
      const at = new Promise<void>((r) => (open = r));
      return { at, open: () => open() };
    };
    const [enterA, enterB, goA, goB] = [gate(), gate(), gate(), gate()];
    const update = h.db.chargeDispute.update.bind(h.db.chargeDispute);
    let closes = 0;
    // Each close write waits after its delivery read closed_at=null.
    h.db.chargeDispute.update = jest.fn(async (args: Row) => {
      if (args.data.closed_at && closes < 2) {
        const first = closes++ === 0;
        (first ? enterA : enterB).open();
        await (first ? goA : goB).at;
      }
      return update(args);
    });
    const a = h.svc.handle(h.closed('evt_a'));
    await enterA.at;
    jest.setSystemTime(t0.getTime() + 1);
    const b = h.svc.handle(h.closed('evt_b'));
    await enterB.at;
    goA.open();
    await a;
    goB.open();
    await b;
    await h.svc.handle(h.closed('evt_c'));
    expect(h.dispute()).toMatchObject({ closed_at: t0, status: 'lost', ledger_reversed: true });
    const times = (h.db.state.splitLedgerReversal as Row[]).map((r) => r.posted_at);
    expect(times).toEqual(Array(3).fill(t0));
    expect(h.state()).toMatchObject({ stripe: 122, transfer: 122, slice: 122 });
  });

  // B-CM4-118: the same race on a refund's first success (posted_at): two
  // charge.refunded deliveries (replicas) for a refund stored pending.
  it('a refund delivery that read posted_at=null before another wrote it moves neither posted_at nor a posting', async () => {
    const t0 = new Date('2027-03-31T23:59:59.999Z');
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(t0);
    const h = teamSale('p-r', new Date(t0.getTime() - 5 * HOUR));
    const pending = { status: 'pending', posted_at: null, ledger_reversed: false };
    h.db.state.chargeRefund.push(refundRow('rf-1', 'p-r', t0, { ...pending, amount_cents: 980 }));
    const [enterA, enterB, goA, goB] = [0, 1, 2, 3].map(() => {
      let open!: () => void;
      return { at: new Promise<void>((r) => (open = r)), open: () => open() };
    });
    const find = h.db.chargeRefund.findUnique.bind(h.db.chargeRefund);
    let reads = 0;
    // Each delivery holds its first read (posted_at=null) until released.
    h.db.chargeRefund.findUnique = jest.fn(async (args: Row) => {
      const snapshot = await find(args);
      if (args.where.stripe_refund_id && reads < 2) {
        const first = reads++ === 0;
        (first ? enterA : enterB).open();
        await (first ? goA : goB).at;
      }
      return snapshot;
    });
    const refunded = (id: string) => ({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_p-r', amount: 4900, amount_refunded: 980, refunded: false,
          refunds: { data: [{ id: 're_rf-1', amount: 980, status: 'succeeded' }] },
        },
      },
    });
    const a = h.svc.handle(refunded('evt_a'));
    await enterA.at;
    const b = h.svc.handle(refunded('evt_b'));
    await enterB.at; // both read posted_at=null
    goA.open();
    await a; // A succeeds and posts at t0
    jest.setSystemTime(t0.getTime() + 1); // April
    goB.open();
    await b;
    const refund = (h.db.state.chargeRefund as Row[])[0];
    expect(refund).toMatchObject({ status: 'succeeded', posted_at: t0, ledger_reversed: true });
    const times = (h.db.state.splitLedgerReversal as Row[]).map((r) => r.posted_at);
    expect(times).toEqual(Array(3).fill(t0));
    expect(h.state()).toMatchObject({ stripe: 49, transfer: 49, slice: 49 });
  });
});

describe('B-674-5 — reconcile never counts a chargeback reversal for a refund (C-674-10: bound id)', () => {
  it('names it: 409; empty body: not unattributed, sends one review reversal and returns its id', async () => {
    const at = new Date(Date.now() - 30 * HOUR);
    const h = harness();
    seedPurchase(h.db, 'p-x', at);
    h.db.state.chargeRefund.push(refundRow('r-x', 'p-x', at, { transfer_reversal_review_at: new Date() }));
    await h.reverseTransfer({
      transfer_id: 'tr_p-x',
      amount: 50,
      idempotencyKey: 'tgp-tr-rev-dispute-cd-9',
      metadata: { tgp_charge_dispute_id: 'cd-9' },
    });
    await expect(
      h.svc.reconcileTransferReversal('r-x', { stripe_transfer_reversal_id: 'trr_1' }),
    ).rejects.toMatchObject({ response: { code: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND' } });
    await expect(h.svc.reconcileTransferReversal('r-x')).resolves.toEqual({
      charge_refund_id: 'r-x',
      outcome: 'reversed',
      stripe_transfer_reversal_id: 'trr_2',
      amount_cents: 122,
    });
    expect(h.refund('r-x').transfer_reversal_stripe_id).toBe('trr_2');
  });
});
