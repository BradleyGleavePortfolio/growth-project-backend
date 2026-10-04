// S-FEE round 11 (agent 116) — F2 findings at 007d3dcb:
//   B-682-1  a reversal sender paused after its attempt write (or at the HTTP
//            boundary) sent again after a takeover and Stripe key expiry:
//            800 cents reversed at Stripe against a 400-cent receipt.
//   B-682-2  free-text error messages reached logs, last_error and errors
//            (C-682-4; the park-after-lock-loss path is C-685-2).
//   B-682-3  payout notices used first person (C-682-1).
// Real orchestrator, ledger and charge lock on the repo fakes; no DB, no
// network. On 007d3dcb (+ F1 round 11) 18 of these fail; the controls (an
// ordinary reversal, the F1 vocabulary, dispute_lost copy) pass on both.
import { Logger } from '@nestjs/common';
import {
  ChargeLock,
  ChargeLockLostError,
  CHARGE_LOCK_TTL_MS,
} from '../src/connect/fees/charge-lock';
import { moneyErrorDiagnostic } from '../src/connect/fees/money-diagnostics';
import { payoutNoticeCopy, type PayoutNoticeAmounts } from '../src/connect/fees/payout-notice-copy';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

const CANARY = 'AUDIT_CANARY client@example.invalid body="Your refund"';
const DAY = 24 * 3_600_000;

function fixture() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  return { db, prisma, stripe, svc };
}
type Fixture = ReturnType<typeof fixture>;

const pending = (f: Fixture) =>
  f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_1',
    purchase_id: 'p1',
    kind: 'coach_net',
    ledger_entry_id: null,
    destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach-1',
    amount_cents: 1_000,
    netted_recovery_cents: 0,
    currency: 'usd',
    source_stripe_charge_id: 'ch1',
    idempotency_key: 'op1',
  });
const paid = async (f: Fixture) => f.svc.attempt((await pending(f)).id);

function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const atGate = new Promise<void>((r) => (reached = r));
  return { open, reached: () => reached(), atGate, opened };
}

// Pause the first reversal-op write that records an attempt, after it
// commits (007d3dcb: update with increment; round 11: the claim CAS).
function pauseAfterAttemptWrite(f: Fixture) {
  const g = gate();
  let paused = false;
  const hold = async <T>(data: Record<string, unknown>, out: T): Promise<T> => {
    if (!paused && data.attempts !== undefined) {
      paused = true;
      g.reached();
      await g.opened;
    }
    return out;
  };
  const ops = f.prisma.transferReversalOp;
  const update = ops.update.getMockImplementation()!;
  ops.update.mockImplementation(async (args) => hold(args.data, await update(args)));
  const updateMany = ops.updateMany.getMockImplementation()!;
  ops.updateMany.mockImplementation(async (args) => hold(args.data, await updateMany(args)));
  return g;
}

// Pause inside the Stripe call, before the fake applies beforeSend.
function pauseAtHttpBoundary(f: Fixture, inFlight = false) {
  const g = gate();
  const real = f.stripe.reverseTransfer.getMockImplementation()!;
  f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
    if (inFlight) args.beforeSend?.(); // the request already started
    g.reached();
    await g.opened;
    return real(inFlight ? { ...args, beforeSend: undefined } : args);
  });
  return g;
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

describe('B-682-1 a claimed reversal is re-proven before and at the HTTP boundary', () => {
  it('paused after the attempt write under the charge lock: takeover, key expiry, resume reverse 400 once', async () => {
    const f = fixture();
    const row = await paid(f);
    let now = Date.now();
    const lockA = new ChargeLock(asPrisma(f.prisma), { now: () => new Date(now), waitMs: 0 });
    const lockB = new ChargeLock(asPrisma(f.prisma), { now: () => new Date(now), waitMs: 0 });
    const g = pauseAfterAttemptWrite(f);
    const a = lockA.run('ch1', () =>
      f.svc.reverse({
        transfer_row_id: row.id,
        amount_cents: 400,
        fence: (tx) => lockA.fence('ch1', tx ?? asPrisma(f.prisma)),
      }),
    );
    await g.atGate;
    now += CHARGE_LOCK_TTL_MS + 1;
    await lockB.run('ch1', () =>
      f.svc.resolvePendingReversals(row.id, (tx) => lockB.fence('ch1', tx ?? asPrisma(f.prisma))),
    );
    now += DAY + 1;
    f.stripe.expireIdempotencyKeys();
    g.open();
    const outcome = await a.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
    expect(outcome).toBeInstanceOf(ChargeLockLostError);
  });

  it('paused after the attempt write without a lock: the resumed worker sees the recorded op and sends nothing', async () => {
    const f = fixture();
    const row = await paid(f);
    const g = pauseAfterAttemptWrite(f);
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.atGate;
    await f.svc.resolvePendingReversals(row.id);
    f.stripe.expireIdempotencyKeys();
    g.open();
    await expect(a).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.stripe.reverseTransfer).toHaveBeenCalledTimes(1); // only the takeover sent
    expect(f.stripe.reversals).toHaveLength(1);
  });

  it('paused at the HTTP boundary past the start budget: nothing sent, the recorded op stands', async () => {
    const f = fixture();
    const row = await paid(f);
    const g = pauseAtHttpBoundary(f);
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.atGate;
    await f.svc.resolvePendingReversals(row.id);
    const later = new Date(Date.now() + DAY + 1);
    f.svc.clock = () => later;
    f.stripe.expireIdempotencyKeys();
    g.open();
    await expect(a).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
    expect(
      lines(warn).some((l) =>
        /^SFEE_REVERSAL_SEND_ABANDONED transfer=\S+ op=\S+ attempt=1 /.test(l),
      ),
    ).toBe(true);
  });

  it('a request already in flight past key expiry is detected: SFEE_REVERSAL_DUPLICATE names both Stripe ids', async () => {
    const f = fixture();
    const row = await paid(f);
    const g = pauseAtHttpBoundary(f, true);
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.atGate;
    await f.svc.resolvePendingReversals(row.id);
    f.stripe.expireIdempotencyKeys();
    g.open();
    await a;
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
    expect(lines(error)).toContainEqual(
      expect.stringMatching(
        /^SFEE_REVERSAL_DUPLICATE alert=true transfer=\S+ op=\S+ amount=400 status=succeeded recorded_stripe_reversal=trr_1 also_at_stripe=trr_2: /,
      ),
    );
  });

  it('control: an ordinary reversal reverses once and records it', async () => {
    const f = fixture();
    const row = await paid(f);
    await expect(
      f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 }),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
});

describe('B-682-2 money-path failures are named by closed codes only', () => {
  const stripeErr = (status: number, code: string) =>
    new StripeConnectApiError(CANARY, status, code, 'invalid_request_error');
  const paths: Record<string, (f: Fixture) => Promise<unknown>> = {
    'transfer refused (final)': async (f) => {
      const row = await pending(f);
      f.stripe.createTransfer.mockRejectedValueOnce(
        new StripeConnectApiError(`No such destination ${CANARY}`, 400, 'resource_missing', null),
      );
      return f.svc.attempt(row.id);
    },
    'transfer uncertain and listing down': async (f) => {
      const row = await pending(f);
      f.stripe.createTransfer.mockRejectedValueOnce(new Error(CANARY));
      f.stripe.listTransfers.mockRejectedValueOnce(new Error(CANARY));
      return f.svc.attempt(row.id);
    },
    'transfer not visible yet': async (f) => {
      const row = await pending(f);
      f.stripe.createTransfer.mockRejectedValueOnce(new Error(CANARY));
      return f.svc.attempt(row.id);
    },
    'transfer receipt write fails': async (f) => {
      const row = await pending(f);
      const tx = f.prisma.$transaction.getMockImplementation()!;
      f.prisma.$transaction.mockImplementation(async (fn: (db: object) => Promise<unknown>) => {
        if (f.stripe.createTransfer.mock.calls.length > 0) throw new Error(CANARY);
        return tx(fn);
      });
      return f.svc.attempt(row.id);
    },
    'park write fails after the lock is lost': async (f) => {
      const row = await pending(f);
      let calls = 0;
      const fence = async () => {
        if (++calls === 2) {
          f.prisma.connectTransfer.updateMany.mockRejectedValueOnce(
            Object.assign(new Error(CANARY), { code: CANARY }),
          );
          throw new ChargeLockLostError('ch1', 'taken_over');
        }
      };
      return f.svc.attempt(row.id, { beforeStripe: fence });
    },
    'reversal refused': async (f) => {
      const row = await paid(f);
      f.stripe.reverseTransfer.mockRejectedValueOnce(stripeErr(400, 'balance_insufficient'));
      return f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    },
    'reversal uncertain and listing down': async (f) => {
      const row = await paid(f);
      f.stripe.reverseTransfer.mockRejectedValueOnce(new Error(CANARY));
      f.stripe.listTransferReversals.mockRejectedValueOnce(new Error(CANARY));
      return f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    },
  };

  it.each(Object.keys(paths))(
    '%s: no free text in logs, rows, outcomes or errors',
    async (path) => {
      const f = fixture();
      const outcome = await paths[path](f).catch((e: unknown) => ({
        thrown: (e as Error).message,
      }));
      const seen = JSON.stringify({ logs: [...lines(warn), ...lines(error)], db: f.db, outcome });
      expect(seen).not.toContain('AUDIT_CANARY');
      expect(seen).not.toContain('example.invalid');
      expect(seen).toMatch(/kind=(stripe|unknown)|error_kind=unknown/);
    },
  );

  it('the vocabulary maps unknown Stripe fields to fixed labels', () => {
    expect(
      moneyErrorDiagnostic(
        new StripeConnectApiError(CANARY, 400, 'balance_insufficient', 'invalid_request_error'),
      ),
    ).toBe('kind=stripe http=400 type=invalid_request_error code=balance_insufficient');
    expect(moneyErrorDiagnostic(new StripeConnectApiError(CANARY, 9_999, CANARY, CANARY))).toBe(
      'kind=stripe http=other type=other code=other',
    );
    expect(moneyErrorDiagnostic(Object.assign(new Error(CANARY), { name: 'AbortError' }))).toBe(
      'kind=timeout',
    );
    expect(moneyErrorDiagnostic(CANARY)).toBe('kind=unknown');
  });
});

describe('B-682-3 payout notices are impersonal, exact and short', () => {
  const amounts = (over: Partial<PayoutNoticeAmounts> = {}): PayoutNoticeAmounts => ({
    currency: 'usd',
    charge_gross_cents: 10_000,
    customer_refunded_cents: 10_000,
    reversed_cents: 9_480,
    reinstated_cents: 7_980,
    released_cents: 2_020,
    held_cents: 520,
    held_tgp_fee_cents: 200,
    held_stripe_fee_cents: 320,
    held_dispute_fee_cents: 0,
    held_not_reversed_cents: 0,
    held_open_cents: 520,
    ...over,
  });
  const cases = [amounts(), amounts({ reinstated_cents: 0 }), amounts({ held_open_cents: 0 })];
  for (const event of ['refund', 'chargeback', 'dispute_won', 'dispute_lost'] as const) {
    for (const role of ['coach', 'head_coach'] as const) {
      it(`${event} / ${role}: no first person, no exclamation mark, at most 160 characters`, () => {
        for (const a of cases) {
          const { title, body } = payoutNoticeCopy(event, role, a);
          expect(`${title} ${body}`).not.toMatch(/\b(we|we'll|we've|us|our|ours)\b/i);
          expect(`${title} ${body}`).not.toMatch(/!/);
          expect(body.length).toBeLessThanOrEqual(160);
        }
      });
    }
  }

  it('keeps exact amounts in the new sentences', () => {
    expect(payoutNoticeCopy('refund', 'coach', amounts()).body).toBe(
      "A client got $100.00 back. $94.80 was taken back from that sale's payout. $5.20 is held from your next sale.",
    );
    expect(
      payoutNoticeCopy('dispute_won', 'head_coach', amounts({ held_open_cents: 0 })).body,
    ).toBe(
      'You won the dispute on a $100.00 charge. $79.80 was paid back to you and the $20.20 hold was released. Nothing is held from your next sale.',
    );
    expect(payoutNoticeCopy('dispute_won', 'coach', amounts({ reinstated_cents: 0 })).body).toBe(
      'You won the dispute on a $100.00 charge. The $20.20 hold was released. $5.20 is held from your next sale.',
    );
  });
});

// B-682-4/8: a lost send, the 24 h key window, then an incomplete page via the real parser.
describe('B-682-4 an incomplete Stripe list never proves a lost send absent', () => {
  const { listTransfers, listTransferReversals } = StripeConnectApiService.prototype;
  const bad: Array<[string, unknown]> = [
    ['no has_more', { data: [] }],
    ['no data', { has_more: false }],
    ['empty object', {}],
    ['an item without an id', { data: [{ amount: 400 }], has_more: false }],
  ];
  const age = (f: Fixture, page: unknown): StripeConnectApiService => {
    f.stripe.failListTransfers = f.stripe.failListReversals = false;
    f.stripe.expireIdempotencyKeys();
    f.svc.clock = () => new Date(Date.now() + DAY + 3_600_000);
    jest.spyOn(f.stripe, 'requireSecret').mockReturnValue('sk_test_wire');
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(page)));
    return f.stripe;
  };

  it.each(bad)('transfer, %s: held, not re-sent; a full list repairs it', async (_n, page) => {
    const f = fixture();
    const row = await pending(f);
    f.stripe.failListTransfers = true;
    f.stripe.transferResponsesLost = 1;
    await f.svc.attempt(row.id);
    jest.spyOn(age(f, page), 'listTransfers').mockImplementationOnce(listTransfers);
    expect(await f.svc.attempt(row.id)).toMatchObject({ status: 'pending' });
    expect(lines(error).pop()).toMatch(/^SFEE_TRANSFER_UNCERTAIN .*list_page_malformed/);
    expect(await f.svc.attempt(row.id)).toMatchObject({ stripe_transfer_id: 'tr_1' });
    expect(f.stripe.transfers.map((t) => t.amount)).toEqual([1_000]);
  });

  it.each(bad)('reversal, %s: not re-sent; a full list repairs it', async (_n, page) => {
    const f = fixture();
    const row = await paid(f);
    f.stripe.failListReversals = true;
    f.stripe.reversalResponsesLost = 1;
    await expect(f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 })).rejects.toThrow();
    jest.spyOn(age(f, page), 'listTransferReversals').mockImplementationOnce(listTransferReversals);
    await expect(f.svc.resolvePendingReversals(row.id)).rejects.toThrow(/list_page_malformed/);
    await f.svc.resolvePendingReversals(row.id);
    expect(f.db.reversalOps![0]).toMatchObject({
      status: 'succeeded',
      stripe_reversal_id: 'trr_1',
    });
    expect(f.stripe.reversals.map((r) => r.amount)).toEqual([400]);
  });
});
