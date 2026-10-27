/**
 * coach-first-payment.service.spec.ts — Roman P4 (Option C)
 *
 * Unit specs for the exactly-once first-payment primitive. These run with NO
 * live database: the transaction client is a mock whose
 * `coachFirstPaymentNotification.createMany({ skipDuplicates: true })` is what
 * the DB UNIQUE(coachId) constraint would answer. B-LSNOTIFY-1 (FR-NOTIFY2):
 * the mock simulates INSERT ... ON CONFLICT DO NOTHING — `{ count: 0 }` on the
 * SECOND insert for a coachId it has already seen, never a thrown P2002 (a
 * thrown unique violation aborts a Postgres transaction even when caught).
 * The real-Postgres proof is test/rls/first-payment-second-purchase-rls.spec.ts.
 *
 * Covers (from the L4 brief):
 *   1. Idempotency — two calls for the same coachId don't throw, the second is
 *      a no-op, and exactly ONE row is inserted.
 *   2. Transaction-sharing — the INSERT is issued against the SAME `tx` object
 *      the caller passes, so when the OUTER transaction rolls back the
 *      notification row rolls back with it (50-Failures #44).
 *   3. First payment — row created AND notification enqueued.
 *   4. Second payment (same coach) — row NOT duplicated AND notification NOT
 *      re-enqueued.
 *   5. Real DB errors rethrow (so the outer tx rolls back and Stripe retries)
 *      and do NOT enqueue a notification.
 *   6. B-LSNOTIFY-1 — the insert is ON CONFLICT DO NOTHING (skipDuplicates),
 *      and nothing catches a unique violation any more.
 */

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AuditService } from '../../audit/audit.service';
import { CoachFirstPaymentService } from '../coach-first-payment.service';
import { FirstPaymentEmitter } from '../emitters/first-payment.emitter';
import { asStub } from './_first-payment-test-stubs';

// R81 (PR-395 follow-up, F7) — strict, no-cast mock helpers. The previous specs
// used `as unknown as` to coerce loose object literals into the real types;
// these typed stubs (a Pick<> for the tx delegate, a jest.Mocked-shaped emitter)
// give the same convenience with full type-checking and no R0-adjacent casts.

/** The single tx delegate this service touches. */
type CoachFirstPaymentDelegate = Pick<
  Prisma.TransactionClient,
  'coachFirstPaymentNotification'
>;

/** A minimal, typed transaction-client stub exposing only what the service uses. */
type MockTx = CoachFirstPaymentDelegate & Prisma.TransactionClient;

/**
 * Builds a mock transaction client whose coachFirstPaymentNotification.createMany
 * enforces a UNIQUE(coachId) like the real DB under ON CONFLICT DO NOTHING:
 * the first insert for a coachId counts 1; a second insert for the same coachId
 * counts 0 and does NOT throw (B-LSNOTIFY-1).
 */
function makeTxWithUniqueConstraint() {
  const insertedCoachIds = new Set<string>();
  const create = jest.fn(
    async ({ data }: { data: Array<{ coachId: string }>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (insertedCoachIds.has(row.coachId)) continue; // ON CONFLICT DO NOTHING
        insertedCoachIds.add(row.coachId);
        count += 1;
      }
      return { count };
    },
  );
  // Typed delegate stub — only `coachFirstPaymentNotification.createMany` is
  // wired; widened to the tx shape through the single `asStub` seam (no `as
  // unknown as`). The local annotation keeps the createMany() shape checked.
  const surface: { coachFirstPaymentNotification: { createMany: typeof create } } = {
    coachFirstPaymentNotification: { createMany: create },
  };
  const tx = asStub<MockTx>(surface);
  return { tx, create, insertedCoachIds };
}

function makeEmitter() {
  // jest.mocked over a typed stub: the object literal is checked against the
  // public surface we use (`emit`), then `jest.mocked` restores the precise
  // mock typing — no `as unknown as`.
  const emit = jest.fn<Promise<void>, Parameters<FirstPaymentEmitter['emit']>>(
    () => Promise.resolve(),
  );
  const emitter = asStub<FirstPaymentEmitter>({ emit });
  return { emitter, emit };
}

const INPUT = {
  coachId: 'coach_1',
  amount: 4999,
  currency: 'usd',
  clientId: 'client_1',
};

describe('CoachFirstPaymentService.tryEmitFirstPayment', () => {
  beforeAll(() => {
    // Silence the structured logs in the test output; assertions below target
    // behaviour, not log lines (the log calls themselves are exercised — they
    // just no-op through this spy).
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('first payment: inserts exactly one row and enqueues the notification', async () => {
    const { tx, create } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: [
        {
          coachId: 'coach_1',
          amount: 4999,
          currency: 'usd',
          clientId: 'client_1',
        },
      ],
      skipDuplicates: true,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    // R81 (PR-395 follow-up, F1/F2): the emit MUST receive the SAME tx so the
    // notification rows ride the purchase transaction.
    expect(emit).toHaveBeenCalledWith(
      'coach_1',
      {
        amount: 4999,
        currency: 'usd',
        clientId: 'client_1',
      },
      tx,
    );
  });

  it('is idempotent: calling twice for the same coachId does not throw, second is a no-op, exactly ONE row', async () => {
    const { tx, create, insertedCoachIds } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);
    // Second call (e.g. Stripe webhook retry) must not throw.
    await expect(svc.tryEmitFirstPayment(tx, INPUT)).resolves.toBeUndefined();

    // createMany was ATTEMPTED twice (no pre-SELECT / check-then-act), but
    // exactly ONE row exists — the second attempt hit the UNIQUE constraint and
    // inserted nothing (ON CONFLICT DO NOTHING, count 0, no throw).
    expect(create).toHaveBeenCalledTimes(2);
    expect(insertedCoachIds.size).toBe(1);
    // Notification enqueued only on the winning insert.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('second payment for the same coach: row NOT duplicated and notification NOT re-enqueued', async () => {
    const { tx, insertedCoachIds } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    // First payment from one client.
    await svc.tryEmitFirstPayment(tx, INPUT);
    // A later, second payment for the SAME coach from a DIFFERENT client and
    // amount — must still no-op (the coach already had their first payment).
    await svc.tryEmitFirstPayment(tx, {
      coachId: 'coach_1',
      amount: 12000,
      currency: 'usd',
      clientId: 'client_2',
    });

    expect(insertedCoachIds.size).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('shares the caller transaction: the INSERT is issued on the SAME tx object (rollback safety)', async () => {
    // 50-Failures #44 — the emit MUST happen inside the same $transaction as
    // the purchase write so an outer rollback discards the notification row.
    // The testable invariant is that createMany() is invoked on the exact tx
    // client the caller threads in (not on a separate/global Prisma client).
    const { tx, create } = makeTxWithUniqueConstraint();
    const { emitter } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);

    // The createMany fn we asserted on belongs to THIS tx's
    // coachFirstPaymentNotification delegate — proving the write rides the
    // caller's transaction and is rolled back if that transaction aborts.
    expect(tx.coachFirstPaymentNotification.createMany).toBe(create);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rethrows real DB errors and does NOT enqueue (outer tx rolls back, Stripe retries)', async () => {
    const dbError = new PrismaClientKnownRequestError('connection reset', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const createMany = jest.fn().mockRejectedValue(dbError);
    const tx = asStub<MockTx>({ coachFirstPaymentNotification: { createMany } });
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await expect(svc.tryEmitFirstPayment(tx, INPUT)).rejects.toBe(dbError);
    expect(emit).not.toHaveBeenCalled();
  });

  it('B-LSNOTIFY-1: never relies on catching a unique violation (a caught P2002 still aborts a Postgres tx)', async () => {
    // The old code caught P2002 from create() and carried on inside the
    // purchase transaction, which Postgres had already aborted (25P02). The
    // service must not have a P2002 catch at all: if a unique violation ever
    // did surface, it propagates so the caller's transaction fails loudly
    // instead of committing nothing after a "success".
    const unique = new PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['coachId'] },
    });
    const createMany = jest.fn().mockRejectedValue(unique);
    const tx = asStub<MockTx>({ coachFirstPaymentNotification: { createMany } });
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await expect(svc.tryEmitFirstPayment(tx, INPUT)).rejects.toBe(unique);
    expect(emit).not.toHaveBeenCalled();
  });

  it('B-LSNOTIFY-1: count 0 (already emitted) skips audit and emit and resolves', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = asStub<MockTx>({ coachFirstPaymentNotification: { createMany } });
    const { emitter, emit } = makeEmitter();
    const write = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());
    const svc = new CoachFirstPaymentService(emitter, asStub<AuditService>({ write }));

    await expect(svc.tryEmitFirstPayment(tx, INPUT)).resolves.toBeUndefined();
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(write).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  // ── R81 (PR-395 follow-up) new coverage ────────────────────────────────────

  it('F1/F2: threads the SAME tx into the emit so the notification rides the purchase transaction', async () => {
    // The whole point of the F1/F2 fix: the emit must run on the caller's tx,
    // not on NotificationsService's autocommitting client. We assert the third
    // positional arg to emit() is the exact tx object the service was handed.
    const { tx } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);

    expect(emit).toHaveBeenCalledTimes(1);
    const [, , usedTx] = emit.mock.calls[0];
    expect(usedTx).toBe(tx);
  });

  it('F4: two DIFFERENT coaches, SAME client → BOTH emit (independent first-evers)', async () => {
    // Brief item 5 / audit F4. The unique key is per-coach, so a single client
    // buying from coach A and later coach B fires the celebration for BOTH —
    // each is that coach's first-ever client payment.
    const { tx, insertedCoachIds } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, {
      coachId: 'coach_A',
      amount: 4999,
      currency: 'usd',
      clientId: 'client_X',
    });
    await svc.tryEmitFirstPayment(tx, {
      coachId: 'coach_B',
      amount: 7500,
      currency: 'usd',
      clientId: 'client_X',
    });

    // Two distinct ledger rows, two emits — one per coach.
    expect(insertedCoachIds.size).toBe(2);
    expect(insertedCoachIds.has('coach_A')).toBe(true);
    expect(insertedCoachIds.has('coach_B')).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(
      1,
      'coach_A',
      expect.objectContaining({ clientId: 'client_X' }),
      tx,
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      'coach_B',
      expect.objectContaining({ clientId: 'client_X' }),
      tx,
    );
  });

  it('F6: Stripe Connect / sub-coach — emit attributes to the SELLING coach (coach_user_id), not the head coach', async () => {
    // Audit F6 / brief item 3. When a sub-coach sells under a head coach's
    // Connect account, the persisted ClientPurchase.coach_user_id is the
    // SELLING sub-coach. The service celebrates that selling coach's first
    // client payment; the head coach is intentionally NOT the recipient (the
    // head-coach revenue split is a separate downstream ledger concern).
    const SUB_COACH = 'subcoach_selling';
    const HEAD_COACH = 'headcoach_owner';
    const { tx, create } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    // coachId is the selling sub-coach (server-trusted purchase.coach_user_id).
    await svc.tryEmitFirstPayment(tx, {
      coachId: SUB_COACH,
      amount: 9900,
      currency: 'usd',
      clientId: 'client_connect',
    });

    // Ledger row + emit are keyed to the selling sub-coach.
    expect(create).toHaveBeenCalledWith({
      data: [
        {
          coachId: SUB_COACH,
          amount: 9900,
          currency: 'usd',
          clientId: 'client_connect',
        },
      ],
      skipDuplicates: true,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const [recipient] = emit.mock.calls[0];
    expect(recipient).toBe(SUB_COACH);
    expect(recipient).not.toBe(HEAD_COACH);
  });

  it('F8: writes the audit-log entry (coach_id, client_id, amount, currency, event, correlation_id) before emit on the winning insert', async () => {
    const { tx } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const write = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());
    // Typed audit stub exposing only the `write` surface the service uses.
    const audit = asStub<AuditService>({ write });
    const svc = new CoachFirstPaymentService(emitter, audit);

    await svc.tryEmitFirstPayment(tx, {
      coachId: 'coach_audit',
      amount: 4999,
      currency: 'usd',
      clientId: 'client_audit',
      correlationId: 'evt_123',
    });

    expect(write).toHaveBeenCalledTimes(1);
    const [entry] = write.mock.calls[0] as [{
      action: string;
      metadata: Record<string, unknown>;
    }];
    expect(entry.action).toBe('notification.first_payment_emitted');
    expect(entry.metadata).toEqual(
      expect.objectContaining({
        event: 'first_payment_emitted',
        coach_id: 'coach_audit',
        client_id: 'client_audit',
        amount: 4999,
        currency: 'usd',
        correlation_id: 'evt_123',
      }),
    );
    // Emit still fires after the audit entry.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('F8: does NOT write an audit entry on the duplicate no-op (already emitted)', async () => {
    const { tx } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const write = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());
    const audit = asStub<AuditService>({ write });
    const svc = new CoachFirstPaymentService(emitter, audit);

    await svc.tryEmitFirstPayment(tx, INPUT);
    // Second call hits the unique constraint (count 0) → no-op, no second audit / emit.
    await svc.tryEmitFirstPayment(tx, INPUT);

    expect(write).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
