import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { PrismaService } from '../../../src/prisma.service';
import { parseInductionManifest, parseEvidence } from '../../../src/scout/induction/parse';
import {
  buildInductionRegistry,
  loadInductionManifests,
} from '../../../src/scout/induction/manifest-registry';
import { ObservationService } from '../../../src/scout/induction/observation.service';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import {
  ReconciliationFactsService,
  type FactsDb,
} from '../../../src/scout/reconciliation/facts.service';
import {
  buildFamilyRegistry,
  buildRunFamilyRegistry,
} from '../../../src/scout/reconstruct/families';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import {
  buildNativeRuleRegistry,
  loadNativeRuleSets,
} from '../../../src/scout/reconstruct/native/native-rule-registry';
import { parseNativeRuleSet } from '../../../src/scout/reconstruct/native/native-rules';
import {
  buildSourceMapperRegistry,
  loadSourceMappingSpecs,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import {
  NO_RUN_PACKAGE,
  SourceRegistryProvider,
  buildSourceRegistries,
  composeRunArtifacts,
  defaultSourceRegistryProvider,
  loadSourceArtifacts,
  type RunPackage,
  type RunPackageSource,
} from '../../../src/scout/reconstruct/source-registry.provider';
import { ScoutEntitiesService } from '../../../src/scout/scout-entities.service';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { ScoutRosterService } from '../../../src/scout/scout-roster.service';
import { rawEvidence } from '../../utils/g2-s10b-fixtures';

/**
 * L06 (docs/decisions/2026-09-27-learn-and-remember.md D-L0-5, L2a slice): ONE
 * `SourceRegistryProvider` replaces the seven registry construction sites. Every site resolves a
 * run-pinned learned slug through `forRun(coachId, intentId)` and still resolves the repository
 * file specs; a slug in both a file and the run's package throws at composition (before any row
 * is read); a run with NO pin sees exactly the file registries — the identical maps the loaders
 * and builders produced before this slice.
 *
 * The learned slug is synthetic (a hostname-shaped token as D-L0-5 defines for a learned source)
 * and lives only in this spec: no file under `src/**` names it.
 */

const COACH = 'coach-l06';
/** The run whose pin carries the learned package. */
const PINNED = '0f1e2d3c-4b5a-4978-8899-aabbccddeeff';
/** A run of the same coach with no pin: file registries only. */
const UNPINNED = '11111111-2222-4333-8444-555555555555';
const LEARNED = 'app.l06-learned.example';
const TOKEN = { clients: 'members', client_history: 'journal', workouts: 'sessions' } as const;

const LEARNED_SPEC = parseSourceMappingSpec(
  {
    specVersion: 1,
    sourcePlatform: LEARNED,
    steps: {
      [TOKEN.clients]: 'clients',
      [TOKEN.client_history]: 'client_history',
      [TOKEN.workouts]: 'workouts',
    },
    families: {
      clients: { displayName: { paths: [['profile', 'name']], coerce: 'string' } },
      client_history: {
        clientSourceId: { paths: [['member_id']], coerce: 'string' },
        label: { paths: [['headline']], coerce: 'string' },
      },
      workouts: {
        clientSourceId: { paths: [['member_id']], coerce: 'string' },
        label: { paths: [['headline']], coerce: 'string' },
      },
    },
  },
  'l06:learned-spec',
);
const LEARNED_RULES = parseNativeRuleSet(
  {
    specVersion: 1,
    sourcePlatform: LEARNED,
    families: {
      workouts: {
        type: { kind: 'enum', paths: [['kind']], map: { lift: 'strength' }, default: 'strength' },
      },
    },
  },
  'l06:learned-rules',
);
const LEARNED_MANIFEST = parseInductionManifest(
  {
    manifestVersion: 1,
    sourcePlatform: LEARNED,
    expectedFamilies: ['client_history', 'clients', 'workouts'],
    basisKinds: {
      client_history: ['source_signed_enumeration'],
      clients: ['source_signed_enumeration'],
      workouts: ['source_signed_enumeration'],
    },
    verifiers: [
      {
        key_id: 'l06-key-1',
        alg: 'ed25519',
        public_key_b64: Buffer.alloc(32, 1).toString('base64'),
      },
    ],
    nativeRules: 'declared',
  },
  'l06:learned-manifest',
);
const PACKAGE: RunPackage = {
  spec: LEARNED_SPEC,
  nativeRuleSet: LEARNED_RULES,
  manifest: LEARNED_MANIFEST,
};

/** A `RunPackageSource` that pins `PACKAGE` to exactly (COACH, PINNED) and records every lookup. */
function pinning(pkg: RunPackage = PACKAGE): RunPackageSource & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    forRun: (coachId, intentId) => {
      lookups.push(`${coachId}/${intentId}`);
      return Promise.resolve(coachId === COACH && intentId === PINNED ? pkg : null);
    },
  };
}

const provider = (source: RunPackageSource = pinning()) =>
  new SourceRegistryProvider(undefined, source);

const analytics = () =>
  Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture: jest.fn(),
  });
const asPrisma = (db: object): PrismaService =>
  Object.assign(Object.create(PrismaService.prototype) as PrismaService, db);

/** Something the file loaders registered, read from the files (never a literal here). */
const fileSlug = (): string => {
  const specs = loadSourceMappingSpecs();
  expect(specs.length).toBeGreaterThan(0);
  return specs[0].sourcePlatform;
};

// ── The provider itself ──────────────────────────────────────────────────────────────────────

describe('L06 — SourceRegistryProvider: files, pins and the double-definition error', () => {
  it('a run with no pin sees exactly the file registries (same maps as the unchanged builders)', async () => {
    const p = provider(NO_RUN_PACKAGE);
    const run = await p.forRun(COACH, UNPINNED);
    expect(run.pinned).toBeNull();
    expect(run.sourceMappers).toBe(p.files.sourceMappers);
    expect(run.nativeRules).toBe(p.files.nativeRules);
    expect(run.induction).toBe(p.files.induction);
    // Every call returns the identical objects: nothing is rebuilt per run without a pin.
    expect(await p.forRun('another-coach', UNPINNED)).toBe(run);

    // Byte-identical composition: the pre-L2a construction sites built exactly these.
    expect([...p.files.sourceMappers.keys()]).toEqual([...buildSourceMapperRegistry().keys()]);
    expect([...p.files.sourceMappers.values()].map((m) => m.spec)).toEqual(
      loadSourceMappingSpecs(),
    );
    expect(p.files.nativeRules).toEqual(buildNativeRuleRegistry(loadNativeRuleSets()));
    expect(p.files.induction).toEqual(
      buildInductionRegistry({
        manifests: loadInductionManifests(),
        specs: loadSourceMappingSpecs(),
        nativeRuleSets: loadNativeRuleSets(),
      }),
    );
    expect(p.files.sourceMappers.has(LEARNED)).toBe(false);
  });

  it('the default provider is one per process and its files are the repository files', () => {
    const d = defaultSourceRegistryProvider();
    expect(defaultSourceRegistryProvider()).toBe(d);
    expect(d.files).toBe(provider().files);
    expect(d.artifacts).toEqual(loadSourceArtifacts());
    expect(d.files.sourceMappers.has(fileSlug())).toBe(true);
  });

  it('a pinned run composes the files with its package; the files themselves are untouched', async () => {
    const src = pinning();
    const p = provider(src);
    const run = await p.forRun(COACH, PINNED);
    expect(run.pinned).toBe(PACKAGE);
    expect(run.sourceMappers.has(LEARNED)).toBe(true);
    expect(run.sourceMappers.has(fileSlug())).toBe(true);
    expect([...run.sourceMappers.keys()]).toEqual([...p.files.sourceMappers.keys(), LEARNED]);
    expect(run.nativeRules.get(LEARNED)).toBe(LEARNED_RULES);
    expect(run.induction.packages.get(LEARNED)?.manifest).toBe(LEARNED_MANIFEST);
    expect(run.induction.specFamilies.get(LEARNED)).toEqual([
      'client_history',
      'clients',
      'workouts',
    ]);
    // The file registries never learn: the pin is the run's, not the process's.
    expect(p.files.sourceMappers.has(LEARNED)).toBe(false);
    expect((await p.forRun(COACH, UNPINNED)).sourceMappers.has(LEARNED)).toBe(false);
    expect(src.lookups).toEqual([`${COACH}/${PINNED}`, `${COACH}/${UNPINNED}`]);
  });

  it('a package without rules or manifest composes too (declares nothing; never provable)', async () => {
    const run = await provider(
      pinning({ spec: LEARNED_SPEC, nativeRuleSet: null, manifest: null }),
    ).forRun(COACH, PINNED);
    expect(run.sourceMappers.has(LEARNED)).toBe(true);
    expect(run.nativeRules.has(LEARNED)).toBe(false);
    expect(run.induction.packages.has(LEARNED)).toBe(false);
    expect(run.induction.specFamilies.has(LEARNED)).toBe(true);
  });

  it('a slug present in both a file spec and the run package throws at composition (file wins is never silent)', async () => {
    const slug = fileSlug();
    const doubled: RunPackage = {
      spec: parseSourceMappingSpec({ ...LEARNED_SPEC, sourcePlatform: slug }, 'l06:doubled'),
      nativeRuleSet: null,
      manifest: null,
    };
    await expect(provider(pinning(doubled)).forRun(COACH, PINNED)).rejects.toThrow(
      `source platform ${slug} is defined by both a repository mapping spec and the run's learned package`,
    );
    expect(() => composeRunArtifacts(loadSourceArtifacts(), doubled)).toThrow(/defined by both/);
  });

  it('a package whose parts disagree on their slug throws', () => {
    const files = loadSourceArtifacts();
    expect(() =>
      composeRunArtifacts(files, {
        spec: LEARNED_SPEC,
        nativeRuleSet: parseNativeRuleSet(
          { ...LEARNED_RULES, sourcePlatform: 'other.l06.example' },
          'l06:other-rules',
        ),
        manifest: null,
      }),
    ).toThrow(/native rule set names other\.l06\.example/);
    expect(() =>
      composeRunArtifacts(files, {
        spec: LEARNED_SPEC,
        nativeRuleSet: null,
        manifest: parseInductionManifest(
          { ...LEARNED_MANIFEST, sourcePlatform: 'other.l06.example', nativeRules: 'absent' },
          'l06:other-manifest',
        ),
      }),
    ).toThrow(/manifest names other\.l06\.example/);
  });

  it('the S10-C cross-check governs the composed set too (a declared manifest without rules is refused)', () => {
    const files = loadSourceArtifacts();
    expect(() =>
      buildSourceRegistries(
        composeRunArtifacts(files, {
          spec: LEARNED_SPEC,
          nativeRuleSet: null,
          manifest: LEARNED_MANIFEST,
        }),
      ),
    ).toThrow(/contradicts the loaded native rule sets/);
  });

  it('a corrupt pin fails the run loudly instead of falling back to the files', async () => {
    const p = provider({ forRun: () => Promise.reject(new Error('pin unreadable')) });
    await expect(p.forRun(COACH, PINNED)).rejects.toThrow('pin unreadable');
  });
});

// ── Site 1 + 2: families.ts (legacy families' mappers; native families' mappers and rules) ───

describe('L06 — families.ts resolves through the provider', () => {
  const learnedClient = {
    source_id: 'm-1',
    source_platform: LEARNED,
    payload: { profile: { name: 'Synthetic Member' } } as Prisma.JsonValue,
    entity_type: TOKEN.clients,
  };
  const learnedHistory = {
    source_id: 'j-1',
    source_platform: LEARNED,
    payload: { member_id: 'm-1', headline: 'note' } as Prisma.JsonValue,
    entity_type: TOKEN.client_history,
  };
  const learnedWorkout = {
    source_id: 's-1',
    source_platform: LEARNED,
    payload: { member_id: 'm-1', headline: 'Push', kind: 'lift' } as Prisma.JsonValue,
    entity_type: TOKEN.workouts,
  };

  it('every family of a pinned run — legacy and native — maps the learned slug', async () => {
    const families = buildRunFamilyRegistry(await provider().forRun(COACH, PINNED));
    expect([...families.keys()]).toEqual(['clients', 'workouts', 'client_history', 'programs']);
    expect(families.get('clients')!.map(learnedClient)).toMatchObject({ ok: true });
    expect(families.get('client_history')!.map(learnedHistory)).toMatchObject({ ok: true });
    expect(families.get('workouts')!.map(learnedWorkout)).toMatchObject({ ok: true });
  });

  it('the same families of a run with no pin refuse the learned slug with the exact S8-A reason', async () => {
    const families = buildRunFamilyRegistry(await provider().forRun(COACH, UNPINNED));
    for (const [family, row] of [
      ['clients', learnedClient],
      ['client_history', learnedHistory],
      ['workouts', learnedWorkout],
    ] as const) {
      expect(families.get(family)!.map(row)).toEqual({
        ok: false,
        reason: `unsupported_platform:${LEARNED}`,
      });
    }
  });

  it('buildFamilyRegistry() (no options) is the file registries: it still resolves the file specs', () => {
    const slug = fileSlug();
    const files = buildFamilyRegistry();
    const fromProvider = buildRunFamilyRegistry(defaultSourceRegistryProvider().files);
    expect([...files.keys()]).toEqual([...fromProvider.keys()]);
    const spec = defaultSourceRegistryProvider().files.sourceMappers.get(slug)!.spec;
    const [token, family] = Object.entries(spec.steps)[0];
    const row = { source_id: 'x-1', source_platform: slug, payload: {}, entity_type: token };
    // Whatever the file spec makes of an empty payload, both registries make of it identically.
    expect(files.get(family)!.map(row)).toEqual(fromProvider.get(family)!.map(row));
    // And the learned slug is nobody's: the files never learn.
    expect(files.get('clients')!.map(learnedClient)).toEqual({
      ok: false,
      reason: `unsupported_platform:${LEARNED}`,
    });
  });

  it('the options seam is unchanged: injected mappers bind the native families, legacy families keep the files', async () => {
    const run = await provider().forRun(COACH, PINNED);
    const injected = buildFamilyRegistry({
      sourceMappers: run.sourceMappers,
      nativeRules: run.nativeRules,
    });
    expect(injected.get('workouts')!.map(learnedWorkout)).toMatchObject({ ok: true });
    expect(injected.get('clients')!.map(learnedClient)).toEqual({
      ok: false,
      reason: `unsupported_platform:${LEARNED}`,
    });
  });
});

// ── Site 3: the reconstruct engine (planner mappers + family registry) ───────────────────────

type Row = Record<string, any>;

/** The few reads and writes the legacy `reconstruct()` path issues, in memory. */
class FakeEnginePrisma {
  staged: Row[] = [];
  readonly ledger = new Map<string, Row>();
  readonly entities = new Map<string, Row>();
  readonly scoutImport = {
    findUnique: async () => ({ terminal_status: 'complete' }),
  };
  readonly scoutIngestEntity = {
    count: async ({ where }: Row) => this.stagedOf(where).length,
    findMany: async ({ where, skip, take }: Row) =>
      this.stagedOf(where)
        .slice(skip ?? 0, (skip ?? 0) + take)
        .map(({ source_id, source_platform, payload }) => ({
          source_id,
          source_platform,
          payload,
        })),
    groupBy: async () => {
      throw new Error('legacy path never groups');
    },
  };
  readonly scoutReconstructedEntity = {
    upsert: async ({ where, create }: Row) => {
      const key = JSON.stringify(where.coach_id_source_platform_entity_type_source_id);
      const id = this.entities.get(key)?.id ?? `entity-${this.entities.size + 1}`;
      this.entities.set(key, { id, ...create });
      return { id };
    },
  };
  readonly scoutReconstructionLedger = {
    upsert: async ({ where, create }: Row) => {
      const key = JSON.stringify(where.coach_id_intent_id_entity_type_source_platform_source_id);
      if (!this.ledger.has(key)) this.ledger.set(key, { ...create });
      return this.ledger.get(key);
    },
    updateMany: async ({ where, data }: Row) => {
      let count = 0;
      for (const row of this.ledger.values()) {
        if (row.coach_id !== where.coach_id || row.intent_id !== where.intent_id) continue;
        if (row.entity_type !== where.entity_type || row.source_id !== where.source_id) continue;
        if (where.status?.not !== undefined && row.status === where.status.not) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    },
    groupBy: async ({ where }: Row) => {
      const counts = new Map<string, number>();
      for (const row of this.ledger.values()) {
        if (row.intent_id !== where.intent_id || row.entity_type !== where.entity_type) continue;
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };
  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => fn(this);

  private stagedOf(where: Row): Row[] {
    return this.staged.filter(
      (r) =>
        r.coach_id === where.coach_id &&
        r.intent_id === where.intent_id &&
        r.entity_type === where.entity_type,
    );
  }
}

describe('L06 — ScoutReconstructService resolves through the provider', () => {
  const stage = (db: FakeEnginePrisma, intentId: string) => {
    db.staged.push({
      coach_id: COACH,
      intent_id: intentId,
      entity_type: 'client_history',
      source_id: 'j-1',
      source_platform: LEARNED,
      payload: { member_id: 'm-1', headline: 'note' },
    });
  };

  it('a pinned run reconstructs a learned-slug row; the same row in a run with no pin is skipped', async () => {
    const db = new FakeEnginePrisma();
    stage(db, PINNED);
    stage(db, UNPINNED);
    const service = new ScoutReconstructService(asPrisma(db), analytics(), provider());

    const pinned = await service.reconstruct(COACH, PINNED, 'client_history');
    expect(pinned).toEqual({
      intent_id: PINNED,
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    expect([...db.entities.values()]).toEqual([
      expect.objectContaining({ source_platform: LEARNED, entity_type: 'client_history' }),
    ]);

    const unpinned = await service.reconstruct(COACH, UNPINNED, 'client_history');
    expect(unpinned).toEqual({
      intent_id: UNPINNED,
      staged: 1,
      reconstructed: 0,
      skipped: 1,
      failed: 0,
    });
    const skipped = [...db.ledger.values()].find((r) => r.intent_id === UNPINNED);
    expect(skipped).toMatchObject({ status: 'skipped', reason: `unsupported_platform:${LEARNED}` });
  });

  it('without an injected provider the engine uses the process default: the file registries', async () => {
    const db = new FakeEnginePrisma();
    stage(db, PINNED);
    const service = new ScoutReconstructService(asPrisma(db), analytics());
    const out = await service.reconstruct(COACH, PINNED, 'client_history');
    expect(out).toMatchObject({ staged: 1, reconstructed: 0, skipped: 1 });
  });

  it('an unknown family still fails closed before any read, pinned or not', async () => {
    const db = new FakeEnginePrisma();
    const service = new ScoutReconstructService(asPrisma(db), analytics(), provider());
    await expect(service.reconstruct(COACH, PINNED, 'billing')).rejects.toThrow(
      /unsupported reconstruct family/,
    );
  });
});

// ── Site 4 + 5: the roster and entities readers (classification mappers) ─────────────────────

/** One settled run whose staged rows are all of the learned slug; the ledger is empty. */
function readerDb(intentId: string, token: string, pageReads: Row[] = []) {
  const tx = {
    scoutImport: { findUnique: async () => ({ terminal_status: 'complete' }) },
    scoutIngestEntity: {
      groupBy: async ({ where }: Row) =>
        where.intent_id === intentId
          ? [{ source_platform: LEARNED, entity_type: token, _count: { _all: 2 } }]
          : [],
    },
    scoutReconstructionLedger: {
      groupBy: async () => [],
      findMany: async (args: Row) => {
        pageReads.push(args.where);
        return [];
      },
    },
  };
  return { $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
}

describe('L06 — ScoutRosterService and ScoutEntitiesService classify through the provider', () => {
  it('roster: the learned token counts as staged clients for the pinned run, unclassified otherwise', async () => {
    const pinnedRoster = await new ScoutRosterService(
      asPrisma(readerDb(PINNED, TOKEN.clients)),
      analytics(),
      provider(),
    ).getRoster(COACH, PINNED, undefined, 10);
    expect(pinnedRoster.accounting).toEqual({
      staged: 2,
      reconstructed: 0,
      skipped: 0,
      failed: 0,
      unclassified: 0,
    });

    const unpinnedRoster = await new ScoutRosterService(
      asPrisma(readerDb(UNPINNED, TOKEN.clients)),
      analytics(),
      provider(),
    ).getRoster(COACH, UNPINNED, undefined, 10);
    expect(unpinnedRoster.accounting).toMatchObject({ staged: 0, unclassified: 2 });
  });

  it('entities: the learned token is in the workouts scope of the pinned run, unclassified otherwise', async () => {
    const pinnedReads: Row[] = [];
    const pinned = await new ScoutEntitiesService(
      asPrisma(readerDb(PINNED, TOKEN.workouts, pinnedReads)),
      analytics(),
      provider(),
    ).getEntities(COACH, PINNED, 'workouts', undefined, 10);
    expect(pinned).toMatchObject({ family: 'workouts', entities: [], unclassified_staged: 0 });
    // The (learned platform, token) pair is the scope the page is read under.
    expect(JSON.stringify(pinnedReads)).toContain(
      JSON.stringify({ source_platform: LEARNED, entity_type: TOKEN.workouts }),
    );

    const unpinnedReads: Row[] = [];
    const unpinned = await new ScoutEntitiesService(
      asPrisma(readerDb(UNPINNED, TOKEN.workouts, unpinnedReads)),
      analytics(),
      provider(),
    ).getEntities(COACH, UNPINNED, 'workouts', undefined, 10);
    expect(unpinned).toMatchObject({ family: 'workouts', entities: [], unclassified_staged: 2 });
    // Nothing classified: the empty scope is the truthful empty page, no ledger page is read.
    expect(unpinnedReads).toEqual([]);
  });
});

// ── Site 6: the observation service (induction registry) ────────────────────────────────────

describe('L06 — ObservationService checks evidence against the run-pinned induction registry', () => {
  const SCOPE = 'a'.repeat(64);
  const evidence = () => {
    const parsed = parseEvidence(
      rawEvidence({ platform: LEARNED, scope: SCOPE, family: 'clients' }),
    );
    if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.reason}`);
    return parsed.value;
  };
  const service = (created: Row[]) => {
    const tx = {
      $queryRaw: async () => [
        {
          execution_epoch: 1,
          terminal_status: null,
          fenced_at: null,
          fence_reason: null,
          phase: 'discovering',
          open_before_deadline: true,
        },
      ],
      scoutImportCompletion: { findUnique: async () => null },
      scoutRunDeclaration: {
        findMany: async () => [{ source_platform: LEARNED, account_scope_id_digest: SCOPE }],
      },
      scoutRunObservation: {
        findMany: async () => [],
        create: async ({ data }: Row) => {
          created.push(data);
          return { id: 'obs-1' };
        },
      },
    };
    const prisma = asPrisma({
      $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    });
    const lifecycle = Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService;
    return new ObservationService(prisma, lifecycle, undefined, provider());
  };

  it('the pinned run stores evidence of the learned slug; the run with no pin refuses it as not declared', async () => {
    const stored: Row[] = [];
    const out = await service(stored).observe(COACH, PINNED, [evidence()]);
    expect(out).toMatchObject({ intent_id: PINNED, stored: 1, replayed: 0 });
    expect(stored).toEqual([
      expect.objectContaining({ source_platform: LEARNED, family: 'clients' }),
    ]);

    const refused: unknown = await service([])
      .observe(COACH, UNPINNED, [evidence()])
      .then(
        () => new Error('resolved'),
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      code: 'observation_not_declared',
    });
  });

  it('the no-pin registry getter is the provider\u2019s cross-checked file induction registry', () => {
    const p = provider();
    const svc = new ObservationService(
      asPrisma({}),
      Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService,
      undefined,
      p,
    );
    expect(svc.registry).toBe(p.files.induction);
  });
});

// ── Site 7: the reconciliation facts service (mappers, workout interpreter, induction) ───────

class FakeFactsDb {
  readonly tables: Record<string, Row[]> = {
    scoutImportCompletion: [],
    scoutIngestEntity: [],
    scoutReconstructionLedger: [],
    importNativeProvenance: [],
    person: [],
    workoutProgram: [],
    workoutPlan: [],
    workoutPlanExercise: [],
    scoutRunDeclaration: [],
    scoutRunObservation: [],
  };
  private seq = 0;
  add(model: string, row: Row): void {
    this.tables[model].push({ id: `${model}-${String(++this.seq).padStart(4, '0')}`, ...row });
  }
  client(): FactsDb {
    const db: Row = {};
    for (const model of Object.keys(this.tables)) {
      db[model] = {
        findMany: (args: Row) => this.query(model, args, false),
        findUnique: (args: Row) => this.query(model, args, true),
      };
    }
    return db as FactsDb;
  }
  private query(model: string, args: Row, unique: boolean): Promise<any> {
    const where: Row = args.where ?? {};
    let rows = this.tables[model].filter((r) =>
      Object.entries(where).every(([k, v]) =>
        k === 'coach_id_intent_id'
          ? r.coach_id === v.coach_id && r.intent_id === v.intent_id
          : v !== null && typeof v === 'object' && 'in' in v
            ? v.in.includes(r[k])
            : r[k] === v,
      ),
    );
    if (unique) return Promise.resolve(rows[0] ?? null);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    const select = args.select as Row | undefined;
    return Promise.resolve(
      rows.map((r) =>
        select === undefined
          ? { ...r }
          : Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])),
      ),
    );
  }
}

describe('L06 — ReconciliationFactsService groups through the run-pinned mappers', () => {
  const staged = (db: FakeFactsDb, intentId: string) =>
    db.add('scoutIngestEntity', {
      coach_id: COACH,
      intent_id: intentId,
      entity_type: TOKEN.client_history,
      source_id: 'j-1',
      source_platform: LEARNED,
      payload: { member_id: 'm-1', headline: 'note' },
    });

  it('the pinned run maps the learned token to its family; the run with no pin reports it unsupported', async () => {
    const db = new FakeFactsDb();
    staged(db, PINNED);
    staged(db, UNPINNED);
    const facts = new ReconciliationFactsService({}, provider());

    const pinned = await facts.collect(db.client(), COACH, PINNED);
    expect(pinned.families.map((f) => [f.family, f.mapped, f.resolution_reason])).toEqual([
      ['client_history', true, null],
    ]);
    expect(pinned.spec_families).toEqual(['client_history', 'clients', 'workouts']);

    const unpinned = await facts.collect(db.client(), COACH, UNPINNED);
    expect(unpinned.families.map((f) => [f.family, f.mapped, f.resolution_reason])).toEqual([
      [TOKEN.client_history, false, `unsupported_platform:${LEARNED}`],
    ]);
    expect(unpinned.spec_families).toBeNull();
  });

  it('without options and without an injected provider the facts service reads the default files', async () => {
    const db = new FakeFactsDb();
    staged(db, PINNED);
    const out = await new ReconciliationFactsService().collect(db.client(), COACH, PINNED);
    expect(out.families.map((f) => [f.family, f.mapped])).toEqual([[TOKEN.client_history, false]]);
  });

  it('defaultRegistry() still projects the file manifests onto an injected mapper partition', () => {
    const files = defaultSourceRegistryProvider().files;
    const partition = ReconciliationFactsService.defaultRegistry(
      files.sourceMappers,
      files.nativeRules,
    );
    expect(partition).toEqual(files.induction);
  });
});
