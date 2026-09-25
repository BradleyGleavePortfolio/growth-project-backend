import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import {
  type RunRow,
  SCOUT_RUN_DEADLINE_MS_DEFAULT,
  ScoutLifecycleService,
} from '../../../src/scout/lifecycle/lifecycle.service';

// S7-L2 unit coverage of ScoutLifecycleService against Prisma doubles: guard
// order, idempotency, resolution and the projections. The SQL gate, fences,
// CAS and lazy deadline are proven on real PG in test/rls-g2-s7l.spec.ts.

const INTENT = '3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const COACH = 'coach-1';

interface Doubles {
  intentFindUnique: jest.Mock;
  runFindUnique: jest.Mock;
  runCreate: jest.Mock;
  completionFindUnique: jest.Mock;
  ledgerGroupBy: jest.Mock;
  queryRaw: jest.Mock;
  executeRaw: jest.Mock;
  transaction: jest.Mock;
  capture: jest.Mock;
}

function makeDoubles(): Doubles {
  const d: Doubles = {
    intentFindUnique: jest.fn(),
    runFindUnique: jest.fn(),
    runCreate: jest.fn(),
    completionFindUnique: jest.fn().mockResolvedValue(null),
    ledgerGroupBy: jest.fn().mockResolvedValue([]),
    queryRaw: jest.fn(),
    executeRaw: jest.fn(),
    transaction: jest.fn(),
    capture: jest.fn(),
  };
  // Interactive $transaction(fn) hands the callback a tx that shares the raw doubles.
  d.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: d.queryRaw,
      $executeRaw: d.executeRaw,
      scoutImportCompletion: { findUnique: d.completionFindUnique },
      scoutIngestEntity: { groupBy: jest.fn().mockResolvedValue([]) },
      scoutReconstructionLedger: { groupBy: d.ledgerGroupBy },
    }),
  );
  return d;
}

function makeService(d: Doubles): ScoutLifecycleService {
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    importIntent: { findUnique: d.intentFindUnique },
    scoutImport: { findUnique: d.runFindUnique, create: d.runCreate },
    scoutImportCompletion: { findUnique: d.completionFindUnique },
    scoutReconstructionLedger: { groupBy: d.ledgerGroupBy },
    $transaction: d.transaction,
  });
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture: d.capture,
  });
  return new ScoutLifecycleService(prisma, analytics);
}

const pairedIntent = (
  over: Partial<{ paired_at: Date | null; superseded_at: Date | null }> = {},
) => ({
  id: INTENT,
  paired_at: new Date('2026-09-24T10:00:00.000Z'),
  superseded_at: null,
  ...over,
});

const openRun = (over: Partial<RunRow> = {}): RunRow => ({
  mode: 'server',
  import_intent_id: INTENT,
  phase: 'discovering',
  accepted_start_at: new Date('2026-09-24T10:00:00.000Z'),
  deadline_at: new Date(Date.now() + 60_000),
  last_observed_at: null,
  execution_epoch: 1,
  fenced_at: null,
  fence_reason: null,
  reason_code: null,
  terminal_status: null,
  completed_at: null,
  started_at: new Date('2026-09-24T10:00:00.000Z'),
  ...over,
});

/** The 409 body of a rejected call (Nest returns the object body verbatim from getResponse). */
const conflictCode = async (p: Promise<unknown>): Promise<string | object> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    if (err instanceof ConflictException) return err.getResponse();
  }
  throw new Error('expected a ConflictException');
};

describe('ScoutLifecycleService', () => {
  let d: Doubles;
  let service: ScoutLifecycleService;
  const envBefore = process.env.SCOUT_RUN_DEADLINE_MS;

  beforeEach(() => {
    delete process.env.SCOUT_RUN_DEADLINE_MS;
    d = makeDoubles();
    service = makeService(d);
  });

  afterAll(() => {
    if (envBefore === undefined) delete process.env.SCOUT_RUN_DEADLINE_MS;
    else process.env.SCOUT_RUN_DEADLINE_MS = envBefore;
  });

  describe('deadline configuration (D-S7L-3)', () => {
    it('defaults to five minutes and accepts only a positive integer override', () => {
      expect(SCOUT_RUN_DEADLINE_MS_DEFAULT).toBe(300_000);
      expect(ScoutLifecycleService.readDeadlineMs(undefined)).toBe(300_000);
      expect(ScoutLifecycleService.readDeadlineMs('90000')).toBe(90_000);
      for (const bad of ['0', '-1', 'abc', '1.5', '', '01']) {
        expect(ScoutLifecycleService.readDeadlineMs(bad)).toBe(300_000);
      }
    });
  });

  describe('resolve (§3.1 resolution precedes the gate)', () => {
    it('a non-UUID string is legacy without touching the database', async () => {
      await expect(service.resolve(COACH, 'intent-1')).resolves.toEqual({ mode: 'legacy' });
      expect(d.intentFindUnique).not.toHaveBeenCalled();
      expect(d.runFindUnique).not.toHaveBeenCalled();
    });

    it('a UUID that is not an owned ImportIntent is legacy (foreign or unknown)', async () => {
      d.intentFindUnique.mockResolvedValue(null);
      d.runFindUnique.mockResolvedValue(null);
      await expect(service.resolve(COACH, INTENT)).resolves.toEqual({ mode: 'legacy' });
      expect(d.intentFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id_coach_id: { id: INTENT, coach_id: COACH } } }),
      );
    });

    it('an owned intent whose run row is already legacy stays legacy (§7: never re-owned)', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue({ mode: 'legacy' });
      await expect(service.resolve(COACH, INTENT)).resolves.toEqual({ mode: 'legacy' });
    });

    it('an owned intent with no legacy row resolves to server', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue(null);
      await expect(service.resolve(COACH, INTENT)).resolves.toEqual({
        mode: 'server',
        intent: pairedIntent(),
      });
    });
  });

  describe('start guard order (§3)', () => {
    it('404 for an intent the caller does not own', async () => {
      d.intentFindUnique.mockResolvedValue(null);
      await expect(service.start(COACH, INTENT)).rejects.toBeInstanceOf(NotFoundException);
      expect(d.runCreate).not.toHaveBeenCalled();
    });

    it('409 intent_not_paired before any run lookup', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent({ paired_at: null }));
      const body = await conflictCode(service.start(COACH, INTENT));
      expect(body).toMatchObject({ code: 'intent_not_paired' });
      expect(d.runFindUnique).not.toHaveBeenCalled();
    });

    it('409 intent_superseded', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent({ superseded_at: new Date() }));
      expect(await conflictCode(service.start(COACH, INTENT))).toMatchObject({
        code: 'intent_superseded',
      });
    });

    it('409 run_terminal when the run already settled', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue(
        openRun({ terminal_status: 'partial', execution_epoch: 1 }),
      );
      expect(await conflictCode(service.start(COACH, INTENT))).toMatchObject({
        code: 'run_terminal',
      });
      expect(d.runCreate).not.toHaveBeenCalled();
    });

    it('409 legacy_run when the intent id names a legacy row', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue(openRun({ mode: 'legacy', accepted_start_at: null }));
      expect(await conflictCode(service.start(COACH, INTENT))).toMatchObject({
        code: 'legacy_run',
      });
    });

    it('creates ONE server row with the server-owned clock and epoch 1, then emits scout.run.started', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue(null);
      d.runCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
      const before = Date.now();
      const res = await service.start(COACH, INTENT);
      const data = d.runCreate.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        coach_id: COACH,
        intent_id: INTENT,
        import_intent_id: INTENT,
        mode: 'server',
        phase: 'discovering',
        execution_epoch: 1,
      });
      const start = data.accepted_start_at as Date;
      const deadline = data.deadline_at as Date;
      expect(start.getTime()).toBeGreaterThanOrEqual(before);
      expect(deadline.getTime() - start.getTime()).toBe(300_000);
      expect(res).toEqual({
        intent_id: INTENT,
        mode: 'server',
        phase: 'discovering',
        execution_epoch: 1,
        accepted_start_at: start.toISOString(),
        deadline_at: deadline.toISOString(),
      });
      expect(d.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RUN_STARTED, {
        intent_id: INTENT,
      });
    });

    it('a duplicate Start on an open run returns the same body and does not insert', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      const row = openRun();
      d.runFindUnique.mockResolvedValue(row);
      const res = await service.start(COACH, INTENT);
      expect(res).toEqual({
        intent_id: INTENT,
        mode: 'server',
        phase: 'discovering',
        execution_epoch: 1,
        accepted_start_at: row.accepted_start_at!.toISOString(),
        deadline_at: row.deadline_at!.toISOString(),
      });
      expect(d.runCreate).not.toHaveBeenCalled();
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('a Start race (P2002) re-reads and answers like the duplicate', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      const row = openRun();
      d.runFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
      d.runCreate.mockRejectedValue(
        new PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6.0.0' }),
      );
      const res = await service.start(COACH, INTENT);
      expect(res.execution_epoch).toBe(1);
      expect(res.accepted_start_at).toBe(row.accepted_start_at!.toISOString());
    });

    it('an open run past its deadline is fenced timed_out first, then 409 run_terminal', async () => {
      d.intentFindUnique.mockResolvedValue(pairedIntent());
      d.runFindUnique.mockResolvedValue(openRun({ deadline_at: new Date(Date.now() - 1) }));
      d.queryRaw.mockResolvedValue([
        { execution_epoch: 1, terminal_status: null, fenced_at: null, fence_reason: null },
      ]);
      d.executeRaw.mockResolvedValue(1);
      expect(await conflictCode(service.start(COACH, INTENT))).toMatchObject({
        code: 'run_terminal',
      });
      expect(d.transaction).toHaveBeenCalledTimes(1);
      expect(d.capture).toHaveBeenCalledWith(
        COACH,
        Events.SCOUT_RUN_FENCED,
        expect.objectContaining({ fence_reason: 'timed_out', terminal_status: 'timed_out' }),
      );
    });
  });

  describe('cancel', () => {
    it('404 when no run exists for the caller', async () => {
      d.runFindUnique.mockResolvedValue(null);
      await expect(service.cancel(COACH, INTENT)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 legacy_run for a legacy row', async () => {
      d.runFindUnique.mockResolvedValue(openRun({ mode: 'legacy' }));
      expect(await conflictCode(service.cancel(COACH, 'intent-1'))).toMatchObject({
        code: 'legacy_run',
      });
      expect(d.transaction).not.toHaveBeenCalled();
    });

    it('is idempotent on an already cancelled run', async () => {
      d.runFindUnique.mockResolvedValue(
        openRun({ terminal_status: 'cancelled', execution_epoch: 2 }),
      );
      await expect(service.cancel(COACH, INTENT)).resolves.toEqual({
        intent_id: INTENT,
        status: 'cancelled',
        execution_epoch: 2,
      });
      expect(d.transaction).not.toHaveBeenCalled();
    });

    it('409 run_terminal when another terminal holds', async () => {
      d.runFindUnique.mockResolvedValue(openRun({ terminal_status: 'partial' }));
      expect(await conflictCode(service.cancel(COACH, INTENT))).toMatchObject({
        code: 'run_terminal',
      });
    });

    it('fences an open run (epoch + 1, terminal cancelled / cancelled_by_coach) in one transaction', async () => {
      d.runFindUnique.mockResolvedValue(openRun());
      d.queryRaw.mockResolvedValue([
        { execution_epoch: 1, terminal_status: null, fenced_at: null, fence_reason: null },
      ]);
      d.executeRaw.mockResolvedValue(1);
      await expect(service.cancel(COACH, INTENT)).resolves.toEqual({
        intent_id: INTENT,
        status: 'cancelled',
        execution_epoch: 2,
      });
      expect(d.transaction).toHaveBeenCalledTimes(1);
      // Two CAS writes inside the one transaction: the fence, then the terminal.
      expect(d.executeRaw).toHaveBeenCalledTimes(2);
      expect(d.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RUN_FENCED, {
        intent_id: INTENT,
        fence_reason: 'cancelled',
        terminal_status: 'cancelled',
        execution_epoch: 2,
      });
    });

    it('a CAS miss inside the fence (row already fenced) yields no writes and 409 run_terminal', async () => {
      d.runFindUnique
        .mockResolvedValueOnce(openRun())
        .mockResolvedValueOnce(openRun({ terminal_status: 'timed_out', fenced_at: new Date() }));
      d.queryRaw.mockResolvedValue([
        {
          execution_epoch: 2,
          terminal_status: 'timed_out',
          fenced_at: new Date(),
          fence_reason: 'timed_out',
        },
      ]);
      expect(await conflictCode(service.cancel(COACH, INTENT))).toMatchObject({
        code: 'run_terminal',
      });
      expect(d.executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('closed-gate classification (§3.1)', () => {
    it('no row → run_not_started', async () => {
      d.runFindUnique.mockResolvedValue(null);
      const closed = await service.classifyClosed(COACH, INTENT);
      expect(closed).toEqual({ kind: 'not_started' });
      expect(ScoutLifecycleService.closedConflict(closed).getResponse()).toMatchObject({
        code: 'run_not_started',
      });
    });

    it('fenced row → run_fenced with its fence_reason', async () => {
      d.runFindUnique.mockResolvedValue(
        openRun({ fenced_at: new Date(), fence_reason: 'cancelled', terminal_status: 'cancelled' }),
      );
      const closed = await service.classifyClosed(COACH, INTENT);
      expect(closed).toEqual({
        kind: 'fenced',
        fence_reason: 'cancelled',
        terminal_status: 'cancelled',
      });
      expect(ScoutLifecycleService.closedConflict(closed).getResponse()).toMatchObject({
        code: 'run_fenced',
        fence_reason: 'cancelled',
      });
    });

    it('an open row that failed the gate is past its deadline → fenced timed_out lazily', async () => {
      d.runFindUnique.mockResolvedValue(openRun({ deadline_at: new Date(Date.now() - 5) }));
      d.queryRaw.mockResolvedValue([
        { execution_epoch: 1, terminal_status: null, fenced_at: null, fence_reason: null },
      ]);
      d.executeRaw.mockResolvedValue(1);
      await expect(service.classifyClosed(COACH, INTENT)).resolves.toEqual({
        kind: 'fenced',
        fence_reason: 'timed_out',
        terminal_status: 'timed_out',
      });
    });
  });

  describe('projections (§5)', () => {
    it('a null / legacy row projects the legacy constants', () => {
      expect(ScoutLifecycleService.projectLifecycle(null)).toEqual({
        mode: 'legacy',
        phase: null,
        accepted_start_at: null,
        deadline_at: null,
        last_observed_at: null,
        execution_epoch: 1,
        reason_code: null,
      });
      expect(ScoutLifecycleService.projectLifecycle(openRun({ mode: 'legacy' })).mode).toBe(
        'legacy',
      );
    });

    it('a server row projects its clocks, phase, epoch and reason code; unknown values fall to null', () => {
      const row = openRun({
        phase: 'reconciling',
        execution_epoch: 3,
        reason_code: 'deadline_exceeded',
        last_observed_at: new Date('2026-09-24T10:01:00.000Z'),
      });
      expect(ScoutLifecycleService.projectLifecycle(row)).toEqual({
        mode: 'server',
        phase: 'reconciling',
        accepted_start_at: '2026-09-24T10:00:00.000Z',
        deadline_at: row.deadline_at!.toISOString(),
        last_observed_at: '2026-09-24T10:01:00.000Z',
        execution_epoch: 3,
        reason_code: 'deadline_exceeded',
      });
      expect(
        ScoutLifecycleService.projectLifecycle(openRun({ phase: 'bogus', reason_code: 'bogus' })),
      ).toMatchObject({ phase: null, reason_code: null });
    });

    it('families: staged_unique is the staged row count, ledger tallies fold, native buckets are null', () => {
      const ledger = ScoutLifecycleService.tallyLedger([
        { entity_type: 'clients', status: 'reconstructed', _count: { _all: 2 } },
        { entity_type: 'clients', status: 'failed', _count: { _all: 1 } },
        { entity_type: 'workouts', status: 'skipped', _count: { _all: 4 } },
        { entity_type: 'workouts', status: 'weird', _count: { _all: 9 } },
      ]);
      expect(ledger).toEqual({
        clients: { reconstructed: 2, skipped: 0, failed: 1 },
        workouts: { reconstructed: 0, skipped: 4, failed: 0 },
      });
      expect(
        ScoutLifecycleService.projectFamilies(
          [
            { entity_type: 'workouts', _count: { _all: 4 } },
            { entity_type: 'clients', _count: { _all: 3 } },
          ],
          ledger,
        ),
      ).toEqual([
        {
          family: 'clients',
          observed_unique: null,
          staged_unique: 3,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: { reconstructed: 2, skipped: 0, failed: 1 },
        },
        {
          family: 'workouts',
          observed_unique: null,
          staged_unique: 4,
          created_native: null,
          already_present_verified: null,
          rejected: null,
          unresolved: null,
          ledger: { reconstructed: 0, skipped: 4, failed: 0 },
        },
      ]);
    });

    it('server terminal guard admits only the server vocabulary (never `success`)', () => {
      expect(ScoutLifecycleService.serverTerminal('complete')).toBe('complete');
      expect(ScoutLifecycleService.serverTerminal('timed_out')).toBe('timed_out');
      expect(ScoutLifecycleService.serverTerminal('success')).toBeNull();
      expect(ScoutLifecycleService.serverTerminal(null)).toBeNull();
    });

    it('isUuid accepts RFC 4122 text and rejects legacy strings', () => {
      expect(ScoutLifecycleService.isUuid(INTENT)).toBe(true);
      expect(ScoutLifecycleService.isUuid(INTENT.toUpperCase())).toBe(true);
      expect(ScoutLifecycleService.isUuid('intent-1')).toBe(false);
      expect(ScoutLifecycleService.isUuid(`${INTENT}x`)).toBe(false);
    });
  });
});
