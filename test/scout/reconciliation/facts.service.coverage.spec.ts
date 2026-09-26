import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  buildInductionRegistry,
  INDUCTION_MANIFESTS_DIR,
  loadInductionManifests,
  type InductionRegistry,
} from '../../../src/scout/induction/manifest-registry';
import { EMPTY_IDENTITY_SET_DIGEST, identitySetDigest } from '../../../src/scout/induction/digest';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import { parseNativeRuleSet } from '../../../src/scout/reconstruct/native/native-rules';
import { buildNativeRuleRegistry } from '../../../src/scout/reconstruct/native/native-rule-registry';
import { buildSourceMapperRegistry } from '../../../src/scout/reconstruct/source-mapper-registry';
import {
  ReconciliationFactsService,
  resolveFamily,
  stagedPlatformFacts,
  type FactsDb,
  type RunBinding,
} from '../../../src/scout/reconciliation/facts.service';
import { reconcile } from '../../../src/scout/reconciliation/reconcile';
import { coverageConditionHolds, familyCoverage } from '../../../src/scout/reconciliation/coverage';
import { S9_REASON_CODES } from '../../../src/scout/reconciliation/types';
import { RUN_REASON_CODES } from '../../../src/scout/lifecycle/reason-codes';
import {
  evidenceFor,
  referenceIdDigest,
  S10_PURE_MANIFESTS_DIR,
  S10_PURE_SPEC_PATH,
  sha256,
  type StatementFields,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-C — the facts service's coverage half (S10-DOC D-S10-3 E6, D-S10-6 invariants 1–4, 7;
 * D-S10-7 row S10-C; R23 terminal half, R27 production-grouping half, R30 old epoch, C-notes
 * "old epoch ignored at settle" and "coach-scoped observation reads"). The synthetic
 * `s10_unseen` package and signer live under test/fixtures only; `src/` never names them.
 */

type Family = 'clients' | 'programs' | 'workouts';
const FAMILIES: readonly Family[] = ['clients', 'programs', 'workouts'];
const IDS: Record<Family, string[]> = {
  clients: ['c1', 'c2'],
  programs: ['p1'],
  workouts: ['w1', 'w2', 'w3'],
};
/** Staged tokens of the fixture spec (`steps`): two tokens share the `workouts` id space. */
const TOKENS: Record<string, Family> = {
  members: 'clients',
  plans: 'programs',
  routines: 'workouts',
  sessions: 'workouts',
};

const SPEC_RAW: Record<string, unknown> = JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
const SLUG = String(SPEC_RAW.sourcePlatform);
const COACH = 'coach-a';
const OTHER = 'coach-b';
const INTENT = 'intent-1';
const EPOCH = 3;
const SCOPE = sha256('workspace-1');
const CHALLENGE = Buffer.alloc(32, 9);
const ACCEPTED = new Date('2026-09-26T09:00:00Z');
const RECEIVED = new Date('2026-09-26T11:00:00Z');

const SPEC = parseSourceMappingSpec(SPEC_RAW, `${SLUG}.json`);
const REGISTRY: InductionRegistry = buildInductionRegistry({
  manifests: loadInductionManifests(S10_PURE_MANIFESTS_DIR),
  specs: [SPEC],
  nativeRuleSets: [],
});
const SPEC_DIGEST = REGISTRY.packages.get(SLUG)?.specDigest ?? 'missing';
const MAPPERS = buildSourceMapperRegistry([SPEC]);

// ── In-memory Prisma double (reads only) ─────────────────────────────────────────────────────

type Row = Record<string, any>;
const READS = new Set(['findMany', 'findUnique']);
const TABLES = [
  'scoutImportCompletion',
  'scoutIngestEntity',
  'scoutReconstructionLedger',
  'importNativeProvenance',
  'person',
  'workoutProgram',
  'workoutPlan',
  'workoutPlanExercise',
  'scoutRunDeclaration',
  'scoutRunObservation',
];

class FakeDb {
  readonly tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, []]));
  readonly calls: Array<{ model: string; method: string; where: Row }> = [];
  private seq = 0;

  add(model: string, row: Row): Row {
    const withId = { id: row.id ?? `${model}-${String(++this.seq).padStart(6, '0')}`, ...row };
    this.tables[model].push(withId);
    return withId;
  }

  client(): FactsDb {
    const db: Row = {};
    for (const model of TABLES) {
      db[model] = new Proxy(
        {},
        {
          get: (_t, method: string) => {
            if (!READS.has(method))
              throw new Error(`S9/S10 facts must not call ${model}.${method} (reads only)`);
            return (args: Row) => this.query(model, method, args);
          },
        },
      );
    }
    return db as FactsDb;
  }

  private matches(row: Row, where: Row): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'coach_id_intent_id') {
        if (row.coach_id !== cond.coach_id || row.intent_id !== cond.intent_id) return false;
      } else if (cond !== null && typeof cond === 'object' && 'in' in cond) {
        if (!cond.in.includes(row[key])) return false;
      } else if (row[key] !== cond) return false;
    }
    return true;
  }

  private query(model: string, method: string, args: Row): Promise<any> {
    this.calls.push({ model, method, where: args.where ?? {} });
    let rows = this.tables[model].filter((r) => this.matches(r, args.where ?? {}));
    if (method === 'findUnique') return Promise.resolve(rows[0] ?? null);
    if (args.orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (args.cursor !== undefined) {
      const at = rows.findIndex((r) => r.id === args.cursor.id);
      rows = rows.slice(at + (args.skip ?? 0));
    }
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

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

/** `'default'` = construct WITHOUT a `registry` option (production wiring); else the given one. */
const service = (registry: InductionRegistry | 'default' = REGISTRY) =>
  new ReconciliationFactsService({
    sourceMappers: MAPPERS,
    nativeRules: buildNativeRuleRegistry([]),
    ...(registry === 'default' ? {} : { registry }),
  });

/** The binding the settle tail / status read hand the collector (D-S10-3 E1): the CALLER's row. */
const RUN: RunBinding = { mode: 'server', execution_epoch: EPOCH, accepted_start_at: ACCEPTED };

/** `collect` as the callers invoke it: the run binding is a parameter, never a read of its own. */
const collect = (db: FakeDb, run: RunBinding | null = RUN, svc = service()) =>
  svc.collect(db.client(), COACH, INTENT, run);

function claim(db: FakeDb, terminal = 'success') {
  db.add('scoutImportCompletion', {
    coach_id: COACH,
    intent_id: INTENT,
    terminal_status: terminal,
  });
}

function declare(db: FakeDb, coach = COACH, scope = SCOPE, challenge: Buffer = CHALLENGE) {
  db.add('scoutRunDeclaration', {
    coach_id: coach,
    intent_id: INTENT,
    source_platform: SLUG,
    account_scope_id_digest: scope,
    challenge,
    declared_at: ACCEPTED,
  });
}

function stage(
  db: FakeDb,
  token: string,
  sourceId: string,
  platform = SLUG,
  coach = COACH,
  payload: Row = { name: sourceId, title: sourceId, member_id: 'c1' },
) {
  db.add('scoutIngestEntity', {
    coach_id: coach,
    intent_id: INTENT,
    entity_type: token,
    source_id: sourceId,
    source_platform: platform,
    payload,
  });
}

/**
 * A NATIVE-CLEAN run (review B-2): one `plans` row reconstructed into an owned, live
 * WorkoutProgram with matching ledger + provenance (S9 bucket j, no client link so no closure
 * edge); `clients` and `workouts` staged empty. With the evidence below this is the one shape
 * that may settle `complete` (D-S10-6 invariant 1).
 */
function cleanRun(): FakeDb {
  const db = new FakeDb();
  claim(db);
  declare(db);
  stage(db, 'plans', 'p1', SLUG, COACH, { title: 'p1' });
  const program = db.add('workoutProgram', { coach_id: COACH, archived_at: null });
  db.add('scoutReconstructionLedger', {
    coach_id: COACH,
    intent_id: INTENT,
    entity_type: 'plans',
    source_id: 'p1',
    source_platform: SLUG,
    status: 'reconstructed',
    target_id: program.id,
    target_kind: 'workout_program',
    reason: null,
  });
  db.add('importNativeProvenance', {
    coach_id: COACH,
    import_intent_id: null,
    source_namespace: SLUG,
    entity_type: 'programs',
    source_id: 'p1',
    native_kind: 'workout_program',
    native_id: program.id,
    outcome: 'created',
    reason: null,
  });
  return db;
}

/** The baseline staged set: every fixture id, `w3` through the shared `sessions` token. */
function stageBaseline(db: FakeDb) {
  for (const id of IDS.clients) stage(db, 'members', id);
  for (const id of IDS.programs) stage(db, 'plans', id);
  stage(db, 'routines', 'w1');
  stage(db, 'routines', 'w2');
  stage(db, 'sessions', 'w3');
}

function statement(family: Family, ids: readonly string[], over: StatementFields = {}) {
  return {
    statement_version: 1,
    source_platform: SLUG,
    account_scope_id_digest: SCOPE,
    family,
    challenge_b64: CHALLENGE.toString('base64'),
    snapshot_ref_digest: sha256(`snapshot-${family}`),
    date_window: null,
    terminal: 'end_of_list',
    observed_unique: new Set(ids).size,
    id_set_digest: referenceIdDigest(ids),
    issued_at: '2026-09-26T10:00:00Z',
    ...over,
  };
}

function observe(db: FakeDb, family: Family, ids: readonly string[] = IDS[family], over: Row = {}) {
  const evidence = evidenceFor(statement(family, ids), SPEC_DIGEST);
  db.add('scoutRunObservation', {
    coach_id: COACH,
    intent_id: INTENT,
    execution_epoch: EPOCH,
    source_platform: SLUG,
    account_scope_id_digest: SCOPE,
    family,
    basis_kind: 'source_signed_enumeration',
    evidence,
    evidence_digest: sha256(JSON.stringify(evidence)),
    received_at: RECEIVED,
    ...over,
  });
}

function observeAll(db: FakeDb, over: Row = {}) {
  for (const family of FAMILIES) observe(db, family, IDS[family], over);
}

const KNOWN = (n: number, covers = true) => ({
  known: true,
  basis_kind: 'source_signed_enumeration',
  observed_unique: n,
  covers_staged_identities: covers,
});
const UNKNOWN = { known: false };
const BASELINE = { clients: KNOWN(2), programs: KNOWN(1), workouts: KNOWN(3) };

/** A fully declared, staged and observed server run with a `success` claim. */
function provenRun(): FakeDb {
  const db = new FakeDb();
  claim(db);
  declare(db);
  stageBaseline(db);
  observeAll(db);
  return db;
}

const s10Calls = (db: FakeDb) => db.calls.filter((c) => c.model.startsWith('scoutRun'));

// ── Specs ────────────────────────────────────────────────────────────────────────────────────

describe('S10-C resolveFamily (the shared classifier, D-S10-3 E6)', () => {
  it('maps a step token, a canonical family token, and nothing else', () => {
    for (const [token, family] of Object.entries(TOKENS)) {
      expect(resolveFamily(MAPPERS, SLUG, token)).toBe(family);
    }
    // The accepted S8-C staging convention: the token IS the family the spec declares.
    expect(resolveFamily(MAPPERS, SLUG, 'workouts')).toBe('workouts');
    expect(resolveFamily(MAPPERS, SLUG, 'client_history')).toBeNull();
    expect(resolveFamily(MAPPERS, SLUG, 'unknown-token')).toBeNull();
    expect(resolveFamily(MAPPERS, 'never-registered', 'members')).toBeNull();
  });
});

describe('S10-C stagedPlatformFacts (R27 production-grouping half)', () => {
  const row = (token: string, id: string, platform = SLUG) => ({
    source_platform: platform,
    entity_type: token,
    source_id: id,
  });

  it('digests every declared family from the classifier partition; a shared id space merges', () => {
    const [facts] = stagedPlatformFacts(MAPPERS, [
      row('members', 'c1'),
      row('members', 'c2'),
      row('routines', 'w1'),
      row('sessions', 'w3'),
      row('workouts', 'w2'),
      row('members', 'c1'), // a duplicate identity counts once
    ]);
    expect(facts.source_platform).toBe(SLUG);
    expect(facts.grouped_families).toEqual(['clients', 'programs', 'workouts']);
    expect(facts.families.get('clients')).toEqual(identitySetDigest(['c1', 'c2']));
    expect(facts.families.get('workouts')).toEqual(identitySetDigest(['w1', 'w2', 'w3']));
  });

  it('a declared family with no staged row is the EMPTY digest (count 0), never absent', () => {
    const [facts] = stagedPlatformFacts(MAPPERS, [row('members', 'c1')]);
    expect(facts.families.get('programs')).toEqual({ digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 });
    expect(facts.families.get('workouts')).toEqual({ digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 });
  });

  it('an unmapped token joins no digest; an unregistered platform groups nothing', () => {
    const facts = stagedPlatformFacts(MAPPERS, [
      row('members', 'c1'),
      row('mystery', 'x1'),
      row('members', 'z1', 'never-registered'),
    ]);
    expect(facts.map((f) => f.source_platform)).toEqual(['never-registered', SLUG]);
    expect(facts[0]).toEqual({
      source_platform: 'never-registered',
      grouped_families: [],
      families: new Map(),
    });
    expect(facts[1].families.get('clients')).toEqual(identitySetDigest(['c1']));
    expect(Array.from(facts[1].families.keys())).toEqual(['clients', 'programs', 'workouts']);
  });

  it('is total over a lone-surrogate id: that family digests to null (unknown), no throw', () => {
    const [facts] = stagedPlatformFacts(MAPPERS, [row('members', '\ud800')]);
    expect(facts.families.get('clients')).toBeNull();
  });
});

describe('S10-C ReconciliationFactsService.collect coverage (D-S10-3, D-S10-6)', () => {
  it('R33 unit half: declared + verified evidence over the staged digests → every family known and covered', async () => {
    const db = provenRun();
    const facts = await collect(db);
    expect(facts.coverage).toEqual(BASELINE);
    expect(coverageConditionHolds(facts)).toBe(false);
    const { verdict, report } = reconcile(facts);
    expect(report.conditions).not.toContain('coverage_basis_unknown');
    const workouts = report.families.find((f) => f.family === 'workouts');
    expect(workouts?.completeness_basis).toBe('source_signed_enumeration');
    expect(workouts?.observed_unique).toBe(3);
    // This fixture's identities have no ledger rows, so it is NOT native-clean: the S9 identity
    // condition, not coverage, keeps it from `complete` (the clean shape is the next case).
    expect(verdict).toEqual({ outcome: 'partial', reason_code: 'unresolved_identities' });
  });

  it('R33 (real composition, review B-2): a native-clean run with a success claim and verified covering evidence settles complete / null through collector → evaluator → familyCoverage → reconcile', async () => {
    const db = cleanRun();
    observe(db, 'programs', ['p1']);
    observe(db, 'clients', []);
    observe(db, 'workouts', []);
    const facts = await collect(db);
    expect(facts.coverage).toEqual({ clients: KNOWN(0), programs: KNOWN(1), workouts: KNOWN(0) });
    const { verdict, report } = reconcile(facts);
    expect(verdict).toEqual({ outcome: 'complete', reason_code: null });
    expect(report.conditions).toEqual([]);
    expect(report.required_families).toEqual(['clients', 'programs', 'workouts']);
    const programs = report.families.find((f) => f.family === 'programs');
    expect(programs).toMatchObject({
      native_present_verified: 1,
      unresolved: 0,
      rejected: 0,
      completeness_basis: 'source_signed_enumeration',
      observed_unique: 1,
    });
    // A verified EMPTY family is a fact of 0 with a basis, never an unknown (invariant 2).
    for (const empty of ['clients', 'workouts']) {
      expect(report.families.find((f) => f.family === empty)).toMatchObject({
        staged_unique: 0,
        completeness_basis: 'source_signed_enumeration',
        observed_unique: 0,
      });
    }
  });

  it('R23 terminal half (exact, review B-2): the same native-clean run whose evidence does not cover the staged identities settles EXACTLY partial / coverage_basis_unknown', async () => {
    const db = cleanRun();
    observe(db, 'programs', ['p1', 'p9']); // the source enumerates one more id than was staged
    observe(db, 'clients', []);
    observe(db, 'workouts', []);
    const facts = await collect(db);
    expect(facts.coverage).toEqual({
      clients: KNOWN(0),
      programs: KNOWN(2, false),
      workouts: KNOWN(0),
    });
    // The S9 predicate turns "known, not covering" into no basis; the count stays a shown fact.
    expect(familyCoverage(facts.coverage?.programs, 'success')).toEqual({
      known: false,
      completeness_basis: 'none',
      observed_unique: 2,
    });
    const { verdict, report } = reconcile(facts);
    expect(verdict).toEqual({ outcome: 'partial', reason_code: 'coverage_basis_unknown' });
    expect(report.conditions).toEqual(['coverage_basis_unknown']);
    // D-S10-8: drawn from the closed S9 set, every member an S7-L run reason code — no new code.
    expect(S9_REASON_CODES).toContain('coverage_basis_unknown');
    expect(RUN_REASON_CODES).toContain('coverage_basis_unknown');
  });

  it('R23 terminal half on the baseline fixture: digest ≠ staged → known but not covering → coverage_basis_unknown holds', async () => {
    const db = provenRun();
    stage(db, 'routines', 'w4'); // staged, never observed
    const facts = await collect(db);
    expect(facts.coverage).toEqual({ ...BASELINE, workouts: KNOWN(3, false) });
    const { verdict, report } = reconcile(facts);
    expect(verdict.outcome).toBe('partial');
    expect(report.conditions).toContain('coverage_basis_unknown');
  });

  it('R34: a claim other than success leaves every basis unknown even with verified evidence', async () => {
    const db = provenRun();
    db.tables.scoutImportCompletion[0].terminal_status = 'partial';
    const facts = await collect(db);
    expect(facts.coverage).toEqual(BASELINE); // the evaluator's fact is unchanged…
    expect(coverageConditionHolds(facts)).toBe(true); // …the S9 predicate refuses it (F1)
    expect(reconcile(facts).report.conditions).toContain('coverage_basis_unknown');
  });

  it('invariant 2 (unknown never zero): nothing staged, nothing observed → known:false without any count', async () => {
    const db = new FakeDb();
    claim(db);
    declare(db);
    const facts = await collect(db);
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    for (const fact of Object.values(facts.coverage ?? {})) {
      expect(fact).not.toHaveProperty('observed_unique');
    }
    const { report } = reconcile(facts);
    expect(report.conditions).toContain('coverage_basis_unknown');
    for (const family of report.families) {
      expect(family.observed_unique).toBeNull();
      expect(family.completeness_basis).toBe('none');
    }
  });

  it('a verified statement of the EMPTY set over zero staged rows is known and covered (R26 evaluator tier); S9 still refuses an empty run', async () => {
    const db = new FakeDb();
    claim(db);
    declare(db);
    for (const family of FAMILIES) observe(db, family, []);
    const facts = await collect(db);
    // A platform with no staged row at all is genuinely the empty identity set (E6).
    expect(facts.coverage).toEqual({ clients: KNOWN(0), programs: KNOWN(0), workouts: KNOWN(0) });
    // …but S9's required set is undeterminable for an empty run (R18): C-COV still holds.
    expect(coverageConditionHolds(facts)).toBe(true);
    expect(reconcile(facts).report.conditions).toContain('coverage_basis_unknown');
  });

  it('R30 / C-note: observations stored under an earlier epoch are excluded by the query and never counted', async () => {
    const db = new FakeDb();
    claim(db);
    declare(db);
    stageBaseline(db);
    observeAll(db, { execution_epoch: EPOCH - 1 });
    const facts = await collect(db);
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    const reads = db.calls.filter((c) => c.model === 'scoutRunObservation');
    expect(reads.length).toBe(1);
    expect(reads[0].where).toEqual({ coach_id: COACH, intent_id: INTENT, execution_epoch: EPOCH });
  });

  it("R30: the current epoch's evidence is used even when an older epoch left rows behind", async () => {
    const db = provenRun();
    observeAll(db, { execution_epoch: EPOCH - 1, received_at: new Date('2026-09-25T00:00:00Z') });
    const facts = await collect(db);
    expect(facts.coverage).toEqual(BASELINE);
  });

  it("C-note / invariant 4: declaration and observation reads carry this coach; another coach's rows for the same intent id are invisible", async () => {
    const db = new FakeDb();
    claim(db);
    declare(db, OTHER);
    stageBaseline(db);
    for (const family of FAMILIES) observe(db, family, IDS[family], { coach_id: OTHER });
    const facts = await collect(db);
    // No declaration for THIS coach: the staged platform is undeclared → all unknown.
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    const reads = s10Calls(db);
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) expect(call.where.coach_id).toBe(COACH);
  });

  it('a declaration whose rows disagree on the challenge verifies nothing (poisoned, not merged)', async () => {
    const db = provenRun();
    declare(db, COACH, sha256('workspace-2'), Buffer.alloc(32, 1));
    const facts = await collect(db);
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
  });

  it('binding: a server binding without accepted_start_at, a legacy binding, or none at all yields coverage null (S9 v1) and no S10 read', async () => {
    for (const run of [
      { ...RUN, accepted_start_at: null },
      { ...RUN, mode: 'legacy' },
      null,
      undefined,
    ]) {
      const db = provenRun();
      const facts =
        run === undefined
          ? await service().collect(db.client(), COACH, INTENT) // the S9-B call shape
          : await collect(db, run);
      expect(facts.coverage).toBeNull();
      expect(s10Calls(db)).toEqual([]);
      expect(facts.families.map((f) => f.family)).toEqual(['clients', 'programs', 'workouts']);
    }
  });

  it('the settle epoch binds: the same run at another epoch sees none of this evidence', async () => {
    const db = provenRun();
    const facts = await collect(db, { ...RUN, execution_epoch: EPOCH + 1 });
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
    expect(s10Calls(db).find((c) => c.model === 'scoutRunObservation')?.where).toMatchObject({
      execution_epoch: EPOCH + 1,
    });
  });

  it('invariant 5/6: collect issues reads only, a bounded number of them, and never reads the run row itself', async () => {
    const db = provenRun();
    await collect(db);
    expect(db.calls.every((c) => c.method === 'findMany' || c.method === 'findUnique')).toBe(true);
    const models = db.calls.map((c) => c.model);
    expect(models.filter((m) => m === 'scoutRunDeclaration').length).toBe(1);
    expect(models.filter((m) => m === 'scoutRunObservation').length).toBe(1);
    expect(models).not.toContain('scoutImport'); // the S9-B statement count is unchanged
  });

  it('review A-1 (D-S10-4 L265-272): the no-basis status recompute — a valid declaration and signed observation exist, but with no binding the report stays S9-C: coverage_basis_unknown, observed_unique null, no S10 read', async () => {
    const db = provenRun(); // declaration + verified observation for every family, success claim
    const facts = await service().collect(db.client(), COACH, INTENT); // the readReport call shape
    expect(facts.coverage).toBeNull();
    expect(s10Calls(db)).toEqual([]);
    const { verdict, report } = reconcile(facts);
    expect(report.basis).toBe('recomputed');
    expect(report.conditions).toContain('coverage_basis_unknown');
    expect(verdict.outcome).not.toBe('complete');
    for (const fam of report.families) {
      expect(fam.observed_unique).toBeNull();
      expect(fam.completeness_basis).toBe('none');
    }
    // The same run WITH the settle tail's binding would have been known — the difference is the
    // binding the settle tail alone supplies, never later evidence on a read.
    const settled = await collect(provenRun());
    expect(settled.coverage).toEqual(BASELINE);
  });
});

describe("S10-C default induction registry (over this service's mapper partition)", () => {
  it('without a registry option, manifests come from disk (none here) → unknown, never a throw', async () => {
    const db = provenRun();
    // (devloop-1: `service(undefined)` hit the parameter DEFAULT — the fixture registry — so
    // this test was proving the fixture, not the disk. `'default'` is an explicit sentinel.)
    const facts = await collect(db, RUN, service('default'));
    expect(existsSync(INDUCTION_MANIFESTS_DIR)).toBe(false); // the premise: no manifest on disk
    expect(facts.coverage).toEqual({ clients: UNKNOWN, programs: UNKNOWN, workouts: UNKNOWN });
  });

  it('drops a native rule set whose platform has no mapping spec here instead of failing construction', () => {
    const foreignRules = parseNativeRuleSet(
      {
        specVersion: 1,
        sourcePlatform: 'elsewhere',
        families: {
          programs: {
            weeks: { kind: 'integer', paths: [['weeks']] },
            daysPerWeek: { kind: 'integer', paths: [['days']] },
          },
          workouts: {
            type: {
              kind: 'enum',
              paths: [['kind']],
              map: { lift: 'strength' },
              default: 'strength',
            },
            programSourceId: { kind: 'identifier', paths: [['block_id']] },
            weekIndex: { kind: 'integer', paths: [['week']], base: 1 },
            dayIndex: { kind: 'integer', paths: [['day']], base: 1 },
          },
        },
      },
      'coverage.spec:foreign',
    );
    const registry = ReconciliationFactsService.defaultRegistry(
      MAPPERS,
      buildNativeRuleRegistry([foreignRules]),
    );
    expect(Array.from(registry.specFamilies.keys())).toEqual([SLUG]);
    expect(registry.packages.size).toBe(0);
  });
});

describe('S10-C D-S10-8: no source name in src', () => {
  it('the fixture slug appears nowhere under src/**/*.ts', () => {
    // A cheap, in-process proxy for `rg -F <slug> src`: the modules S10-C touched.
    const files = [
      'src/scout/reconciliation/facts.service.ts',
      'src/scout/lifecycle/lifecycle.service.ts',
      'src/scout/reconciliation/types.ts',
      'src/scout/scout.module.ts',
    ];
    for (const file of files) {
      expect(readFileSync(join(__dirname, '..', '..', '..', file), 'utf8')).not.toContain(SLUG);
    }
  });
});
