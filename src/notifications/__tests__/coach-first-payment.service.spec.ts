/**
 * coach-first-payment.service.spec.ts — Roman P4 (Option C)
 *
 * Unit specs for the exactly-once first-payment primitive. These run with NO
 * live database: the transaction client is a mock whose
 * `coachFirstPaymentNotification.create` is what the DB UNIQUE(coachId)
 * constraint would call. The mock simulates the constraint by throwing a
 * Prisma P2002 on the SECOND insert for a coachId it has already seen, exactly
 * as Postgres would.
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
 *   5. Non-P2002 errors rethrow (so the outer tx rolls back and Stripe retries)
 *      and do NOT enqueue a notification.
 */

import { Logger } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CoachFirstPaymentService } from '../coach-first-payment.service';
import { FirstPaymentEmitter } from '../emitters/first-payment.emitter';

/**
 * Builds a mock transaction client whose coachFirstPaymentNotification.create
 * enforces a UNIQUE(coachId) like the real DB: the first insert for a coachId
 * succeeds; a second insert for the same coachId throws Prisma P2002.
 */
function makeTxWithUniqueConstraint() {
  const insertedCoachIds = new Set<string>();
  const create = jest.fn(async ({ data }: { data: { coachId: string } }) => {
    if (insertedCoachIds.has(data.coachId)) {
      throw new PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['coachId'] },
      });
    }
    insertedCoachIds.add(data.coachId);
    return { id: `row_${data.coachId}`, ...data, createdAt: new Date() };
  });
  return {
    tx: { coachFirstPaymentNotification: { create } } as never,
    create,
    insertedCoachIds,
  };
}

function makeEmitter() {
  const emit = jest.fn().mockResolvedValue(undefined);
  const emitter = { emit } as unknown as FirstPaymentEmitter;
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
      data: {
        coachId: 'coach_1',
        amount: 4999,
        currency: 'usd',
        clientId: 'client_1',
      },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('coach_1', {
      amount: 4999,
      currency: 'usd',
      clientId: 'client_1',
    });
  });

  it('is idempotent: calling twice for the same coachId does not throw, second is a no-op, exactly ONE row', async () => {
    const { tx, create, insertedCoachIds } = makeTxWithUniqueConstraint();
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);
    // Second call (e.g. Stripe webhook retry) must not throw.
    await expect(svc.tryEmitFirstPayment(tx, INPUT)).resolves.toBeUndefined();

    // create was ATTEMPTED twice (no pre-SELECT / check-then-act), but exactly
    // ONE row exists — the second attempt hit the UNIQUE constraint (P2002).
    expect(create).toHaveBeenCalledTimes(2);
    expect(insertedCoachIds.size).toBe(1);
    // Notification enqueued only on the winning insert.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('second payment for the same coach: row NOT duplicated and notification NOT re-enqueued', async () => {
    const { tx, create, insertedCoachIds } = makeTxWithUniqueConstraint();
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
    // The testable invariant is that create() is invoked on the exact tx
    // client the caller threads in (not on a separate/global Prisma client).
    const { tx, create } = makeTxWithUniqueConstraint();
    const { emitter } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await svc.tryEmitFirstPayment(tx, INPUT);

    // The create fn we asserted on belongs to THIS tx's
    // coachFirstPaymentNotification delegate — proving the write rides the
    // caller's transaction and is rolled back if that transaction aborts.
    expect(
      (tx as unknown as {
        coachFirstPaymentNotification: { create: typeof create };
      }).coachFirstPaymentNotification.create,
    ).toBe(create);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-P2002 errors and does NOT enqueue (outer tx rolls back, Stripe retries)', async () => {
    const dbError = new PrismaClientKnownRequestError('connection reset', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const create = jest.fn().mockRejectedValue(dbError);
    const tx = { coachFirstPaymentNotification: { create } } as never;
    const { emitter, emit } = makeEmitter();
    const svc = new CoachFirstPaymentService(emitter);

    await expect(svc.tryEmitFirstPayment(tx, INPUT)).rejects.toBe(dbError);
    expect(emit).not.toHaveBeenCalled();
  });
});
