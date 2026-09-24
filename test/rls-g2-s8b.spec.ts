// G2-S8-B proof on the isolated PostgreSQL 17 lane (S1-provisioned, synthetic data only).
// Ordered stages in ONE file, run with --runInBand, on a FRESH bootstrap whose "old" side is
// a detached checkout of OLD_HEAD (the S8-B base: the accepted C head 1b6cc661), whose
// `prisma migrate deploy`
// installed the whole accepted history. The candidate ships EXACTLY ONE migration
// (20270122000000_scout_native_provenance_expand), applied here through the candidate's own
// `prisma migrate deploy` (P01, the release mechanism).
//   1. baseline on the OLD shape: the OLD N writer reconstructs a family; up refuses a decoy
//      relation, a decoy constraint and a held lock, each leaving nothing;
//   2. P01 deploy exactness (provenance table columns/CHECKs/FK/indexes/RLS/grants exact; the
//      ledger gains exactly one nullable column and two CHECKs; ledger RLS byte-equal; ledger
//      rows untouched), P02 rerun refusal;
//   3. P05 mixed version (OLD and candidate N writers + readers unchanged on the S8-B schema),
//      CHECK/FK/identity refusals, the contract's child source_id encoding, P06 API-role denial
//      (revoked privileges AND policies) and service-role rollback;
//   4. P03 down refusal with provenance state (fixed text, nothing deleted), P04 down/up shape
//      identity with ledger rows retained; history never rewritten.
// Accepted E/T-Q0, B, R, N/Q1 (and C) proofs are neither rerun nor restated. Nothing here
// claims deployment, S8-C behaviour (no native writer exists yet), or customer acceptance.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  appliedMigrations,
  directory,
  downFile,
  expectedVersion,
  holdTransaction,
  json,
  OLD_HEAD,
  oldClient,
  prisma,
  prismaMigrateDeploy,
  quote,
  refused,
  refusedFile,
  root,
  run,
  S8B_MIGRATION,
  sql,
  sqlAdmin,
  sqlAs,
  sqlFile,
  target,
  upFile,
} from './utils/g2-s8b-pg-harness';
import { G2_S8B_CLUSTER_MARKER, G2_S8B_DATABASE_MARKER } from './utils/g2-s8b-db';
import {
  childSourceId,
  columns,
  constraints,
  EXPECTED_FK_DEF,
  EXPECTED_INDEX_DEFS,
  EXPECTED_LEDGER_CHECK_DEFS,
  EXPECTED_LEDGER_TARGET_KIND,
  EXPECTED_PK_DEF,
  EXPECTED_PROVENANCE_CHECK_DEFS,
  EXPECTED_PROVENANCE_COLUMNS,
  exists,
  FK_NAME,
  IDENTITY_INDEX,
  identityRows,
  indexes,
  intent,
  intentCount,
  LEDGER,
  LEDGER_CHECK_NAMES,
  LEDGER_POLICIES,
  ledgerCount,
  ledgerRows,
  ledgerRowsWithoutTargetKind,
  ledgerTargetKind,
  ledgerTypedCount,
  personCount,
  PROVENANCE,
  PROVENANCE_CHECK_NAMES,
  PROVENANCE_POLICIES,
  provenanceCount,
  provenanceInsert,
  provenanceRows,
  resetData,
  rls,
  settle,
  shape,
  shapeWithOids,
  stage,
} from './utils/g2-s8b-harness';

jest.setTimeout(240000);
/** Accepted history installed by the OLD root's deploy: 170 at the accepted C head 1b6cc661. */
const EXPECTED_HISTORY = 170;
const ALREADY = 'G2-S8B provenance already present';
const ABSENT = 'G2-S8B provenance absent';
const REFUSE_DOWN =
  'Native provenance state exists; retain schema and use compatible forward repair';
const byName = (list: any[]) => Object.fromEntries(list.map((entry: any[]) => [entry[0], entry]));
const tally = (staged: number, reconstructed: number) => ({
  staged,
  reconstructed,
  skipped: 0,
  failed: 0,
});
/** The OLD-shape snapshot (down target) and the S8-B snapshot (up target), both OID-free. */
let before: ReturnType<typeof shape>;
let after: ReturnType<typeof shape>;
let afterOids: ReturnType<typeof shapeWithOids>;

// Teardown authority (S5-R3-A-01), unchanged from the accepted proofs: no mutating cleanup
// against a fixture whose identity this proof never accepted.
let teardownAuthorized = false;

beforeAll(() => {
  const identity =
    json(`SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),
    'port',inet_server_port(),'directory',${quote(sqlAdmin(`SELECT current_setting('data_directory')`))},
    'version',current_setting('server_version_num'),'user',current_user,'super',
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassrls',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),'owner',
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`);
  expect(identity).toMatchObject({
    database: 'g2_s8b_disposable',
    address: '127.0.0.1',
    port: target.port,
    directory,
    user: 'postgres',
    super: false,
    bypassrls: true,
    owner: 'postgres',
  });
  expect(Number(identity.version)).toBe(expectedVersion);
  expect(Number(identity.version)).toBeGreaterThanOrEqual(170000);
  expect(Number(identity.version)).toBeLessThan(180000);
  expect(directory).toMatch(/\/pg17\/clusters\/s8-b\/pg-data$/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_S8B_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_S8B_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh OLD-shaped bootstrap: the whole accepted history through the OLD root's own
  // `prisma migrate deploy`; S8-B absent in both catalog and history.
  expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(S8B_MIGRATION)}`),
  ).toBe('0');
  expect(exists(PROVENANCE)).toBe(false);
  expect(ledgerTargetKind()).toEqual([]);
  for (const name of LEDGER_CHECK_NAMES)
    expect(byName(constraints(LEDGER))).not.toHaveProperty(name);
  expect(byName(indexes(LEDGER))).toHaveProperty('ScoutReconstructionLedger_identity_key');
  // The candidate ships exactly S8-B: its migration tree differs from OLD_HEAD by the two files.
  expect(
    execFileSync('git', ['diff', '--name-only', OLD_HEAD, 'HEAD', '--', 'prisma/migrations'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort(),
  ).toEqual([
    `prisma/migrations/${S8B_MIGRATION}/down.sql`,
    `prisma/migrations/${S8B_MIGRATION}/migration.sql`,
  ]);
  // The candidate client is S8-B's (provenance model + ledger target_kind); the OLD client is
  // pre-S8-B (neither), while both carry N's required ledger source_platform.
  const client = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  expect(client).toMatch(/model ImportNativeProvenance \{/);
  expect(client).toMatch(/model ScoutReconstructionLedger \{[^}]*\n\s+target_kind\s+String\?/);
  expect(client).toMatch(/model ScoutReconstructionLedger \{[^}]*\n\s+source_platform\s+String\s/);
  const old = readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8');
  expect(old).not.toMatch(/model ImportNativeProvenance \{/);
  expect(old).not.toMatch(/model ScoutReconstructionLedger \{[^}]*\n\s+target_kind\s/);
  expect(old).toMatch(/model ScoutReconstructionLedger \{[^}]*\n\s+source_platform\s+String\s/);
  expect(
    sql(`SELECT string_agg(rolsuper::text||':'||rolbypassrls::text,',' ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`),
  ).toBe('false:false,false:false,false:true');
  // Read-only gates passed; authorize teardown, then the accepted setup mutations.
  teardownAuthorized = true;
  sql(`GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
    GRANT ALL ON public."ScoutImport",public."ScoutIngestEntity",public."ScoutReconstructionLedger",
      public."Person",public."ScoutReconstructedEntity",public."ImportIntent",public."ExtensionPairCode",
      public."User" TO service_role,anon,authenticated;`);
  resetData();
  settle();
});

afterAll(() => {
  if (!teardownAuthorized) {
    console.warn(
      'PG17_TEARDOWN_SKIPPED',
      JSON.stringify({ reason: 'setup refused before first mutation; no DDL/DML issued' }),
    );
    return;
  }
  // Synthetic rows only; the schema (S8-B applied and recorded) is retained for inspection.
  resetData();
});

describe('stage 1: OLD shape baseline and refusing entry gates', () => {
  it('the OLD N writer reconstructs a family on the pre-S8-B schema (baseline snapshot)', async () => {
    stage('a');
    const pass = await run({}, true);
    expect(pass.failure).toBeUndefined();
    expect(pass.result).toEqual(tally(1, 1));
    expect(identityRows()).toEqual([
      ['clients', 'a', 'truecoach', 'reconstructed', expect.any(String)],
    ]);
    expect(personCount()).toBe(1);
    before = shape();
    expect(before.provenanceExists).toBe(false);
    expect(before.ledger.rls).toMatchObject({ enabled: true, forced: true });
    expect(before.ledger.rls.policies.map((p: any) => p.policyname)).toEqual([...LEDGER_POLICIES]);
  });
  it('a decoy relation holding the provenance name refuses up; the decoy and the ledger are untouched', () => {
    sql(`CREATE TABLE public."${PROVENANCE}" (decoy integer)`);
    const withDecoy = shapeWithOids();
    refusedFile(upFile, ALREADY);
    expect(shapeWithOids()).toEqual(withDecoy);
    expect(ledgerTargetKind()).toEqual([]);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
    // Fixture shaping only: remove the harness's own decoy; the OLD shape is back.
    sql(`DROP TABLE public."${PROVENANCE}"`);
    expect(shape()).toEqual(before);
  });
  it('a decoy ledger constraint holding an S8-B name refuses up; nothing is created', () => {
    sql(
      `ALTER TABLE public."${LEDGER}" ADD CONSTRAINT "ScoutReconstructionLedger_target_kind_check" CHECK (true)`,
    );
    const withDecoy = shapeWithOids();
    refusedFile(upFile, ALREADY);
    expect(shapeWithOids()).toEqual(withDecoy);
    expect(exists(PROVENANCE)).toBe(false);
    sql(
      `ALTER TABLE public."${LEDGER}" DROP CONSTRAINT "ScoutReconstructionLedger_target_kind_check"`,
    );
    expect(shape()).toEqual(before);
  });
  it('a held transaction on the ledger makes up hit lock_timeout (55P03); nothing applied; release → free', async () => {
    const snapshot = shapeWithOids();
    const holder = holdTransaction(`SELECT count(*) FROM public."${LEDGER}"`);
    await holder.held;
    try {
      let error: unknown;
      const started = Date.now();
      try {
        sqlFile(upFile);
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      expect(String(error)).toMatch(/canceling statement due to lock timeout/);
      // The 5s budget is the file's own SET LOCAL lock_timeout, not the harness timeout.
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(30000);
      expect(shapeWithOids()).toEqual(snapshot);
      expect(exists(PROVENANCE)).toBe(false);
      expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
      console.warn('PG17_LOCK_TIMEOUT', JSON.stringify({ elapsed }));
    } finally {
      holder.release();
    }
    for (let n = 0; n < 200; n++) {
      const held = sqlAdmin(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE c.relname=${quote(LEDGER)} AND l.granted AND l.pid<>pg_backend_pid()`);
      if (held === '0') return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('holder did not release the ledger lock');
  });
});

describe('stage 2: S8-B through the release mechanism', () => {
  it('P01: prisma migrate deploy applies exactly S8-B; both catalogs exact; ledger RLS and rows untouched', () => {
    const ledgerBefore = ledgerRowsWithoutTargetKind();
    const since = sql('SELECT now()');
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(S8B_MIGRATION);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
    expect(
      json(`SELECT COALESCE(jsonb_agg(migration_name ORDER BY migration_name),'[]')
      FROM "_prisma_migrations" WHERE finished_at >= ${quote(since)}::timestamptz`),
    ).toEqual([S8B_MIGRATION]);
    // Provenance table: exact columns (names, types, nullability, defaults, order).
    expect(columns(PROVENANCE)).toEqual(EXPECTED_PROVENANCE_COLUMNS);
    // Constraints: four validated CHECKs, the composite FK, the PK; nothing else.
    const cons = byName(constraints(PROVENANCE));
    for (const name of PROVENANCE_CHECK_NAMES) {
      expect(cons[name]).toEqual([name, 'c', true, EXPECTED_PROVENANCE_CHECK_DEFS[name]]);
    }
    expect(cons[FK_NAME]).toEqual([FK_NAME, 'f', true, EXPECTED_FK_DEF]);
    expect(cons.ImportNativeProvenance_pkey).toEqual([
      'ImportNativeProvenance_pkey',
      'p',
      true,
      EXPECTED_PK_DEF,
    ]);
    expect(Object.keys(cons).sort()).toEqual(
      [...PROVENANCE_CHECK_NAMES, FK_NAME, 'ImportNativeProvenance_pkey'].sort(),
    );
    // Indexes: PK, the D-S8-3 identity key, the native reverse lookup, the per-intent index.
    const idx = byName(indexes(PROVENANCE));
    expect(Object.keys(idx).sort()).toEqual(Object.keys(EXPECTED_INDEX_DEFS).sort());
    for (const [name, def] of Object.entries(EXPECTED_INDEX_DEFS)) {
      expect(idx[name]).toEqual([name, name.endsWith('_idx') ? false : true, true, def]);
    }
    // RLS: enabled + forced, exactly the three policies, no API-role table privilege (revoked),
    // service_role privileged.
    const posture = rls(PROVENANCE);
    expect(posture).toMatchObject({ enabled: true, forced: true });
    expect(posture.policies.map((p: any) => p.policyname)).toEqual([...PROVENANCE_POLICIES]);
    expect(posture.policies.map((p: any) => [p.policyname, p.permissive, p.roles, p.cmd])).toEqual([
      ['deny_all_anon_import_native_provenance', 'RESTRICTIVE', ['anon'], 'ALL'],
      ['deny_all_authenticated_import_native_provenance', 'RESTRICTIVE', ['authenticated'], 'ALL'],
      ['p_import_native_provenance_service_role_all', 'PERMISSIVE', ['service_role'], 'ALL'],
    ]);
    const grantees = new Set(posture.grants.map((g: any[]) => g[0]));
    expect(grantees.has('anon')).toBe(false);
    expect(grantees.has('authenticated')).toBe(false);
    expect(grantees.has('service_role')).toBe(true);
    // Ledger: exactly one nullable TEXT column without default appended, exactly two validated
    // CHECKs added; indexes, RLS flags, policies and grants byte-equal to the OLD shape.
    expect(columns(LEDGER)).toEqual([...before.ledger.columns, EXPECTED_LEDGER_TARGET_KIND]);
    expect(ledgerTargetKind()).toEqual([EXPECTED_LEDGER_TARGET_KIND]);
    const ledgerCons = byName(constraints(LEDGER));
    for (const name of LEDGER_CHECK_NAMES) {
      expect(ledgerCons[name]).toEqual([name, 'c', true, EXPECTED_LEDGER_CHECK_DEFS[name]]);
    }
    expect(Object.keys(ledgerCons).sort()).toEqual(
      [...before.ledger.constraints.map((c: any[]) => c[0]), ...LEDGER_CHECK_NAMES].sort(),
    );
    expect(indexes(LEDGER)).toEqual(before.ledger.indexes);
    expect(rls(LEDGER)).toEqual(before.ledger.rls);
    // Existing ledger rows: every old column untouched, target_kind NULL on every row.
    expect(ledgerRowsWithoutTargetKind()).toEqual(ledgerBefore);
    expect(ledgerTypedCount()).toBe(0);
    expect(provenanceCount()).toBe(0);
    after = shape();
    afterOids = shapeWithOids();
    console.warn('PG17_S8B_APPLIED', JSON.stringify({ columns: columns(PROVENANCE).length }));
  });
  it('P02: a raw rerun of S8-B is refused atomically; OIDs, rows and history unchanged; deploy has nothing pending', () => {
    const data = ledgerRows();
    refusedFile(upFile, ALREADY);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(ledgerRows()).toEqual(data);
    expect(provenanceCount()).toBe(0);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
    const again = prisma(root, ['migrate', 'deploy']);
    expect(again.ok).toBe(true);
    expect(again.output).toMatch(/No pending migrations/);
    expect(shapeWithOids()).toEqual(afterOids);
  });
});

describe('stage 3: writers, constraints and API roles on S8-B', () => {
  it('P05: the OLD image N writer (pre-S8-B client) reconstructs on S8-B unchanged: ledger rows carry target_kind NULL; replay converges', async () => {
    stage('b');
    const pass = await run({}, true);
    expect(pass.failure).toBeUndefined();
    expect(pass.result).toEqual(tally(2, 2));
    expect(identityRows()).toEqual([
      ['clients', 'a', 'truecoach', 'reconstructed', expect.any(String)],
      ['clients', 'b', 'truecoach', 'reconstructed', expect.any(String)],
    ]);
    expect(ledgerTypedCount()).toBe(0);
    expect(personCount()).toBe(2);
    expect(provenanceCount()).toBe(0);
    // Replay from the OLD image: identical tally, no new row, no drift.
    const first = ledgerRows();
    const replay = await run({}, true);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(tally(2, 2));
    expect(ledgerRows()).toEqual(first);
    expect(personCount()).toBe(2);
  });
  it('P05: the candidate image N writer and both images` roster read behave identically on S8-B', async () => {
    stage('c');
    const pass = await run({});
    expect(pass.failure).toBeUndefined();
    expect(pass.result).toEqual(tally(3, 3));
    expect(identityRows().map((r: any[]) => r[1])).toEqual(['a', 'b', 'c']);
    // The N writer never names target_kind: the candidate image leaves it NULL as well.
    expect(ledgerTypedCount()).toBe(0);
    expect(provenanceCount()).toBe(0);
    const oldRead = await run({ action: 'roster', limit: 10 }, true);
    const newRead = await run({ action: 'roster', limit: 10 });
    expect(oldRead.failure).toBeUndefined();
    expect(newRead.failure).toBeUndefined();
    expect(newRead.result).toEqual(oldRead.result);
    // Cross-tenant and unknown intents stay a uniform 404 for both images.
    const foreignOld = await run({ action: 'roster', coach: 'other', limit: 10 }, true);
    const foreignNew = await run({ action: 'roster', coach: 'other', limit: 10 });
    expect(foreignOld.failure).toMatchObject({ status: 404 });
    expect(foreignNew.failure).toMatchObject({ status: 404 });
  });
  it('CHECK/FK refuse every malformed provenance or typed-ledger row for the owner and the runtime role; nothing is written', () => {
    const data = provenanceRows();
    const ledger = ledgerRows();
    const foreign = intent('other');
    const cases: [string, string][] = [
      [provenanceInsert({ native_kind: "'client'" }), 'ImportNativeProvenance_native_kind_check'],
      [provenanceInsert({ native_kind: "'Person'" }), 'ImportNativeProvenance_native_kind_check'],
      [provenanceInsert({ outcome: "'failed'" }), 'ImportNativeProvenance_outcome_check'],
      [provenanceInsert({ outcome: "'reconstructed'" }), 'ImportNativeProvenance_outcome_check'],
      // A2 closure: native_id NULL iff unresolved.
      [provenanceInsert({ native_id: 'NULL' }), 'ImportNativeProvenance_native_id_shape_check'],
      [
        provenanceInsert({ outcome: "'already_present'", native_id: 'NULL' }),
        'ImportNativeProvenance_native_id_shape_check',
      ],
      [
        provenanceInsert({ outcome: "'unresolved'", reason: "'unresolved:exercise_reference'" }),
        'ImportNativeProvenance_native_id_shape_check',
      ],
      [
        provenanceInsert({ outcome: "'unresolved'", native_id: 'NULL' }),
        'ImportNativeProvenance_unresolved_reason_check',
      ],
      [provenanceInsert({ import_intent_id: `${quote(foreign)}::uuid` }), FK_NAME],
      [provenanceInsert({ import_intent_id: 'gen_random_uuid()' }), FK_NAME],
      [provenanceInsert({ coach_id: 'NULL' }), 'null value in column "coach_id"'],
      [provenanceInsert({ source_namespace: 'NULL' }), 'null value in column "source_namespace"'],
      [provenanceInsert({ source_id: 'NULL' }), 'null value in column "source_id"'],
      [
        `UPDATE "${LEDGER}" SET target_kind='workout_plan_exercise' WHERE coach_id='coach' AND source_id='a'`,
        'ScoutReconstructionLedger_target_kind_check',
      ],
      [
        `UPDATE "${LEDGER}" SET target_kind='Person' WHERE coach_id='coach' AND source_id='a'`,
        'ScoutReconstructionLedger_target_kind_check',
      ],
      [
        `INSERT INTO "${LEDGER}" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,target_kind,reason)
         VALUES ('typed-without-target','coach','intent','workouts','w-x','truecoach','skipped',NULL,'workout_plan','unresolved:no_native_client_principal')`,
        'ScoutReconstructionLedger_target_kind_shape_check',
      ],
    ];
    for (const [statement, constraint] of cases) refused(statement, constraint);
    // The runtime role (BYPASSRLS service_role) is bound by the same constraints.
    refused(
      provenanceInsert({ outcome: "'unresolved'", native_id: 'NULL' }),
      'ImportNativeProvenance_unresolved_reason_check',
      'service_role',
    );
    refused(
      provenanceInsert({ import_intent_id: `${quote(foreign)}::uuid` }),
      FK_NAME,
      'service_role',
    );
    expect(provenanceRows()).toEqual(data);
    expect(ledgerRows()).toEqual(ledger);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(intentCount()).toBeGreaterThanOrEqual(1);
  });
  it('D-S8-3 identity, the child source_id encoding and the typed ledger target are accepted exactly once; the bound intent cannot vanish', () => {
    const owned = intent('coach');
    // Top-level created record bound to the coach's intent.
    sql(provenanceInsert({ import_intent_id: `${quote(owned)}::uuid` }));
    expect(provenanceRows()).toEqual([
      expect.objectContaining({
        coach_id: 'coach',
        import_intent_id: owned,
        source_namespace: 'truecoach',
        entity_type: 'workouts',
        source_id: 'w-1',
        native_kind: 'workout_plan',
        native_id: 'plan-1',
        outcome: 'created',
        reason: null,
      }),
    ]);
    // The same identity again (any outcome, any native target) is refused by the identity key only.
    refused(
      provenanceInsert({ native_id: "'plan-other'", outcome: "'already_present'" }),
      `duplicate key value violates unique constraint "${IDENTITY_INDEX}"`,
    );
    // Another namespace, coach or family with the same source_id is a different identity.
    sql(provenanceInsert({ source_namespace: "'auto:other.example'" }));
    sql(provenanceInsert({ coach_id: "'other'", native_id: "'plan-of-other'" }));
    sql(
      provenanceInsert({
        entity_type: "'programs'",
        native_kind: "'workout_program'",
        native_id: "'program-1'",
      }),
    );
    // Children (contract §3.3): a written exercise and an unresolved one under the same parent,
    // the id-bearing and ordinal forms kept apart by their markers; nested ids with `#`/`:` and a
    // long parent id stay unambiguous through the length prefix.
    const exercise = (child: { id: string } | { ordinal: number }) =>
      quote(childSourceId('w-1', child));
    sql(
      provenanceInsert({
        entity_type: "'workouts.exercise'",
        source_id: exercise({ id: '3' }),
        native_kind: "'workout_plan_exercise'",
        native_id: "'exercise-1'",
      }),
    );
    sql(
      provenanceInsert({
        entity_type: "'workouts.exercise'",
        source_id: exercise({ ordinal: 3 }),
        native_kind: "'workout_plan_exercise'",
        native_id: 'NULL',
        outcome: "'unresolved'",
        reason: "'unresolved:exercise_reference'",
      }),
    );
    expect(childSourceId('w-1', { id: '3' })).toBe('3:w-1#id:3');
    expect(childSourceId('w-1', { ordinal: 3 })).toBe('3:w-1#ord:3');
    expect(childSourceId('a#id:b', { id: 'c' })).toBe('6:a#id:b#id:c');
    expect(childSourceId('a', { id: 'b#id:c' })).toBe('1:a#id:b#id:c');
    const longParent = 'p'.repeat(4000);
    sql(
      provenanceInsert({
        entity_type: "'workouts.exercise'",
        source_id: quote(childSourceId(longParent, { id: 'x' })),
        native_kind: "'workout_plan_exercise'",
        native_id: "'exercise-long'",
      }),
    );
    expect(
      sql(
        `SELECT max(length(source_id)) FROM "${PROVENANCE}" WHERE entity_type='workouts.exercise'`,
      ),
    ).toBe(String(childSourceId(longParent, { id: 'x' }).length));
    expect(provenanceCount()).toBe(7);
    // Typed ledger target beside an existing target_id is accepted for every ledger kind.
    sql(
      `UPDATE "${LEDGER}" SET target_kind='person' WHERE coach_id='coach' AND entity_type='clients'`,
    );
    expect(ledgerTypedCount()).toBe(ledgerCount());
    // RESTRICT: the bound intent cannot vanish under its provenance (owner erasure through the
    // User cascade therefore fails closed as well while bound provenance exists: the L8 seam).
    refused(`DELETE FROM "ImportIntent" WHERE id=${quote(owned)}::uuid`, FK_NAME);
    expect(intentCount()).toBeGreaterThanOrEqual(1);
    // Fixture shaping only: back to untyped ledger rows for the API-role and down stages.
    sql(`UPDATE "${LEDGER}" SET target_kind=NULL`);
    expect(ledgerTypedCount()).toBe(0);
  });
  it('P06: anon/authenticated are refused by privilege AND by policy; a service_role transaction that rolls back persists nothing', () => {
    const data = provenanceRows();
    for (const role of ['anon', 'authenticated']) {
      // Belt: the migration revoked the API roles' table privileges.
      refused(`SET ROLE ${role}; SELECT count(*) FROM "${PROVENANCE}"`, 'permission denied');
      refused(
        `SET ROLE ${role}; ${provenanceInsert({ source_id: "'w-api'" })}`,
        'permission denied',
      );
      // Braces: even with privileges granted back (fixture shaping only), the RESTRICTIVE
      // policies deny every command; the grant is revoked again below.
      sql(`GRANT ALL ON "${PROVENANCE}" TO ${role}`);
      expect(sql(`SET ROLE ${role}; SELECT count(*) FROM "${PROVENANCE}"`)).toBe('0');
      refused(
        `SET ROLE ${role}; ${provenanceInsert({ source_id: "'w-api'" })}`,
        'row-level security',
      );
      expect(
        sql(
          `SET ROLE ${role}; WITH u AS (UPDATE "${PROVENANCE}" SET reason='x' RETURNING id) SELECT count(*) FROM u`,
        ),
      ).toBe('0');
      expect(
        sql(
          `SET ROLE ${role}; WITH d AS (DELETE FROM "${PROVENANCE}" RETURNING id) SELECT count(*) FROM d`,
        ),
      ).toBe('0');
      sql(`REVOKE ALL ON "${PROVENANCE}" FROM ${role}`);
    }
    expect(provenanceRows()).toEqual(data);
    expect(rls(PROVENANCE)).toEqual(after.provenance.rls);
    // Runtime role: a provenance row inside a transaction that rolls back leaves no trace.
    expect(
      sqlAs(
        'service_role',
        `BEGIN; ${provenanceInsert({ source_id: "'w-rollback'" })}; SELECT count(*) FROM "${PROVENANCE}" WHERE source_id='w-rollback'; ROLLBACK;`,
      ),
    ).toBe('1');
    expect(provenanceRows()).toEqual(data);
    expect(sqlAs('service_role', `SELECT count(*) FROM "${PROVENANCE}"`)).toBe(String(data.length));
  });
});

describe('stage 4: down refuses provenance state; on an empty ledger of facts it removes exactly S8-B', () => {
  it('P03: down refuses with provenance rows (fixed text); nothing deleted; schema, OIDs and history unchanged', () => {
    expect(provenanceCount()).toBeGreaterThan(0);
    const data = provenanceRows();
    const ledger = ledgerRows();
    refusedFile(downFile, REFUSE_DOWN);
    expect(provenanceRows()).toEqual(data);
    expect(ledgerRows()).toEqual(ledger);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
    // A typed ledger target alone refuses down as well (a recorded fact the drop would erase).
    sql(`DELETE FROM "${PROVENANCE}"`);
    sql(`UPDATE "${LEDGER}" SET target_kind='person' WHERE coach_id='coach' AND source_id='a'`);
    refusedFile(downFile, REFUSE_DOWN);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(ledgerTypedCount()).toBe(1);
    // Fixture shaping only: back to no recorded provenance facts.
    sql(`UPDATE "${LEDGER}" SET target_kind=NULL`);
    expect(ledgerTypedCount()).toBe(0);
    expect(provenanceCount()).toBe(0);
  });
  it('P04: down removes exactly S8-B and keeps every ledger row and value; the OLD writer continues; a second down refuses', async () => {
    const keep = ledgerRowsWithoutTargetKind();
    expect(keep.length).toBeGreaterThanOrEqual(3);
    sqlFile(downFile);
    expect(shape()).toEqual(before);
    expect(exists(PROVENANCE)).toBe(false);
    expect(ledgerTargetKind()).toEqual([]);
    expect(ledgerRowsWithoutTargetKind()).toEqual(keep);
    expect(ledgerRows()).toEqual(keep);
    // The recorded history is not rewritten by the file (forward repair doctrine).
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
    refusedFile(downFile, ABSENT);
    expect(shape()).toEqual(before);
    stage('d');
    const pass = await run({}, true);
    expect(pass.failure).toBeUndefined();
    expect(pass.result).toEqual(tally(4, 4));
    expect(identityRows().map((r: any[]) => r[1])).toEqual(['a', 'b', 'c', 'd']);
  });
  it('re-applying the file restores the identical shape (OIDs aside); ledger rows keep target_kind NULL; a raw rerun is refused again', () => {
    const keep = ledgerRowsWithoutTargetKind();
    sqlFile(upFile);
    expect(shape()).toEqual(after);
    expect(ledgerRowsWithoutTargetKind()).toEqual(keep);
    expect(ledgerTypedCount()).toBe(0);
    expect(provenanceCount()).toBe(0);
    refusedFile(upFile, ALREADY);
    expect(shape()).toEqual(after);
    const again = prisma(root, ['migrate', 'deploy']);
    expect(again.ok).toBe(true);
    expect(again.output).toMatch(/No pending migrations/);
    console.warn('PG17_S8B_DOWN_UP', JSON.stringify({ ledgerRows: ledgerCount() }));
  });
});
