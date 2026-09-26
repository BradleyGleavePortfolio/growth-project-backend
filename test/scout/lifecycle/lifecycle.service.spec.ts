import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import {
  PROJECTED_FAMILY_QUALIFIERS,
  PROJECTED_RELATIONSHIP_CLOSURES,
  type RunRow,
  S9_RUN_REASON_CODES,
  S9_SNAPSHOT_TX_OPTIONS,
  SCOUT_RUN_DEADLINE_MS_DEFAULT,
  ScoutLifecycleService,
  SETTLE_ATTEMPTS,
} from '../../../src/scout/lifecycle/lifecycle.service';
import {
  CONSTANT_REASON_CODES,
  QUALIFIER_FAMILY_NAMES,
  QUALIFIER_FIELD_NAMES,
  QUALIFIER_MODEL_NAMES,
  UNRESOLVED_QUALIFIER_DOMAIN,
} from '../../../src/scout/lifecycle/reason-domains';
import {
  FAMILY_QUALIFIERS,
  isRunReasonCode,
  RELATIONSHIP_CLOSURES,
} from '../../../src/scout/lifecycle/reason-codes';
import { ReconciliationFactsService } from '../../../src/scout/reconciliation/facts.service';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import {
  type FamilyFacts,
  type IdentityFacts,
  type LedgerRowFacts,
  type ReconciliationFacts,
  type ReconciliationFamilyV1,
  type ReconciliationReportV1,
  S9_REASON_CODES,
} from '../../../src/scout/reconciliation/types';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';

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

    it('an open row with a FUTURE deadline (Start committed after the gate) → run_not_started, no fence, no write', async () => {
      // Review B F1: the zero-row gate ran before a concurrent Start committed; the reread now sees
      // a fresh open run. It must not be fenced timed_out (that would make a new run permanently
      // terminal and burn the unique intent). Same answer as the failed gate, and nothing mutated.
      d.runFindUnique.mockResolvedValue(openRun({ deadline_at: new Date(Date.now() + 60_000) }));
      const closed = await service.classifyClosed(COACH, INTENT);
      expect(closed).toEqual({ kind: 'not_started' });
      expect(ScoutLifecycleService.closedConflict(closed).getResponse()).toMatchObject({
        code: 'run_not_started',
      });
      expect(d.transaction).not.toHaveBeenCalled();
      expect(d.queryRaw).not.toHaveBeenCalled();
      expect(d.executeRaw).not.toHaveBeenCalled();
      expect(d.capture).not.toHaveBeenCalled();
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
  // ── S9-C: settle wiring, recompute-on-read and the additive projection (D-S9-1, D-S9-5) ──

  /** Doubles for the two S8-G/S9-B seams the settle hook drives; nothing else is real. */
  interface S9Doubles {
    reconstructRun: jest.Mock;
    collect: jest.Mock;
  }
  const wired = (
    d: Doubles,
    factSet: ReconciliationFacts,
  ): { service: ScoutLifecycleService; s9: S9Doubles } => {
    const s9: S9Doubles = {
      reconstructRun: jest
        .fn()
        .mockResolvedValue({ families: [], unmapped_families: [], stopped: null }),
      collect: jest.fn().mockResolvedValue(factSet),
    };
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
    const service = new ScoutLifecycleService(
      prisma,
      analytics,
      Object.assign(Object.create(ScoutReconstructService.prototype) as ScoutReconstructService, {
        reconstructRun: s9.reconstructRun,
      }),
      Object.assign(
        Object.create(ReconciliationFactsService.prototype) as ReconciliationFactsService,
        { collect: s9.collect },
      ),
    );
    return { service, s9 };
  };

  const skipped = (reason: string): LedgerRowFacts => ({ status: 'skipped', reason });
  const verified: LedgerRowFacts = {
    status: 'reconstructed',
    target_kind: 'workout_plan',
    provenance: {
      outcome: 'created',
      native: 'present_owned',
      reason: null,
      unresolved_children: {},
    },
  };
  const identity = (token: string, n: number, ledger: LedgerRowFacts | null): IdentityFacts => ({
    token,
    identity: `p\u001f${token}-${n}`,
    ledger,
    client_linked: false,
  });
  const family = (
    name: string,
    identities: IdentityFacts[],
    over: Partial<FamilyFacts> = {},
  ): FamilyFacts => ({
    family: name,
    mapped: true,
    resolution_reason: null,
    client_owned: false,
    ceiling_exceeded: false,
    identities,
    ledger_without_staged: 0,
    qualifiers: [],
    ...over,
  });
  const facts = (
    families: FamilyFacts[],
    claim: ReconciliationFacts['claim'] = 'success',
  ): ReconciliationFacts => ({
    claim,
    families,
    relationships: [],
    spec_families: families.filter((f) => f.mapped).map((f) => f.family),
    ledger_without_staged: 0,
    coverage: null,
  });
  /** One verified plan under the `routines` token plus one unresolved: partial / unresolved_identities. */
  const MIXED = facts([
    family('workouts', [
      identity('routines', 1, verified),
      identity('routines', 2, skipped('unresolved:missing_required_field:name')),
    ]),
  ]);
  const lockedOpen = {
    execution_epoch: 1,
    terminal_status: null,
    fenced_at: null,
    fence_reason: null,
    deadline_at: null,
  };
  const terminalWrites = (d: Doubles) =>
    d.executeRaw.mock.calls.filter((c: unknown[]) =>
      (c[0] as string[]).join('?').includes('SET terminal_status = '),
    );
  const flatArgs = (call: unknown[]) => call.slice(1);
  /** What Prisma raises for PostgreSQL 40001 (serialization failure) / 40P01 (deadlock). */
  const serialization = () =>
    new PrismaClientKnownRequestError('write conflict or deadlock', {
      code: 'P2034',
      clientVersion: '6.0.0',
    });

  describe('S9-C settle wiring (D-S9-1, R09)', () => {
    it('passes the recomputed S9 verdict to the arbiter: the S9 reason code is the one terminal write', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      // Sanity: the pure reconciler agrees on the fixture.
      expect(reconcile(MIXED).verdict).toEqual({
        outcome: 'partial',
        reason_code: 'unresolved_identities',
      });
      expect(s9.reconstructRun).toHaveBeenCalledTimes(1);
      expect(s9.collect).toHaveBeenCalledTimes(1);
      expect(s9.collect.mock.calls[0].slice(1)).toEqual([COACH, INTENT]);
      // The facts service reads on the SAME transaction client the tail holds (D-S9-1), not on prisma.
      expect(s9.collect.mock.calls[0][0]).toHaveProperty('$executeRaw', d.executeRaw);
      const writes = terminalWrites(d);
      expect(writes).toHaveLength(1);
      expect(flatArgs(writes[0])).toEqual(
        expect.arrayContaining(['partial', 'unresolved_identities', 1]),
      );
      expect(d.executeRaw).toHaveBeenCalledTimes(1);
      expect(d.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RUN_SETTLED, {
        intent_id: INTENT,
        terminal_status: 'partial',
        reason_code: 'unresolved_identities',
      });
    });

    it('never yields complete in v1: a fully verified run still reconciles partial / coverage_basis_unknown', async () => {
      const clean = facts([family('workouts', [identity('routines', 1, verified)])]);
      const { service: svc } = wired(d, clean);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(reconcile(clean).verdict).toEqual({
        outcome: 'partial',
        reason_code: 'coverage_basis_unknown',
      });
      expect(flatArgs(terminalWrites(d)[0])).toEqual(
        expect.arrayContaining(['partial', 'coverage_basis_unknown']),
      );
      expect(flatArgs(terminalWrites(d)[0])).not.toContain('complete');
    });

    it('R09: a fence on the locked row wins over the S9 verdict', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([
        { ...lockedOpen, fenced_at: new Date(), fence_reason: 'cancelled' },
      ]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(s9.collect).toHaveBeenCalledTimes(1);
      const writes = terminalWrites(d);
      expect(writes).toHaveLength(1);
      expect(flatArgs(writes[0])).toEqual(
        expect.arrayContaining(['cancelled', 'cancelled_by_coach']),
      );
      expect(flatArgs(writes[0])).not.toContain('unresolved_identities');
    });

    it('R09: claim failed with zero staged rows → failed / transfer_failed regardless of the S9 verdict', async () => {
      const { service: svc } = wired(d, facts([], 'failed'));
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'failed' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      const writes = terminalWrites(d);
      expect(writes).toHaveLength(1);
      expect(flatArgs(writes[0])).toEqual(expect.arrayContaining(['failed', 'transfer_failed']));
    });

    it('R09: a CAS miss (epoch moved or terminal set) is a no-op — no S9 read, no write, no event', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([{ ...lockedOpen, execution_epoch: 2 }]);
      await svc.onTransferSettled(COACH, INTENT, 1);
      d.queryRaw.mockResolvedValue([{ ...lockedOpen, terminal_status: 'cancelled' }]);
      await svc.onTransferSettled(COACH, INTENT, 1);
      d.queryRaw.mockResolvedValue([]);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(s9.collect).not.toHaveBeenCalled();
      expect(d.executeRaw).not.toHaveBeenCalled();
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('S9 writes nothing of its own: the only statement after the lock and the reads is the terminal CAS', async () => {
      const { service: svc } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(d.transaction).toHaveBeenCalledTimes(1);
      expect(d.queryRaw).toHaveBeenCalledTimes(1); // the FOR NO KEY UPDATE lock
      expect(d.executeRaw).toHaveBeenCalledTimes(1); // the terminal write
    });

    it('a failed terminal CAS after the S9 read emits nothing (exactly-once terminal)', async () => {
      const { service: svc } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(0);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(d.executeRaw).toHaveBeenCalledTimes(1);
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('C-9: the settle tail opens its transaction with the S9 snapshot options (REPEATABLE READ, R16-sized timeout)', async () => {
      const { service: svc } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(d.transaction).toHaveBeenCalledTimes(1);
      expect(d.transaction.mock.calls[0][1]).toBe(S9_SNAPSHOT_TX_OPTIONS);
      expect(S9_SNAPSHOT_TX_OPTIONS).toEqual({
        isolationLevel: 'RepeatableRead',
        timeout: 20_000,
        maxWait: 5_000,
      });
      // R16: 10k rows reconcile within 10 000 ms; the timeout sits above that and well inside the
      // run deadline, so a slow reconcile fails loudly instead of being cut at Prisma's 5 s
      // default.
      expect(S9_SNAPSHOT_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(2 * 10_000);
      expect(S9_SNAPSHOT_TX_OPTIONS.timeout).toBeLessThanOrEqual(
        SCOUT_RUN_DEADLINE_MS_DEFAULT / 10,
      );
    });

    it('C-9: a serialization failure (P2034) retries the WHOLE settle transaction once more; exactly one terminal write lands', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      // PG raises 40001 at the terminal UPDATE of a row a concurrent committed writer changed
      // after this snapshot was taken; Prisma surfaces it as P2034 and the transaction is aborted.
      d.executeRaw.mockRejectedValueOnce(serialization()).mockResolvedValueOnce(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(d.transaction).toHaveBeenCalledTimes(2);
      for (const call of d.transaction.mock.calls) expect(call[1]).toBe(S9_SNAPSHOT_TX_OPTIONS);
      // Each attempt re-locks and re-reads from its own fresh snapshot.
      expect(d.queryRaw).toHaveBeenCalledTimes(2);
      expect(s9.collect).toHaveBeenCalledTimes(2);
      // Two UPDATE statements were issued, but the first belonged to the aborted attempt (PG
      // rolled it back with the 40001); exactly one terminal landed and exactly one event fired.
      expect(terminalWrites(d)).toHaveLength(2);
      expect(d.capture).toHaveBeenCalledTimes(1);
      expect(d.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RUN_SETTLED, {
        intent_id: INTENT,
        terminal_status: 'partial',
        reason_code: 'unresolved_identities',
      });
    });

    it('C-9: a retry that re-locks a now-terminal row is a no-op — the concurrent writer won, nothing is written', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      d.queryRaw
        .mockResolvedValueOnce([lockedOpen])
        .mockResolvedValueOnce([{ ...lockedOpen, terminal_status: 'cancelled' }]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockRejectedValueOnce(serialization());
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(d.transaction).toHaveBeenCalledTimes(2);
      expect(d.queryRaw).toHaveBeenCalledTimes(2);
      expect(s9.collect).toHaveBeenCalledTimes(1); // the retry returned at the terminal check
      expect(d.executeRaw).toHaveBeenCalledTimes(1); // only the aborted attempt's UPDATE
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('C-9: retries are bounded — after SETTLE_ATTEMPTS serialization failures the error propagates, no terminal is fabricated', async () => {
      const { service: svc } = wired(d, MIXED);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.transaction.mockImplementation(async () => {
        throw serialization();
      });
      await expect(svc.onTransferSettled(COACH, INTENT, 1)).rejects.toMatchObject({
        code: 'P2034',
      });
      expect(SETTLE_ATTEMPTS).toBe(3);
      expect(d.transaction).toHaveBeenCalledTimes(SETTLE_ATTEMPTS);
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('C-9: non-serialization errors are NOT retried — one attempt, error propagates unchanged', async () => {
      const { service: svc } = wired(d, MIXED);
      const dup = new PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      const plain = new Error('connection reset');
      d.transaction.mockImplementationOnce(async () => {
        throw dup;
      });
      await expect(svc.onTransferSettled(COACH, INTENT, 1)).rejects.toBe(dup);
      d.transaction.mockImplementationOnce(async () => {
        throw plain;
      });
      await expect(svc.onTransferSettled(COACH, INTENT, 1)).rejects.toBe(plain);
      expect(d.transaction).toHaveBeenCalledTimes(2);
      expect(ScoutLifecycleService.isSerializationFailure(dup)).toBe(false);
      expect(ScoutLifecycleService.isSerializationFailure(plain)).toBe(false);
      expect(ScoutLifecycleService.isSerializationFailure(serialization())).toBe(true);
      expect(d.capture).not.toHaveBeenCalled();
    });

    it('without an injected facts service the constructor still accepts (prisma, analytics) — R13 callers unchanged', () => {
      expect(service).toBeInstanceOf(ScoutLifecycleService);
      expect(S9_RUN_REASON_CODES.every((c) => isRunReasonCode(c))).toBe(true);
      expect([...S9_RUN_REASON_CODES]).toEqual([...S9_REASON_CODES]);
    });
  });

  describe('S9-C recompute-on-read (D-S9-5, RC-2, C-9)', () => {
    const settledServer = (over: Partial<RunRow> = {}) =>
      openRun({
        phase: 'reconciling',
        terminal_status: 'partial',
        reason_code: 'unresolved_identities',
        ...over,
      });

    it('reportApplies: server + terminal + not reconciliation_not_performed; fenced terminals included (RC-2)', () => {
      const applies = ScoutLifecycleService.reportApplies;
      expect(applies(settledServer())).toBe(true);
      expect(
        applies(settledServer({ terminal_status: 'cancelled', reason_code: 'cancelled_by_coach' })),
      ).toBe(true);
      expect(
        applies(settledServer({ terminal_status: 'timed_out', reason_code: 'deadline_exceeded' })),
      ).toBe(true);
      expect(
        applies(settledServer({ terminal_status: 'failed', reason_code: 'transfer_failed' })),
      ).toBe(true);
      expect(applies(settledServer({ reason_code: 'reconciliation_not_performed' }))).toBe(false);
      expect(applies(openRun())).toBe(false); // open server run
      expect(applies(openRun({ mode: 'legacy', terminal_status: 'success' }))).toBe(false);
      expect(applies(null)).toBe(false);
      expect(applies(undefined)).toBe(false);
    });

    it('readReport returns null without opening a transaction when no report applies (R13, R15)', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      await expect(svc.readReport(COACH, INTENT, null)).resolves.toBeNull();
      await expect(svc.readReport(COACH, INTENT, openRun())).resolves.toBeNull();
      await expect(
        svc.readReport(
          COACH,
          INTENT,
          settledServer({ reason_code: 'reconciliation_not_performed' }),
        ),
      ).resolves.toBeNull();
      await expect(
        svc.readReport(COACH, INTENT, openRun({ mode: 'legacy', terminal_status: 'success' })),
      ).resolves.toBeNull();
      expect(d.transaction).not.toHaveBeenCalled();
      expect(s9.collect).not.toHaveBeenCalled();
    });

    it('readReport opens ONE REPEATABLE READ transaction, reads on it, writes nothing, and returns the recomputed report', async () => {
      const { service: svc, s9 } = wired(d, MIXED);
      const report = await svc.readReport(COACH, INTENT, settledServer());
      expect(d.transaction).toHaveBeenCalledTimes(1);
      expect(d.transaction.mock.calls[0][1]).toBe(S9_SNAPSHOT_TX_OPTIONS);
      expect(d.transaction.mock.calls[0][1]).toMatchObject({
        isolationLevel: 'RepeatableRead',
        timeout: 20_000,
        maxWait: 5_000,
      });
      expect(s9.collect).toHaveBeenCalledTimes(1);
      expect(s9.collect.mock.calls[0][0]).toHaveProperty('$queryRaw', d.queryRaw);
      expect(d.executeRaw).not.toHaveBeenCalled();
      expect(d.queryRaw).not.toHaveBeenCalled();
      expect(report).toEqual(reconcile(MIXED).report);
      expect(report?.conditions).toEqual(['unresolved_identities', 'coverage_basis_unknown']);
    });
  });

  describe('S9-C R10(C) — a replayed intent that converged already_present', () => {
    /** S8-C replay: the create-only writers find their row and record `already_present` (j). */
    const replayed: ReconciliationFacts = {
      ...MIXED,
      families: MIXED.families.map((f) => ({
        ...f,
        identities: f.identities.map((i) =>
          i.ledger?.status === 'reconstructed' && i.ledger.provenance?.outcome === 'created'
            ? {
                ...i,
                ledger: {
                  ...i.ledger,
                  provenance: { ...i.ledger.provenance, outcome: 'already_present' as const },
                },
              }
            : i,
        ),
      })),
    };

    it('gives the same verdict and report as the first pass; created_native / already_present_verified stay null', async () => {
      // Non-vacuous: the fixture really flipped an outcome.
      expect(JSON.stringify(replayed)).toContain('already_present');
      expect(JSON.stringify(MIXED)).not.toContain('already_present');
      expect(reconcile(replayed)).toEqual(reconcile(MIXED));
      const first = ScoutLifecycleService.projectFamilies(
        [{ entity_type: 'routines', _count: { _all: 2 } }],
        { routines: { reconstructed: 1, skipped: 1, failed: 0 } },
        reconcile(MIXED).report,
      );
      const again = ScoutLifecycleService.projectFamilies(
        [{ entity_type: 'routines', _count: { _all: 2 } }],
        { routines: { reconstructed: 1, skipped: 1, failed: 0 } },
        reconcile(replayed).report,
      );
      expect(again).toEqual(first);
      expect(again[0].native_present_verified).toBe(1);
      expect(again[0].created_native).toBeNull(); // D-S9-4: the split is unknown, never 0
      expect(again[0].already_present_verified).toBeNull();
      // And the settle tail writes the identical terminal for the replayed facts.
      const { service: svc } = wired(d, replayed);
      d.queryRaw.mockResolvedValue([lockedOpen]);
      d.completionFindUnique.mockResolvedValue({ terminal_status: 'success' });
      d.executeRaw.mockResolvedValue(1);
      await svc.onTransferSettled(COACH, INTENT, 1);
      expect(flatArgs(terminalWrites(d)[0])).toEqual(
        expect.arrayContaining(['partial', 'unresolved_identities']),
      );
    });
  });

  describe('S9-C additive projection (D-S9-5, C-6, C-7, C-10, R13, R15)', () => {
    const STAGED = [
      { entity_type: 'routines', _count: { _all: 2 } },
      { entity_type: 'notes', _count: { _all: 1 } },
    ];
    const LEDGER = {
      routines: { reconstructed: 1, skipped: 1, failed: 0 },
      notes: { reconstructed: 0, skipped: 1, failed: 0 },
    };
    const S7L_SHAPE_KEYS = [
      'already_present_verified',
      'created_native',
      'family',
      'ledger',
      'observed_unique',
      'rejected',
      'staged_unique',
      'unresolved',
    ];
    const ADDITIVE_KEYS = [
      'canonical_family',
      'completeness_basis',
      'native_present_verified',
      'qualifiers',
      'reasons',
      'relationship_closure',
    ];
    const withNotes = facts([
      MIXED.families[0],
      family('notes', [identity('notes', 1, skipped('unresolved_family:notes'))], {
        mapped: false,
        resolution_reason: 'unresolved_family:notes',
      }),
    ]);

    it('R13/R15: the two-argument call and an explicit null report are the S7-L shape — no additive key, no zero', () => {
      for (const out of [
        ScoutLifecycleService.projectFamilies(STAGED, LEDGER),
        ScoutLifecycleService.projectFamilies(STAGED, LEDGER, null),
        ScoutLifecycleService.projectFamilies(STAGED, LEDGER, undefined),
      ]) {
        expect(out.map((f) => f.family)).toEqual(['notes', 'routines']);
        for (const entry of out) {
          expect(Object.keys(entry).sort()).toEqual(S7L_SHAPE_KEYS);
          expect(entry).toMatchObject({
            observed_unique: null,
            created_native: null,
            already_present_verified: null,
            rejected: null,
            unresolved: null,
          });
        }
      }
    });

    it('R15: with a report the entries equal the recomputed report for the same facts; D-S9-4 buckets stay null', () => {
      const report = reconcile(withNotes).report;
      const out = ScoutLifecycleService.projectFamilies(STAGED, LEDGER, report);
      expect(out.map((f) => f.family)).toEqual(['notes', 'routines']);
      const routines = out[1];
      expect(Object.keys(routines).sort()).toEqual([...S7L_SHAPE_KEYS, ...ADDITIVE_KEYS].sort());
      const tokenRow = report.families
        .find((f) => f.family === 'workouts')!
        .tokens.find((t) => t.token === 'routines')!;
      expect(routines).toEqual({
        family: 'routines',
        observed_unique: null,
        staged_unique: 2,
        created_native: null,
        already_present_verified: null,
        rejected: tokenRow.rejected,
        unresolved: tokenRow.unresolved,
        ledger: LEDGER.routines,
        canonical_family: 'workouts',
        native_present_verified: tokenRow.native_present_verified,
        completeness_basis: 'none',
        relationship_closure: 'not_applicable',
        reasons: report.families.find((f) => f.family === 'workouts')!.reasons,
        qualifiers: [],
      });
      expect(routines.native_present_verified).toBe(1);
      expect(routines.unresolved).toBe(1);
      expect(routines.rejected).toBe(0);
      expect(routines.reasons).toEqual([
        { code: 'unresolved:missing_required_field:name', count: 1 },
      ]);
      // The unmapped token: canonical_family null, its own staged token admitted as the qualifier (C-6).
      expect(out[0]).toMatchObject({
        family: 'notes',
        canonical_family: null,
        unresolved: 1,
        rejected: 0,
        native_present_verified: 0,
        reasons: [{ code: 'unresolved_family:notes', count: 1 }],
      });
    });

    it('RC-3 / partial coverage: a report entry with no staged token never creates an entry; a token without a report row keeps the S7-L shape', () => {
      const report = reconcile(withNotes).report;
      const out = ScoutLifecycleService.projectFamilies(
        [{ entity_type: 'ghost', _count: { _all: 3 } }],
        {},
        report,
      );
      expect(out).toHaveLength(1);
      expect(Object.keys(out[0]).sort()).toEqual(S7L_SHAPE_KEYS);
      expect(out[0]).toMatchObject({ family: 'ghost', rejected: null, unresolved: null });
    });

    it('C-10: a token resolving to two families sums its rows and projects canonical_family null', () => {
      const report = reconcile(
        facts([
          family('workouts', [identity('items', 1, verified)]),
          family('programs', [
            identity('items', 2, skipped('unresolved:missing_required_field:name')),
          ]),
        ]),
      ).report;
      const [items] = ScoutLifecycleService.projectFamilies(
        [{ entity_type: 'items', _count: { _all: 2 } }],
        {},
        report,
      );
      expect(items).toMatchObject({
        family: 'items',
        canonical_family: null,
        native_present_verified: 1,
        unresolved: 1,
        rejected: 0,
        completeness_basis: 'none',
        relationship_closure: 'not_applicable',
        reasons: [{ code: 'unresolved:missing_required_field:name', count: 1 }],
      });
    });

    it('C-6: qualifiers outside their domain fold into unresolved:reason_unrecognised; counts merge; sorted', () => {
      const staged = new Set(['routines']);
      expect(
        ScoutLifecycleService.projectReasons(
          [
            { code: 'unresolved_family:routines', count: 2 },
            { code: 'unresolved_family:Jane Doe <jane@example.com>', count: 1 },
            { code: 'unsupported_platform:s9c-proof', count: 1 },
            { code: 'unsupported_platform:Jane Doe', count: 1 },
            { code: 'unresolved:missing_required_field:name', count: 1 },
            { code: 'unresolved:missing_required_field:jane@example.com', count: 1 },
            { code: 'unresolved:missing_required_field:Jane', count: 1 }, // well-formed, off-domain
            { code: 'unresolved:no_native_client_principal', count: 1 },
            { code: 'unresolved:reason_unrecognised', count: 1 },
            { code: 'failed', count: 1 },
            { code: 'missing_source_id', count: 1 },
            { code: 'free text with spaces', count: 1 },
            { code: 'frobnicate', count: 1 }, // well-formed bare word, not a known code
          ],
          staged,
        ),
      ).toEqual([
        { code: 'failed', count: 1 },
        { code: 'missing_source_id', count: 1 },
        { code: 'unresolved:missing_required_field:name', count: 1 },
        { code: 'unresolved:no_native_client_principal', count: 1 },
        { code: 'unresolved:reason_unrecognised', count: 7 },
        { code: 'unresolved_family:routines', count: 2 },
        { code: 'unsupported_platform:s9c-proof', count: 1 },
      ]);
      const text = JSON.stringify(
        ScoutLifecycleService.projectReasons(
          [{ code: 'unresolved_family:Jane Doe <jane@example.com>', count: 1 }],
          staged,
        ),
      );
      expect(text).not.toContain('Jane');
      expect(text).not.toContain('example.com');
    });

    it('C-6: admission is closed-domain membership, not grammar — every domain is derived from a code constant', () => {
      const admit = (code: string, platforms?: ReadonlySet<string>) =>
        ScoutLifecycleService.admitReasonCode(code, new Set(['routines']), platforms);
      // Qualifier domains: native columns, rule field keys, families, target models.
      for (const q of ['name', 'days_per_week', 'reps_or_duration_seconds', 'week_index', 'type']) {
        expect(QUALIFIER_FIELD_NAMES.has(q)).toBe(true);
      }
      for (const q of ['daysPerWeek', 'exerciseRef', 'exercises', 'durationEstimateMinutes']) {
        expect(QUALIFIER_FIELD_NAMES.has(q)).toBe(true);
      }
      for (const q of ['clients', 'workouts', 'client_history', 'programs', 'workouts.exercise']) {
        expect(QUALIFIER_FAMILY_NAMES.has(q)).toBe(true);
      }
      for (const q of ['WorkoutProgram', 'WorkoutPlan', 'WorkoutPlanExercise', 'Person']) {
        expect(QUALIFIER_MODEL_NAMES.has(q)).toBe(true);
      }
      for (const q of UNRESOLVED_QUALIFIER_DOMAIN) expect(q).toMatch(/^[A-Za-z_][A-Za-z0-9_.]*$/);
      const offDomain = [
        'Jane',
        'jane',
        'title',
        'minutes',
        'kind',
        'Jane Doe',
        'jane@example.com',
      ];
      for (const q of offDomain) expect(UNRESOLVED_QUALIFIER_DOMAIN.has(q)).toBe(false);
      // Admitted: catalogue code + in-domain qualifier, bare catalogue codes, constant codes.
      expect(admit('unresolved:missing_required_field:name')).toBe(true);
      expect(admit('unresolved:missing_required_field:daysPerWeek')).toBe(true);
      expect(admit('unresolved:invalid_value:exercises')).toBe(true);
      expect(admit('unresolved:relationship_missing:programs')).toBe(true);
      expect(admit('unresolved:native_uniqueness:WorkoutPlan')).toBe(true);
      expect(admit('unresolved:no_native_destination:workouts')).toBe(true);
      expect(admit('unresolved:no_native_client_principal')).toBe(true);
      expect(admit('unresolved:exercise_reference')).toBe(true);
      for (const c of CONSTANT_REASON_CODES) expect(admit(c)).toBe(true);
      expect(admit('unresolved:not_reconstructed')).toBe(true);
      expect(admit('unresolved:reason_unrecognised')).toBe(true);
      expect(admit('failed')).toBe(true);
      expect(admit('missing_source_id')).toBe(true);
      expect(admit('unresolved_family:routines')).toBe(true);
      // Folded: off-domain qualifier, unknown code, wrong shape, unknown bare word.
      expect(admit('unresolved:missing_required_field:Jane')).toBe(false);
      expect(admit('unresolved:missing_required_field:title')).toBe(false);
      expect(admit('unresolved:missing_required_field')).toBe(false); // qualified, no qualifier
      expect(admit('unresolved:no_native_client_principal:programs')).toBe(false); // bare+qual
      expect(admit('unresolved:frobnicate')).toBe(false); // not a catalogue code
      expect(admit('unresolved:frobnicate:name')).toBe(false);
      expect(admit('unresolved:missing_required_field:name:extra')).toBe(false);
      expect(admit('unresolved:missing_required_field:')).toBe(false);
      expect(admit('unresolved:')).toBe(false);
      expect(admit('frobnicate')).toBe(false);
      expect(admit('Jane')).toBe(false);
      expect(admit('unresolved_family:Jane')).toBe(false);
      // unsupported_platform: grammar always; staged-platform membership when the caller has it.
      expect(admit('unsupported_platform:s9c-proof')).toBe(true);
      expect(admit('unsupported_platform:s9c-proof', new Set(['s9c-proof']))).toBe(true);
      expect(admit('unsupported_platform:s9c-proof', new Set(['other']))).toBe(false);
      expect(admit('unsupported_platform:Jane Doe')).toBe(false);
      expect(admit('unsupported_platform:Jane Doe', new Set(['Jane Doe']))).toBe(false);
    });

    it('C-7 / C-10: the DTO enums and the S9-A literals are the same closed sets', () => {
      expect([...FAMILY_QUALIFIERS]).toEqual(['roster_bridge_pending']);
      expect([...PROJECTED_FAMILY_QUALIFIERS]).toEqual([...FAMILY_QUALIFIERS]);
      expect([...RELATIONSHIP_CLOSURES].sort()).toEqual([
        'not_applicable',
        'unverified',
        'verified',
      ]);
      expect([...PROJECTED_RELATIONSHIP_CLOSURES]).toEqual([...RELATIONSHIP_CLOSURES]);
      const fam: ReconciliationFamilyV1 = {
        ...reconcile(MIXED).report.families[0],
        qualifiers: ['roster_bridge_pending'],
      };
      const report: ReconciliationReportV1 = { ...reconcile(MIXED).report, families: [fam] };
      const [routines] = ScoutLifecycleService.projectFamilies(
        [{ entity_type: 'routines', _count: { _all: 2 } }],
        {},
        report,
      );
      expect(routines.qualifiers).toEqual(['roster_bridge_pending']);
      for (const q of routines.qualifiers ?? []) expect(FAMILY_QUALIFIERS).toContain(q);
    });

    it('R10: the projection is deterministic — identical facts give identical entries', () => {
      const a = ScoutLifecycleService.projectFamilies(STAGED, LEDGER, reconcile(withNotes).report);
      const b = ScoutLifecycleService.projectFamilies(STAGED, LEDGER, reconcile(withNotes).report);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });
});
