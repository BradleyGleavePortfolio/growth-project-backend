// G2-S7-L proof (replacement lineage) on the isolated PostgreSQL 17 lane (synthetic data only).
// Ordered stages in ONE file, run with --runInBand, on a FRESH bootstrap whose "old" side is a
// detached checkout of OLD_HEAD (the S7-L base: the accepted S8-B head 93389265), whose
// `prisma migrate deploy` installed the whole accepted history (171). The candidate ships EXACTLY
// ONE migration (20270123000000_scout_run_lifecycle_expand), applied here through the candidate's
// own `prisma migrate deploy` (L01, the release mechanism). Decision:
// docs/decisions/2026-09-24-s7l-run-lifecycle.md §9 (L01-L12).
//   1. baseline on the OLD shape: the OLD legacy `/complete` writer settles a legacy run; up
//      refuses a decoy relation, a decoy constraint and a held lock, each leaving nothing; down
//      refuses on the OLD shape;
//   2. L01 deploy exactness (ten columns, four CHECKs, partial unique, composite FK; ScoutImport
//      RLS byte-equal; ImportIntent untouched; legacy rows byte-identical with defaults), L02 rerun
//      refusal, plus the SQL-level §3.1 gate serialization (no 40P01) and the FOR NO KEY UPDATE
//      fence wait;
//   3. CHECK/FK/partial-unique matrix and L06 API-role denial / service-role rollback;
//   4. writers through the REAL services in separate OS processes: L07 duplicate Start race and
//      Start guards; L08 cancel vs in-flight ingest and ingest vs /progress with barriers (row lock,
//      no 40P01, last_observed_at monotonic); L09 late /complete and /complete on a run that never
//      started; L10 lazy deadline (fence after the writer's rollback, no self-wait); L11
//      projections; L05/L12 the OLD image's legacy writers on the S7-L schema and the legacy marker
//      protecting a server row from an old writer;
//   5. L03 down refusal with one server row (fixed text, nothing deleted), L04 down/up shape
//      identity with legacy rows retained; history never rewritten.
// Accepted E/T-Q0, B, R, N/Q1, C and S8-B proofs are neither rerun nor restated. Nothing here
// claims deployment, S8-G/S9 behaviour (no reconciliation verdict exists: every settle is
// partial/reconciliation_not_performed), or customer acceptance.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  appliedMigrations,
  blocked,
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
  S7L_MIGRATION,
  sql,
  sqlAdmin,
  sqlAs,
  sqlFile,
  target,
  upFile,
  worker,
} from './utils/g2-s7l-pg-harness';
import { G2_S7L_CLUSTER_MARKER, G2_S7L_DATABASE_MARKER } from './utils/g2-s7l-db';
import {
  byName,
  completionRows,
  constraints,
  EXPECTED_CHECK_DEFS,
  EXPECTED_FK_DEF,
  EXPECTED_INDEX_DEFS,
  EXPECTED_LIFECYCLE_COLUMNS,
  expire,
  FK_NAME,
  gateSql,
  historyRows,
  indexes,
  intent,
  intentCount,
  legacyRun,
  LIFECYCLE_COLUMNS,
  lifecycleColumns,
  PARTIAL_INDEX,
  resetData,
  rls,
  RUN,
  RUN_CHECK_NAMES,
  RUN_POLICIES,
  runCount,
  runRow,
  runRows,
  runRowsLegacyView,
  serverRunCount,
  serverRunInsert,
  shape,
  shapeWithOids,
  stage,
  stagedCount,
  supersede,
} from './utils/g2-s7l-harness';

jest.setTimeout(240000);
/** Accepted history installed by the OLD root's deploy: 171 at the accepted S8-B head 93389265. */
const EXPECTED_HISTORY = 171;
const ALREADY = 'G2-S7L run lifecycle already present';
const ABSENT = 'G2-S7L run lifecycle absent';
const REFUSE_DOWN = 'Run lifecycle state exists; retain schema and use compatible forward repair';
const COACH = 'coach';
const OTHER = 'other-coach';
const LEGACY_INTENT = 'intent_legacy_2026';
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });
const conflict = (code: string, extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ status: 409, response: expect.objectContaining({ code, ...extra }) });
/** The OLD-shape snapshot (down target) and the S7-L snapshot (up target), both OID-free. */
let before: ReturnType<typeof shape>;
let after: ReturnType<typeof shape>;
let afterOids: ReturnType<typeof shapeWithOids>;
let rlsBefore: any;
let legacyBaseline: any[];

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
    database: 'g2_s7l_disposable',
    address: '127.0.0.1',
    port: target.port,
    directory,
    user: 'postgres',
    super: false,
    bypassrls: true,
    owner: 'postgres',
  });
  expect(target.port).toBe(55641);
  expect(Number(identity.version)).toBe(expectedVersion);
  expect(Number(identity.version)).toBeGreaterThanOrEqual(170000);
  expect(Number(identity.version)).toBeLessThan(180000);
  // Fresh recovery-reset lane only: never a historical /home/user/pg17 path or the tool dist.
  expect(directory).toMatch(/\/execution\/64e33dc7\/recovery-reset\/.*\/s7l\/pg-data$/);
  expect(directory).not.toMatch(/pg17\/dist/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_S7L_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_S7L_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh OLD-shaped bootstrap: the whole accepted history through the OLD root's own
  // `prisma migrate deploy`; S8-B present, S7-L absent in both catalog and history.
  expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(S7L_MIGRATION)}`),
  ).toBe('0');
  expect(sql(`SELECT to_regclass('public."ImportNativeProvenance"') IS NOT NULL`)).toBe('t');
  expect(lifecycleColumns()).toEqual([]);
  for (const name of RUN_CHECK_NAMES) expect(byName(constraints(RUN))).not.toHaveProperty(name);
  expect(byName(constraints(RUN))).not.toHaveProperty(FK_NAME);
  expect(byName(indexes(RUN))).not.toHaveProperty(PARTIAL_INDEX);
  expect(Object.keys(byName(indexes(RUN))).sort()).toEqual([
    'ScoutImport_coach_id_idx',
    'ScoutImport_coach_id_intent_id_key',
    'ScoutImport_pkey',
  ]);
  rlsBefore = rls(RUN);
  expect(rlsBefore).toMatchObject({ enabled: true, forced: true });
  expect(rlsBefore.policies.map((p: any) => p.policyname)).toEqual([...RUN_POLICIES]);
  // The candidate ships exactly S7-L: its migration tree differs from OLD_HEAD by the two files.
  expect(
    execFileSync('git', ['diff', '--name-only', OLD_HEAD, 'HEAD', '--', 'prisma/migrations'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort(),
  ).toEqual([
    `prisma/migrations/${S7L_MIGRATION}/down.sql`,
    `prisma/migrations/${S7L_MIGRATION}/migration.sql`,
  ]);
  // The candidate client is S7-L's (lifecycle fields + relation); the OLD client is pre-S7-L,
  // while both carry S8-B's provenance model.
  const client = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  for (const column of LIFECYCLE_COLUMNS) {
    expect(client).toMatch(new RegExp(`model ScoutImport \\{[^}]*\\n\\s+${column}\\s`));
  }
  expect(client).toMatch(/model ScoutImport \{[^}]*\n\s+intent\s+ImportIntent\?/);
  expect(client).toMatch(/model ImportIntent \{[^}]*\n\s+runs\s+ScoutImport\[\]/);
  expect(client).toMatch(/model ImportNativeProvenance \{/);
  const old = readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8');
  for (const column of LIFECYCLE_COLUMNS) {
    expect(old).not.toMatch(new RegExp(`model ScoutImport \\{[^}]*\\n\\s+${column}\\s`));
  }
  expect(old).toMatch(/model ImportNativeProvenance \{/);
  expect(
    sql(`SELECT string_agg(rolsuper::text||':'||rolbypassrls::text,',' ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`),
  ).toBe('false:false,false:false,false:true');
  // Read-only gates passed; authorize teardown, then the accepted setup mutations.
  teardownAuthorized = true;
  sql(`GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
    GRANT ALL ON public."ScoutImport",public."ScoutImportCompletion",public."ScoutProgressSnapshot",
      public."ScoutIngestEntity",public."ScoutReconstructionLedger",public."Person",
      public."ScoutReconstructedEntity",public."ImportIntent",public."ExtensionPairCode",
      public."ImportNativeProvenance",public."User" TO service_role,anon,authenticated;`);
  resetData();
});

afterAll(() => {
  if (!teardownAuthorized) {
    console.warn(
      'PG17_TEARDOWN_SKIPPED',
      JSON.stringify({ reason: 'setup refused before first mutation; no DDL/DML issued' }),
    );
    return;
  }
  // Synthetic rows only; the schema (S7-L applied and recorded) is retained for inspection.
  resetData();
});

describe('stage 1: OLD shape baseline and refusing entry gates', () => {
  it('the OLD legacy /complete writer settles a legacy run on the pre-S7-L schema (baseline)', async () => {
    intent(COACH);
    const result = await run(
      {
        action: 'complete',
        coach: COACH,
        intent: LEGACY_INTENT,
        body: { terminal_status: 'success' },
      },
      true,
    );
    expect(result.failure).toBeUndefined();
    expect(result.result).toEqual(ack(LEGACY_INTENT));
    expect(runRow(COACH, LEGACY_INTENT)).toMatchObject({
      state: 'success',
      terminal_status: 'success',
    });
    expect(completionRows()).toEqual([[COACH, LEGACY_INTENT, 'success']]);
    legacyBaseline = runRowsLegacyView();
    expect(legacyBaseline).toHaveLength(1);
    before = shape();
  });
  it('a decoy relation holding the partial-unique name refuses up; the decoy and the run table are untouched', () => {
    sql(`CREATE TABLE "${PARTIAL_INDEX}" (x int)`);
    const oids = shapeWithOids();
    refusedFile(upFile, ALREADY);
    expect(shapeWithOids()).toEqual(oids);
    expect(lifecycleColumns()).toEqual([]);
    expect(sql(`SELECT to_regclass('public."${PARTIAL_INDEX}"') IS NOT NULL`)).toBe('t');
    sql(`DROP TABLE "${PARTIAL_INDEX}"`);
    expect(shape()).toEqual(before);
  });
  it('a decoy constraint holding an S7-L name refuses up; nothing is created', () => {
    sql(`ALTER TABLE "${RUN}" ADD CONSTRAINT "ScoutImport_mode_check" CHECK (true)`);
    refusedFile(upFile, ALREADY);
    expect(lifecycleColumns()).toEqual([]);
    expect(Object.keys(byName(constraints(RUN)))).toContain('ScoutImport_mode_check');
    expect(byName(constraints(RUN))).not.toHaveProperty('ScoutImport_phase_check');
    sql(`ALTER TABLE "${RUN}" DROP CONSTRAINT "ScoutImport_mode_check"`);
    expect(shape()).toEqual(before);
  });
  it('a held transaction on the run table makes up hit lock_timeout (55P03); nothing applied; release → free', async () => {
    const holder = holdTransaction(
      `SELECT 1 FROM "${RUN}" WHERE coach_id=${quote(COACH)} FOR UPDATE`,
    );
    await holder.held;
    const started = Date.now();
    refusedFile(upFile, '55P03');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    expect(lifecycleColumns()).toEqual([]);
    expect(shape()).toEqual(before);
    holder.release();
    await new Promise((r) => setTimeout(r, 200));
    expect(
      sqlAdmin(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE c.relname=${quote(RUN)} AND l.granted AND l.pid<>pg_backend_pid()`),
    ).toBe('0');
  });
  it('down on the OLD shape refuses with the fixed absent text; nothing changes', () => {
    refusedFile(downFile, ABSENT);
    expect(shape()).toEqual(before);
    expect(runRowsLegacyView()).toEqual(legacyBaseline);
  });
});

describe('stage 2: S7-L through the release mechanism, catalog exactness and the gate SQL', () => {
  it('L01: prisma migrate deploy applies exactly S7-L; catalog exact; RLS byte-equal; legacy rows untouched', () => {
    const history = historyRows();
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(S7L_MIGRATION);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
    expect(historyRows()).toEqual([...history, [S7L_MIGRATION, expect.any(String), true, true]]);
    // Ten columns, exactly as shipped, appended after the accepted seven.
    expect(lifecycleColumns()).toEqual(EXPECTED_LIFECYCLE_COLUMNS);
    const cols = shape().run.columns.map(([name]: [string]) => name);
    expect(cols).toEqual([
      'id',
      'coach_id',
      'intent_id',
      'state',
      'terminal_status',
      'started_at',
      'completed_at',
      ...LIFECYCLE_COLUMNS,
    ]);
    // Four validated CHECKs and the validated composite FK; nothing else new on the table.
    const cons = byName(constraints(RUN));
    for (const name of RUN_CHECK_NAMES) {
      expect(cons[name]).toEqual([name, 'c', true, EXPECTED_CHECK_DEFS[name]]);
    }
    expect(cons[FK_NAME]).toEqual([FK_NAME, 'f', true, EXPECTED_FK_DEF]);
    expect(Object.keys(cons).sort()).toEqual(
      [...Object.keys(byName(before.run.constraints)), ...RUN_CHECK_NAMES, FK_NAME].sort(),
    );
    // Both accepted indexes plus the partial unique, exact definitions.
    const idx = byName(indexes(RUN));
    expect(Object.keys(idx).sort()).toEqual(Object.keys(EXPECTED_INDEX_DEFS).sort());
    for (const [name, def] of Object.entries(EXPECTED_INDEX_DEFS)) {
      expect(idx[name]).toEqual([name, def.startsWith('CREATE UNIQUE'), true, def]);
    }
    // RLS byte-equal (policies, flags and grants) and the FK target untouched.
    expect(rls(RUN)).toEqual(rlsBefore);
    expect(shape().intent).toEqual(before.intent);
    // Every existing row: mode legacy, epoch 1, everything else NULL; legacy view byte-identical.
    expect(runRowsLegacyView()).toEqual(legacyBaseline);
    expect(runRows()).toEqual(
      legacyBaseline.map((row: any) => ({
        ...row,
        mode: 'legacy',
        import_intent_id: null,
        phase: null,
        accepted_start_at: null,
        deadline_at: null,
        last_observed_at: null,
        execution_epoch: 1,
        fenced_at: null,
        fence_reason: null,
        reason_code: null,
      })),
    );
    after = shape();
    afterOids = shapeWithOids();
  });
  it('L02: a raw rerun is refused atomically; OIDs, rows and history unchanged; deploy has nothing pending', () => {
    const history = historyRows();
    refusedFile(upFile, ALREADY);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(runRows()).toHaveLength(1);
    expect(historyRows()).toEqual(history);
    const again = prisma(root, ['migrate', 'deploy']);
    expect(again.ok).toBe(true);
    expect(again.output).toMatch(/No pending migrations/);
    expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY + 1);
  });
  it('§3.1 gate SQL: two sessions on one run serialize on the UPDATE (no 40P01); last_observed_at monotonic; phase moves once', async () => {
    const intentId = intent(COACH);
    sqlAs('service_role', serverRunInsert(COACH, intentId));
    const holder = holdTransaction(gateSql(COACH, intentId));
    await holder.held;
    const gate2 = holdTransaction(gateSql(COACH, intentId));
    let settled = false;
    gate2.held.then(() => {
      settled = true;
    });
    // The second gate must WAIT (row lock), not fail with 40P01 and not proceed.
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    expect(
      Number(
        sqlAdmin(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query ILIKE '%last_observed_at%' AND datname=current_database()`),
      ),
    ).toBeGreaterThanOrEqual(1);
    holder.release();
    await gate2.held;
    const midway = runRow(COACH, intentId);
    // Holder committed: phase transferring, one observation; gate2 still holds its own UPDATE.
    expect(midway).toMatchObject({ phase: 'transferring', mode: 'server', execution_epoch: 1 });
    gate2.release();
    await new Promise((r) => setTimeout(r, 200));
    const final = runRow(COACH, intentId);
    expect(final.phase).toBe('transferring');
    expect(new Date(final.last_observed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(midway.last_observed_at).getTime(),
    );
    expect(final.execution_epoch).toBe(1);
  });
  it('a FOR NO KEY UPDATE fence waits for the gated writer to commit, then sees the committed observation', async () => {
    const intentId = intent(COACH);
    sqlAs('service_role', serverRunInsert(COACH, intentId));
    const writer = holdTransaction(gateSql(COACH, intentId));
    await writer.held;
    const fence = holdTransaction(
      `SELECT execution_epoch FROM "${RUN}" WHERE coach_id=${quote(COACH)} AND intent_id=${quote(intentId)} AND mode='server' FOR NO KEY UPDATE`,
    );
    let acquired = false;
    fence.held.then(() => {
      acquired = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(acquired).toBe(false);
    writer.release();
    await fence.held;
    expect(acquired).toBe(true);
    fence.release();
    await new Promise((r) => setTimeout(r, 200));
    expect(runRow(COACH, intentId)).toMatchObject({ phase: 'transferring', execution_epoch: 1 });
  });
});

describe('stage 3: constraints and API roles on S7-L', () => {
  beforeAll(() => {
    resetData();
  });
  it('CHECK/FK/partial-unique refuse every malformed run row for the owner and the runtime role; nothing is written', () => {
    const intentId = intent(COACH);
    const foreign = intent(OTHER);
    const count = runCount();
    const cases: [string, string][] = [
      // mode vocabulary and the mode shape
      [serverRunInsert(COACH, intentId, { mode: "'other'" }), 'ScoutImport_mode_check'],
      [
        serverRunInsert(COACH, intentId, { import_intent_id: 'NULL' }),
        'ScoutImport_mode_shape_check',
      ],
      [
        serverRunInsert(COACH, intentId, { accepted_start_at: 'NULL' }),
        'ScoutImport_mode_shape_check',
      ],
      [serverRunInsert(COACH, intentId, { deadline_at: 'NULL' }), 'ScoutImport_mode_shape_check'],
      [
        // Both clocks read the same statement now(): deadline_at = accepted_start_at.
        serverRunInsert(COACH, intentId, { deadline_at: "(now() AT TIME ZONE 'UTC')" }),
        'ScoutImport_mode_shape_check',
      ],
      [
        serverRunInsert(COACH, intentId, { terminal_status: "'success'", state: "'success'" }),
        'ScoutImport_mode_shape_check',
      ],
      [
        serverRunInsert(COACH, `${intentId}-legacy`, {
          mode: "'legacy'",
          import_intent_id: 'NULL',
          accepted_start_at: 'NULL',
          deadline_at: 'NULL',
          phase: 'NULL',
          terminal_status: "'complete'",
          state: "'complete'",
        }),
        'ScoutImport_mode_shape_check',
      ],
      [
        serverRunInsert(COACH, `${intentId}-legacy2`, {
          mode: "'legacy'",
          import_intent_id: `${quote(intentId)}::uuid`,
          accepted_start_at: 'NULL',
          deadline_at: 'NULL',
          phase: 'NULL',
        }),
        'ScoutImport_mode_shape_check',
      ],
      // phase, fence and epoch vocabularies
      [serverRunInsert(COACH, intentId, { phase: "'settling'" }), 'ScoutImport_phase_check'],
      [
        serverRunInsert(COACH, intentId, { fence_reason: "'cancelled'" }),
        'ScoutImport_fence_reason_check',
      ],
      [
        serverRunInsert(COACH, intentId, { fenced_at: "(now() AT TIME ZONE 'UTC')" }),
        'ScoutImport_fence_reason_check',
      ],
      [
        serverRunInsert(COACH, intentId, {
          fenced_at: "(now() AT TIME ZONE 'UTC')",
          fence_reason: "'paused'",
        }),
        'ScoutImport_fence_reason_check',
      ],
      [
        serverRunInsert(COACH, intentId, { execution_epoch: '0' }),
        'ScoutImport_fence_reason_check',
      ],
      // owner-scoped FK: unknown intent, and another coach's intent under this coach
      [serverRunInsert(COACH, '00000000-0000-4000-8000-000000000000'), FK_NAME],
      [serverRunInsert(COACH, foreign), FK_NAME],
    ];
    for (const [statement, message] of cases) {
      refused(statement, message);
      refused(statement, message, 'service_role');
    }
    expect(runCount()).toBe(count);
    // The well-formed server row is accepted exactly once per intent (partial unique), by the
    // runtime role; a second run for the same intent is refused even under another run id.
    sqlAs('service_role', serverRunInsert(COACH, intentId));
    refused(
      serverRunInsert(COACH, intentId, {
        id: quote('second-run'),
        intent_id: quote(`${intentId}-b`),
      }),
      PARTIAL_INDEX,
      'service_role',
    );
    // Legacy rows are free of the partial unique (NULL import_intent_id) and of the FK.
    legacyRun(COACH, 'legacy-a');
    legacyRun(COACH, 'legacy-b', 'partial');
    legacyRun(COACH, 'legacy-c', null);
    expect(runCount()).toBe(count + 4);
    // RESTRICT: the bound intent cannot vanish while its run exists; the coach's other rows can.
    refused(`DELETE FROM "ImportIntent" WHERE id=${quote(intentId)}::uuid`, FK_NAME);
    expect(intentCount()).toBe(2);
    // Server terminal vocabulary is accepted on the server row; the legacy one is not.
    sqlAs(
      'service_role',
      `UPDATE "${RUN}" SET terminal_status='complete', state='complete' WHERE intent_id=${quote(intentId)}`,
    );
    refused(
      `UPDATE "${RUN}" SET terminal_status='success' WHERE intent_id=${quote(intentId)}`,
      'ScoutImport_mode_shape_check',
      'service_role',
    );
    expect(runRow(COACH, intentId)).toMatchObject({ terminal_status: 'complete', mode: 'server' });
  });
  it('L06: anon/authenticated are refused by policy; a service_role transaction that rolls back persists nothing', () => {
    const intentId = intent(COACH);
    const count = runCount();
    for (const role of ['anon', 'authenticated']) {
      expect(sqlAs(role, `SELECT count(*) FROM "${RUN}"`)).toBe('0');
      refused(serverRunInsert(COACH, intentId), 'row-level security', role);
      // Policy-filtered UPDATE/DELETE see no rows: nothing changes.
      sqlAs(role, `UPDATE "${RUN}" SET phase='reconciling' WHERE mode='server'`);
      sqlAs(role, `DELETE FROM "${RUN}"`);
    }
    expect(runCount()).toBe(count);
    expect(sql(`SELECT count(*) FROM "${RUN}" WHERE phase='reconciling'`)).toBe('0');
    sqlAs(
      'service_role',
      `BEGIN; ${serverRunInsert(COACH, intentId)}; UPDATE "${RUN}" SET phase='transferring' WHERE intent_id=${quote(intentId)}; ROLLBACK;`,
    );
    expect(runCount()).toBe(count);
    expect(runRow(COACH, intentId)).toBeNull();
  });
});

describe('stage 4: the real writers on S7-L (separate OS processes, real clients, barriers)', () => {
  beforeAll(() => {
    resetData();
  });
  it('L07: Start guards — 404 foreign/unknown, 409 intent_not_paired, 409 intent_superseded, 409 legacy_run', async () => {
    const unpaired = intent(COACH, false);
    expect(await run({ action: 'start', coach: COACH, intent: unpaired })).toMatchObject({
      failure: conflict('intent_not_paired'),
    });
    const stale = intent(COACH);
    supersede(stale);
    expect(await run({ action: 'start', coach: COACH, intent: stale })).toMatchObject({
      failure: conflict('intent_superseded'),
    });
    const foreign = intent(OTHER);
    expect(await run({ action: 'start', coach: COACH, intent: foreign })).toMatchObject({
      failure: expect.objectContaining({ status: 404 }),
    });
    expect(
      await run({ action: 'start', coach: COACH, intent: '00000000-0000-4000-8000-000000000001' }),
    ).toMatchObject({ failure: expect.objectContaining({ status: 404 }) });
    // A legacy row already holding the intent's UUID as its string id: legacy_run, no rewrite.
    const taken = intent(COACH);
    legacyRun(COACH, taken);
    const legacyBefore = runRow(COACH, taken);
    expect(await run({ action: 'start', coach: COACH, intent: taken })).toMatchObject({
      failure: conflict('legacy_run'),
    });
    expect(runRow(COACH, taken)).toEqual(legacyBefore);
    expect(serverRunCount()).toBe(0);
  });
  it('L07: a duplicate Start race produces exactly one server row; both callers receive the same body', async () => {
    const intentId = intent(COACH);
    const [a, b] = await Promise.all([
      run({ action: 'start', coach: COACH, intent: intentId }),
      run({ action: 'start', coach: COACH, intent: intentId }),
    ]);
    for (const r of [a, b]) {
      expect(r.failure).toBeUndefined();
      expect(r.result).toMatchObject({
        intent_id: intentId,
        mode: 'server',
        phase: 'discovering',
        execution_epoch: 1,
      });
      expect(r.failure?.code).not.toBe('40P01');
    }
    expect(a.result).toEqual(b.result);
    expect(
      new Date(a.result.deadline_at).getTime() - new Date(a.result.accepted_start_at).getTime(),
    ).toBe(300_000);
    expect(
      sql(`SELECT count(*) FROM "${RUN}" WHERE import_intent_id=${quote(intentId)}::uuid`),
    ).toBe('1');
    expect(runRow(COACH, intentId)).toMatchObject({
      mode: 'server',
      phase: 'discovering',
      execution_epoch: 1,
      terminal_status: null,
      fenced_at: null,
      state: 'in_progress',
    });
    // Exactly one of the two emitted scout.run.started (the winner); the loser re-read.
    const started = [...a.events, ...b.events].filter((e) => e[1] === 'scout.run.started');
    expect(started).toHaveLength(1);
    // A third Start is the idempotent duplicate: same body, no second row, no event.
    const c = await run({ action: 'start', coach: COACH, intent: intentId });
    expect(c.result).toEqual(a.result);
    expect(c.events.filter((e) => e[1] === 'scout.run.started')).toHaveLength(0);
  });
  it('L08: cancel vs in-flight ingest — the fence waits on the gated writer, both succeed in order, no 40P01', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    const ingest = worker({
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      pause: 'gated',
      txTimeout: 30000,
      body: { sources: ['a', 'b', 'c'] },
    });
    await ingest.ready;
    const cancel = worker({ action: 'cancel', coach: COACH, intent: intentId });
    await blocked(cancel.name);
    // Nothing of either writer is visible yet: the gate holds the row, the ingest rows are uncommitted.
    expect(stagedCount(COACH, intentId)).toBe(0);
    expect(runRow(COACH, intentId)).toMatchObject({ phase: 'discovering', fenced_at: null });
    ingest.release();
    const ingested = await ingest.done;
    const cancelled = await cancel.done;
    expect(ingested.failure).toBeUndefined();
    expect(ingested.result).toEqual({ received: 3, deduped: 0 });
    expect(cancelled.failure).toBeUndefined();
    expect(cancelled.result).toEqual({
      intent_id: intentId,
      status: 'cancelled',
      execution_epoch: 2,
    });
    expect(stagedCount(COACH, intentId)).toBe(3);
    expect(runRow(COACH, intentId)).toMatchObject({
      phase: 'transferring',
      terminal_status: 'cancelled',
      state: 'cancelled',
      fence_reason: 'cancelled',
      reason_code: 'cancelled_by_coach',
      execution_epoch: 2,
    });
    expect(runRow(COACH, intentId).fenced_at).not.toBeNull();
    expect(runRow(COACH, intentId).completed_at).not.toBeNull();
    expect(cancelled.events.map((e) => e[1])).toContain('scout.run.fenced');
    // After the fence: ingest and progress are refused run_fenced/cancelled and write nothing.
    const late = await run({
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      body: { sources: ['d'] },
    });
    expect(late).toMatchObject({ failure: conflict('run_fenced', { fence_reason: 'cancelled' }) });
    expect(stagedCount(COACH, intentId)).toBe(3);
    // cancel is idempotent; a second cancel answers the same body without a new epoch.
    expect((await run({ action: 'cancel', coach: COACH, intent: intentId })).result).toEqual(
      cancelled.result,
    );
  });
  it('L08: concurrent ingest and /progress on one run serialize on the row lock; last_observed_at monotonic; no 40P01', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    const ingest = worker({
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      pause: 'gated',
      txTimeout: 30000,
      body: { sources: ['p1', 'p2'] },
    });
    await ingest.ready;
    const observedByGate = runRow(COACH, intentId).last_observed_at;
    expect(observedByGate).toBeNull(); // uncommitted
    const progress = worker({
      action: 'progress',
      coach: COACH,
      intent: intentId,
      body: { count: 2 },
    });
    await blocked(progress.name);
    ingest.release();
    const [ingested, progressed] = await Promise.all([ingest.done, progress.done]);
    expect(ingested.failure).toBeUndefined();
    expect(ingested.result).toEqual({ received: 2, deduped: 0 });
    expect(progressed.failure).toBeUndefined();
    for (const r of [ingested, progressed]) expect(JSON.stringify(r)).not.toContain('40P01');
    const row = runRow(COACH, intentId);
    expect(row).toMatchObject({ phase: 'transferring', execution_epoch: 1, terminal_status: null });
    expect(row.last_observed_at).not.toBeNull();
    expect(
      Number(
        sql(`SELECT count(*) FROM "ScoutProgressSnapshot" WHERE intent_id=${quote(intentId)}`),
      ),
    ).toBe(1);
    // The status projection carries the lifecycle and the observation.
    const status = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(status.failure).toBeUndefined();
    expect(status.result).toMatchObject({
      intent_id: intentId,
      status: 'running',
      mode: 'server',
      phase: 'transferring',
      execution_epoch: 1,
      claimed_status: null,
      reason_code: null,
    });
    expect(new Date(status.result.last_observed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.last_observed_at).getTime(),
    );
  });
  it('L09: /complete on an open run stores the claim and settles partial/reconciliation_not_performed (never complete); a duplicate is a no-op ack', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    await run({ action: 'ingest', coach: COACH, intent: intentId, body: { sources: ['x', 'y'] } });
    const done = await run({
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'success', final_counts: { clients: 2 } },
    });
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    expect(completionRows()).toEqual(expect.arrayContaining([[COACH, intentId, 'success']]));
    expect(runRow(COACH, intentId)).toMatchObject({
      phase: 'reconciling',
      terminal_status: 'partial',
      state: 'partial',
      reason_code: 'reconciliation_not_performed',
      execution_epoch: 1,
      fenced_at: null,
    });
    expect(done.events.map((e) => e[1])).toEqual(
      expect.arrayContaining(['scout.ingest.completed', 'scout.run.settled']),
    );
    const settledEvent = done.events.find((e) => e[1] === 'scout.run.settled');
    expect(settledEvent[2]).toMatchObject({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
    const rowAfter = runRow(COACH, intentId);
    // Duplicate /complete: the gate is closed (terminal) → 200 ack, nothing changes.
    const again = await run({
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'failed' },
    });
    expect(again.result).toEqual(ack(intentId));
    expect(runRow(COACH, intentId)).toEqual(rowAfter);
    expect(completionRows().filter((r: string[]) => r[1] === intentId)).toEqual([
      [COACH, intentId, 'success'],
    ]);
    // Late ingest / cancel / Start against the terminal run.
    expect(
      await run({ action: 'ingest', coach: COACH, intent: intentId, body: { sources: ['z'] } }),
    ).toMatchObject({
      failure: conflict('run_fenced'),
    });
    expect(await run({ action: 'cancel', coach: COACH, intent: intentId })).toMatchObject({
      failure: conflict('run_terminal'),
    });
    expect(await run({ action: 'start', coach: COACH, intent: intentId })).toMatchObject({
      failure: conflict('run_terminal'),
    });
    expect(runRow(COACH, intentId)).toEqual(rowAfter);
    const status = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(status.result).toMatchObject({
      status: 'partial',
      mode: 'server',
      phase: 'reconciling',
      claimed_status: 'success',
      reason_code: 'reconciliation_not_performed',
    });
    expect(status.result.families).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: 'clients', staged_unique: 2 })]),
    );
  });
  it('L09: /complete after a cancel is a no-op ack (fence beats late complete); /complete without a Start is 409 run_not_started', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    await run({ action: 'cancel', coach: COACH, intent: intentId });
    const rowAfterCancel = runRow(COACH, intentId);
    const late = await run({
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'success' },
    });
    expect(late.failure).toBeUndefined();
    expect(late.result).toEqual(ack(intentId));
    expect(runRow(COACH, intentId)).toEqual(rowAfterCancel);
    expect(completionRows().filter((r: string[]) => r[1] === intentId)).toEqual([]);
    expect(late.events.map((e) => e[1])).not.toContain('scout.ingest.completed');
    // Owned, paired intent with no Start: the server path applies and the gate finds no row.
    const fresh = intent(COACH);
    const early = await run({
      action: 'complete',
      coach: COACH,
      intent: fresh,
      body: { terminal_status: 'success' },
    });
    expect(early).toMatchObject({ failure: conflict('run_not_started') });
    expect(runRow(COACH, fresh)).toBeNull();
    expect(completionRows().filter((r: string[]) => r[1] === fresh)).toEqual([]);
    expect(
      await run({ action: 'ingest', coach: COACH, intent: fresh, body: { sources: ['q'] } }),
    ).toMatchObject({
      failure: conflict('run_not_started'),
    });
    expect(stagedCount(COACH, fresh)).toBe(0);
  });
  it('L10: lazy deadline — an expired open run is fenced timed_out by the next writer AFTER its own rollback (no self-wait); the read path fences too', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    expire(COACH, intentId);
    const late = await run({
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      body: { sources: ['t'] },
    });
    expect(late).toMatchObject({ failure: conflict('run_fenced', { fence_reason: 'timed_out' }) });
    expect(stagedCount(COACH, intentId)).toBe(0);
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'timed_out',
      state: 'timed_out',
      fence_reason: 'timed_out',
      reason_code: 'deadline_exceeded',
      execution_epoch: 2,
    });
    // Order in the writer's own query log: the gate UPDATE, then the rollback of that transaction,
    // and only then the fence's FOR NO KEY UPDATE in a new transaction.
    const gateAt = late.queries.findIndex((q) => q.includes('last_observed_at ='));
    const rollbackAt = late.queries.findIndex((q, i) => i > gateAt && q === '-- tx:rollback');
    const beginAt = late.queries.findIndex((q, i) => i > rollbackAt && q === '-- tx:begin');
    const lockAt = late.queries.findIndex((q) => q.includes('FOR NO KEY UPDATE'));
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(rollbackAt).toBeGreaterThan(gateAt);
    expect(beginAt).toBeGreaterThan(rollbackAt);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(late.queries.filter((q) => q.includes('FOR NO KEY UPDATE'))).toHaveLength(1);
    expect(late.events.map((e) => e[1])).toContain('scout.run.fenced');
    // Read path: a second expired run is fenced by GET status itself.
    const second = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: second });
    expire(COACH, second);
    const status = await run({ action: 'status', coach: COACH, intent: second });
    expect(status.failure).toBeUndefined();
    expect(status.result).toMatchObject({
      status: 'timed_out',
      mode: 'server',
      execution_epoch: 2,
      reason_code: 'deadline_exceeded',
    });
    expect(runRow(COACH, second)).toMatchObject({
      terminal_status: 'timed_out',
      execution_epoch: 2,
    });
    // Start and cancel against an expired-but-unfenced run fence it and answer run_terminal.
    const third = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: third });
    expire(COACH, third);
    expect(await run({ action: 'cancel', coach: COACH, intent: third })).toMatchObject({
      failure: conflict('run_terminal'),
    });
    expect(runRow(COACH, third)).toMatchObject({
      terminal_status: 'timed_out',
      execution_epoch: 2,
    });
  });
  it('CAS terminal-once: a stale settle epoch after a fence writes nothing', async () => {
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    stage(COACH, intentId, 'clients', 'cas');
    await run({ action: 'cancel', coach: COACH, intent: intentId });
    const fenced = runRow(COACH, intentId);
    expect(fenced.execution_epoch).toBe(2);
    const stale = await run({
      action: 'settled',
      coach: COACH,
      intent: intentId,
      body: { epoch: 1 },
    });
    expect(stale.failure).toBeUndefined();
    expect(runRow(COACH, intentId)).toEqual(fenced);
    const current = await run({
      action: 'settled',
      coach: COACH,
      intent: intentId,
      body: { epoch: 2 },
    });
    expect(current.failure).toBeUndefined();
    expect(runRow(COACH, intentId)).toEqual(fenced); // terminal already written once
    const revoked = await run({
      action: 'fence',
      coach: COACH,
      intent: intentId,
      body: { reason: 'revoked' },
    });
    expect(revoked.result).toBeNull();
    expect(runRow(COACH, intentId)).toEqual(fenced);
  });
  it('L11: projections — legacy rows read as mode legacy with the accepted fields; non-UUID intents never touch the lifecycle; unknown intents 404', async () => {
    legacyRun(COACH, LEGACY_INTENT);
    const legacy = await run({ action: 'status', coach: COACH, intent: LEGACY_INTENT });
    expect(legacy.failure).toBeUndefined();
    expect(legacy.result).toMatchObject({
      intent_id: LEGACY_INTENT,
      status: 'success',
      mode: 'legacy',
      phase: null,
      execution_epoch: 1,
      claimed_status: 'success',
      reason_code: null,
      families: [],
    });
    expect(legacy.queries.some((q) => q.includes('FOR NO KEY UPDATE'))).toBe(false);
    expect(legacy.queries.some((q) => q.includes('last_observed_at ='))).toBe(false);
    expect(legacy.queries.some((q) => q === '-- tx:begin')).toBe(false);
    // A legacy-string progress write stays on the legacy path: no gate, no server row.
    const progressed = await run({ action: 'progress', coach: COACH, intent: 'intent_plain_2026' });
    expect(progressed.failure).toBeUndefined();
    expect(progressed.queries.some((q) => q.includes('last_observed_at ='))).toBe(false);
    expect(serverRunCount()).toBe(Number(sql(`SELECT count(*) FROM "${RUN}" WHERE mode='server'`)));
    expect(
      await run({ action: 'status', coach: COACH, intent: 'intent_never_seen' }),
    ).toMatchObject({
      failure: expect.objectContaining({ status: 404 }),
    });
    expect(await run({ action: 'status', coach: OTHER, intent: LEGACY_INTENT })).toMatchObject({
      failure: expect.objectContaining({ status: 404 }),
    });
  });
  it('L05/L12: the OLD image legacy writers on the S7-L schema — byte-identical legacy rows; a server row is protected by the legacy marker', async () => {
    const oldIntent = 'intent_old_ext_2026';
    const newIntent = 'intent_new_ext_2026';
    const viaOld = await run(
      { action: 'complete', coach: COACH, intent: oldIntent, body: { terminal_status: 'partial' } },
      true,
    );
    const viaNew = await run({
      action: 'complete',
      coach: COACH,
      intent: newIntent,
      body: { terminal_status: 'partial' },
    });
    expect(viaOld.failure).toBeUndefined();
    expect(viaNew.failure).toBeUndefined();
    const strip = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'intent_id', 'started_at', 'completed_at'].includes(key),
        ),
      );
    expect(strip(runRow(COACH, oldIntent))).toEqual(strip(runRow(COACH, newIntent)));
    expect(runRow(COACH, oldIntent)).toMatchObject({
      mode: 'legacy',
      import_intent_id: null,
      phase: null,
      execution_epoch: 1,
      terminal_status: 'partial',
    });
    // Replay through the OLD image: idempotent ack, row unchanged.
    const rowBefore = runRow(COACH, oldIntent);
    const replay = await run(
      { action: 'complete', coach: COACH, intent: oldIntent, body: { terminal_status: 'success' } },
      true,
    );
    expect(replay.result).toEqual(ack(oldIntent));
    expect(runRow(COACH, oldIntent)).toEqual(rowBefore);
    // The OLD image reads the legacy row and a server row through its own client unchanged.
    const oldStatus = await run({ action: 'status', coach: COACH, intent: oldIntent }, true);
    expect(oldStatus.failure).toBeUndefined();
    expect(oldStatus.result).toMatchObject({ intent_id: oldIntent, status: 'partial' });
    // An old-extension /complete aimed at a SERVER run (UUID): the OLD writer's legacy upsert
    // would flip the row to `success`; the database mode-shape CHECK refuses and nothing moves.
    const intentId = intent(COACH);
    await run({ action: 'start', coach: COACH, intent: intentId });
    const serverBefore = runRow(COACH, intentId);
    const crossed = await run(
      { action: 'complete', coach: COACH, intent: intentId, body: { terminal_status: 'success' } },
      true,
    );
    expect(crossed.failure).toMatchObject({ status: 500 });
    expect(runRow(COACH, intentId)).toEqual(serverBefore);
    expect(completionRows().filter((r: string[]) => r[1] === intentId)).toEqual([]);
  });
});

describe('stage 5: down refuses lifecycle state; with legacy rows only it removes exactly S7-L', () => {
  it('L03: down refuses with one server row (fixed text); nothing deleted; schema, OIDs and history unchanged', () => {
    resetData();
    const intentId = intent(COACH);
    sqlAs('service_role', serverRunInsert(COACH, intentId));
    legacyRun(COACH, 'legacy-keep');
    const rows = runRows();
    const history = historyRows();
    refusedFile(downFile, REFUSE_DOWN);
    expect(runRows()).toEqual(rows);
    expect(shapeWithOids()).toEqual(afterOids);
    expect(historyRows()).toEqual(history);
    // Any single lifecycle fact on an otherwise legacy row also refuses down.
    sql(`DELETE FROM "${RUN}" WHERE mode='server'`);
    sql(`UPDATE "${RUN}" SET execution_epoch=2 WHERE intent_id='legacy-keep'`);
    refusedFile(downFile, REFUSE_DOWN);
    sql(`UPDATE "${RUN}" SET execution_epoch=1 WHERE intent_id='legacy-keep'`);
    expect(shapeWithOids()).toEqual(afterOids);
  });
  it('L04: down removes exactly S7-L and keeps every legacy row; the OLD writer continues; a second down refuses', async () => {
    legacyRun(COACH, 'legacy-keep-2', 'failed');
    const legacyView = runRowsLegacyView();
    const history = historyRows();
    sqlFile(downFile);
    expect(lifecycleColumns()).toEqual([]);
    expect(shape()).toEqual(before);
    expect(runRowsLegacyView()).toEqual(legacyView);
    expect(historyRows()).toEqual(history); // never rewritten
    const viaOld = await run(
      {
        action: 'complete',
        coach: COACH,
        intent: 'intent_after_down',
        body: { terminal_status: 'success' },
      },
      true,
    );
    expect(viaOld.failure).toBeUndefined();
    expect(runCount()).toBe(legacyView.length + 1);
    refusedFile(downFile, ABSENT);
    expect(shape()).toEqual(before);
  });
  it('re-applying the file restores the identical shape (OIDs aside); legacy rows keep defaults; a raw rerun is refused again', () => {
    const legacyView = runRowsLegacyView();
    sqlFile(upFile);
    expect(shape()).toEqual(after);
    expect(runRowsLegacyView()).toEqual(legacyView);
    expect(
      sql(`SELECT count(*) FROM "${RUN}" WHERE mode<>'legacy' OR import_intent_id IS NOT NULL OR execution_epoch<>1
        OR phase IS NOT NULL OR fenced_at IS NOT NULL OR reason_code IS NOT NULL`),
    ).toBe('0');
    refusedFile(upFile, ALREADY);
    expect(shape()).toEqual(after);
  });
});
