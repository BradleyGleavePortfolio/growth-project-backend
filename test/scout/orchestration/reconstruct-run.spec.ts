import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import type { FamilyReconstructor, PersistResult } from '../../../src/scout/reconstruct/families';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import type { ServerRunContext } from '../../../src/scout/reconstruct/orchestration/run-context';
import {
  buildSourceMapperRegistry,
  type SourceMapper,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_MAX_ROWS } from '../../../src/scout/scout-reconstruct.dto';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';

/**
 * S8-G engine seam under test with stubbed families (pattern: S8-C
 * test/scout/reconstruct/native/engine-handoff.spec.ts FakePrisma):
 *  - the §3.1 gate is the FIRST statement of EVERY per-row transaction of a server pass, for
 *    success, skip, failure and unmapped outcomes (G02);
 *  - the coach-JWT legacy route keeps the pre-S8-G statement sequence and never gates (G08);
 *  - a closed gate (zero rows or another epoch) stops the pass at that row, writes nothing
 *    further and never records a fabricated `failed` (G03);
 *  - §3.8 order, token forwarding into the ledger, unmapped tokens ledgered `skipped` with the
 *    exact S8-A reason, over-ceiling / provenance-conflict isolation (G01, G10);
 *  - enumeration is tenant/intent scoped (G11).
 * The real PG behaviour of the gate (row lock, fence race) is proven in test/rls-g2-s8g.spec.ts.
 */

const COACH = 'coach-A';
const INTENT = '3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const PLATFORM = 's8g-proof';
const TOKEN = {
  clients: 'people',
  programs: 'blocks',
  workouts: 'routines',
  client_history: 'log',
};

interface Staged {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_platform: string;
  source_id: string;
  payload: Prisma.JsonValue;
}
interface LedgerRow {
  entity_type: string;
  source_platform: string;
  source_id: string;
  status: string;
  target_id: string | null;
  target_kind?: string;
  reason: string | null;
}

/** Ordered log of what happened INSIDE each $transaction callback; 'gate' is the §3.1 UPDATE. */
class FakePrisma {
  staged: Staged[] = [];
  ledger = new Map<string, LedgerRow>();
  txLog: string[][] = [];
  /** Epochs the gate returns per call (default 1); `null` → zero rows. */
  gateScript: (number | null)[] = [];
  gateCalls = 0;
  groupByArgs: unknown[] = [];
  /** Override the staged count the planner sees for one token (over-ceiling fixture). */
  countOverride = new Map<string, number>();
  private current: string[] | null = null;
  note(n: string) {
    if (this.current) this.current.push(n);
  }
  private key(r: Pick<LedgerRow, 'entity_type' | 'source_platform' | 'source_id'>) {
    return `${r.entity_type}|${r.source_platform}|${r.source_id}`;
  }
  private select(where: Record<string, unknown>) {
    return this.staged.filter((s) =>
      Object.entries(where).every(([k, v]) => s[k as keyof Staged] === v),
    );
  }
  scoutImport = { findUnique: async () => ({ terminal_status: 'success' }) };
  scoutIngestEntity = {
    groupBy: async (args: { where: Record<string, unknown> }) => {
      this.groupByArgs.push(args);
      const out = new Map<string, { source_platform: string; entity_type: string; n: number }>();
      for (const r of this.select(args.where)) {
        const k = `${r.source_platform}|${r.entity_type}`;
        const prev = out.get(k)?.n ?? 0;
        out.set(k, { source_platform: r.source_platform, entity_type: r.entity_type, n: prev + 1 });
      }
      return [...out.values()].map((g) => ({
        source_platform: g.source_platform,
        entity_type: g.entity_type,
        _count: { _all: this.countOverride.get(g.entity_type) ?? g.n },
      }));
    },
    count: async (args: { where: Record<string, unknown> }) => this.select(args.where).length,
    findMany: async (args: { where: Record<string, unknown>; take?: number; skip?: number }) =>
      this.select(args.where)
        .sort((a, b) => a.source_id.localeCompare(b.source_id))
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 500))
        .map(({ source_id, source_platform, payload, entity_type }) => ({
          source_id,
          source_platform,
          payload,
          entity_type,
        })),
  };
  scoutReconstructionLedger = {
    upsert: async (args: { where: any; create: LedgerRow; update: Partial<LedgerRow> }) => {
      this.note('ledger.upsert');
      const k = this.key(args.where.coach_id_intent_id_entity_type_source_platform_source_id);
      const row = this.ledger.get(k) ?? { ...args.create };
      this.ledger.set(k, row);
      return row;
    },
    updateMany: async (args: { where: any; data: Partial<LedgerRow> }) => {
      this.note('ledger.updateMany');
      const k = this.key(args.where);
      const row = this.ledger.get(k);
      if (row && (args.where.status === undefined || row.status !== 'reconstructed')) {
        Object.assign(row, args.data);
      }
      return { count: row ? 1 : 0 };
    },
    groupBy: async (args: { where: { entity_type: string; source_platform?: string } }) => {
      const rows = [...this.ledger.values()].filter(
        (r) =>
          r.entity_type === args.where.entity_type &&
          (args.where.source_platform === undefined ||
            r.source_platform === args.where.source_platform),
      );
      const by = new Map<string, number>();
      for (const r of rows) by.set(r.status, (by.get(r.status) ?? 0) + 1);
      return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };
  /** The §3.1 gate stand-in: the server context's `gate` calls this on the tx handle. */
  gate = async (): Promise<number | null> => {
    this.note('gate');
    const epoch = this.gateScript[this.gateCalls++];
    return epoch === undefined ? 1 : epoch;
  };
  $transaction = async <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    const log: string[] = [];
    this.txLog.push(log);
    this.current = log;
    try {
      return await fn(this);
    } finally {
      this.current = null;
    }
  };
}

function stubFamily(
  entityType: string,
  persist: (id: string) => PersistResult,
  db: FakePrisma,
): FamilyReconstructor {
  return {
    entityType,
    map: (row) => {
      if (String(row.source_id).startsWith('skip')) return { ok: false, reason: 'fixture_skip' };
      if (String(row.source_id).startsWith('boom')) throw new Error('fixture private payload');
      return { ok: true, mapped: row };
    },
    async persist(_tx, _coach, sourceId) {
      db.note('persist:' + entityType);
      return persist(sourceId);
    },
  };
}

const spec = parseSourceMappingSpec(
  {
    specVersion: 1,
    sourcePlatform: PLATFORM,
    steps: { people: 'clients', blocks: 'programs', routines: 'workouts', log: 'client_history' },
    families: {
      clients: { displayName: { paths: [['name']], coerce: 'string' } },
      programs: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      workouts: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
      client_history: {
        clientSourceId: { paths: [['client_id']], coerce: 'string_or_finite_number' },
        label: { paths: [['title']], coerce: 'string' },
      },
    },
  },
  'reconstruct-run.spec:fixture',
);

function makeService(db: FakePrisma, extraMappers: [string, SourceMapper][] = []) {
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, db);
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture: jest.fn(),
  });
  const service = new ScoutReconstructService(prisma, analytics);
  const families = new Map<string, FamilyReconstructor>();
  for (const f of ['clients', 'programs', 'workouts', 'client_history']) {
    families.set(
      f,
      stubFamily(
        f,
        (id) => ({
          ok: true,
          targetId: `${f}:${id}`,
          targetKind: 'scout_entity',
          unresolvedChildren: 0,
        }),
        db,
      ),
    );
  }
  // Injected the same way the S8-G worker does: the family registry and the planner's mappers.
  Object.assign(service, {
    families,
    sourceMappers: new Map([...buildSourceMapperRegistry([spec]), ...extraMappers]),
  });
  return { service, analytics, families };
}

const row = (entity_type: string, source_id: string, source_platform = PLATFORM): Staged => ({
  coach_id: COACH,
  intent_id: INTENT,
  entity_type,
  source_platform,
  source_id,
  payload: {},
});

const serverCtx = (epoch = 1): ServerRunContext => ({
  mode: 'server',
  epoch,
  gate: (tx) => (tx as Prisma.TransactionClient & FakePrisma).gate(),
});

describe('reconstructRun — gate-first in every per-row transaction (G02)', () => {
  it('gates success, skip, failure and unmapped outcomes; the ledger carries the staged token', async () => {
    const db = new FakePrisma();
    db.staged = [
      row(TOKEN.clients, 'a'),
      row(TOKEN.clients, 'skip-b'),
      row(TOKEN.clients, 'boom-c'),
      row('notes', 'n1'),
    ];
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(db.txLog).toEqual([
      ['gate', 'persist:clients', 'ledger.upsert', 'ledger.updateMany'],
      ['gate', 'ledger.upsert', 'ledger.updateMany'],
      ['gate', 'ledger.upsert', 'ledger.updateMany'],
      ['gate', 'ledger.upsert', 'ledger.updateMany'],
    ]);
    // Token forwarding (C4): the ledger groups by the staged token, not the family name.
    expect(db.ledger.get(`people|${PLATFORM}|a`)).toMatchObject({
      status: 'reconstructed',
      target_id: 'clients:a',
      target_kind: 'scout_entity',
    });
    expect(db.ledger.get(`people|${PLATFORM}|skip-b`)).toMatchObject({
      status: 'skipped',
      reason: 'fixture_skip',
    });
    expect(db.ledger.get(`people|${PLATFORM}|boom-c`)).toMatchObject({ status: 'failed' });
    expect(db.ledger.get(`people|${PLATFORM}|boom-c`)?.reason).not.toContain('private payload');
    expect(db.ledger.get(`notes|${PLATFORM}|n1`)).toMatchObject({
      status: 'skipped',
      reason: 'unresolved_family:notes',
    });
    expect(db.ledger.has(`clients|${PLATFORM}|a`)).toBe(false);
    expect(result.stopped).toBeNull();
    expect(result.unmapped_families).toEqual(['notes']);
    expect(result.families).toEqual([
      {
        token: 'people',
        source_platform: PLATFORM,
        family: 'clients',
        staged: 3,
        reconstructed: 1,
        skipped: 1,
        failed: 1,
        stopped: null,
      },
      {
        token: 'notes',
        source_platform: PLATFORM,
        family: null,
        staged: 1,
        reconstructed: 0,
        skipped: 1,
        failed: 0,
        stopped: null,
      },
    ]);
  });

  it('a gate epoch that differs from the pass epoch closes the row (per-row CAS), nothing written', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.clients, 'a')];
    db.gateScript = [2];
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx(1));
    expect(result.stopped).toBe('gate_closed');
    expect(db.txLog).toEqual([['gate']]);
    expect(db.ledger.size).toBe(0);
  });

  it('captures one SCOUT_RECONSTRUCT_COMPLETED per planned token with ledger read-back counts', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.clients, 'a'), row(TOKEN.programs, 'skip-p'), row('notes', 'n')];
    const { service, analytics } = makeService(db);
    await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(analytics.capture).toHaveBeenCalledTimes(2);
    expect(analytics.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RECONSTRUCT_COMPLETED, {
      intent_id: INTENT,
      entity_type: 'people',
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(analytics.capture).toHaveBeenCalledWith(COACH, Events.SCOUT_RECONSTRUCT_COMPLETED, {
      intent_id: INTENT,
      entity_type: 'blocks',
      staged: 1,
      reconstructed: 0,
      skipped: 1,
      failed: 0,
    });
  });
});

describe('reconstruct (coach-JWT legacy route) — statement-sequence identity (G08)', () => {
  it('never gates and keeps the S8-C per-row sequence and result shape', async () => {
    const db = new FakePrisma();
    db.staged = [row('clients', 'a'), row('clients', 'skip-b'), row('clients', 'boom-c')];
    const { service } = makeService(db);
    const result = await service.reconstruct(COACH, INTENT, 'clients');
    expect(db.gateCalls).toBe(0);
    expect(db.txLog).toEqual([
      ['persist:clients', 'ledger.upsert', 'ledger.updateMany'],
      ['ledger.upsert', 'ledger.updateMany'],
      ['ledger.upsert', 'ledger.updateMany'],
    ]);
    expect(result).toEqual({
      intent_id: INTENT,
      staged: 3,
      reconstructed: 1,
      skipped: 1,
      failed: 1,
    });
    // Legacy rows select no token: the ledger carries the family name as before.
    expect(db.ledger.get(`clients|${PLATFORM}|a`)).toMatchObject({ status: 'reconstructed' });
  });
});

describe('reconstructRun — a closed gate stops the pass (G03/G05)', () => {
  it('stops at the first zero-row gate, writes nothing further, never records a fabricated failed', async () => {
    const db = new FakePrisma();
    db.staged = [
      row(TOKEN.clients, 'a'),
      row(TOKEN.clients, 'b'),
      row(TOKEN.clients, 'c'),
      row(TOKEN.programs, 'p'),
      row('notes', 'n'),
    ];
    db.gateScript = [1, 1, null];
    const { service, analytics } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(result.stopped).toBe('gate_closed');
    expect(db.txLog).toEqual([
      ['gate', 'persist:clients', 'ledger.upsert', 'ledger.updateMany'],
      ['gate', 'persist:clients', 'ledger.upsert', 'ledger.updateMany'],
      ['gate'],
    ]);
    expect([...db.ledger.keys()].sort()).toEqual([`people|${PLATFORM}|a`, `people|${PLATFORM}|b`]);
    expect(db.gateCalls).toBe(3); // programs and the unmapped token never started
    // Families that never completed have no completion event; the tokens are still reported.
    expect(analytics.capture).not.toHaveBeenCalled();
    expect(result.families).toEqual([]);
    expect(result.unmapped_families).toEqual(['notes']);
  });

  it('a closed gate on a skip/failed outcome transaction also stops the pass without a ledger row', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.clients, 'skip-a'), row(TOKEN.clients, 'b')];
    db.gateScript = [null];
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(result.stopped).toBe('gate_closed');
    expect(db.txLog).toEqual([['gate']]);
    expect(db.ledger.size).toBe(0);
  });
});

describe('reconstructRun — family orchestration (G01/G10)', () => {
  it('runs families in §3.8 order independent of staged order, unmapped tokens last', async () => {
    const db = new FakePrisma();
    db.staged = [
      row('notes', 'n'),
      row(TOKEN.client_history, 'h'),
      row(TOKEN.workouts, 'w'),
      row(TOKEN.programs, 'p'),
      row(TOKEN.clients, 'c'),
    ];
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(db.txLog.map((t) => t[1])).toEqual([
      'persist:clients',
      'persist:programs',
      'persist:workouts',
      'persist:client_history',
      'ledger.upsert',
    ]);
    expect(result.families.map((f) => [f.token, f.family])).toEqual([
      ['people', 'clients'],
      ['blocks', 'programs'],
      ['routines', 'workouts'],
      ['log', 'client_history'],
      ['notes', null],
    ]);
  });

  it('isolates an over-ceiling source: no read or write for it, later families proceed, pass not stopped', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.programs, 'p'), row(TOKEN.workouts, 'w')];
    db.countOverride.set(TOKEN.programs, RECONSTRUCT_MAX_ROWS + 1);
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(result.stopped).toBeNull();
    expect(result.families.find((f) => f.token === TOKEN.programs)).toMatchObject({
      stopped: 'over_ceiling',
      staged: RECONSTRUCT_MAX_ROWS + 1,
      reconstructed: 0,
    });
    expect([...db.ledger.keys()]).toEqual([`routines|${PLATFORM}|w`]);
    expect(db.txLog).toHaveLength(1);
  });

  it('a noncanonical staged platform is a structural conflict: nothing written, pass continues', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.programs, 'p', 'Not_Canonical'), row(TOKEN.workouts, 'w')];
    const { service } = makeService(db);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(result.stopped).toBeNull();
    expect(result.families.find((f) => f.source_platform === 'Not_Canonical')).toMatchObject({
      token: TOKEN.programs,
      family: null,
      stopped: 'provenance_conflict',
      reconstructed: 0,
      skipped: 0,
      failed: 0,
    });
    expect([...db.ledger.keys()]).toEqual([`routines|${PLATFORM}|w`]);
  });

  it('a provenance conflict inside a planned family stops that family only', async () => {
    // A mapper registered for a noncanonical platform cannot exist through the parser; a hand-built
    // one exercises the engine's own structural refusal on the row.
    const db = new FakePrisma();
    db.staged = [row(TOKEN.programs, 'p', 'Not_Canonical'), row(TOKEN.workouts, 'w')];
    const real = buildSourceMapperRegistry([spec]).get(PLATFORM);
    if (!real) throw new Error('fixture mapper missing');
    const rogue: SourceMapper = {
      sourcePlatform: 'Not_Canonical',
      spec: real.spec,
      mapClient: (r) => real.mapClient(r),
      mapEntity: (family, r) => real.mapEntity(family, r),
      resolveStep: () => ({ ok: true, family: 'programs' }),
    };
    const { service } = makeService(db, [['Not_Canonical', rogue]]);
    const result = await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(result.stopped).toBeNull();
    expect(result.families.find((f) => f.token === TOKEN.programs)).toMatchObject({
      family: 'programs',
      stopped: 'provenance_conflict',
    });
    expect([...db.ledger.keys()]).toEqual([`routines|${PLATFORM}|w`]);
  });

  it('does not write terminal fields: only ledger and target calls appear in any transaction', async () => {
    const db = new FakePrisma();
    db.staged = [row(TOKEN.clients, 'a'), row('notes', 'n')];
    const { service } = makeService(db);
    await service.reconstructRun(COACH, INTENT, serverCtx());
    const seen = new Set(db.txLog.flat());
    expect([...seen].sort()).toEqual([
      'gate',
      'ledger.updateMany',
      'ledger.upsert',
      'persist:clients',
    ]);
  });
});

describe('reconstructRun — tenancy (G11)', () => {
  it('enumerates only the calling coach and intent', async () => {
    const db = new FakePrisma();
    db.staged = [
      row(TOKEN.clients, 'a'),
      { ...row(TOKEN.clients, 'a'), coach_id: 'coach-B' },
      { ...row(TOKEN.clients, 'z'), intent_id: 'other' },
    ];
    const { service } = makeService(db);
    await service.reconstructRun(COACH, INTENT, serverCtx());
    expect(db.groupByArgs[0]).toMatchObject({
      by: ['source_platform', 'entity_type'],
      where: { coach_id: COACH, intent_id: INTENT },
    });
    expect(db.ledger.size).toBe(1);
  });
});
