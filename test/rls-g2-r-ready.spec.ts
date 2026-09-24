// S7-3′ G2 R/ready proof on the isolated PostgreSQL 17 lane (S1-provisioned,
// synthetic data only). Ordered stages in ONE file, run with --runInBand, on a
// FRESH S5-shaped bootstrap (164 migrations). Fixture history (S1, C1, E, B) is
// applied from the shipped files and recorded exactly as the accepted B proof
// does, so `prisma migrate deploy` has exactly R pending. Establishes only what is
// new in R: required canonical provenance (NOT NULL + CHECK on both tables) and
// the wide identity keys — their entry gate, deploy exactness, coexistence with
// the accepted T writer and the narrow keys that still arbitrate, the O negative
// control, and down/up.
//   1. identity + history on E, fence-absent refusal (R04), B;  2. refusals on E+B
//   (R02 NULL, R03 noncanonical, R11 decoy, R10 lock budget);  3. R through
//   `prisma migrate deploy` (R01), raw/shadow rerun (R05, R11);  4. T on R (R06),
//   narrow arbitration (R07), runtime content refusal + RLS (R08), O fails closed
//   (R09);  5. down/up (R12).
// Accepted E/T-Q0 and B proofs are neither rerun nor restated. Nothing here claims
// deployment, drain of any real database, or customer acceptance; N/Q1/C remain
// unimplemented and unclaimed.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  allLedger,
  appliedMigrations,
  catalog,
  directory,
  E_MIGRATION,
  expectedVersion,
  gitShow,
  hasColumn,
  holdTransaction,
  json,
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
} from './utils/g2-r-ready-pg-harness';
import { G2_R_CLUSTER_MARKER, G2_R_DATABASE_MARKER } from './utils/g2-r-ready-db';
import {
  acceptedUpFile,
  appliedSince,
  B_MIGRATION,
  bUpFile,
  C1_MIGRATION,
  CANONICAL_CHECK,
  fence,
  ledgerCount,
  ledgerIds,
  narrow,
  nullCount,
  nullify,
  platformOf,
  R_MIGRATION,
  rDownFile,
  rUp,
  rUpFile,
  S1_MIGRATION,
  stagingSnapshot,
  wide,
  WIDE_COLUMNS,
} from './utils/g2-r-ready-harness';

jest.setTimeout(240000);
const FENCED = 'G2-B obsolete writer fenced';
const ABSENT = { indexes: [], checks: [], ledgerNotNull: false };
const WIDE_INDEX = (table: string) =>
  `CREATE UNIQUE INDEX "${table}_identity_key" ON public."${table}" USING btree (${WIDE_COLUMNS})`;
/** pg_get_constraintdef parenthesization is not part of the contract; the tokens are. */
const stripParens = (s: string) => s.replace(/[()]/g, '');
/** Catalog observations with OIDs removed: what down→up must restore identically. */
const shape = (w: any) => ({
  indexes: w.indexes.map(([name, , unique, valid, def]: any[]) => [name, unique, valid, def]),
  checks: w.checks.map(([name, , rel, valid, def]: any[]) => [name, rel, valid, stripParens(def)]),
  ledgerNotNull: w.ledgerNotNull,
});
const parsedCatalog = () => JSON.parse(catalog());
const fenceOid = () =>
  sql(`SELECT oid FROM pg_trigger WHERE tgrelid='public."ScoutReconstructionLedger"'::regclass
  AND tgname='ScoutReconstructionLedger_platform_fence'`);
const ledgerInsert = (id: string, platform: string | null, role?: string, family = 'clients') =>
  `${role ? `SET ROLE ${role}; ` : ''}INSERT INTO public."ScoutReconstructionLedger"
  (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
  VALUES (${quote(id)},'coach','intent',${quote(family)},${quote(id)},${platform === null ? 'NULL' : quote(platform)},'skipped')`;
const stagingInsert = (id: string, platform: string, role?: string, source = id) =>
  `${role ? `SET ROLE ${role}; ` : ''}INSERT INTO public."ScoutIngestEntity"
  (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
  VALUES (${quote(id)},'coach','intent','clients',${quote(source)},${quote(platform)},'{}'::jsonb)`;
/** Refusal with the SQLSTATE visible: psql prints `ERROR:  <sqlstate>:` under verbose verbosity. */
const refusedCode = (statement: string, sqlstate: string) =>
  refused(`\\set VERBOSITY verbose\n${statement}`, `ERROR:  ${sqlstate}:`);
/** R's entry gate refused: nothing of R exists, history and rows are untouched. */
function expectRefusedUp(
  message: RegExp,
  before: { ledger: unknown; staging: unknown; applied: string },
) {
  expect(() => sqlFile(rUpFile)).toThrow(message);
  expect(wide()).toEqual(ABSENT);
  expect(allLedger()).toEqual(before.ledger);
  expect(stagingSnapshot()).toEqual(before.staging);
  expect(appliedMigrations()).toBe(before.applied);
}
const snapshot = () => ({
  ledger: allLedger(),
  staging: stagingSnapshot(),
  applied: appliedMigrations(),
});
/** Session-default search_path for the migration role: the redirection attempt (ID 15). */
const withShadowSearchPath = (fn: () => void) => {
  sql(`CREATE SCHEMA shadow;
    CREATE TABLE shadow."ScoutIngestEntity" (LIKE public."ScoutIngestEntity" INCLUDING DEFAULTS);
    CREATE TABLE shadow."ScoutReconstructionLedger" (LIKE public."ScoutReconstructionLedger" INCLUDING DEFAULTS);
    ALTER ROLE postgres SET search_path = shadow, public`);
  try {
    expect(sql(`SHOW search_path`)).toBe('shadow, public');
    fn();
    // The shadow relations never acquired anything: no indexes, no constraints, no NOT NULL.
    expect(
      sql(
        `SELECT count(*) FROM pg_index WHERE indrelid IN ('shadow."ScoutIngestEntity"'::regclass,'shadow."ScoutReconstructionLedger"'::regclass)`,
      ),
    ).toBe('0');
    expect(
      sql(
        `SELECT count(*) FROM pg_constraint WHERE conrelid IN ('shadow."ScoutIngestEntity"'::regclass,'shadow."ScoutReconstructionLedger"'::regclass)`,
      ),
    ).toBe('0');
  } finally {
    sql(`ALTER ROLE postgres RESET search_path; DROP SCHEMA shadow CASCADE`);
  }
};

// Teardown authority (S5-R3-A-01), unchanged from the accepted proofs: no mutating cleanup
// against a fixture whose identity this proof never accepted.
let teardownAuthorized = false;
/** Recorded migrations on the fresh fixture; every later count is relative to it. */
let base = 0;

beforeAll(() => {
  const identity =
    json(`SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),
    'port',inet_server_port(),'directory',${quote(sqlAdmin(`SELECT current_setting('data_directory')`))},
    'version',current_setting('server_version_num'),'user',current_user,'super',
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassrls',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),'owner',
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`);
  expect(identity).toMatchObject({
    database: 'g2_r_ready_disposable',
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
  expect(directory).toMatch(/\/pg17\/clusters\/r-ready\/pg-data$/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_R_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_R_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh S5-shaped bootstrap: the O root's full history (164 recorded), none of the
  // accepted S1/C1/E/B predecessors this root tracks, no R.
  base = Number(appliedMigrations());
  expect(base).toBe(164);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN
    (${[S1_MIGRATION, C1_MIGRATION, E_MIGRATION, B_MIGRATION, R_MIGRATION].map(quote).join(',')})`),
  ).toBe('0');
  expect(hasColumn()).toBe('0');
  expect(fence()).toEqual({ triggers: [], function: null });
  expect(wide()).toEqual({ indexes: [], checks: [], ledgerNotNull: null });
  // Accepted E and B are the shipped files at this head; R is this packet's file and carries
  // the exact CHECK predicate the runtime authority (isCanonicalPlatform) mirrors. The client in
  // this root is R's (both wide keys declared), not a stale C1/B client.
  for (const [file, name] of [
    [upFile, E_MIGRATION],
    [bUpFile, B_MIGRATION],
  ]) {
    expect(readFileSync(file, 'utf8')).toBe(
      gitShow(`HEAD:prisma/migrations/${name}/migration.sql`),
    );
  }
  expect(rUp.match(/'\^\[a-z0-9\]\[a-z0-9\._:-\]\{0,255\}\$'/g)).toHaveLength(4);
  const client = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  expect(client).toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/);
  expect(client).toMatch(/map: "ScoutIngestEntity_identity_key"/);
  expect(client).toMatch(/map: "ScoutReconstructionLedger_identity_key"/);
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
afterAll(() => {
  if (!teardownAuthorized) {
    console.warn(
      'PG17_TEARDOWN_SKIPPED',
      JSON.stringify({ reason: 'setup refused before first mutation; no DDL/DML issued' }),
    );
    return;
  }
  sql(`ALTER ROLE postgres RESET search_path; DROP SCHEMA IF EXISTS shadow CASCADE;
    DROP TABLE IF EXISTS public.g2r_decoy`);
  resetData();
  sql('DELETE FROM "ScoutImport"');
});

describe('stage 1: fixture history on E, R refused without the fence, then B', () => {
  it('S1, C1, E by file and recorded; T writes provenance on E', async () => {
    // Accepted S1/C1/E are fixture history only (this root tracks them, the O root does not):
    // applied from their shipped files and recorded exactly as the accepted B proof does.
    for (const name of [S1_MIGRATION, C1_MIGRATION]) {
      sqlFile(acceptedUpFile(name));
      expect(prisma(root, ['migrate', 'resolve', '--applied', name]).ok).toBe(true);
    }
    sqlFile(upFile);
    expect(prisma(root, ['migrate', 'resolve', '--applied', E_MIGRATION]).ok).toBe(true);
    expect(appliedMigrations()).toBe(String(base + 3));
    expect(hasColumn()).toBe('1');
    stageMany(20, 'clients');
    expect((await run()).result).toMatchObject({ reconstructed: 20 });
    expect(ledgerCount()).toBe(20);
    expect(nullCount()).toBe(0);
    expect(sql(`SELECT count(DISTINCT source_platform) FROM "ScoutReconstructionLedger"`)).toBe(
      '1',
    );
  });
  it('R04: on E without B the entry gate refuses (fence absent); nothing changes', () => {
    const before = snapshot();
    expect(fence()).toEqual({ triggers: [], function: null });
    expectRefusedUp(/G2-R fence absent/, before);
    expect(hasColumn()).toBe('1');
  });
  it('B by file and recorded: the fence is present, deploy has nothing pending before R', () => {
    // B is accepted history for this proof (0d69c7ba); applied by file and recorded so that
    // `migrate deploy` in stage 3 has exactly R pending. Nothing about B is proven here.
    const rOnDisk = sql(
      `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(R_MIGRATION)}`,
    );
    expect(rOnDisk).toBe('0');
    sqlFile(bUpFile);
    expect(prisma(root, ['migrate', 'resolve', '--applied', B_MIGRATION]).ok).toBe(true);
    expect(appliedMigrations()).toBe(String(base + 4));
    expect(fence().triggers).toHaveLength(1);
    refused(ledgerInsert('direct-null', null), FENCED);
  });
});

describe('stage 2: the entry gate on E+B — refusals leave everything untouched', () => {
  it('R02: one NULL provenance row (re-opened by UPDATE) refuses R; T then reclaims it on E+B', async () => {
    const reopened = ledgerIds(`source_id='s00001'`);
    expect(reopened).toHaveLength(1);
    expect(nullify(`id=${quote(reopened[0])}`)).toBe(1);
    expect(nullCount()).toBe(1);
    const before = snapshot();
    expectRefusedUp(/G2-R unresolved NULL provenance/, before);
    expect(hasColumn()).toBe('1');
    expect(platformOf(reopened[0])).toBe('<NULL>');
    // The accepted T writer still runs on E+B and claims the re-opened row (B stage 4 path).
    expect((await run()).result).toMatchObject({ reconstructed: 20 });
    expect(platformOf(reopened[0])).toBe('truecoach');
    expect(nullCount()).toBe(0);
  });
  it('R03: a noncanonical ledger value refuses; a noncanonical staged value refuses; atomic', () => {
    const [id] = ledgerIds(`source_id='s00002'`);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='TrueCoach' WHERE id=${quote(id)}`);
    let before = snapshot();
    expectRefusedUp(/G2-R noncanonical provenance/, before);
    expect(platformOf(id)).toBe('TrueCoach');
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='truecoach' WHERE id=${quote(id)}`);
    // Staging: E+B carry no constraint on the staging column, so the value is admitted there
    // and it is R's gate (not a write block) that refuses.
    sql(`UPDATE "ScoutIngestEntity" SET source_platform='Auto:X' WHERE source_id='s00003'`);
    before = snapshot();
    expectRefusedUp(/G2-R noncanonical staged provenance/, before);
    sql(`UPDATE "ScoutIngestEntity" SET source_platform='truecoach' WHERE source_id='s00003'`);
    // Trailing line terminator is noncanonical too (COLLATE "C" regex, `$` is end of string).
    sql(
      `UPDATE "ScoutReconstructionLedger" SET source_platform=E'truecoach\\n' WHERE id=${quote(id)}`,
    );
    before = snapshot();
    expectRefusedUp(/G2-R noncanonical provenance/, before);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='truecoach' WHERE id=${quote(id)}`);
    expect(allLedger()).toEqual(
      before.ledger.map((row: any) =>
        row.id === id ? { ...row, source_platform: 'truecoach' } : row,
      ),
    );
  });
  it('R11: a decoy relation or constraint holding an R name refuses; the decoy is untouched', () => {
    sql(`CREATE TABLE public.g2r_decoy (x text);
      CREATE INDEX "ScoutIngestEntity_identity_key" ON public.g2r_decoy (x)`);
    let before = snapshot();
    const decoy = () =>
      json(`SELECT jsonb_build_object('index',(SELECT pg_get_indexdef(oid) FROM pg_class
        WHERE relname='ScoutIngestEntity_identity_key' AND relnamespace='public'::regnamespace),
        'constraints',(SELECT COALESCE(jsonb_agg(conname ORDER BY conname),'[]') FROM pg_constraint
        WHERE conrelid='public.g2r_decoy'::regclass))`);
    const decoyBefore = decoy();
    expect(decoyBefore.index).toBe(
      'CREATE INDEX "ScoutIngestEntity_identity_key" ON public.g2r_decoy USING btree (x)',
    );
    expectRefusedUp(/G2-R wide identity already present/, before);
    expect(decoy()).toEqual(decoyBefore);
    sql(`DROP INDEX public."ScoutIngestEntity_identity_key";
      ALTER TABLE public.g2r_decoy ADD CONSTRAINT "ScoutReconstructionLedger_source_platform_canonical" CHECK (x IS NOT NULL)`);
    before = snapshot();
    expectRefusedUp(/G2-R wide identity already present/, before);
    expect(decoy()).toEqual({
      index: null,
      constraints: ['ScoutReconstructionLedger_source_platform_canonical'],
    });
    sql(`DROP TABLE public.g2r_decoy`);
    expect(wide()).toEqual(ABSENT);
  });
  it('R10: a held transaction on the ledger makes up hit lock_timeout (55P03); nothing applied; release → free', async () => {
    const before = snapshot();
    const holder = holdTransaction(`SELECT count(*) FROM public."ScoutReconstructionLedger"`);
    await holder.held;
    try {
      let error: unknown;
      const started = Date.now();
      try {
        sqlFile(rUpFile);
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      expect(String(error)).toMatch(/canceling statement due to lock timeout/);
      // The 5s budget is the file's own SET LOCAL lock_timeout, not the harness timeout.
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(30000);
      expect(wide()).toEqual(ABSENT);
      expect(allLedger()).toEqual(before.ledger);
      expect(appliedMigrations()).toBe(before.applied);
      console.warn('PG17_LOCK_TIMEOUT', JSON.stringify({ elapsed }));
    } finally {
      holder.release();
    }
    // Released: no other session holds the ledger any more, so the release path (stage 3) is free.
    for (let n = 0; n < 200; n++) {
      const held = sqlAdmin(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE c.relname='ScoutReconstructionLedger' AND l.granted AND l.pid<>pg_backend_pid()`);
      if (held === '0') return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('holder did not release the ledger lock');
  });
});

describe('stage 3: R through the release mechanism', () => {
  let beforeCatalog: any;
  let beforeNarrow: unknown;
  let beforeFence: unknown;
  let beforeFenceOid: string;
  let installed: any;
  it('R01: prisma migrate deploy applies exactly R; narrow keys, fence, RLS and policies are untouched', () => {
    beforeCatalog = parsedCatalog();
    beforeNarrow = narrow();
    beforeFence = fence();
    beforeFenceOid = fenceOid();
    const ledger = allLedger();
    const staging = stagingSnapshot();
    expect(beforeNarrow).toHaveLength(2);
    const start = sql('SELECT now()');
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(R_MIGRATION);
    expect(output).not.toContain(B_MIGRATION);
    expect(output).not.toContain(E_MIGRATION);
    expect(appliedSince(start)).toEqual([R_MIGRATION]);
    expect(appliedMigrations()).toBe(String(base + 5));
    // Rows and values: byte-identical (R derives, deletes and rewrites nothing).
    expect(allLedger()).toEqual(ledger);
    expect(stagingSnapshot()).toEqual(staging);
    // Catalog: tables (RLS flags), policies and both narrow indexes (OIDs included) identical;
    // the index set grew by exactly the two wide keys.
    const after = parsedCatalog();
    expect(after.tables).toEqual(beforeCatalog.tables);
    expect(after.policies).toEqual(beforeCatalog.policies);
    expect(narrow()).toEqual(beforeNarrow);
    expect(fence()).toEqual(beforeFence);
    expect(fenceOid()).toBe(beforeFenceOid);
    const added = after.indexes.filter(
      ([oid]: [number, string]) =>
        !beforeCatalog.indexes.some(([o]: [number, string]) => o === oid),
    );
    expect(added.map(([, def]: [number, string]) => def).sort()).toEqual([
      WIDE_INDEX('ScoutIngestEntity'),
      WIDE_INDEX('ScoutReconstructionLedger'),
    ]);
    expect(after.indexes).toHaveLength(beforeCatalog.indexes.length + 2);
    installed = wide();
    expect(installed.ledgerNotNull).toBe(true);
    expect(
      installed.indexes.map(([name, , unique, valid, def]: any[]) => [name, unique, valid, def]),
    ).toEqual([
      ['ScoutIngestEntity_identity_key', true, true, WIDE_INDEX('ScoutIngestEntity')],
      [
        'ScoutReconstructionLedger_identity_key',
        true,
        true,
        WIDE_INDEX('ScoutReconstructionLedger'),
      ],
    ]);
    expect(
      installed.checks.map(([name, , rel, valid, def]: any[]) => [
        name,
        rel,
        valid,
        stripParens(def),
      ]),
    ).toEqual([
      [
        'ScoutIngestEntity_source_platform_canonical',
        '"ScoutIngestEntity"',
        true,
        stripParens(CANONICAL_CHECK),
      ],
      [
        'ScoutReconstructionLedger_source_platform_canonical',
        '"ScoutReconstructionLedger"',
        true,
        stripParens(CANONICAL_CHECK),
      ],
    ]);
    console.warn('PG17_WIDE', JSON.stringify(installed));
  });
  it('R05: a raw rerun of R is refused atomically; OIDs, rows and history unchanged; deploy has nothing pending', () => {
    const before = snapshot();
    expect(() => sqlFile(rUpFile)).toThrow(/G2-R wide identity already present/);
    expect(wide()).toEqual(installed);
    expect(narrow()).toEqual(beforeNarrow);
    expect(allLedger()).toEqual(before.ledger);
    expect(stagingSnapshot()).toEqual(before.staging);
    expect(appliedMigrations()).toBe(String(base + 5));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
  });
  it('R11: a shadow schema first on search_path cannot redirect up (still refused against public)', () => {
    withShadowSearchPath(() => {
      expect(() => sqlFile(rUpFile)).toThrow(/G2-R wide identity already present/);
    });
    expect(wide()).toEqual(installed);
    const after = parsedCatalog();
    expect(after.tables).toEqual(beforeCatalog.tables);
    expect(after.policies).toEqual(beforeCatalog.policies);
    expect(after.indexes).toHaveLength(beforeCatalog.indexes.length + 2);
  });
});

describe('stage 4: R against the accepted T writer, the narrow keys, direct writers, API roles and O', () => {
  it('R06: T on R creates with provenance; replay writes nothing and is identical', async () => {
    settle('coach', 'i3');
    stageMany(10, 'clients', 'truecoach', 'coach', 'i3');
    const first = await run({ intent: 'i3' });
    expect(first.result).toMatchObject({ reconstructed: 10 });
    const rows = records('coach', 'i3');
    expect(rows).toHaveLength(10);
    expect(rows.every((r: any) => r.source_platform === 'truecoach')).toBe(true);
    // Five-tuple: exactly one ledger row per (coach, intent, family, platform, source).
    expect(
      sql(`SELECT count(*) FROM (SELECT 1 FROM "ScoutReconstructionLedger" WHERE intent_id='i3'
      GROUP BY coach_id,intent_id,entity_type,source_platform,source_id HAVING count(*)>1) d`),
    ).toBe('0');
    const replay = await run({ intent: 'i3' });
    expect(replay.result).toEqual(first.result);
    expect(records('coach', 'i3')).toEqual(rows);
    // A second platform on the same intent/family is a distinct five-tuple for the wide key and
    // yet a narrow-key duplicate for the product: the writer's dedup, not R, decides (R07 next).
    expect(nullCount()).toBe(0);
  });
  it('R07 (negative control): the narrow keys still arbitrate; the wide keys are present but are not the identity', () => {
    // Staging: same (coach, intent, source_id), different platform → the NARROW staging key.
    sql(stagingInsert('narrow-a', 'truecoach', undefined, 'narrow-shared'));
    refusedCode(
      stagingInsert('narrow-b', 'auto:other.example', undefined, 'narrow-shared'),
      '23505',
    );
    refused(
      stagingInsert('narrow-b', 'auto:other.example', undefined, 'narrow-shared'),
      'ScoutIngestEntity_coach_id_intent_id_source_id_key',
    );
    // The ON CONFLICT DO NOTHING path the ingest writer uses: zero rows, no error.
    expect(
      sql(`WITH ins AS (${stagingInsert('narrow-b', 'auto:other.example', undefined, 'narrow-shared')}
        ON CONFLICT DO NOTHING RETURNING id) SELECT count(*) FROM ins`),
    ).toBe('0');
    expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE source_id='narrow-shared'`)).toBe(
      '1',
    );
    // Ledger: same (coach, intent, family, source_id), different platform → the NARROW ledger key.
    sql(ledgerInsert('narrow-l', 'truecoach'));
    refusedCode(
      `INSERT INTO public."ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
      VALUES ('narrow-l2','coach','intent','clients','narrow-l','auto:other.example','skipped')`,
      '23505',
    );
    refused(
      `INSERT INTO public."ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
      VALUES ('narrow-l2','coach','intent','clients','narrow-l','auto:other.example','skipped')`,
      // PostgreSQL truncates the accepted narrow key's name to 63 characters.
      'ScoutReconstructionLedger_coach_id_intent_id_entity_type_source"',
    );
    expect(ledgerIds(`source_id='narrow-l'`)).toEqual(['narrow-l']);
    // Same five-tuple twice: refused by the wide key only if the narrow key did not already
    // answer — it always does, since a five-tuple duplicate is a narrow duplicate.
    sql(
      `DELETE FROM "ScoutReconstructionLedger" WHERE id='narrow-l'; DELETE FROM "ScoutIngestEntity" WHERE id='narrow-a'`,
    );
  });
  it('R08: content is refused at runtime by CHECK/NOT NULL for the owner and the runtime role; API roles by policy', () => {
    for (const role of [undefined, 'service_role']) {
      refusedCode(ledgerInsert('bad-l', 'Bad_Platform', role), '23514');
      refused(
        ledgerInsert('bad-l', 'Bad_Platform', role),
        'ScoutReconstructionLedger_source_platform_canonical',
      );
      refusedCode(ledgerInsert('bad-l', 'truecoach\n', role), '23514');
      // NULL meets the fence (BEFORE ROW trigger, check_violation) before NOT NULL.
      refusedCode(ledgerInsert('bad-l', null, role), '23514');
      refused(ledgerInsert('bad-l', null, role), FENCED);
      refusedCode(stagingInsert('bad-s', 'Auto:X', role), '23514');
      refused(
        stagingInsert('bad-s', 'Auto:X', role),
        'ScoutIngestEntity_source_platform_canonical',
      );
      refusedCode(stagingInsert('bad-s', '', role), '23514');
    }
    // UPDATE to a noncanonical value is refused as well: the CHECK is not INSERT-only.
    const [id] = ledgerIds(`source_id='s00001'`);
    refusedCode(
      `UPDATE public."ScoutReconstructionLedger" SET source_platform='TrueCoach' WHERE id=${quote(id)}`,
      '23514',
    );
    refusedCode(
      `UPDATE public."ScoutReconstructionLedger" SET source_platform=NULL WHERE id=${quote(id)}`,
      '23502',
    );
    expect(platformOf(id)).toBe('truecoach');
    expect(ledgerIds(`id IN ('bad-l')`)).toEqual([]);
    expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE id='bad-s'`)).toBe('0');
    // API roles with canonical values: the policy answers (42501); reads, updates, deletes see 0.
    for (const role of ['anon', 'authenticated']) {
      refusedCode(ledgerInsert('bad-l', 'truecoach', role), '42501');
      refusedCode(stagingInsert('bad-s', 'truecoach', role), '42501');
      expect(
        sql(`SET ROLE ${role}; SELECT (SELECT count(*) FROM public."ScoutReconstructionLedger")||','||
        (SELECT count(*) FROM public."ScoutIngestEntity")`),
      ).toBe('0,0');
      expect(
        sql(`SET ROLE ${role}; WITH u AS (UPDATE public."ScoutReconstructionLedger" SET status=status RETURNING 1),
        d AS (DELETE FROM public."ScoutIngestEntity" WHERE id='none' RETURNING 1)
        SELECT (SELECT count(*) FROM u)||','||(SELECT count(*) FROM d)`),
      ).toBe('0,0');
    }
    expect(ledgerIds(`id IN ('bad-l')`)).toEqual([]);
    expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE id='bad-s'`)).toBe('0');
  });
  it('R09 (negative control): the actual O binary fails closed on R: 500, no ledger row, no target; T reconstructs it', async () => {
    const before = { ledger: ledgerCount(), targets: targets(), nulls: nullCount() };
    stage('o-on-r', 'workouts');
    const old = await run({ family: 'workouts' }, true);
    expect(old.result).toBeUndefined();
    expect(old.failure).toMatchObject({ status: 500, message: 'Internal server error' });
    expect(ledgerCount()).toBe(before.ledger);
    expect(targets()).toEqual(before.targets);
    expect(nullCount()).toBe(0);
    expect(ledgerIds(`source_id='o-on-r'`)).toEqual([]);
    // O readers are unaffected.
    expect((await run({ action: 'roster', limit: 5 }, true)).result.persons).toHaveLength(5);
    // The accepted T writer reconstructs the same staged row on R with provenance.
    const t = await run({ family: 'workouts' });
    expect(t.result).toMatchObject({ reconstructed: 1 });
    const [id] = ledgerIds(`source_id='o-on-r'`);
    expect(platformOf(id)).toBe('truecoach');
  });
});

describe('stage 5: down removes only R; T continues on E+B; up restores the identical shape', () => {
  let installed: any;
  let installedCatalog: any;
  let installedNarrow: unknown;
  let installedFence: unknown;
  it('R12: down keeps rows, values, narrow keys, fence, column and history; wide/checks/NOT NULL are gone', () => {
    installed = wide();
    installedCatalog = parsedCatalog();
    installedNarrow = narrow();
    installedFence = fence();
    const ledger = allLedger();
    const staging = stagingSnapshot();
    // Under a shadow-first search_path the down still acts on public only (ID 15).
    withShadowSearchPath(() => {
      sqlFile(rDownFile);
    });
    expect(wide()).toEqual(ABSENT);
    expect(narrow()).toEqual(installedNarrow);
    expect(fence()).toEqual(installedFence);
    expect(hasColumn()).toBe('1');
    expect(allLedger()).toEqual(ledger);
    expect(stagingSnapshot()).toEqual(staging);
    const after = parsedCatalog();
    expect(after.tables).toEqual(installedCatalog.tables);
    expect(after.policies).toEqual(installedCatalog.policies);
    expect(after.indexes).toHaveLength(installedCatalog.indexes.length - 2);
    // History is not rewritten by down (S1-owned recovery semantics, recorded not judged):
    // R stays applied and deploy has nothing pending while the objects are absent.
    expect(appliedMigrations()).toBe(String(base + 5));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    // The fence still refuses NULL; a noncanonical value is admitted again (E+B shape).
    refused(ledgerInsert('after-down', null), FENCED);
    sql(ledgerInsert('after-down', 'TrueCoach'));
    expect(platformOf('after-down')).toBe('TrueCoach');
    sql(`DELETE FROM "ScoutReconstructionLedger" WHERE id='after-down'`);
    // A raw rerun of down is refused atomically.
    expect(() => sqlFile(rDownFile)).toThrow(/G2-R wide identity absent/);
    expect(wide()).toEqual(ABSENT);
    expect(narrow()).toEqual(installedNarrow);
  });
  it('T continues on E+B after down', async () => {
    stage('after-down-t', 'clients');
    const before = ledgerCount();
    expect((await run()).result).toBeDefined();
    expect(ledgerCount()).toBe(before + 1);
    expect(platformOf(ledgerIds(`source_id='after-down-t'`)[0])).toBe('truecoach');
    expect(nullCount()).toBe(0);
  });
  it('re-applying the file restores the identical shape (OIDs aside); a raw rerun is refused again', () => {
    sqlFile(rUpFile);
    expect(shape(wide())).toEqual(shape(installed));
    expect(narrow()).toEqual(installedNarrow);
    expect(fence()).toEqual(installedFence);
    const after = parsedCatalog();
    expect(after.tables).toEqual(installedCatalog.tables);
    expect(after.policies).toEqual(installedCatalog.policies);
    expect(after.indexes.map(([, def]: [number, string]) => def).sort()).toEqual(
      installedCatalog.indexes.map(([, def]: [number, string]) => def).sort(),
    );
    expect(appliedMigrations()).toBe(String(base + 5));
    expect(() => sqlFile(rUpFile)).toThrow(/G2-R wide identity already present/);
    refusedCode(ledgerInsert('after-up', 'Bad_Platform'), '23514');
    refused(ledgerInsert('after-up', null), FENCED);
    expect(ledgerIds(`id='after-up'`)).toEqual([]);
  });
});
