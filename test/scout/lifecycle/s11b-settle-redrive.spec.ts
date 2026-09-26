import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutLifecycleService, type Tx } from '../../../src/scout/lifecycle/lifecycle.service';
import { ScoutService } from '../../../src/scout/scout.service';
import type { ScoutCompleteDto } from '../../../src/scout/scout.dto';

/**
 * S11-B unit half (docs/decisions/2026-09-26-s11-journey.md D-S11-4; J16, plus the unit shadow of
 * J14/J15): `completeServerRun`'s P2002 branch against doubles, no DB. What is decided here is
 * DECISION SHAPE only — which lifecycle seams a replayed claim touches, in which transaction, with
 * which epoch, and what it never does (push, `SCOUT_INGEST_COMPLETED`, a stored-claim write, a
 * body-supplied epoch). The real kill, the two-host race and the verdict equality run on real PG
 * in test/scout/s11/settle-redrive.pg.spec.ts.
 */

const COACH = 'coach-s11b';
const INTENT = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const CLAIM_EPOCH = 7;
const REDRIVE_EPOCH = 9;
const ACK = { acknowledged: true, intent_id: INTENT };
const COMPLETE: ScoutCompleteDto = { intent_id: INTENT, terminal_status: 'success' };

const p2002 = () =>
  new PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`coach_id`,`intent_id`)',
    {
      code: 'P2002',
      clientVersion: '6.0.0',
    },
  );

interface Seams {
  /** Every interactive transaction the service opened, in order (each hands out its own tx). */
  transactions: Tx[];
  completionCreate: jest.Mock;
  executeRaw: jest.Mock;
  assertRunOpen: jest.Mock;
  isSettlePending: jest.Mock;
  classifyClosed: jest.Mock;
  onTransferSettled: jest.Mock;
  pushToUser: jest.Mock;
  capture: jest.Mock;
  service: ScoutService;
}

/**
 * The service over structural doubles (the `Object.create(<Class>.prototype)` pattern of
 * src/scout/scout.service.spec.ts): a PrismaService whose interactive `$transaction` hands the
 * callback a fresh tx object, and a lifecycle whose gate, pending read, classifier and settle hook
 * are recorded. `resolve` answers `server` so the claim takes `completeServerRun`.
 */
function makeSeams(): Seams {
  const completionCreate = jest.fn().mockResolvedValue({});
  const executeRaw = jest.fn().mockResolvedValue(1);
  const transactions: Tx[] = [];
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutProgressSnapshot: { upsert: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (tx: Tx) => Promise<unknown>) => {
      const tx = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
        scoutImportCompletion: { create: completionCreate },
        $executeRaw: executeRaw,
      });
      transactions.push(tx);
      return fn(tx);
    }),
  });
  const assertRunOpen = jest.fn();
  const isSettlePending = jest.fn();
  const classifyClosed = jest.fn().mockResolvedValue({ kind: 'fenced', fence_reason: 'revoked' });
  const onTransferSettled = jest.fn().mockResolvedValue(undefined);
  const lifecycle = Object.assign(
    Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService,
    {
      resolve: jest.fn().mockResolvedValue({ mode: 'server', intent: { id: INTENT } }),
      assertRunOpen,
      isSettlePending,
      classifyClosed,
      onTransferSettled,
    },
  );
  const pushToUser = jest.fn().mockResolvedValue({ delivered: true, code: 'delivered' });
  const notifications = Object.assign(
    Object.create(NotificationsService.prototype) as NotificationsService,
    { pushToUser },
  );
  const capture = jest.fn();
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture,
  });
  const service = new ScoutService(prisma, notifications, analytics, lifecycle);
  return {
    transactions,
    completionCreate,
    executeRaw,
    assertRunOpen,
    isSettlePending,
    classifyClosed,
    onTransferSettled,
    pushToUser,
    capture,
    service,
  };
}

/** The replay fixture: the claim gate opens, the ledger unique refuses the second completion row. */
function refusedClaim(s: Seams, redriveGate: number | null = REDRIVE_EPOCH) {
  s.assertRunOpen.mockResolvedValueOnce(CLAIM_EPOCH).mockResolvedValueOnce(redriveGate);
  s.completionCreate.mockRejectedValueOnce(p2002());
}

describe('S11-B completeServerRun: a replayed claim re-drives a lost settle (D-S11-4)', () => {
  let s: Seams;
  beforeEach(() => {
    s = makeSeams();
  });

  it("J16: P2002 → a second short transaction whose FIRST statement is the gate → the pending read in the SAME transaction → onTransferSettled once with the gate's re-read epoch (never the first gate's, never the body's)", async () => {
    refusedClaim(s);
    s.isSettlePending.mockResolvedValueOnce(true);
    // A client that smuggles an epoch in the body: the DTO has no such field and the branch has no
    // epoch input, so 42 can reach nothing.
    const body = { ...COMPLETE, execution_epoch: 42 };
    await expect(s.service.complete(COACH, body)).resolves.toEqual(ACK);

    expect(s.transactions).toHaveLength(2);
    const [claimTx, redriveTx] = s.transactions;
    expect(s.assertRunOpen.mock.calls).toEqual([
      [claimTx, COACH, INTENT],
      [redriveTx, COACH, INTENT],
    ]);
    expect(s.isSettlePending).toHaveBeenCalledTimes(1);
    expect(s.isSettlePending).toHaveBeenCalledWith(redriveTx, COACH, INTENT);
    // Order inside the re-drive transaction: gate, then the read.
    expect(s.assertRunOpen.mock.invocationCallOrder[1]).toBeLessThan(
      s.isSettlePending.mock.invocationCallOrder[0],
    );
    expect(s.onTransferSettled).toHaveBeenCalledTimes(1);
    expect(s.onTransferSettled).toHaveBeenCalledWith(COACH, INTENT, REDRIVE_EPOCH);
    expect(s.onTransferSettled).not.toHaveBeenCalledWith(COACH, INTENT, CLAIM_EPOCH);
    expect(s.onTransferSettled).not.toHaveBeenCalledWith(COACH, INTENT, 42);
    // The settle is decided after the eligibility transaction returned, not inside it.
    expect(s.isSettlePending.mock.invocationCallOrder[0]).toBeLessThan(
      s.onTransferSettled.mock.invocationCallOrder[0],
    );
  });

  it('the replay stores nothing of its own: one refused completion INSERT, no phase CAS, no push, no scout.ingest.completed, no classification', async () => {
    refusedClaim(s);
    s.isSettlePending.mockResolvedValueOnce(true);
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.completionCreate).toHaveBeenCalledTimes(1);
    expect(s.executeRaw).not.toHaveBeenCalled();
    expect(s.pushToUser).not.toHaveBeenCalled();
    expect(s.capture).not.toHaveBeenCalled();
    expect(s.classifyClosed).not.toHaveBeenCalled();
  });

  it('J14 (unit shadow): a replay claiming a different terminal status is only a trigger — the refused INSERT is the only completion statement and the settle is re-driven from DB state', async () => {
    refusedClaim(s);
    s.isSettlePending.mockResolvedValueOnce(true);
    await expect(
      s.service.complete(COACH, { intent_id: INTENT, terminal_status: 'partial' }),
    ).resolves.toEqual(ACK);
    expect(s.completionCreate).toHaveBeenCalledTimes(1);
    expect(s.completionCreate.mock.calls[0][0]).toMatchObject({
      data: { coach_id: COACH, intent_id: INTENT, terminal_status: 'partial' },
    });
    const claimTx = s.transactions[0];
    // No update/upsert seam exists on the transaction the branch used: the stored claim cannot move.
    expect(Object.keys(claimTx.scoutImportCompletion)).toEqual(['create']);
    expect(s.onTransferSettled).toHaveBeenCalledWith(COACH, INTENT, REDRIVE_EPOCH);
  });

  it('no re-drive when the settle is not pending: the gate opens, the read says no, nothing is settled', async () => {
    refusedClaim(s);
    s.isSettlePending.mockResolvedValueOnce(false);
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.isSettlePending).toHaveBeenCalledTimes(1);
    expect(s.onTransferSettled).not.toHaveBeenCalled();
    expect(s.pushToUser).not.toHaveBeenCalled();
    expect(s.capture).not.toHaveBeenCalled();
  });

  it('J15 (unit shadow): the gate closes between the refused claim and the re-drive → ack, no read, no settle, no 409, no classifyClosed', async () => {
    refusedClaim(s, null);
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.assertRunOpen).toHaveBeenCalledTimes(2);
    expect(s.isSettlePending).not.toHaveBeenCalled();
    expect(s.onTransferSettled).not.toHaveBeenCalled();
    expect(s.classifyClosed).not.toHaveBeenCalled();
    expect(s.pushToUser).not.toHaveBeenCalled();
  });

  it('idempotent: after a re-drive, the next replay meets a closed claim gate and is the existing ack no-op — no second settle, no push', async () => {
    refusedClaim(s);
    s.isSettlePending.mockResolvedValueOnce(true);
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.onTransferSettled).toHaveBeenCalledTimes(1);

    s.assertRunOpen.mockResolvedValueOnce(null); // the terminal is written: the gate sees zero rows
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.assertRunOpen).toHaveBeenCalledTimes(3);
    expect(s.completionCreate).toHaveBeenCalledTimes(1);
    expect(s.classifyClosed).toHaveBeenCalledTimes(1);
    expect(s.isSettlePending).toHaveBeenCalledTimes(1);
    expect(s.onTransferSettled).toHaveBeenCalledTimes(1);
    expect(s.pushToUser).not.toHaveBeenCalled();
    expect(s.capture).not.toHaveBeenCalled();
  });

  it('J15 (c): before any claim the closed gate is still 409 run_not_started, and the branch is not reached', async () => {
    s.assertRunOpen.mockResolvedValueOnce(null);
    s.classifyClosed.mockResolvedValueOnce({ kind: 'not_started' });
    await expect(s.service.complete(COACH, COMPLETE)).rejects.toBeInstanceOf(ConflictException);
    expect(s.completionCreate).not.toHaveBeenCalled();
    expect(s.isSettlePending).not.toHaveBeenCalled();
    expect(s.onTransferSettled).not.toHaveBeenCalled();
  });

  it('the branch is P2002-only: any other claim failure propagates unchanged with no re-drive', async () => {
    s.assertRunOpen.mockResolvedValueOnce(CLAIM_EPOCH);
    s.completionCreate.mockRejectedValueOnce(
      new PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: '6.0.0' }),
    );
    await expect(s.service.complete(COACH, COMPLETE)).rejects.toMatchObject({ code: 'P2025' });
    s.assertRunOpen.mockResolvedValueOnce(CLAIM_EPOCH);
    s.completionCreate.mockRejectedValueOnce(new Error('fixture failure'));
    await expect(s.service.complete(COACH, COMPLETE)).rejects.toThrow('fixture failure');
    expect(s.transactions).toHaveLength(2);
    expect(s.isSettlePending).not.toHaveBeenCalled();
    expect(s.onTransferSettled).not.toHaveBeenCalled();
    expect(s.pushToUser).not.toHaveBeenCalled();
  });

  it("first claim unchanged: one transaction, the phase CAS on the claim gate's epoch, one push, one scout.ingest.completed, the settle under that same epoch, no pending read", async () => {
    s.assertRunOpen.mockResolvedValueOnce(CLAIM_EPOCH);
    await expect(s.service.complete(COACH, COMPLETE)).resolves.toEqual(ACK);
    expect(s.transactions).toHaveLength(1);
    expect(s.completionCreate).toHaveBeenCalledTimes(1);
    expect(s.executeRaw).toHaveBeenCalledTimes(1);
    expect(s.executeRaw.mock.calls[0].slice(1)).toContain(CLAIM_EPOCH);
    expect(s.pushToUser).toHaveBeenCalledTimes(1);
    expect(s.capture).toHaveBeenCalledTimes(1);
    expect(s.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_INGEST_COMPLETED, {
      intent_id: INTENT,
      terminal_status: 'success',
    });
    expect(s.onTransferSettled).toHaveBeenCalledWith(COACH, INTENT, CLAIM_EPOCH);
    expect(s.isSettlePending).not.toHaveBeenCalled();
  });
});

describe('S11-B ScoutLifecycleService.isSettlePending: the ONE read helper', () => {
  const lifecycle = () => {
    const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {});
    const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
      capture: jest.fn(),
    });
    return new ScoutLifecycleService(prisma, analytics);
  };
  const txOf = (rows: unknown[]) => {
    const queryRaw = jest.fn().mockResolvedValue(rows);
    const tx = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
      $queryRaw: queryRaw,
    });
    return { tx, queryRaw };
  };
  const statementOf = (queryRaw: jest.Mock) => {
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return { text: strings.join('?'), values };
  };

  it('one row → true; zero rows → false', async () => {
    const one = txOf([{ pending: 1 }]);
    await expect(lifecycle().isSettlePending(one.tx, COACH, INTENT)).resolves.toBe(true);
    const none = txOf([]);
    await expect(lifecycle().isSettlePending(none.tx, COACH, INTENT)).resolves.toBe(false);
    expect(one.queryRaw).toHaveBeenCalledTimes(1);
    expect(none.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('is a tenant-scoped SELECT with no lock and no write, bound to exactly [coach, intent] — no epoch parameter', async () => {
    const { tx, queryRaw } = txOf([]);
    await lifecycle().isSettlePending(tx, COACH, INTENT);
    const { text, values } = statementOf(queryRaw);
    expect(values).toEqual([COACH, INTENT]);
    expect(text).toMatch(/^\s*SELECT/);
    expect(text).toContain('FROM "ScoutImport" r');
    expect(text).toMatch(/r\.coach_id = \?/);
    expect(text).toMatch(/r\.intent_id = \?/);
    expect(text).toMatch(/r\.mode = 'server'/);
    expect(text).toMatch(/r\.terminal_status IS NULL/);
    expect(text).toMatch(/r\.fenced_at IS NULL/);
    expect(text).toMatch(/r\.phase = 'reconciling'/);
    expect(text).toMatch(/EXISTS \(SELECT 1 FROM "ScoutImportCompletion" c/);
    expect(text).toMatch(/c\.coach_id = r\.coach_id AND c\.intent_id = r\.intent_id/);
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(text).not.toMatch(/FOR (NO KEY )?UPDATE|FOR (KEY )?SHARE/);
    expect(text).not.toContain('execution_epoch');
    // The S11 worker's barrier matchers must not fire on this read (a gate or a lock would).
    expect(text).not.toContain('last_observed_at');
  });
});
