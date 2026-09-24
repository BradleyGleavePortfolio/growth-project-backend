// S7-3′ G2 B/drain proof on the isolated PostgreSQL 17 lane (S1-provisioned,
// synthetic data only). Ordered stages in ONE file, run with --runInBand, on a
// FRESH S5-shaped bootstrap (164 migrations, no E). Establishes only what is new
// in B: the bounded/resumable/unambiguous NULL→platform backfill, the obsolete-
// writer fence migration (deploy, refusal, down/up), their coexistence with the
// accepted O/T writers and readers, and the drain verdict semantics.
//   1. identity + O legacy rows on narrow and on E;  2. backfill on E without the
//   fence (completion is not drain);  3. B through `prisma migrate deploy`;
//   4. fence vs O/T/RLS;  5. bounded fixture: unresolvable classes, cursor,
//   untouched columns, idempotence, provenance recovery → drained;
//   6. concurrency (row locks, T barriers, staging writer);  7. down/up.
// Accepted E/T-Q0 proof (test/rls-g2-pg17-etq0.spec.ts) is neither rerun nor
// restated. A "drained" verdict here is a property of THIS disposable fixture and
// says nothing about production writers; R remains unimplemented and unclaimed.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  appliedMigrations,
  blocked,
  catalog,
  directory,
  E_MIGRATION,
  expectedVersion,
  gitShow,
  hasColumn,
  holdTransaction,
  json,
  legacy,
  OLD_HEAD,
  oldClient,
  oldRoot,
  prisma,
  prismaMigrateDeploy,
  quote,
  records,
  refused,
  resetData,
  root,
  run,
  settle,
  sql,
  sqlAdmin,
  sqlFile,
  stage,
  stageMany,
  target,
  targets,
  upFile,
  worker,
} from './utils/g2-b-drain-pg-harness';
import { G2_B_CLUSTER_MARKER, G2_B_DATABASE_MARKER } from './utils/g2-b-drain-db';
import {
  acceptedUpFile,
  appliedSince,
  B_MIGRATION,
  bDownFile,
  bUpFile,
  C1_MIGRATION,
  disagreeing,
  fence,
  ledgerCount,
  ledgerIds,
  ledgerWithoutPlatform,
  nullCount,
  nullify,
  platformOf,
  runtimeClient,
  S1_MIGRATION,
  stagingSnapshot,
} from './utils/g2-b-drain-harness';
import {
  backfillLedgerPlatform,
  FENCE_TRIGGER_DEFINITION,
  FENCE_TRIGGER_TYPE,
  type BackfillOptions,
  type BackfillReport,
} from '../src/scout/scout-ledger-backfill';

jest.setTimeout(240000);
const FENCED = 'G2-B obsolete writer fenced';
const nullInsert = (id: string, role?: string) =>
  `${role ? `SET ROLE ${role}; ` : ''}INSERT INTO public."ScoutReconstructionLedger"
  (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
  VALUES (${quote(id)},'coach','intent','clients',${quote(id)},NULL,'skipped')`;

// Teardown authority (S5-R3-A-01), unchanged from the accepted proof: no mutating cleanup
// against a fixture whose identity this proof never accepted.
let teardownAuthorized = false;
/** Recorded migrations on the fresh fixture; every later count is relative to it. */
let base = 0;
const clients: Array<{ client: { $disconnect(): Promise<void> } }> = [];
async function backfill(name: string, options: BackfillOptions = {}) {
  const runtime = runtimeClient(name);
  clients.push(runtime);
  try {
    const report = await backfillLedgerPlatform(runtime.client, options);
    // Counts and shapes only; the report carries no identifiers by construction.
    console.warn('PG17_BACKFILL', JSON.stringify({ name, options, report }));
    return { report, queries: runtime.queries };
  } finally {
    await runtime.client.$disconnect();
  }
}
const selects = (queries: string[]) => queries.filter((q) => /FOR UPDATE SKIP LOCKED/.test(q));
const updates = (queries: string[]) =>
  queries.filter((q) => /^\s*UPDATE public\."ScoutReconstructionLedger"/.test(q));

beforeAll(() => {
  const identity =
    json(`SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),
    'port',inet_server_port(),'directory',${quote(sqlAdmin(`SELECT current_setting('data_directory')`))},
    'version',current_setting('server_version_num'),'user',current_user,'super',
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassrls',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),'owner',
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`);
  expect(identity).toMatchObject({
    database: 'g2_b_drain_disposable',
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
  expect(directory).toMatch(/\/pg17\/clusters\/b-drain\/pg-data$/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_B_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_B_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh S5-shaped bootstrap: the O root's full history (164 recorded), none of the
  // accepted S1/C1/E predecessors this root tracks, no B, no fence.
  base = Number(appliedMigrations());
  expect(base).toBe(164);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations"
    WHERE migration_name IN (${quote(S1_MIGRATION)},${quote(C1_MIGRATION)},${quote(E_MIGRATION)},${quote(B_MIGRATION)})`),
  ).toBe('0');
  expect(hasColumn()).toBe('0');
  expect(fence()).toEqual({ triggers: [], function: null });
  // Accepted E is the shipped file; B is this packet's file; the O source is byte-identical to
  // the preserved head. The T client in this root carries the nullable provenance column.
  expect(readFileSync(upFile, 'utf8')).toBe(
    gitShow(`HEAD:prisma/migrations/${E_MIGRATION}/migration.sql`),
  );
  expect(readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8')).not.toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform/,
  );
  expect(readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8')).toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/,
  );
  expect(readFileSync(resolve(oldRoot!, 'src/scout/scout-reconstruct.service.ts'), 'utf8')).toBe(
    gitShow(`${OLD_HEAD}:src/scout/scout-reconstruct.service.ts`),
  );
  expect(
    sql(`SELECT string_agg(rolsuper::text||':'||rolbypassrls::text,',' ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`),
  ).toBe('false:false,false:false,false:true');
  // Read-only gates passed; authorize teardown, then the accepted setup mutations.
  teardownAuthorized = true;
  sql(`GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
    GRANT ALL ON public."ScoutIngestEntity",public."ScoutReconstructionLedger",
      public."Person",public."ScoutReconstructedEntity",public."ScoutImport" TO service_role,anon,authenticated;`);
  resetData();
});
afterAll(async () => {
  for (const c of clients) await c.client.$disconnect();
  if (!teardownAuthorized) {
    console.warn(
      'PG17_TEARDOWN_SKIPPED',
      JSON.stringify({ reason: 'setup refused before first mutation; no DDL/DML issued' }),
    );
    return;
  }
  resetData();
  sql('DELETE FROM "ScoutImport"');
});

describe('stage 1: legacy rows from the actual O binary, on narrow and on E', () => {
  it('O on the narrow base, then E, then O on E: 430 rows without provenance', async () => {
    stageMany(400, 'clients');
    expect((await run({}, true)).result).toMatchObject({ reconstructed: 400 });
    expect(ledgerCount()).toBe(400);
    // Accepted S1 and C1 are fixture history only: this root tracks them, the O root does not,
    // so they are applied from their shipped files and recorded (the path E takes next) purely
    // so that `migrate deploy` in stage 3 has exactly B pending. Nothing about them is proven.
    for (const name of [S1_MIGRATION, C1_MIGRATION]) {
      sqlFile(acceptedUpFile(name));
      expect(prisma(root, ['migrate', 'resolve', '--applied', name]).ok).toBe(true);
    }
    expect(appliedMigrations()).toBe(String(base + 2));
    expect(hasColumn()).toBe('0');
    // E exactly as the accepted proof applies it, then recorded so `migrate deploy` later
    // applies precisely B (E's own deploy path is accepted elsewhere and not re-proven).
    sqlFile(upFile);
    expect(prisma(root, ['migrate', 'resolve', '--applied', E_MIGRATION]).ok).toBe(true);
    expect(appliedMigrations()).toBe(String(base + 3));
    expect(hasColumn()).toBe('1');
    stageMany(30, 'workouts', 'truecoach', 'coach', 'intent', 0, 'w');
    expect((await run({ family: 'workouts' }, true)).result).toMatchObject({ reconstructed: 30 });
    expect(nullCount()).toBe(430);
    // T on a second intent writes provenance; those rows are never backfill candidates.
    settle('coach', 'i2');
    stageMany(10, 'clients', 'truecoach', 'coach', 'i2');
    expect((await run({ intent: 'i2' })).result).toMatchObject({ reconstructed: 10 });
    expect(ledgerCount()).toBe(440);
    expect(nullCount()).toBe(430);
  });
});

describe('stage 2: backfill on E without the fence — completion is not drain', () => {
  it('assigns exactly the staged platform to every NULL row and touches nothing else', async () => {
    const ledgerBefore = ledgerWithoutPlatform();
    const stagingBefore = stagingSnapshot();
    const { report, queries } = await backfill('g2b_stage2', { batch: 200 });
    expect(report).toMatchObject({
      batch: 200,
      ledgerTotal: 440,
      nullBefore: 430,
      nullAfter: 0,
      mismatch: 0,
      fenced: false,
      unresolved: { orphan: 0, invalid: 0, ambiguous: 0 },
      outcome: 'complete_unfenced',
    });
    // 200 + 200 + 30 (short chunk ends the pass), then one confirming pass with nothing left.
    expect(report.passes.map((p) => [p.chunks, p.examined, p.updated])).toEqual([
      [3, 430, 430],
      [1, 0, 0],
    ]);
    expect(selects(queries)).toHaveLength(4);
    expect(updates(queries)).toHaveLength(3);
    expect(disagreeing()).toBe(0);
    expect(ledgerWithoutPlatform()).toEqual(ledgerBefore);
    expect(stagingSnapshot()).toEqual(stagingBefore);
    expect(
      sql(`SELECT string_agg(DISTINCT source_platform,',') FROM "ScoutReconstructionLedger"`),
    ).toBe('truecoach');
  });
  it('an O restart re-creates NULL rows after completion, so unfenced completion is not drain', async () => {
    stage('w-late', 'workouts');
    expect((await run({ family: 'workouts' }, true)).result).toMatchObject({ reconstructed: 31 });
    expect(nullCount()).toBe(1);
    const { report } = await backfill('g2b_stage2_again', { batch: 200 });
    expect(report).toMatchObject({ nullBefore: 1, nullAfter: 0, outcome: 'complete_unfenced' });
    expect(report.passes[0]).toMatchObject({ chunks: 1, examined: 1, updated: 1 });
  });
});

describe('stage 3: B through the release mechanism', () => {
  let beforeCatalog: string;
  it('prisma migrate deploy applies exactly B; identity, RLS and indexes are untouched', () => {
    beforeCatalog = catalog();
    const start = sql('SELECT now()');
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(B_MIGRATION);
    expect(output).not.toContain(E_MIGRATION);
    // Exactly one migration recorded by this deploy, and it is B.
    expect(appliedSince(start)).toEqual([B_MIGRATION]);
    expect(appliedMigrations()).toBe(String(base + 4));
    expect(catalog()).toBe(beforeCatalog);
    expect(hasColumn()).toBe('1');
    expect(nullCount()).toBe(0);
    const installed = fence();
    // Rendered under search_path = '' (canonical text) and structurally BEFORE INSERT ROW.
    expect(installed.triggers).toEqual([
      [
        'ScoutReconstructionLedger_platform_fence',
        'O',
        FENCE_TRIGGER_TYPE,
        FENCE_TRIGGER_DEFINITION,
      ],
    ]);
    expect(installed.function).toMatchObject({
      proname: 'scout_ledger_platform_fence',
      prosecdef: false,
      proconfig: [expect.stringMatching(/^search_path=("")?$/)],
    });
    // The fixture (like Supabase) grants EXECUTE on new functions to the API roles through
    // ALTER DEFAULT PRIVILEGES, which a REVOKE FROM PUBLIC does not touch. The boundary B
    // ships is therefore: PUBLIC holds no EXECUTE (ACL is explicit, not the NULL default), and a
    // trigger function is not directly callable by any role at all.
    expect(installed.function.proacl).not.toBeNull();
    expect(
      sql(`SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid=to_regprocedure('public.scout_ledger_platform_fence()')
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`),
    ).toBe('0');
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role']) {
      refused(
        `${role === 'postgres' ? '' : `SET ROLE ${role}; `}SELECT public.scout_ledger_platform_fence()`,
        'trigger functions can only be called as triggers',
      );
    }
    console.warn('PG17_FENCE', JSON.stringify(installed));
  });
  it('a raw rerun of B is refused atomically and changes nothing', () => {
    const before = fence();
    expect(() => sqlFile(bUpFile)).toThrow(/G2-B fence already present/);
    expect(fence()).toEqual(before);
    expect(catalog()).toBe(beforeCatalog);
    expect(appliedMigrations()).toBe(String(base + 4));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
  });
});

describe('stage 4: the fence against O, T, direct writers and the API roles', () => {
  it('refuses a NULL-provenance INSERT from the owner and from the runtime role', () => {
    refused(nullInsert('direct-null'), FENCED);
    refused(nullInsert('direct-null', 'service_role'), FENCED);
    expect(ledgerIds(`id='direct-null'`)).toEqual([]);
    // Provenance present: admitted (then removed) — the fence is not a write block.
    sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
      VALUES ('direct-ok','coach','intent','clients','direct-ok','truecoach','skipped')`);
    expect(platformOf('direct-ok')).toBe('truecoach');
    sql(`DELETE FROM "ScoutReconstructionLedger" WHERE id='direct-ok'`);
  });
  it('the actual O binary fails closed on a new staged row: 500, no ledger row, no target', async () => {
    const before = { ledger: ledgerCount(), targets: targets() };
    stage('w-fenced', 'workouts');
    const old = await run({ family: 'workouts' }, true);
    expect(old.result).toBeUndefined();
    expect(old.failure).toMatchObject({ status: 500, message: 'Internal server error' });
    expect(ledgerCount()).toBe(before.ledger);
    expect(targets()).toEqual(before.targets);
    expect(nullCount()).toBe(0);
    // O readers are unaffected by an INSERT trigger.
    expect((await run({ action: 'roster', limit: 5 }, true)).result.persons).toHaveLength(5);
    expect(
      (await run({ action: 'entities', family: 'workouts', limit: 5 }, true)).result.entities,
    ).toHaveLength(5);
  });
  it('API roles are still denied by policy (with provenance, so the policy, not the fence, answers)', () => {
    for (const role of ['anon', 'authenticated']) {
      refused(
        `SET ROLE ${role}; INSERT INTO public."ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
        VALUES ('bad','coach','intent','clients','bad','truecoach','skipped')`,
        'row-level security',
      );
      // BEFORE ROW triggers run before WITH CHECK policies, so a NULL row from an API role is
      // expected to meet the fence first; whichever answers, it is refused and never exists.
      let error: unknown;
      try {
        sql(nullInsert('bad', role));
      } catch (e) {
        error = e;
      }
      expect(String(error)).toMatch(/G2-B obsolete writer fenced|row-level security/);
    }
    expect(ledgerIds(`id='bad'`)).toEqual([]);
  });
  it('T creates with provenance and claims a re-opened NULL row through the fence; replay identical', async () => {
    // The fence rejected O's row for w-fenced; T reconstructs it (create path, provenance set)
    // and claims one legacy row whose provenance is re-opened (update path, not fenced).
    const reopened = ledgerIds(
      `intent_id='intent' AND entity_type='workouts' AND source_id='w00001'`,
    );
    expect(nullify(`id=${quote(reopened[0])}`)).toBe(1);
    const first = await run({ family: 'workouts' });
    expect(first.result).toMatchObject({ reconstructed: 32 });
    expect(platformOf(reopened[0])).toBe('truecoach');
    expect(nullCount()).toBe(0);
    const rows = records('coach', 'intent', 'workouts');
    const replay = await run({ family: 'workouts' });
    expect(replay.result).toEqual(first.result);
    expect(records('coach', 'intent', 'workouts')).toEqual(rows);
  });
});

describe('stage 5: bounded fixture — unresolvable classes, cursor, idempotence, recovery', () => {
  let report: BackfillReport;
  let queries: string[];
  let ledgerBefore: unknown;
  let stagingBefore: unknown;
  it('builds 1238 NULL rows: 1230 resolvable, 5 orphans, 3 invalid; 2 mismatching and 10 claimed stay', async () => {
    resetData();
    stageMany(1244, 'clients');
    expect((await run()).result).toMatchObject({ reconstructed: 1244 });
    expect(nullCount()).toBe(0);
    // Two populated rows disagree with staging (never overwritten); ten keep their claim.
    expect(
      Number(
        sql(`WITH c AS (UPDATE "ScoutReconstructionLedger" SET source_platform='other-platform'
        WHERE source_id IN ('s01243','s01244') RETURNING id) SELECT count(*) FROM c`),
      ),
    ).toBe(2);
    expect(nullify(`source_id NOT BETWEEN 's01233' AND 's01244'`)).toBe(1232);
    // Erased staging: two NULL rows whose exact staging match no longer exists.
    sql(`DELETE FROM "ScoutIngestEntity" WHERE source_id IN ('s01231','s01232')`);
    // Cross-tenant: staged under coach 'c2' would not match; here nothing is staged for c2.
    settle('c2');
    for (const s of ['x1', 'x2']) {
      legacy('skipped', 'truecoach', s, 'clients', 'c2');
      nullify(`coach_id='c2' AND source_id=${quote(s)}`);
    }
    // Wrong family: a workouts ledger row with no staging at all.
    legacy('skipped', 'truecoach', 'w1', 'workouts');
    nullify(`source_id='w1'`);
    // Invalid: staging carries a non-canonical token; the backfill must not copy it.
    for (const s of ['b1', 'b2', 'b3']) {
      stage(s, 'clients', 'Bad Platform');
      legacy('skipped', 'Bad Platform', s);
      nullify(`source_id=${quote(s)}`);
    }
    expect(ledgerCount()).toBe(1250);
    expect(nullCount()).toBe(1238);
    ledgerBefore = ledgerWithoutPlatform();
    stagingBefore = stagingSnapshot();
  });
  it('resolves exactly the 1230 in three chunks, reports the 8 remaining by class, stops honestly', async () => {
    ({ report, queries } = await backfill('g2b_stage5'));
    expect(report).toMatchObject({
      batch: 500,
      ledgerTotal: 1250,
      nullBefore: 1238,
      nullAfter: 8,
      mismatch: 2,
      fenced: true,
      unresolved: { orphan: 5, invalid: 3, ambiguous: 0 },
      outcome: 'unresolved',
    });
    expect(
      report.passes.map((p) => [p.chunks, p.examined, p.updated, p.orphan, p.invalid]),
    ).toEqual([
      [3, 1238, 1230, 5, 3],
      [1, 8, 0, 5, 3],
    ]);
    expect(report.passes.every((p) => p.lockFailures === 0 && !p.stalledByLocks)).toBe(true);
    expect(selects(queries)).toHaveLength(4);
    expect(updates(queries)).toHaveLength(3);
    // The written values are the staged values; nothing non-NULL changed; staging untouched.
    // Disagreeing = 2 mismatching + 3 invalid (NULL vs non-canonical staging); orphans have no join.
    expect(disagreeing()).toBe(5);
    expect(
      sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='Bad Platform'`),
    ).toBe('0');
    expect(
      sql(
        `SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='other-platform'`,
      ),
    ).toBe('2');
    expect(ledgerWithoutPlatform()).toEqual(ledgerBefore);
    expect(stagingSnapshot()).toEqual(stagingBefore);
    expect(ledgerIds(`source_platform IS NULL`).sort()).toEqual(
      ledgerIds(`source_id IN ('s01231','s01232','x1','x2','w1','b1','b2','b3')`).sort(),
    );
  });
  it('rerun is idempotent: one short chunk, nothing written, same verdict', async () => {
    const again = await backfill('g2b_stage5_again');
    expect(again.report.passes).toEqual([
      expect.objectContaining({ chunks: 1, examined: 8, updated: 0 }),
    ]);
    expect(again.report).toMatchObject({ nullAfter: 8, outcome: 'unresolved' });
    expect(updates(again.queries)).toHaveLength(0);
    expect(ledgerWithoutPlatform()).toEqual(ledgerBefore);
  });
  it('forward provenance recovery (staging repaired, not ledger edited) drains under the fence', async () => {
    // Re-stage the erased/missing sources and correct the invalid token at the source of truth.
    stageMany(2, 'clients', 'truecoach', 'coach', 'intent', 0, 'r');
    sql(`UPDATE "ScoutIngestEntity" SET source_id=CASE id WHEN 'coach-intent-r00001' THEN 's01231' ELSE 's01232' END
      WHERE id IN ('coach-intent-r00001','coach-intent-r00002')`);
    stage('x1', 'clients', 'truecoach', 'Synthetic X1', 'c2', 'intent');
    stage('x2', 'clients', 'truecoach', 'Synthetic X2', 'c2', 'intent');
    stage('w1', 'workouts');
    sql(
      `UPDATE "ScoutIngestEntity" SET source_platform='truecoach' WHERE source_platform='Bad Platform'`,
    );
    const drained = await backfill('g2b_stage5_drain');
    expect(drained.report).toMatchObject({
      nullBefore: 8,
      nullAfter: 0,
      mismatch: 2,
      fenced: true,
      outcome: 'drained',
    });
    expect(drained.report.passes[0]).toMatchObject({ chunks: 1, examined: 8, updated: 8 });
    expect(disagreeing()).toBe(2);
    expect(ledgerWithoutPlatform()).toEqual(ledgerBefore);
  });
});

describe('stage 6: concurrency — locked rows, T barriers, a staging writer', () => {
  it('skips a row locked by another transaction, stalls honestly, drains after release', async () => {
    expect(nullify(`source_id IN ('s00001','s00002','s00003')`)).toBe(3);
    const [held] = ledgerIds(`source_id='s00002'`);
    const holder = holdTransaction(
      `SELECT id FROM public."ScoutReconstructionLedger" WHERE id=${quote(held)} FOR UPDATE`,
    );
    await holder.held;
    try {
      const stalled = await backfill('g2b_stage6_locked', { lockRetries: 0 });
      expect(stalled.report.passes.map((p) => [p.examined, p.updated, p.lockFailures])).toEqual([
        [2, 2, 0],
        [0, 0, 0],
      ]);
      expect(stalled.report).toMatchObject({ nullAfter: 1, outcome: 'stalled' });
      expect(platformOf(held)).toBe('<NULL>');
    } finally {
      holder.release();
    }
    const drained = await backfill('g2b_stage6_released');
    expect(drained.report.passes[0]).toMatchObject({ examined: 1, updated: 1 });
    expect(drained.report.outcome).toBe('drained');
  });
  it('T paused after reading staging: the backfill completes; T then claims identically', async () => {
    settle('coach', 'i3');
    stageMany(20, 'clients', 'truecoach', 'coach', 'i3');
    expect(nullify(`source_id IN ('s00004','s00005')`)).toBe(2);
    const paused = worker({ intent: 'i3', pause: 'staged' });
    await paused.ready;
    const during = await backfill('g2b_stage6_t_staged');
    expect(during.report).toMatchObject({ nullAfter: 0, outcome: 'drained' });
    paused.release();
    expect((await paused.done).result).toMatchObject({ staged: 20, reconstructed: 20 });
    expect(records('coach', 'i3').every((r: any) => r.source_platform === 'truecoach')).toBe(true);
  });
  it('T paused inside its claim: the backfill skips that row without waiting', async () => {
    // Every i3 row is re-opened so that whichever row T claims first is the locked one.
    expect(nullify(`intent_id='i3'`)).toBe(20);
    expect(nullify(`intent_id='intent' AND source_id='s00006'`)).toBe(1);
    const paused = worker({ intent: 'i3', pause: 'claimed', txTimeout: 60000 });
    await paused.ready;
    const during = await backfill('g2b_stage6_t_claimed', { lockRetries: 0 });
    // The uncommitted claim is invisible and locked: skipped without a lock wait, reported as an
    // unexplained remainder. Completing before release is the non-blocking evidence.
    expect(during.report).toMatchObject({ nullBefore: 21, nullAfter: 1, outcome: 'stalled' });
    expect(during.report.passes[0]).toMatchObject({ examined: 20, updated: 20, lockFailures: 0 });
    paused.release();
    expect((await paused.done).result).toMatchObject({ reconstructed: 20 });
    expect(nullCount()).toBe(0);
    expect(records('coach', 'i3').every((r: any) => r.source_platform === 'truecoach')).toBe(true);
    const after = await backfill('g2b_stage6_t_claimed_after');
    expect(after.report).toMatchObject({ nullBefore: 0, nullAfter: 0, outcome: 'drained' });
    expect(after.report.passes).toEqual([expect.objectContaining({ examined: 0, updated: 0 })]);
  });
  it('a concurrent staging writer makes the chunk wait, hit lock_timeout, and write nothing', async () => {
    expect(nullify(`intent_id='intent' AND source_id='s00007'`)).toBe(1);
    const holder = holdTransaction(
      `UPDATE public."ScoutIngestEntity" SET payload=payload WHERE id='coach-intent-s00007'`,
    );
    await holder.held;
    try {
      const name = 'g2b_stage6_staging_writer';
      const pending = backfill(name, { lockRetries: 0 });
      await blocked(name);
      const { report, queries } = await pending;
      expect(report.passes).toEqual([
        expect.objectContaining({
          chunks: 0,
          examined: 0,
          updated: 0,
          lockFailures: 1,
          stalledByLocks: true,
        }),
      ]);
      expect(report).toMatchObject({ nullBefore: 1, nullAfter: 1, outcome: 'stalled' });
      expect(selects(queries)).toHaveLength(0);
      expect(updates(queries)).toHaveLength(0);
    } finally {
      holder.release();
    }
    const drained = await backfill('g2b_stage6_staging_released');
    expect(drained.report).toMatchObject({ nullAfter: 0, outcome: 'drained' });
  });
});

describe('stage 7: down removes only the fence; up restores it', () => {
  let installed: unknown;
  let installedCatalog: string;
  it('down keeps column, rows and history; NULL inserts are admitted again', () => {
    installed = fence();
    installedCatalog = catalog();
    const ledger = ledgerWithoutPlatform();
    const nulls = nullCount();
    sqlFile(bDownFile);
    expect(fence()).toEqual({ triggers: [], function: null });
    expect(hasColumn()).toBe('1');
    expect(ledgerWithoutPlatform()).toEqual(ledger);
    expect(nullCount()).toBe(nulls);
    expect(catalog()).toBe(installedCatalog);
    // History is not rewritten by down (S1-owned recovery semantics, recorded not judged):
    // B stays applied and deploy has nothing pending, so the fence is absent while recorded.
    expect(appliedMigrations()).toBe(String(base + 4));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    sql(nullInsert('after-down'));
    expect(platformOf('after-down')).toBe('<NULL>');
    sql(`DELETE FROM "ScoutReconstructionLedger" WHERE id='after-down'`);
    expect(() => sqlFile(bDownFile)).toThrow(/G2-B fence absent/);
  });
  it('re-applying the file restores the identical fence', () => {
    sqlFile(bUpFile);
    expect(fence()).toEqual(installed);
    expect(catalog()).toBe(installedCatalog);
    refused(nullInsert('after-up'), FENCED);
    expect(appliedMigrations()).toBe(String(base + 4));
  });
});
