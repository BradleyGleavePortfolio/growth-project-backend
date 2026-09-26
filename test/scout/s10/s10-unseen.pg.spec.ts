/**
 * S10-D D2 — the synthetic unseen source `s10_unseen` on REAL PostgreSQL
 * (docs/decisions/2026-09-26-s10-induction.md D-S10-5; acceptance R39 (a)-(f), R41 replay half).
 *
 * The chain, end to end, with the REPOSITORY-DEFAULT registries (the source exists only as the
 * three D2 JSON files; no spec, rule set, manifest or registry is injected except in case (b),
 * which names its injection):
 *   declaration (ObservationController.postDeclaration)
 *   → staging (ScoutIngestService.ingest)
 *   → observation (ObservationController.postObservation, evidence signed at test time over the
 *     run's server challenge by the synthetic SOURCE key of test/fixtures/scout/s10_unseen)
 *   → claim (ScoutService.complete → ScoutLifecycleService.onTransferSettled)
 *   → S8-G server pass (ScoutReconstructService.reconstructRun) → native / evidence rows
 *   → S10-C evaluator + S9 reconcile → terminal CAS + ScoutRunSettledBasis
 *   → status (ScoutService.getImportStatus).
 *
 * THROUGHPUT RULE (as S10-C): this file forks NO harness and adds no helper file. It reuses the
 * S10-B lane by import only (test/utils/g2-s10b-{db,pg-harness,harness}.ts: the same disposable
 * PG17 cluster, G2_S10B_* environment, attested candidate head and clean-tree guard, which the
 * pg-harness enforces at import). The services run IN this jest process against the runtime role
 * (`service_role`) with the candidate's generated @prisma/client; the S10-B worker is not used
 * because it has no S8-G pass action and injects a synthetic induction registry.
 *
 * Guard: without G2_S10B_DATABASE_URL the whole file is `describe.skip` and imports nothing from
 * the PG lane (the default jest suite picks up test/scout/**; it must not hard-fail there).
 *
 * SHAPES (proof v1 finding, s10d2/d2_diagnose_fix.md). The `complete` cases stage the NATIVE-CLEAN
 * subset of the fixture (the two workouts rows; `clients` and `programs` declared, source-signed
 * as EMPTY enumerations — the R33 unit shape, facts.service.coverage.spec `cleanRun`). A staged
 * `clients` row can NOT be part of a `complete` run at this head: `clientsFamily.persist`
 * (src/scout/reconstruct/families.ts L83-101) returns the legacy string id, so the engine writes
 * the ledger row with `target_kind` NULL (scout-reconstruct.service.ts L510-520) and no provenance;
 * S9-A classifies it bucket f `unresolved:evidence_only` (reconcile.ts L136-146; S9-DOC D-S9-2 f)
 * → C-ID `unresolved_identities`. The typed `person` handoff is S8-D, blocked on D-S8-2 (owner).
 * Case (h) pins that truth live instead of hiding it; nothing here injects around it.
 */
import { createHash, createPrivateKey, sign } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const LIVE = typeof process.env.G2_S10B_DATABASE_URL === 'string';
const suite = LIVE ? describe : describe.skip;
jest.setTimeout(300000);

const FIXTURES = join(__dirname, '../../fixtures/scout/s10_unseen');
const readFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const ROWS = readFixture('staged-rows.json');
const STATEMENTS = readFixture('statements.json');
const KEYS = readFixture('signer-test-key.json');
const PLATFORM: string = ROWS.source_platform;
type Row = { token: string; source_id: string; payload: Record<string, unknown> };
const SET = ROWS.sets as Record<
  'base' | 'client_linked' | 'undeclared_family' | 'canonical_token',
  Row[]
>;
/** The roster rows (`clients`, legacy Person handoff) and the native-clean rest of `base`. */
const ROSTER: Row[] = SET.base.filter((r) => r.token === 'u10-members');
const NATIVE_CLEAN: Row[] = SET.base.filter((r) => r.token !== 'u10-members');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SCOPE = sha256(ROWS.account_scope_seed);

function referenceIdDigest(ids: readonly string[]): string {
  const sorted = [...new Set(ids)]
    .map((id) => Buffer.from(id, 'utf8'))
    .sort((a, b) => Buffer.compare(a, b));
  return createHash('sha256')
    .update(Buffer.concat(sorted.map((b) => Buffer.concat([Buffer.from(`${b.length}:`), b]))))
    .digest('hex');
}
function statementBytes(fields: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key];
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A PG `timestamp` rendered by to_jsonb has no zone; the columns are UTC by contract. */
const utc = (text: string) => new Date(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);

suite('s10_unseen — NEW SOURCE → CORE DIFF = 0, live on PG17 (R39, R41)', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  let lane: any;
  let fixtures: any;
  let prisma: any;
  const S = (p: string) => require(join(__dirname, '../../../src', p));
  const analytics = { capture: () => undefined };
  const notifications = { pushToUser: async () => undefined };

  beforeAll(() => {
    lane = require('../../utils/g2-s10b-pg-harness');
    fixtures = require('../../utils/g2-s10b-harness');
    const db = require('../../utils/g2-s10b-db');
    const { PrismaClient } = require('@prisma/client');
    const url = new URL(
      db.withFixturePassword(
        lane.target.prismaUrl,
        process.env.G2_S10B_PASSWORD,
        db.G2_S10B_RUNTIME_ROLE,
      ),
    );
    url.searchParams.set('application_name', 's10d2_unseen');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  });
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  /** Whole-fixture reset of every table this chain writes (disposable cluster; S9-C precedent). */
  const reset = () => {
    lane.sql(`DELETE FROM "ImportNativeProvenance"; DELETE FROM "ScoutReconstructionLedger";
      DELETE FROM "ScoutIngestEntity"; DELETE FROM "ScoutReconstructedEntity";
      DELETE FROM "ScoutProgressSnapshot"; DELETE FROM "ScoutImportCompletion"; DELETE FROM "ScoutImport";
      DELETE FROM "WorkoutPlanRevision"; DELETE FROM "WorkoutPlanExercise"; DELETE FROM "WorkoutPlan";
      DELETE FROM "WorkoutProgram"; DELETE FROM "Person";
      DELETE FROM "ExtensionPairCode"; DELETE FROM "ImportIntent";`);
  };
  beforeEach(() => reset());

  /** The real services with the repository-default registries (optionally case (b)'s injection). */
  function services(opts: { nativeRulesAbsent?: boolean } = {}) {
    const { ScoutLifecycleService } = S('scout/lifecycle/lifecycle.service');
    const { ScoutReconstructService } = S('scout/scout-reconstruct.service');
    const { ReconciliationFactsService } = S('scout/reconciliation/facts.service');
    const { ObservationService } = S('scout/induction/observation.service');
    const { ObservationController } = S('scout/induction/observation.controller');
    const { ScoutService } = S('scout/scout.service');
    const { ScoutIngestService } = S('scout/scout-ingest.service');
    const reconstruct = new ScoutReconstructService(prisma, analytics);
    let facts = new ReconciliationFactsService();
    if (opts.nativeRulesAbsent) {
      // (b) the ONE injected case: the same source with its native rule set withheld and its
      // manifest saying `nativeRules: 'absent'` (V6-consistent), through the accepted S8-G / S9-B
      // options seams (the S9-C worker precedent). Nothing on disk changes.
      const { buildSourceMapperRegistry } = S('scout/reconstruct/source-mapper-registry');
      const { buildFamilyRegistry } = S('scout/reconstruct/families');
      const nr = S('scout/reconstruct/native/native-rule-registry');
      const ind = S('scout/induction/manifest-registry');
      const mappers = buildSourceMapperRegistry();
      const rules = nr.buildNativeRuleRegistry(
        nr.loadNativeRuleSets().filter((s: any) => s.sourcePlatform !== PLATFORM),
      );
      reconstruct.families = buildFamilyRegistry({ sourceMappers: mappers, nativeRules: rules });
      reconstruct.sourceMappers = mappers;
      const registry = ind.buildInductionRegistry({
        manifests: ind
          .loadInductionManifests()
          .filter((m: any) => mappers.has(m.sourcePlatform))
          .map((m: any) => (m.sourcePlatform === PLATFORM ? { ...m, nativeRules: 'absent' } : m)),
        specs: Array.from(mappers.values()).map((m: any) => m.spec),
        nativeRuleSets: Array.from(rules.values()),
      });
      facts = new ReconciliationFactsService({
        sourceMappers: mappers,
        nativeRules: rules,
        registry,
      });
    }
    const lifecycle = new ScoutLifecycleService(prisma, analytics, reconstruct, facts);
    const controller = new ObservationController(new ObservationService(prisma, lifecycle));
    const scout = new ScoutService(prisma, notifications, analytics, lifecycle);
    const ingest = new ScoutIngestService(prisma, analytics, lifecycle);
    return { lifecycle, controller, scout, ingest };
  }

  function evidence(
    family: string,
    ids: readonly string[],
    challengeB64: string,
    issuedAt: string,
    signer: 'source' | 'observer',
    specDigest: string,
  ) {
    const pair = KEYS[signer];
    const bytes = statementBytes({
      account_scope_id_digest: SCOPE,
      challenge_b64: challengeB64,
      date_window: STATEMENTS.template.date_window,
      family,
      id_set_digest: referenceIdDigest(ids),
      issued_at: issuedAt,
      observed_unique: new Set(ids).size,
      snapshot_ref_digest: sha256(STATEMENTS.template.snapshot_ref_seed),
      source_platform: PLATFORM,
      statement_version: STATEMENTS.template.statement_version,
      terminal: STATEMENTS.template.terminal,
    });
    const privateKey = createPrivateKey({
      key: Buffer.from(pair.private_key_pkcs8_b64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return {
      evidence_version: STATEMENTS.evidence_version,
      source_platform: PLATFORM,
      account_scope_id_digest: SCOPE,
      family,
      basis_kind: STATEMENTS.basis_kind,
      mapping_spec_digest: specDigest,
      statement_b64: bytes.toString('base64'),
      key_id: pair.key_id,
      signature_b64: sign(null, bytes, privateKey).toString('base64'),
    };
  }

  /**
   * One full run for `coach`: start → declare (+ identical replay) → ingest `rows` per token →
   * observe `families` → complete → status. Returns the run row, settled basis and status.
   */
  async function chain(
    coach: string,
    rows: readonly Row[],
    opts: {
      families?: readonly string[];
      signer?: 'source' | 'observer';
      nativeRulesAbsent?: boolean;
    } = {},
  ) {
    const svc = services(opts);
    const intentId: string = fixtures.intent(coach);
    await svc.lifecycle.start(coach, intentId);

    const platforms = [{ source_platform: PLATFORM, account_scope_id_digests: [SCOPE] }];
    const declared = await svc.controller.postDeclaration(
      { user: { id: coach } },
      { intent_id: intentId, platforms },
    );
    const replay = await svc.controller.postDeclaration(
      { user: { id: coach } },
      { intent_id: intentId, platforms },
    );
    expect(replay.challenge_b64).toBe(declared.challenge_b64); // identical replay, no new row

    const tokens = [...new Set(rows.map((r) => r.token))];
    for (const token of tokens) {
      await svc.ingest.ingest(coach, {
        intent_id: intentId,
        entity_type: token,
        entities: rows
          .filter((r) => r.token === token)
          .map((r) => ({
            sourceId: r.source_id,
            sourcePlatform: PLATFORM,
            capturedAt: '2026-09-26T00:00:00.000Z',
            payload: r.payload,
          })),
      });
    }

    // Staged ids per family through the S9-B/S10-C classifier over the DEFAULT mappers.
    const { buildSourceMapperRegistry } = S('scout/reconstruct/source-mapper-registry');
    const { resolveFamily } = S('scout/reconciliation/facts.service');
    const { mappingSpecDigest } = S('scout/induction/digest');
    const mappers = buildSourceMapperRegistry();
    const ids: Record<string, string[]> = { clients: [], programs: [], workouts: [] };
    for (const r of rows) {
      const family = resolveFamily(mappers, PLATFORM, r.token);
      if (family !== null) ids[family].push(r.source_id);
    }
    const specDigest = mappingSpecDigest(mappers.get(PLATFORM).spec);

    // issued_at inside [accepted_start_at, received_at] (E4): after the start, before the upload.
    const acceptedStart = utc(fixtures.runRow(coach, intentId).accepted_start_at).getTime();
    const issuedMs = Math.max(Date.now(), acceptedStart) + 5;
    while (Date.now() <= issuedMs + 5) await sleep(5);
    const issuedAt = new Date(issuedMs).toISOString();
    const observations = (opts.families ?? STATEMENTS.families).map((family: string) =>
      evidence(
        family,
        ids[family],
        declared.challenge_b64,
        issuedAt,
        opts.signer ?? 'source',
        specDigest,
      ),
    );
    const body = { intent_id: intentId, observations };
    const stored = await svc.controller.postObservation(
      { user: { id: coach }, rawBody: Buffer.from(JSON.stringify(body), 'utf8') },
      body,
    );
    expect(stored.stored).toBe(observations.length);

    await svc.scout.complete(coach, { intent_id: intentId, terminal_status: 'success' });
    const status = await svc.scout.getImportStatus(coach, intentId);
    const run = fixtures.runRow(coach, intentId);
    const basis = lane.json(
      `SELECT COALESCE((SELECT to_jsonb(s) FROM "ScoutRunSettledBasis" s
        WHERE coach_id=${lane.quote(coach)} AND intent_id=${lane.quote(intentId)}),'null')`,
    );
    return { intentId, status, run, basis };
  }

  const nativeCounts = (coach: string) => ({
    persons: Number(lane.sql(`SELECT count(*) FROM "Person" WHERE coach_id=${lane.quote(coach)}`)),
    plans: Number(
      lane.sql(`SELECT count(*) FROM "WorkoutPlan" WHERE coach_id=${lane.quote(coach)}`),
    ),
    programs: Number(
      lane.sql(`SELECT count(*) FROM "WorkoutProgram" WHERE coach_id=${lane.quote(coach)}`),
    ),
  });
  /** The settled report's entry for a canonical family (declared-only entries have no tokens). */
  const familyOf = (basis: any, family: string) =>
    basis.report.families.find((f: any) => f.family === family);
  const evidenceRows = (coach: string) =>
    Number(
      lane.sql(
        `SELECT count(*) FROM "ScoutReconstructedEntity" WHERE coach_id=${lane.quote(coach)}`,
      ),
    );

  it('R39 (a) all declared units verified → complete (one settled basis, source-signed)', async () => {
    const coach = 's10u-a';
    const { status, run, basis } = await chain(coach, NATIVE_CLEAN);
    expect(run.terminal_status).toBe('complete');
    expect(run.reason_code).toBeNull();
    expect(status.status).toBe('complete');
    expect(basis).not.toBeNull();
    expect(basis.execution_epoch).toBe(run.execution_epoch);
    expect(basis.report.conditions).toEqual([]);
    expect(basis.report.required_families).toEqual(['clients', 'programs', 'workouts']);
    for (const family of ['clients', 'programs', 'workouts']) {
      expect(familyOf(basis, family).completeness_basis).toBe('source_signed_enumeration');
    }
    // The two declared-but-unstaged families are PROVEN empty (observed 0), never absent.
    expect(familyOf(basis, 'clients').observed_unique).toBe(0);
    expect(familyOf(basis, 'programs').observed_unique).toBe(0);
    expect(familyOf(basis, 'workouts')).toMatchObject({
      staged_unique: 2,
      native_present_verified: 2,
      unresolved: 0,
      observed_unique: 2,
    });
    // Native, not evidence: two coach-owned workout templates (one per step, one id space).
    expect(nativeCounts(coach)).toEqual({ persons: 0, plans: 2, programs: 0 });
    expect(evidenceRows(coach)).toBe(0);
  });

  it('R41 replaying the intent over the same source ids creates no second native row', async () => {
    const coach = 's10u-replay';
    await chain(coach, NATIVE_CLEAN);
    const before = nativeCounts(coach);
    expect(before.plans).toBe(2);
    const again = await chain(coach, NATIVE_CLEAN);
    expect(nativeCounts(coach)).toEqual(before);
    expect(again.run.terminal_status).toBe('complete');
  });

  it("R39 (b) nativeRules 'absent' → partial / unresolved_identities", async () => {
    const coach = 's10u-b';
    const { run, basis } = await chain(coach, NATIVE_CLEAN, { nativeRulesAbsent: true });
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('unresolved_identities');
    // The ONLY difference from (a) is the withheld rule set: the same two rows land as evidence.
    expect(familyOf(basis, 'workouts')).toMatchObject({
      native_present_verified: 0,
      unresolved: 2,
    });
    expect(familyOf(basis, 'workouts').reasons).toEqual([
      { code: 'unresolved:evidence_only', count: 2 },
    ]);
    expect(nativeCounts(coach)).toEqual({ persons: 0, plans: 0, programs: 0 });
    expect(evidenceRows(coach)).toBe(2);
  });

  it('R39 (c) a client-linked row → partial (no native client principal, D-S8-2)', async () => {
    const coach = 's10u-c';
    const { run, basis } = await chain(coach, [...NATIVE_CLEAN, ...SET.client_linked]);
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('unresolved_identities');
    expect(basis.report.conditions).toContain('unresolved_identities');
    expect(familyOf(basis, 'workouts')).toMatchObject({
      staged_unique: 3,
      native_present_verified: 2,
      unresolved: 1,
    });
    expect(familyOf(basis, 'workouts').reasons).toEqual([
      { code: 'unresolved:no_native_client_principal', count: 1 },
    ]);
    expect(nativeCounts(coach)).toEqual({ persons: 0, plans: 2, programs: 0 });
    expect(evidenceRows(coach)).toBe(1);
  });

  it('R39 (d) staged undeclared client_history → unresolved_family', async () => {
    const { run } = await chain('s10u-d', [...NATIVE_CLEAN, ...SET.undeclared_family]);
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('unresolved_family');
  });

  it('R39 (e) one declared family unproven → coverage_basis_unknown', async () => {
    const { run, basis } = await chain('s10u-e', NATIVE_CLEAN, {
      families: ['clients', 'workouts'],
    });
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('coverage_basis_unknown');
    expect(basis.report.conditions).toEqual(['coverage_basis_unknown']);
    expect(familyOf(basis, 'clients').completeness_basis).toBe('source_signed_enumeration');
    expect(familyOf(basis, 'workouts').completeness_basis).toBe('source_signed_enumeration');
    expect(familyOf(basis, 'programs')).toMatchObject({
      completeness_basis: 'none',
      observed_unique: null,
    });
  });

  it('R39 (f) extension-signed statements only → coverage_basis_unknown', async () => {
    const { run, basis } = await chain('s10u-f', NATIVE_CLEAN, { signer: 'observer' });
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('coverage_basis_unknown');
    expect(basis.report.conditions).toEqual(['coverage_basis_unknown']);
    for (const family of basis.report.families) {
      expect(family.completeness_basis).toBe('none');
      expect(family.observed_unique).toBeNull();
    }
  });

  it('R27 live: canonical-token programs row is covered but unmapped by the pass → partial', async () => {
    const { run, basis } = await chain('s10u-g', [...NATIVE_CLEAN, ...SET.canonical_token]);
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('unresolved_identities');
    expect(basis.report.conditions).not.toContain('coverage_basis_unknown');
    expect(familyOf(basis, 'programs')).toMatchObject({
      staged_unique: 1,
      native_present_verified: 0,
      completeness_basis: 'source_signed_enumeration',
      observed_unique: 1,
    });
    expect(nativeCounts('s10u-g').programs).toBe(0);
  });

  it('(h) staged clients rows → partial / unresolved_identities: Person rows exist, but the legacy handoff (ledger kind NULL, no provenance) is bucket f evidence_only until S8-D', async () => {
    const coach = 's10u-h';
    const { run, basis } = await chain(coach, [...ROSTER, ...NATIVE_CLEAN]);
    expect(run.terminal_status).toBe('partial');
    expect(run.reason_code).toBe('unresolved_identities');
    // C-ID alone: coverage is known for every family (the source signed all three sets).
    expect(basis.report.conditions).toEqual(['unresolved_identities']);
    expect(familyOf(basis, 'clients')).toMatchObject({
      staged_unique: 2,
      native_present_verified: 0,
      unresolved: 2,
      reasons: [{ code: 'unresolved:evidence_only', count: 2 }],
      qualifiers: ['roster_bridge_pending'],
      completeness_basis: 'source_signed_enumeration',
      observed_unique: 2,
    });
    expect(familyOf(basis, 'workouts')).toMatchObject({
      native_present_verified: 2,
      unresolved: 0,
    });
    // The roster Persons ARE written (S8-DOC §4.1) — the run is partial because S9 cannot verify
    // them through the ledger/provenance join, not because anything is missing natively.
    expect(nativeCounts(coach)).toEqual({ persons: 2, plans: 2, programs: 0 });
    expect(evidenceRows(coach)).toBe(0);
  });
});
