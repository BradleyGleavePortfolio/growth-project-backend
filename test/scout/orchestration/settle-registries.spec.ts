import type { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import type { RunPassResult } from '../../../src/scout/reconstruct/orchestration/run-context';
import {
  ReconciliationFactsService,
  type FactsDb,
} from '../../../src/scout/reconciliation/facts.service';
import type { ReconciliationFacts } from '../../../src/scout/reconciliation/types';
import {
  NO_RUN_PACKAGE,
  runPackageDigest,
  RunRegistryPinChangedError,
  SourceRegistryProvider,
  type RunRegistries,
} from '../../../src/scout/reconstruct/source-registry.provider';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import {
  COACH,
  LEARNED,
  PACKAGE,
  PINNED,
  TOKEN,
  recordingSource,
  type RecordingSource,
} from '../reconstruct/l06-learned-package.fixture';

/**
 * L2a r2 — R588-B-1: ONE settle interprets a run through ONE registry set.
 *
 * `onTransferSettled` resolves the run's registries once (on the root client), hands that object
 * to the reconstruction pass and to the facts collector (whose coverage evaluator reads the same
 * induction registry), and — inside the settle transaction, under the run-row lock — re-reads the
 * pin on THAT transaction and refuses to settle if it changed. A pin that appears (or changes)
 * mid-settle therefore fails the settle closed: nothing terminal is written and the run stays
 * open for the lazy deadline, exactly like any other failed settle.
 *
 * On f4c469c (L2a r1) the pass and the tail each resolved the pin themselves (probe P1): the
 * mid-settle case below settled a terminal instead of refusing, and the pass / collector were
 * never handed a shared registries object.
 */

const EMPTY_FACTS: ReconciliationFacts = {
  claim: 'success',
  families: [],
  relationships: [],
  spec_families: [],
  ledger_without_staged: 0,
  coverage: null,
};

const passResult = (): RunPassResult => ({ families: [], unmapped_families: [], stopped: null });

const open = {
  execution_epoch: 1,
  terminal_status: null,
  fenced_at: null,
  fence_reason: null,
  deadline_at: new Date(Date.now() + 60_000),
  accepted_start_at: new Date('2026-09-29T10:00:00.000Z'),
};

function make(source: RecordingSource) {
  const order: string[] = [];
  const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FOR NO KEY UPDATE')) {
      order.push('lock');
      return [open];
    }
    return [{ execution_epoch: 1 }];
  });
  const executeRaw = jest.fn(async (strings: TemplateStringsArray) => {
    order.push(strings.join('?').includes('terminal_status = ') ? 'terminal' : 'exec');
    return 1;
  });
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    scoutImportCompletion: { findUnique: jest.fn(async () => ({ terminal_status: 'success' })) },
    scoutIngestEntity: { groupBy: jest.fn(async () => []) },
    scoutReconstructionLedger: { groupBy: jest.fn(async () => []) },
    scoutRunObservation: { findMany: jest.fn(async () => []) },
    scoutRunSettledBasis: { create: jest.fn(async () => ({})) },
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutImport: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  });
  const capture = jest.fn();
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture,
  });
  const reconstructRun = jest.fn(async (..._args: unknown[]) => {
    order.push('pass');
    return passResult();
  });
  const collect = jest.fn(async (..._args: unknown[]) => {
    order.push('facts');
    return EMPTY_FACTS;
  });
  const reconstruct = Object.assign(
    Object.create(ScoutReconstructService.prototype) as ScoutReconstructService,
    { reconstructRun },
  );
  const facts = Object.assign(
    Object.create(ReconciliationFactsService.prototype) as ReconciliationFactsService,
    { collect },
  );
  const registries = new SourceRegistryProvider(source);
  const forRun = jest.spyOn(registries, 'forRun');
  const verifyPin = jest.spyOn(registries, 'verifyPin');
  const service = new ScoutLifecycleService(prisma, analytics, reconstruct, facts, registries);
  return {
    service,
    prisma,
    tx,
    order,
    executeRaw,
    capture,
    reconstructRun,
    collect,
    forRun,
    verifyPin,
  };
}

const terminalWrites = (executeRaw: jest.Mock) =>
  executeRaw.mock.calls.filter((c: unknown[]) =>
    (c[0] as TemplateStringsArray).join('?').includes('terminal_status = '),
  );

describe('L2a r2 — one registry set per settle (R588-B-1)', () => {
  it('resolves ONCE and threads the same RunRegistries through the pass and the facts/evaluator', async () => {
    const source = recordingSource();
    const h = make(source);
    await h.service.onTransferSettled(COACH, PINNED, 1);

    expect(h.forRun).toHaveBeenCalledTimes(1);
    const resolved = (await h.forRun.mock.results[0].value) as RunRegistries;
    expect(resolved.pinned).toBe(PACKAGE);
    expect(resolved.pinDigest).toBe(runPackageDigest(PACKAGE));
    expect(resolved.sourceMappers.has(LEARNED)).toBe(true);

    // The pass and the collector receive the identical object.
    expect(h.reconstructRun).toHaveBeenCalledTimes(1);
    expect(h.reconstructRun.mock.calls[0][3]).toBe(resolved);
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.collect.mock.calls[0][4]).toBe(resolved);

    // The pin is resolved on the root client before the pass and verified on the settle tx,
    // after the lock and before any facts read.
    expect(source.lookups.map((l) => l.db)).toEqual([h.prisma, h.tx]);
    expect(h.verifyPin).toHaveBeenCalledTimes(1);
    expect(h.verifyPin.mock.calls[0][0]).toBe(h.tx);
    expect(h.verifyPin.mock.calls[0][3]).toBe(resolved);
    expect(h.order).toEqual(['pass', 'lock', 'facts', 'terminal']);
    expect(terminalWrites(h.executeRaw)).toHaveLength(1);
  });

  it('a pin that appears mid-settle fails the settle CLOSED: no facts, no terminal, no settled event', async () => {
    // No pin when the pass resolves; the package is pinned by the time the tail runs.
    const source = recordingSource((n) => (n === 1 ? null : PACKAGE));
    const h = make(source);
    const err: unknown = await h.service.onTransferSettled(COACH, PINNED, 1).then(
      () => new Error('settled'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RunRegistryPinChangedError);
    expect(err).toMatchObject({
      coachId: COACH,
      intentId: PINNED,
      expected: null,
      actual: runPackageDigest(PACKAGE),
    });
    // The pass ran on the unpinned registries; the tail refused before reading any facts.
    expect((h.reconstructRun.mock.calls[0][3] as RunRegistries).pinned).toBeNull();
    expect(h.collect).not.toHaveBeenCalled();
    expect(terminalWrites(h.executeRaw)).toHaveLength(0);
    expect(h.order).toEqual(['pass', 'lock']);
    expect(h.capture).not.toHaveBeenCalledWith(COACH, Events.SCOUT_RUN_SETTLED, expect.anything());
  });

  it('a pin that changes to a different package mid-settle is refused too', async () => {
    const other = {
      ...PACKAGE,
      nativeRuleSet: null,
      manifest: null,
    };
    const h = make(recordingSource((n) => (n === 1 ? PACKAGE : other)));
    await expect(h.service.onTransferSettled(COACH, PINNED, 1)).rejects.toBeInstanceOf(
      RunRegistryPinChangedError,
    );
    expect(h.collect).not.toHaveBeenCalled();
    expect(terminalWrites(h.executeRaw)).toHaveLength(0);
  });

  it('a run with no pin settles exactly as before: the file registries, one lookup each side', async () => {
    const h = make(recordingSource(() => null));
    await h.service.onTransferSettled(COACH, PINNED, 1);
    const resolved = h.reconstructRun.mock.calls[0][3] as RunRegistries;
    expect(resolved).toMatchObject({ pinned: null, pinDigest: null });
    const files = new SourceRegistryProvider(NO_RUN_PACKAGE).files;
    expect(resolved.sourceMappers).toBe(files.sourceMappers);
    expect(resolved.induction).toBe(files.induction);
    expect(h.collect.mock.calls[0][4]).toBe(resolved);
    expect(terminalWrites(h.executeRaw)).toHaveLength(1);
  });
});

// ── The collector interprets through the threaded object, not a fresh read ──────────────────

type Row = Record<string, unknown>;

/** The tables `collect` reads, in memory (the L06 FakeFactsDb, reduced). */
function factsDb(staged: Row[]): FactsDb {
  const tables: Record<string, Row[]> = {
    scoutImportCompletion: [],
    scoutIngestEntity: staged,
    scoutReconstructionLedger: [],
    importNativeProvenance: [],
    person: [],
    workoutProgram: [],
    workoutPlan: [],
    workoutPlanExercise: [],
    scoutRunDeclaration: [],
    scoutRunObservation: [],
  };
  const query = (model: string, args: Row, unique: boolean) => {
    const where = (args.where ?? {}) as Row;
    let rows = tables[model].filter((r) =>
      Object.entries(where).every(([k, v]) =>
        k === 'coach_id_intent_id'
          ? r.coach_id === (v as Row).coach_id && r.intent_id === (v as Row).intent_id
          : v !== null && typeof v === 'object' && 'in' in (v as Row)
            ? ((v as Row).in as unknown[]).includes(r[k])
            : r[k] === v,
      ),
    );
    if (unique) return Promise.resolve(rows[0] ?? null);
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    const select = args.select as Row | undefined;
    return Promise.resolve(
      rows.map((r) =>
        select === undefined
          ? { ...r }
          : Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])),
      ),
    );
  };
  const db: Record<string, any> = {};
  for (const model of Object.keys(tables)) {
    db[model] = {
      findMany: (args: Row) => query(model, args, false),
      findUnique: (args: Row) => query(model, args, true),
    };
  }
  return db as FactsDb;
}

describe('L2a r2 — collect() honours the settle-resolved registries (probe P1 closed)', () => {
  const staged: Row[] = [
    {
      id: 'staged-1',
      coach_id: COACH,
      intent_id: PINNED,
      entity_type: TOKEN.client_history,
      source_id: 'j-1',
      source_platform: LEARNED,
      payload: { member_id: 'm-1', headline: 'note' } as Prisma.JsonValue,
    },
  ];

  it('with the pass-time (unpinned) registries threaded, a pin appearing later does not change the grouping', async () => {
    // The source flips: null for the settle's one resolution, the package on any later read.
    const source = recordingSource((n) => (n === 1 ? null : PACKAGE));
    const provider = new SourceRegistryProvider(source);
    const resolved = await provider.forRun(factsDb([]), COACH, PINNED);
    const facts = new ReconciliationFactsService({}, provider);

    const threaded = await facts.collect(factsDb(staged), COACH, PINNED, null, resolved);
    expect(threaded.families.map((f) => [f.family, f.mapped])).toEqual([
      [TOKEN.client_history, false],
    ]);
    // Exactly one pin read: the collector did not re-resolve.
    expect(source.lookups).toHaveLength(1);

    // Without the threaded object (the r1 behaviour, still the status read's path) it re-reads
    // the pin on the handle it is given — and now sees the package.
    const reread = await facts.collect(factsDb(staged), COACH, PINNED);
    expect(reread.families.map((f) => [f.family, f.mapped])).toEqual([['client_history', true]]);
    expect(source.lookups).toHaveLength(2);
  });
});
