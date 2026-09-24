// S7-3′ G2 C/contract proof on the isolated PostgreSQL 17 lane (S1-provisioned,
// synthetic data only). Ordered stages in ONE file, run with --runInBand, on a
// FRESH bootstrap whose "old" side is N/Q1: a detached checkout of the accepted
// N/Q1 head, whose `prisma migrate deploy` installed the whole accepted history
// (164 base + S1, C1, E, B, R = 169). C ships ONE migration
// (20270121000000_scout_identity_contract: drop both narrow unique indexes) and
// its reverse; the candidate's deploy must have exactly C pending.
// Establishes only what is new in C: the contraction through the release
// mechanism, the activation of cross-family / cross-platform identities for the
// REAL ingest service and the N writer, retained idempotency, races, lock
// budgets, real Q1 ties, security, late ingest (D-C1), and C.down: collision-free
// reverse (with the whole E/B/R/C chain), the fixed identifier-free 23505 refusal
// on any collision, entry guards/decoys/shadow, and the older downs' refusals.
//   1. C02 negative control on the pre-C shape;  2. C14a C.down before C, C09a
//   C.up lock budget;  3. C01 deploy exactness, C14b rerun/shadow;  4. C03/C04,
//   C05, C06, C07, C08, C09b, C16, C17a, C18;  5. C11, C12, C13, C14c, C15;
//   6. C10 (+C14d, C17b), N/Q1 continues on C.
// Accepted E/T-Q0, B, R and N/Q1 proofs are neither rerun nor restated. Nothing
// here claims deployment, drain of any real database, or customer acceptance.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  allLedger,
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
  legacyEntityCursor,
  legacyRosterCursor,
  OLD_HEAD,
  oldClient,
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
  target,
  targets,
  upFile,
  downFile,
  v2,
  worker,
} from './utils/g2-c-pg-harness';
import { G2_C_CLUSTER_MARKER, G2_C_DATABASE_MARKER } from './utils/g2-c-db';
import {
  appliedSince,
  B_MIGRATION,
  bDownFile,
  bUpFile,
  C1_MIGRATION,
  C_DOWN_REFUSAL,
  C_MIGRATION,
  cDown,
  cDownFile,
  cUp,
  cUpFile,
  fence,
  identityRows,
  ingestClient,
  ledgerCount,
  ledgerIds,
  ledgerRow,
  narrow,
  narrowDuplicates,
  narrowNamed,
  NARROW_LEDGER_DEF,
  NARROW_LEDGER_NAME,
  NARROW_STAGING_DEF,
  NARROW_STAGING_NAME,
  nullCount,
  R_MIGRATION,
  rDownFile,
  rUpFile,
  S1_MIGRATION,
  stagedRows,
  stagingSnapshot,
  wide,
} from './utils/g2-c-harness';

jest.setTimeout(240000);
const EXPECTED_HISTORY = 169;
const FENCED = 'G2-B obsolete writer fenced';
const R_ABSENT = { indexes: [], checks: [], ledgerNotNull: false };
const MALFORMED = { status: 400, message: 'malformed cursor' };
const CONTRACT_ABSENT = /G2-C contract absent/;
const NARROW_PREREQUISITE = /G2-C unexpected identity prerequisite/;
const LOCK_TIMEOUT = /canceling statement due to lock timeout/;
const ids = (rows: any[]) => rows.map((r) => r.id);
const visible = (family: string, r: any) => (family === 'clients' ? r.persons : r.entities);
const cursorOf = (family: string, r: any) =>
  family === 'clients' ? r.page.next_cursor : r.next_cursor;
const actionOf = (family: string) => (family === 'clients' ? 'roster' : 'entities');
const nextLegacy = (family: string, s: string) =>
  family === 'clients' ? legacyRosterCursor(s) : legacyEntityCursor(family, s);
/** A page read touched the ledger page (target_id selected) or the staged count. */
const readPage = (queries: string[]) =>
  queries.some(
    (q) =>
      (q.includes('"ScoutReconstructionLedger"') && q.includes('"target_id"')) ||
      (q.includes('"ScoutIngestEntity"') && q.includes('COUNT')),
  );
const parsedCatalog = () => JSON.parse(catalog());
/** Catalog observations with OIDs removed: what down→up must restore identically. */
const stripParens = (s: string) => s.replace(/[()]/g, '');
const shape = (w: any) => ({
  indexes: w.indexes.map(([name, , unique, valid, def]: any[]) => [name, unique, valid, def]),
  checks: w.checks.map(([name, , rel, valid, def]: any[]) => [name, rel, valid, stripParens(def)]),
  ledgerNotNull: w.ledgerNotNull,
});
const indexDefs = (c: any) => c.indexes.map(([, def]: [number, string]) => def).sort();
/** Targets without the writer's @updatedAt touch: a replay's Person/entity upsert bumps
 *  updated_at and nothing else; identity, ids and content must be untouched. */
const stableTargets = (t: any) => ({
  persons: t.persons.map(({ updated_at: _u, ...p }: any) => p),
  entities: t.entities.map(({ updated_at: _v, ...e }: any) => e),
});
/** Narrow observations without OIDs (C.down recreates the objects, so OIDs legitimately move). */
const narrowDefs = () => narrow().map(([name, , def]: any[]) => [name, def]);
const NARROW_SHAPE = [
  [NARROW_STAGING_NAME, NARROW_STAGING_DEF],
  [NARROW_LEDGER_NAME, NARROW_LEDGER_DEF],
];
const ledgerInsert = (
  id: string,
  platform: string | null,
  role?: string,
  family = 'clients',
  source = id,
  intent = 'intent',
) =>
  `${role ? `SET ROLE ${role}; ` : ''}INSERT INTO public."ScoutReconstructionLedger"
  (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
  VALUES (${quote(id)},'coach',${quote(intent)},${quote(family)},${quote(source)},${platform === null ? 'NULL' : quote(platform)},'skipped')`;
const stagingInsert = (
  id: string,
  platform: string | null,
  role?: string,
  source = id,
  family = 'clients',
  intent = 'intent',
) =>
  `${role ? `SET ROLE ${role}; ` : ''}INSERT INTO public."ScoutIngestEntity"
  (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
  VALUES (${quote(id)},'coach',${quote(intent)},${quote(family)},${quote(source)},${platform === null ? 'NULL' : quote(platform)},'{}'::jsonb)`;
/** Refusal with the SQLSTATE visible: psql prints `ERROR:  <sqlstate>:` under verbose verbosity. */
const refusedCode = (statement: string, sqlstate: string) =>
  refused(`\\set VERBOSITY verbose\n${statement}`, `ERROR:  ${sqlstate}:`);
/** A migration file refused, with verbose verbosity so the SQLSTATE is in the output; returns
 *  the whole psql output so identifier-leak assertions can run on it. */
function refusedFile(file: string, message: RegExp | string): string {
  let error: unknown;
  try {
    sql(`\\set VERBOSITY verbose\n\\i ${file}`);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error(`${file} unexpectedly succeeded`);
  const output = String(error);
  expect(output).toMatch(message);
  return output;
}
const snapshot = () => ({
  ledger: allLedger(),
  staging: stagingSnapshot(),
  applied: appliedMigrations(),
  targets: targets(),
  wide: wide(),
  narrow: narrow(),
  fence: fence(),
  column: hasColumn(),
});
/** Every refusal is atomic: rows, targets, history, R's objects, the narrow keys (OIDs
 *  included), the fence and the column are exactly what they were. */
const expectUnchanged = (before: ReturnType<typeof snapshot>) => {
  expect(snapshot()).toEqual(before);
};
/** C.down refused on a collision: the fixed text, SQLSTATE 23505, no `DETAIL: Key`, none of the
 *  fixture identifiers in the output, everything unchanged, and no narrow relation on either
 *  table (both tables are checked before either CREATE). */
function expectDownRefusedCollision(identifiers: string[]) {
  const before = snapshot();
  expect(before.narrow).toEqual([]);
  const output = refusedFile(cDownFile, C_DOWN_REFUSAL);
  expect(output).toContain('ERROR:  23505:');
  expect(output).not.toMatch(/DETAIL:\s+Key/);
  for (const identifier of identifiers) expect(output).not.toContain(identifier);
  expectUnchanged(before);
  expect(narrowNamed()).toEqual([]);
  return output;
}
/** Session-default search_path for the migration role: the redirection attempt (case 15). */
const withShadowSearchPath = (fn: () => void) => {
  sql(`CREATE SCHEMA shadow;
    CREATE TABLE shadow."ScoutIngestEntity" (LIKE public."ScoutIngestEntity" INCLUDING DEFAULTS);
    CREATE TABLE shadow."ScoutReconstructionLedger" (LIKE public."ScoutReconstructionLedger" INCLUDING DEFAULTS);
    ALTER ROLE postgres SET search_path = shadow, public`);
  try {
    expect(sql(`SHOW search_path`)).toBe('shadow, public');
    fn();
    // The shadow relations never acquired anything: no indexes, no constraints.
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
/** Every non-final Q1 page of `family` from `after`, one row at a time; returns visible ids. */
async function enumerate(family: string, after?: string, old = false, limit = 1) {
  const action = actionOf(family);
  const union: string[] = [];
  const tokens: (string | null)[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const page = await run({ action, family, cursor: after, limit }, old);
    expect(page.failure).toBeUndefined();
    union.push(...ids(visible(family, page.result)));
    const next = cursorOf(family, page.result);
    tokens.push(next);
    if (next === null) return { union, tokens };
    after = next;
  }
  throw new Error('pagination did not terminate');
}
/** Target ids of the reconstructed rows of a scope in Q1's page order (source_id, source_platform). */
const reconstructedTargets = (intent: string, family: string) =>
  json(`SELECT COALESCE(jsonb_agg(target_id ORDER BY source_id,source_platform),'[]')
  FROM "ScoutReconstructionLedger" WHERE coach_id='coach' AND intent_id=${quote(intent)}
  AND entity_type=${quote(family)} AND status='reconstructed'`);
/** Lock-budget refusal of a migration file against a held transaction: the file's own 5s
 *  SET LOCAL lock_timeout, not the harness timeout, and nothing applied. */
function expectLockTimeout(file: string) {
  let error: unknown;
  const started = Date.now();
  try {
    sqlFile(file);
  } catch (e) {
    error = e;
  }
  const elapsed = Date.now() - started;
  expect(String(error)).toMatch(LOCK_TIMEOUT);
  expect(elapsed).toBeGreaterThanOrEqual(4500);
  expect(elapsed).toBeLessThan(30000);
  console.warn(
    'PG17_LOCK_TIMEOUT',
    JSON.stringify({ file: file.split('/').slice(-2).join('/'), elapsed }),
  );
}
async function expectTableUnlocked(table: string) {
  for (let n = 0; n < 200; n++) {
    const held = sqlAdmin(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE c.relname=${quote(table)} AND l.granted AND l.pid<>pg_backend_pid()`);
    if (held === '0') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`another session still holds ${table}`);
}
/** API roles: policy denies INSERT (42501) and hides every row from SELECT/UPDATE/DELETE. */
function expectApiRolesDenied() {
  for (const role of ['anon', 'authenticated']) {
    refusedCode(ledgerInsert('api-l', 'truecoach', role), '42501');
    refusedCode(stagingInsert('api-s', 'truecoach', role), '42501');
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
  expect(ledgerIds(`id='api-l'`)).toEqual([]);
  expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE id='api-s'`)).toBe('0');
  // The runtime role's own rolled-back transaction leaves nothing behind.
  sql(`SET ROLE service_role; BEGIN;
    ${stagingInsert('rb-s', 'truecoach')}; ${ledgerInsert('rb-l', 'truecoach')};
    ROLLBACK`);
  expect(ledgerIds(`id='rb-l'`)).toEqual([]);
  expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE id='rb-s'`)).toBe('0');
}

// Teardown authority (S5-R3-A-01), unchanged from the accepted proofs: no mutating cleanup
// against a fixture whose identity this proof never accepted.
let teardownAuthorized = false;
const disconnects: (() => Promise<void>)[] = [];
const ingest = (name: string) => {
  const client = ingestClient(name);
  disconnects.push(client.disconnect);
  return client;
};

beforeAll(() => {
  const identity =
    json(`SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),
    'port',inet_server_port(),'directory',${quote(sqlAdmin(`SELECT current_setting('data_directory')`))},
    'version',current_setting('server_version_num'),'user',current_user,'super',
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassrls',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),'owner',
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`);
  expect(identity).toMatchObject({
    database: 'g2_c_disposable',
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
  expect(directory).toMatch(/\/pg17\/clusters\/c-contract\/pg-data$/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_C_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_C_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh N/Q1-shaped bootstrap: the accepted N/Q1 head's whole history through its own
  // `prisma migrate deploy`; R's shape (column, fence, wide keys, NOT NULL) AND both narrow keys
  // are present; C is not recorded.
  expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN
    (${[S1_MIGRATION, C1_MIGRATION, E_MIGRATION, B_MIGRATION, R_MIGRATION].map(quote).join(',')})
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL`),
  ).toBe('5');
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(C_MIGRATION)}`),
  ).toBe('0');
  expect(hasColumn()).toBe('1');
  expect(fence().triggers).toHaveLength(1);
  const installed = wide();
  expect(installed.indexes).toHaveLength(2);
  expect(installed.checks).toHaveLength(2);
  expect(installed.ledgerNotNull).toBe(true);
  expect(narrowDefs()).toEqual(NARROW_SHAPE);
  // C ships exactly two files on top of the accepted N/Q1 head, and those files are this packet's.
  expect(OLD_HEAD).toMatch(/^[0-9a-f]{40}$/);
  expect(
    execFileSync('git', ['diff', '--name-only', OLD_HEAD, 'HEAD', '--', 'prisma/migrations'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort(),
  ).toEqual([
    `prisma/migrations/${C_MIGRATION}/down.sql`,
    `prisma/migrations/${C_MIGRATION}/migration.sql`,
  ]);
  expect(cUp).toBe(gitShow(`HEAD:prisma/migrations/${C_MIGRATION}/migration.sql`));
  expect(cDown).toBe(gitShow(`HEAD:prisma/migrations/${C_MIGRATION}/down.sql`));
  expect(cDown).toContain(C_DOWN_REFUSAL);
  expect(cDown).toContain(`USING ERRCODE = 'unique_violation'`);
  // The candidate client is C's (required ledger provenance, both wide keys, NEITHER narrow
  // @@unique); the old client is N's (required provenance, both wide keys, BOTH narrow @@unique).
  const client = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  expect(client).toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String(?!\?)/);
  expect(client).not.toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/);
  expect(client).toMatch(/map: "ScoutIngestEntity_identity_key"/);
  expect(client).toMatch(/map: "ScoutReconstructionLedger_identity_key"/);
  expect(client).not.toContain('@@unique([coach_id, intent_id, source_id])');
  expect(client).not.toContain('@@unique([coach_id, intent_id, entity_type, source_id])');
  const old = readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8');
  expect(old).toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String(?!\?)/);
  expect(old).toMatch(/map: "ScoutReconstructionLedger_identity_key"/);
  expect(old).toContain('@@unique([coach_id, intent_id, source_id])');
  expect(old).toContain('@@unique([coach_id, intent_id, entity_type, source_id])');
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
  for (const disconnect of disconnects) {
    try {
      await disconnect();
    } catch (e) {
      console.warn('PG17_DISCONNECT_FAILED', String(e));
    }
  }
  if (!teardownAuthorized) {
    console.warn(
      'PG17_TEARDOWN_SKIPPED',
      JSON.stringify({ reason: 'setup refused before first mutation; no DDL/DML issued' }),
    );
    return;
  }
  sql(`ALTER ROLE postgres RESET search_path; DROP SCHEMA IF EXISTS shadow CASCADE;
    DROP TABLE IF EXISTS public.g2c_decoy;
    DROP TABLE IF EXISTS public."ScoutIngestEntity_coach_id_intent_id_source_id_key"`);
  resetData();
  sql('DELETE FROM "ScoutImport"');
});

describe('stage 1: the pre-C shape — the narrow keys still arbitrate (negative control)', () => {
  it('C02: on R (N/Q1 head) the REAL ingest service dedupes a second family and a second platform of one source; raw inserts hit the narrow keys', async () => {
    const service = ingest('c02');
    expect(
      await service.ingest('clients', [{ sourceId: 's', sourcePlatform: 'truecoach' }], 'c02'),
    ).toEqual({ received: 1, deduped: 0 });
    // Same source in another family: the narrow staging key (coach_id, intent_id, source_id)
    // answers ON CONFLICT DO NOTHING → deduped, no row.
    expect(
      await service.ingest('workouts', [{ sourceId: 's', sourcePlatform: 'truecoach' }], 'c02'),
    ).toEqual({ received: 1, deduped: 1 });
    expect(
      await service.ingest(
        'client_history',
        [{ sourceId: 's', sourcePlatform: 'truecoach' }],
        'c02',
      ),
    ).toEqual({ received: 1, deduped: 1 });
    // Same source on another platform: also the narrow key.
    expect(
      await service.ingest(
        'clients',
        [{ sourceId: 's', sourcePlatform: 'conformance_alpha' }],
        'c02',
      ),
    ).toEqual({ received: 1, deduped: 1 });
    expect(stagedRows('coach', 'c02').map((r: any[]) => r.slice(0, 3))).toEqual([
      ['clients', 's', 'truecoach'],
    ]);
    // Raw writers: 23505 naming the narrow staging index, for a second family and a second platform.
    refusedCode(stagingInsert('c02-raw', 'truecoach', undefined, 's', 'workouts', 'c02'), '23505');
    refused(
      stagingInsert('c02-raw', 'truecoach', undefined, 's', 'workouts', 'c02'),
      NARROW_STAGING_NAME,
    );
    refused(
      stagingInsert('c02-raw', 'conformance_alpha', undefined, 's', 'clients', 'c02'),
      NARROW_STAGING_NAME,
    );
    // Ledger: (coach, intent, family, source) narrow key refuses a second platform of one family;
    // a second family of the same source is a distinct narrow key and is admitted.
    sql(ledgerInsert('c02-l1', 'truecoach', undefined, 'clients', 's', 'c02'));
    refusedCode(
      ledgerInsert('c02-l2', 'conformance_alpha', undefined, 'clients', 's', 'c02'),
      '23505',
    );
    refused(
      ledgerInsert('c02-l2', 'conformance_alpha', undefined, 'clients', 's', 'c02'),
      // PostgreSQL truncates the accepted narrow key's name to 63 characters.
      `${NARROW_LEDGER_NAME}"`,
    );
    sql(ledgerInsert('c02-l3', 'truecoach', undefined, 'workouts', 's', 'c02'));
    expect(ledgerIds(`intent_id='c02'`)).toEqual(['c02-l1', 'c02-l3']);
    expect(narrowDuplicates()).toEqual({ staging: 0, ledger: 0 });
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
    sql(
      `DELETE FROM "ScoutReconstructionLedger" WHERE intent_id='c02'; DELETE FROM "ScoutIngestEntity" WHERE intent_id='c02'`,
    );
    console.warn(
      'PG17_C02_EVENTS',
      JSON.stringify(service.events.map((e: any) => [e[2].received, e[2].deduped])),
    );
  });
});

describe('stage 2: before C — the reverse refuses, the forward respects the lock budget', () => {
  it('C14a: C.down on a pre-C database is refused atomically (contract absent)', () => {
    const before = snapshot();
    refusedFile(cDownFile, CONTRACT_ABSENT);
    expectUnchanged(before);
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
  });
  it('C09a: a held ledger read makes C.up hit lock_timeout (55P03); nothing applied; release → free', async () => {
    const before = snapshot();
    const holder = holdTransaction(`SELECT count(*) FROM public."ScoutReconstructionLedger"`);
    await holder.held;
    try {
      expectLockTimeout(cUpFile);
      expectUnchanged(before);
    } finally {
      holder.release();
    }
    await expectTableUnlocked('ScoutReconstructionLedger');
  });
});

describe('stage 3: C through the release mechanism', () => {
  let beforeCatalog: any;
  let installedWide: unknown;
  let installedFence: unknown;
  it('C01: prisma migrate deploy applies exactly C; only the two narrow indexes leave; wide keys, CHECKs, NOT NULL, fence, RLS, policies and rows are untouched', () => {
    beforeCatalog = parsedCatalog();
    installedWide = wide();
    installedFence = fence();
    const ledger = allLedger();
    const staging = stagingSnapshot();
    const before = narrow();
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
    const start = sql('SELECT now()');
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(C_MIGRATION);
    expect(output).not.toContain(R_MIGRATION);
    expect(output).not.toContain(B_MIGRATION);
    expect(output).not.toContain(E_MIGRATION);
    expect(appliedSince(start)).toEqual([C_MIGRATION]);
    expect(appliedMigrations()).toBe(String(EXPECTED_HISTORY + 1));
    // Contraction: both narrow keys gone, nothing else moved (OIDs included).
    expect(narrow()).toEqual([]);
    expect(narrowNamed()).toEqual([]);
    expect(wide()).toEqual(installedWide);
    expect(fence()).toEqual(installedFence);
    expect(hasColumn()).toBe('1');
    const after = parsedCatalog();
    expect(after.tables).toEqual(beforeCatalog.tables);
    expect(after.policies).toEqual(beforeCatalog.policies);
    const removed = beforeCatalog.indexes.filter(
      ([oid]: [number, string]) => !after.indexes.some(([o]: [number, string]) => o === oid),
    );
    expect(removed.map(([, def]: [number, string]) => def).sort()).toEqual(
      [NARROW_STAGING_DEF, NARROW_LEDGER_DEF].sort(),
    );
    expect(removed.map(([oid]: [number, string]) => oid).sort()).toEqual(
      before.map(([, oid]: any[]) => oid).sort(),
    );
    expect(after.indexes).toHaveLength(beforeCatalog.indexes.length - 2);
    // Rows and values: byte-identical (C derives, deletes and rewrites nothing).
    expect(allLedger()).toEqual(ledger);
    expect(stagingSnapshot()).toEqual(staging);
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    console.warn('PG17_C01', JSON.stringify({ removed, applied: appliedMigrations() }));
  });
  it('C14b: a raw rerun of C.up is refused atomically; a shadow schema first on search_path cannot redirect it', () => {
    const before = snapshot();
    refusedFile(cUpFile, NARROW_PREREQUISITE);
    expectUnchanged(before);
    withShadowSearchPath(() => {
      refusedFile(cUpFile, NARROW_PREREQUISITE);
    });
    expectUnchanged(before);
    const after = parsedCatalog();
    expect(after.tables).toEqual(beforeCatalog.tables);
    expect(after.policies).toEqual(beforeCatalog.policies);
    expect(after.indexes).toHaveLength(beforeCatalog.indexes.length - 2);
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
  });
});

describe('stage 4: on C — the wide identity is the identity for the real ingest service, the N writer and the Q1 readers', () => {
  it('C03/C04: one source across two, then three, families inserts every row (deduped 0); the staging duplicates are narrow-key groups the wide key holds', async () => {
    const service = ingest('c03');
    settle('coach', 'c3');
    expect(
      await service.ingest('clients', [{ sourceId: 's', sourcePlatform: 'truecoach' }], 'c3'),
    ).toEqual({ received: 1, deduped: 0 });
    expect(
      await service.ingest('workouts', [{ sourceId: 's', sourcePlatform: 'truecoach' }], 'c3'),
    ).toEqual({ received: 1, deduped: 0 });
    expect(stagedRows('coach', 'c3').map((r: any[]) => r.slice(0, 3))).toEqual([
      ['clients', 's', 'truecoach'],
      ['workouts', 's', 'truecoach'],
    ]);
    settle('coach', 'c4');
    for (const family of ['clients', 'workouts', 'client_history']) {
      expect(
        await service.ingest(family, [{ sourceId: 't', sourcePlatform: 'truecoach' }], 'c4'),
      ).toEqual({ received: 1, deduped: 0 });
    }
    expect(stagedRows('coach', 'c4').map((r: any[]) => r[0])).toEqual([
      'client_history',
      'clients',
      'workouts',
    ]);
    expect(narrowDuplicates('c3')).toEqual({ staging: 1, ledger: 0 });
    expect(narrowDuplicates('c4')).toEqual({ staging: 1, ledger: 0 });
    expect(narrowDuplicates()).toEqual({ staging: 2, ledger: 0 });
    // The ON CONFLICT DO NOTHING statement names no conflict target: the wide key arbitrates.
    expect(service.queries.some((q) => /ON CONFLICT DO NOTHING/.test(q))).toBe(true);
    expect(service.queries.some((q) => /ON CONFLICT \(/.test(q))).toBe(false);
  });
  it('C05: retained idempotency — full-tuple replay, changed captured_at and in-batch duplicates dedupe; another intent or coach inserts', async () => {
    const service = ingest('c05');
    settle('coach', 'c5');
    const batch = ['a', 'b', 'c'].map((sourceId) => ({ sourceId, sourcePlatform: 'truecoach' }));
    expect(await service.ingest('clients', batch, 'c5')).toEqual({ received: 3, deduped: 0 });
    const rows = stagedRows('coach', 'c5');
    expect(rows).toHaveLength(3);
    expect(await service.ingest('clients', batch, 'c5')).toEqual({ received: 3, deduped: 3 });
    expect(stagedRows('coach', 'c5')).toEqual(rows);
    // captured_at is a value, not a key (R-IDEMP-1): a fresh timestamp is still a replay.
    expect(
      await service.ingest(
        'clients',
        batch.map((e) => ({ ...e, capturedAt: '2026-09-25T12:00:00.000Z' })),
        'c5',
      ),
    ).toEqual({ received: 3, deduped: 3 });
    expect(stagedRows('coach', 'c5')).toEqual(rows);
    // In-batch duplicates collapse to one row.
    expect(
      await service.ingest(
        'clients',
        ['d', 'd', 'd'].map((sourceId) => ({ sourceId, sourcePlatform: 'truecoach' })),
        'c5',
      ),
    ).toEqual({ received: 3, deduped: 2 });
    expect(stagedRows('coach', 'c5')).toHaveLength(4);
    // Another intent or another coach is a new observation series.
    expect(await service.ingest('clients', [batch[0]], 'c5b')).toEqual({ received: 1, deduped: 0 });
    expect(await service.ingest('clients', [batch[0]], 'c5', 'coach2')).toEqual({
      received: 1,
      deduped: 0,
    });
    expect(stagedRows('coach', 'c5b')).toHaveLength(1);
    expect(stagedRows('coach2', 'c5')).toHaveLength(1);
    expect(narrowDuplicates('c5')).toEqual({ staging: 0, ledger: 0 });
    sql(`DELETE FROM "ScoutIngestEntity" WHERE coach_id='coach2'`);
  });
  it('C06: one source on two platforms through the real service inserts both, replays both as deduped, and the N writer reconstructs two identities', async () => {
    const service = ingest('c06');
    settle('coach', 'c6');
    const both = [
      { sourceId: 'u', sourcePlatform: 'truecoach' },
      { sourceId: 'u', sourcePlatform: 'conformance_alpha' },
    ];
    expect(await service.ingest('clients', both, 'c6')).toEqual({ received: 2, deduped: 0 });
    const rows = stagedRows('coach', 'c6');
    expect(rows.map((r: any[]) => r.slice(0, 3))).toEqual([
      ['clients', 'u', 'conformance_alpha'],
      ['clients', 'u', 'truecoach'],
    ]);
    expect(
      await service.ingest(
        'clients',
        both.map((e) => ({ ...e, capturedAt: '2026-09-25T12:00:00.000Z' })),
        'c6',
      ),
    ).toEqual({ received: 2, deduped: 2 });
    expect(stagedRows('coach', 'c6')).toEqual(rows);
    expect(service.events.map((e: any) => [e[2].received, e[2].deduped])).toEqual([
      [2, 0],
      [2, 2],
    ]);
    const n = await run({ intent: 'c6' });
    expect(n.failure).toBeUndefined();
    expect(n.result).toMatchObject({ staged: 2, reconstructed: 2, skipped: 0, failed: 0 });
    expect(identityRows('coach', 'c6', 'clients').map((r: any[]) => r.slice(0, 4))).toEqual([
      ['clients', 'u', 'conformance_alpha', 'reconstructed'],
      ['clients', 'u', 'truecoach', 'reconstructed'],
    ]);
    expect(
      sql(
        `SELECT count(DISTINCT id)||','||count(DISTINCT source_platform) FROM "Person" WHERE coach_id='coach' AND source_person_id='u'`,
      ),
    ).toBe('2,2');
    expect(narrowDuplicates('c6')).toEqual({ staging: 1, ledger: 1 });
    const replay = await run({ intent: 'c6' });
    expect(replay.result).toEqual(n.result);
    expect(nullCount()).toBe(0);
  });
  it('C07: three platforms of one workout through the writer: two reconstructed, the unregistered one skipped; replay and the old N writer are identical', async () => {
    settle('coach', 'c7');
    for (const platform of ['truecoach', 'conformance_alpha', 'unknown_platform']) {
      stage('w', 'workouts', platform, 'Synthetic W', 'coach', 'c7');
    }
    const first = await run({ intent: 'c7', family: 'workouts' });
    expect(first.failure).toBeUndefined();
    expect(first.result).toEqual({
      intent_id: 'c7',
      staged: 3,
      reconstructed: 2,
      skipped: 1,
      failed: 0,
    });
    const rows = records('coach', 'c7', 'workouts');
    expect(identityRows('coach', 'c7', 'workouts').map((r: any[]) => r.slice(0, 4))).toEqual([
      ['workouts', 'w', 'conformance_alpha', 'reconstructed'],
      ['workouts', 'w', 'truecoach', 'reconstructed'],
      ['workouts', 'w', 'unknown_platform', 'skipped'],
    ]);
    expect(
      sql(
        `SELECT reason FROM "ScoutReconstructionLedger" WHERE intent_id='c7' AND source_platform='unknown_platform'`,
      ),
    ).toBe('unsupported_platform:unknown_platform');
    expect(
      sql(
        `SELECT count(*) FROM "ScoutReconstructedEntity" WHERE coach_id='coach' AND entity_type='workouts' AND source_id='w'`,
      ),
    ).toBe('2');
    // The tally is cumulative over the ledger: a replay reports the same non-zero tally.
    const replay = await run({ intent: 'c7', family: 'workouts' });
    expect(replay.result).toEqual(first.result);
    expect(records('coach', 'c7', 'workouts')).toEqual(rows);
    const old = await run({ intent: 'c7', family: 'workouts' }, true);
    expect(old.failure).toBeUndefined();
    expect(old.result).toEqual(first.result);
    expect(records('coach', 'c7', 'workouts')).toEqual(rows);
    expect(narrowDuplicates('c7')).toEqual({ staging: 1, ledger: 1 });
  });
  it('C08: candidate/candidate and candidate/old races on one identity converge to one row and one target; cross-family/platform rows race to distinct outcomes; success dominates', async () => {
    // (a) candidate paused inside its row transaction before the ledger write; a second
    // candidate waits on the row lock; both converge on one row.
    resetData();
    stage('m1', 'clients');
    const paused = worker({ pause: 'before-ledger', txTimeout: 60000 });
    await paused.ready;
    const late = worker({});
    await blocked(late.name);
    paused.release();
    const [a1, a2] = await Promise.all([paused.done, late.done]);
    expect(a1.failure).toBeUndefined();
    expect(a2.failure).toBeUndefined();
    expect(a1.result).toMatchObject({ reconstructed: 1 });
    expect(a2.result).toMatchObject({ reconstructed: 1 });
    expect(ledgerIds(`source_id='m1'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    // (b) old paused after its staging read; candidate completes; old converges.
    resetData();
    stage('m2', 'clients');
    const oldPaused = worker({ pause: 'staged' }, true);
    await oldPaused.ready;
    expect((await run()).result).toMatchObject({ reconstructed: 1 });
    oldPaused.release();
    const b = await oldPaused.done;
    expect(b.failure).toBeUndefined();
    expect(b.result).toMatchObject({ reconstructed: 1 });
    expect(ledgerIds(`source_id='m2'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    // (c) the reverse order.
    resetData();
    stage('m3', 'clients');
    const candidatePaused = worker({ pause: 'staged' });
    await candidatePaused.ready;
    expect((await run({}, true)).result).toMatchObject({ reconstructed: 1 });
    candidatePaused.release();
    const c = await candidatePaused.done;
    expect(c.failure).toBeUndefined();
    expect(c.result).toMatchObject({ reconstructed: 1 });
    expect(ledgerIds(`source_id='m3'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    // (d) success dominates a later non-success attempt from either writer.
    const [[, , , status, targetBefore]] = identityRows('coach', 'intent', 'clients');
    expect(status).toBe('reconstructed');
    expect((await run({ mapper: 'skip' }, true)).failure).toBeUndefined();
    expect((await run({ mapper: 'skip' })).failure).toBeUndefined();
    expect(identityRows('coach', 'intent', 'clients')).toEqual([
      ['clients', 'm3', 'truecoach', 'reconstructed', targetBefore],
    ]);
    // (e) the same source across families and platforms, written concurrently by both writers:
    // three distinct identities, three outcomes, two Persons (two platforms), one entity.
    resetData();
    stage('m4', 'clients', 'truecoach');
    stage('m4', 'clients', 'conformance_alpha');
    stage('m4', 'workouts', 'truecoach');
    const [e1, e2] = await Promise.all([
      run({ family: 'clients' }),
      run({ family: 'workouts' }, true),
    ]);
    expect(e1.failure).toBeUndefined();
    expect(e2.failure).toBeUndefined();
    expect(e1.result).toMatchObject({ staged: 2, reconstructed: 2 });
    expect(e2.result).toMatchObject({ staged: 1, reconstructed: 1 });
    expect(identityRows('coach', 'intent').map((r: any[]) => r.slice(0, 4))).toEqual([
      ['clients', 'm4', 'conformance_alpha', 'reconstructed'],
      ['clients', 'm4', 'truecoach', 'reconstructed'],
      ['workouts', 'm4', 'truecoach', 'reconstructed'],
    ]);
    expect(
      sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach' AND source_person_id='m4'`),
    ).toBe('2');
    expect(
      sql(
        `SELECT count(*) FROM "ScoutReconstructedEntity" WHERE coach_id='coach' AND source_id='m4'`,
      ),
    ).toBe('1');
    console.warn(
      'PG17_C08_QUERIES',
      JSON.stringify({
        candidate_pair: [a1.queries.length, a2.queries.length],
        late_rollbacks: a2.queries.filter((q) => q === 'ROLLBACK').length,
        old_after_candidate: b.queries.length,
        candidate_after_old: c.queries.length,
      }),
    );
  });
  it('C09b: a held (uncommitted) ingest insert makes C.down hit lock_timeout atomically; rolled back, the row never lands and later ingest counts are accurate', async () => {
    resetData();
    const before = snapshot();
    const holder = holdTransaction(stagingInsert('hold-c9', 'truecoach'));
    await holder.held;
    try {
      expectLockTimeout(cDownFile);
      expectUnchanged(before);
      expect(narrow()).toEqual([]);
    } finally {
      holder.rollback();
    }
    await expectTableUnlocked('ScoutIngestEntity');
    expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE source_id='hold-c9'`)).toBe('0');
    // The contraction is committed: replay + new identities through the real service are exact.
    const service = ingest('c09');
    expect(
      await service.ingest('clients', [
        { sourceId: 'hold-c9', sourcePlatform: 'truecoach' },
        { sourceId: 'hold-c9', sourcePlatform: 'conformance_alpha' },
      ]),
    ).toEqual({ received: 2, deduped: 0 });
    expect(
      await service.ingest('clients', [{ sourceId: 'hold-c9', sourcePlatform: 'truecoach' }]),
    ).toEqual({ received: 1, deduped: 1 });
    expect(stagedRows().map((r: any[]) => r.slice(0, 3))).toEqual([
      ['clients', 'hold-c9', 'conformance_alpha'],
      ['clients', 'hold-c9', 'truecoach'],
    ]);
  });
  it.each(['clients', 'workouts'])(
    'C16: real %s identity ties (one source on three platforms) enumerate every reconstructed row exactly once at limit 1 on both heads; a tied legacy token is 400; an untied one resolves',
    async (family) => {
      resetData();
      // truecoach and conformance_alpha are registered mappers (reconstructed); p3 is canonical but
      // unregistered (skipped: the readers page reconstructed rows only). d is untied.
      for (const platform of ['truecoach', 'conformance_alpha', 'p3']) stage('a', family, platform);
      stage('d', family, 'truecoach');
      const written = await run({ family });
      expect(written.failure).toBeUndefined();
      expect(written.result).toMatchObject({ staged: 4, reconstructed: 3, skipped: 1, failed: 0 });
      const expected = reconstructedTargets('intent', family);
      expect(expected).toHaveLength(3);
      for (const old of [false, true]) {
        const { union, tokens } = await enumerate(family, undefined, old);
        expect(union).toEqual(expected);
        expect(tokens).toEqual([
          v2(family, 'a', 'conformance_alpha'),
          v2(family, 'a', 'truecoach'),
          null,
        ]);
        // The legacy format cannot name a tied boundary: 400, no page read, restart from the top.
        const tied = await run(
          { action: actionOf(family), family, cursor: nextLegacy(family, 'a') },
          old,
        );
        expect(tied.result).toBeUndefined();
        expect(tied.failure).toEqual(MALFORMED);
        expect(readPage(tied.queries)).toBe(false);
        // A legacy token for the untied row still resolves (last row → empty final page).
        const untied = await run(
          { action: actionOf(family), family, cursor: nextLegacy(family, 'd') },
          old,
        );
        expect(untied.failure).toBeUndefined();
        expect(visible(family, untied.result)).toEqual([]);
        expect(cursorOf(family, untied.result)).toBeNull();
      }
      // The old reader fed the candidate's exact v2 token pages the same next row.
      const crossed = await run(
        { action: actionOf(family), family, cursor: v2(family, 'a', 'conformance_alpha') },
        true,
      );
      expect(crossed.failure).toBeUndefined();
      expect(ids(visible(family, crossed.result))).toEqual([expected[1]]);
      expect(narrowDuplicates('intent')).toEqual({ staging: 1, ledger: 1 });
    },
  );
  it("C17a: after C the API roles are denied on both tables, the runtime role's rollback leaves nothing, and content refusals (CHECK, NOT NULL, fence) are unchanged", () => {
    expectApiRolesDenied();
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
      refusedCode(stagingInsert('bad-s', null, role), '23502');
    }
    expect(ledgerIds(`id='bad-l'`)).toEqual([]);
    expect(sql(`SELECT count(*) FROM "ScoutIngestEntity" WHERE id='bad-s'`)).toBe('0');
  });
  it('C18 (D-C1): an ingest between the count and the page leaves its row staged and unaccounted; the next replay converges and the tally equals the ledger', async () => {
    settle('coach', 'c18');
    const service = ingest('c18');
    expect(
      await service.ingest('clients', [{ sourceId: 'e1', sourcePlatform: 'truecoach' }], 'c18'),
    ).toEqual({ received: 1, deduped: 0 });
    // The shared worker's `staged` barrier fires after the count AND the page read.
    const paused = worker({ intent: 'c18', pause: 'staged' });
    await paused.ready;
    expect(
      await service.ingest('clients', [{ sourceId: 'e2', sourcePlatform: 'truecoach' }], 'c18'),
    ).toEqual({ received: 1, deduped: 0 });
    paused.release();
    const first = await paused.done;
    expect(first.failure).toBeUndefined();
    expect(first.result).toEqual({
      intent_id: 'c18',
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    // (b) e2 is observable as staged (present in staging, absent from the ledger, no target);
    // nothing marks it reconstructed.
    expect(stagedRows('coach', 'c18').map((r: any[]) => r[1])).toEqual(['e1', 'e2']);
    expect(identityRows('coach', 'c18').map((r: any[]) => r[1])).toEqual(['e1']);
    expect(ledgerRow('e2', 'truecoach', 'clients', 'coach', 'c18')).toBeNull();
    expect(
      sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach' AND source_person_id='e2'`),
    ).toBe('0');
    // (a) the next idempotent replay converges; the tally is ledger truth.
    const second = await run({ intent: 'c18' });
    expect(second.result).toEqual({
      intent_id: 'c18',
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(identityRows('coach', 'c18')).toHaveLength(stagedRows('coach', 'c18').length);
    expect(ledgerRow('e2', 'truecoach', 'clients', 'coach', 'c18')).toMatchObject({
      status: 'reconstructed',
    });
    const rows = records('coach', 'c18');
    const third = await run({ intent: 'c18' });
    expect(third.result).toEqual(second.result);
    expect(records('coach', 'c18')).toEqual(rows);
  });
});

describe('stage 5: C.down refuses — collisions (fixed 23505, no identifiers), decoys, shadow, and the older downs with C applied', () => {
  beforeAll(() => resetData());
  it('C11: a cross-family collision in staging refuses C.down; both rows and the wide keys remain; no narrow relation on either table', async () => {
    const service = ingest('c11');
    expect(
      await service.ingest(
        'clients',
        [{ sourceId: 'xf-c11', sourcePlatform: 'truecoach' }],
        'i-c11',
      ),
    ).toEqual({ received: 1, deduped: 0 });
    expect(
      await service.ingest(
        'workouts',
        [{ sourceId: 'xf-c11', sourcePlatform: 'truecoach' }],
        'i-c11',
      ),
    ).toEqual({ received: 1, deduped: 0 });
    expect(narrowDuplicates()).toEqual({ staging: 1, ledger: 0 });
    const output = expectDownRefusedCollision(['xf-c11', 'i-c11']);
    expect(stagedRows('coach', 'i-c11')).toHaveLength(2);
    console.warn(
      'PG17_C11_REFUSAL',
      JSON.stringify(output.split('\n').filter((l) => /ERROR|DETAIL|HINT/.test(l))),
    );
    sql(`DELETE FROM "ScoutIngestEntity" WHERE intent_id='i-c11'`);
  });
  it('C12: a cross-platform collision in staging refuses C.down identically', async () => {
    const service = ingest('c12');
    expect(
      await service.ingest(
        'clients',
        [
          { sourceId: 'xp-c12', sourcePlatform: 'truecoach' },
          { sourceId: 'xp-c12', sourcePlatform: 'conformance_alpha' },
        ],
        'i-c12',
      ),
    ).toEqual({ received: 2, deduped: 0 });
    expect(narrowDuplicates()).toEqual({ staging: 1, ledger: 0 });
    expectDownRefusedCollision(['xp-c12', 'i-c12']);
    expect(stagedRows('coach', 'i-c12')).toHaveLength(2);
    sql(`DELETE FROM "ScoutIngestEntity" WHERE intent_id='i-c12'`);
  });
  it('C13: a ledger-only collision refuses C.down; the staging narrow key is NOT created first (no half-narrow state)', () => {
    expect(narrowDuplicates()).toEqual({ staging: 0, ledger: 0 });
    sql(ledgerInsert('c13-l1', 'truecoach', undefined, 'clients', 'xl-c13', 'i-c13'));
    sql(ledgerInsert('c13-l2', 'conformance_alpha', undefined, 'clients', 'xl-c13', 'i-c13'));
    expect(narrowDuplicates()).toEqual({ staging: 0, ledger: 1 });
    expectDownRefusedCollision(['xl-c13', 'i-c13', 'c13-l1', 'c13-l2']);
    expect(ledgerIds(`intent_id='i-c13'`)).toEqual(['c13-l1', 'c13-l2']);
    sql(`DELETE FROM "ScoutReconstructionLedger" WHERE intent_id='i-c13'`);
  });
  it('C14c: a decoy relation holding a narrow name refuses C.down (contract absent) and C.up (unexpected prerequisite), shadow or not; the decoy is untouched', () => {
    expect(narrowDuplicates()).toEqual({ staging: 0, ledger: 0 });
    // A table named as the staging narrow key, and an index on a decoy table named as the ledger
    // narrow key (the 70-character text truncates to the same 63-character stored name).
    sql(`CREATE TABLE public."ScoutIngestEntity_coach_id_intent_id_source_id_key" (x text);
      CREATE TABLE public.g2c_decoy (x text);
      CREATE INDEX "ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key" ON public.g2c_decoy (x)`);
    const decoys = narrowNamed();
    expect(decoys.map(([name, , kind]: any[]) => [name, kind])).toEqual([
      [NARROW_STAGING_NAME, 'r'],
      [NARROW_LEDGER_NAME, 'i'],
    ]);
    const before = snapshot();
    expect(before.narrow).toEqual([]);
    refusedFile(cDownFile, CONTRACT_ABSENT);
    expectUnchanged(before);
    expect(narrowNamed()).toEqual(decoys);
    refusedFile(cUpFile, NARROW_PREREQUISITE);
    expectUnchanged(before);
    expect(narrowNamed()).toEqual(decoys);
    withShadowSearchPath(() => {
      refusedFile(cDownFile, CONTRACT_ABSENT);
      refusedFile(cUpFile, NARROW_PREREQUISITE);
    });
    expectUnchanged(before);
    expect(narrowNamed()).toEqual(decoys);
    // Only the staging-named decoy: the ledger-named decoy alone refuses the same way.
    sql(`DROP TABLE public."ScoutIngestEntity_coach_id_intent_id_source_id_key"`);
    refusedFile(cDownFile, CONTRACT_ABSENT);
    expectUnchanged(before);
    sql(`DROP TABLE public.g2c_decoy`);
    expect(narrowNamed()).toEqual([]);
    expectUnchanged(before);
  });
  it('C15: with C applied, R.down, B.down and E.down each refuse atomically on the absent narrow keys', () => {
    const before = snapshot();
    expect(before.narrow).toEqual([]);
    refusedFile(rDownFile, /G2-R unexpected identity prerequisite/);
    expectUnchanged(before);
    refusedFile(bDownFile, /G2-B unexpected identity prerequisite/);
    expectUnchanged(before);
    refusedFile(downFile, /G2-E unexpected identity prerequisite/);
    expectUnchanged(before);
    expect(fence().triggers).toHaveLength(1);
    expect(hasColumn()).toBe('1');
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
  });
});

describe('stage 6: collision-free reverse and forward — C.down, the whole chain down, the whole chain up', () => {
  let installedWide: any;
  let installedCatalog: any;
  let installedFence: unknown;
  it('C10: C.down restores the exact R shape with rows and targets intact (history not rewritten, narrow arbitrates again, writers idle; C14d rerun refused; C17b security); then R/B/E down and E/B/R/C up restore the C shape with staging byte-equivalent and the ledger re-derived identically', async () => {
    resetData();
    for (const id of ['a', 'b', 'c']) stage(id, 'clients');
    stage('w1', 'workouts');
    expect((await run({ family: 'clients' })).result).toMatchObject({ reconstructed: 3 });
    expect((await run({ family: 'workouts' })).result).toMatchObject({ reconstructed: 1 });
    expect(narrowDuplicates()).toEqual({ staging: 0, ledger: 0 });
    // Replay tallies (cumulative over the ledger) BEFORE the snapshots: a replay touches only
    // the targets' updated_at.
    const clientsTally = (await run({ family: 'clients' })).result;
    const workoutsTally = (await run({ family: 'workouts' })).result;
    installedWide = wide();
    installedCatalog = parsedCatalog();
    installedFence = fence();
    const ledger = allLedger();
    const identities = identityRows();
    const staging = stagingSnapshot();
    const persisted = targets();
    const persistedStable = stableTargets(persisted);
    // C.down under a shadow-first search_path still acts on public only.
    withShadowSearchPath(() => {
      sqlFile(cDownFile);
    });
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
    expect(wide()).toEqual(installedWide);
    expect(fence()).toEqual(installedFence);
    expect(hasColumn()).toBe('1');
    expect(allLedger()).toEqual(ledger);
    expect(stagingSnapshot()).toEqual(staging);
    expect(targets()).toEqual(persisted);
    let after = parsedCatalog();
    expect(after.tables).toEqual(installedCatalog.tables);
    expect(after.policies).toEqual(installedCatalog.policies);
    expect(after.indexes).toHaveLength(installedCatalog.indexes.length + 2);
    // History is not rewritten by down (S1-owned recovery semantics, recorded not judged): C
    // stays applied and deploy has nothing pending while the narrow keys are back.
    expect(appliedMigrations()).toBe(String(EXPECTED_HISTORY + 1));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    // The narrow keys arbitrate again.
    refusedCode(stagingInsert('a-other', 'conformance_alpha', undefined, 'a'), '23505');
    refused(stagingInsert('a-other', 'conformance_alpha', undefined, 'a'), NARROW_STAGING_NAME);
    refusedCode(ledgerInsert('a-other', 'conformance_alpha', undefined, 'clients', 'a'), '23505');
    expect(stagingSnapshot()).toEqual(staging);
    // Both writers are idle on the restored shape.
    expect((await run({ family: 'clients' })).result).toEqual(clientsTally);
    expect((await run({ family: 'clients' }, true)).result).toEqual(clientsTally);
    expect((await run({ family: 'workouts' }, true)).result).toEqual(workoutsTally);
    expect(allLedger()).toEqual(ledger);
    expect(stableTargets(targets())).toEqual(persistedStable);
    // C14d: a raw rerun of C.down is refused atomically.
    const restored = snapshot();
    refusedFile(cDownFile, CONTRACT_ABSENT);
    expectUnchanged(restored);
    // C17b: security after C.down.
    expectApiRolesDenied();
    refusedCode(ledgerInsert('bad-l', 'Bad_Platform'), '23514');
    refusedCode(ledgerInsert('bad-l', null), '23514');
    // R.down → B.down → E.down. E.down refuses assigned provenance first; the ledger is emptied
    // for the E step only and re-derived by the writers after the forward chain.
    sqlFile(rDownFile);
    expect(wide()).toEqual(R_ABSENT);
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
    expect(stagingSnapshot()).toEqual(staging);
    sqlFile(bDownFile);
    expect(fence()).toEqual({ triggers: [], function: null });
    expect(stagingSnapshot()).toEqual(staging);
    refusedFile(downFile, /G2-E refuses removal of assigned provenance/);
    expect(hasColumn()).toBe('1');
    expect(allLedger()).toEqual(ledger);
    sql(`DELETE FROM "ScoutReconstructionLedger"`);
    sqlFile(downFile);
    expect(hasColumn()).toBe('0');
    expect(stagingSnapshot()).toEqual(staging);
    expect(stableTargets(targets())).toEqual(persistedStable);
    // E.up → B.up → R.up → C.up.
    sqlFile(upFile);
    expect(hasColumn()).toBe('1');
    sqlFile(bUpFile);
    expect(fence().triggers).toHaveLength(1);
    sqlFile(rUpFile);
    expect(shape(wide())).toEqual(shape(installedWide));
    expect(narrowDefs()).toEqual(NARROW_SHAPE);
    sqlFile(cUpFile);
    expect(narrow()).toEqual([]);
    expect(shape(wide())).toEqual(shape(installedWide));
    expect(fence()).toEqual(installedFence);
    after = parsedCatalog();
    expect(after.tables).toEqual(installedCatalog.tables);
    expect(after.policies).toEqual(installedCatalog.policies);
    expect(indexDefs(after)).toEqual(indexDefs(installedCatalog));
    expect(stagingSnapshot()).toEqual(staging);
    expect(stableTargets(targets())).toEqual(persistedStable);
    expect(appliedMigrations()).toBe(String(EXPECTED_HISTORY + 1));
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    // Re-derive the ledger: the targets survived, so the same identities point at the same targets.
    expect((await run({ family: 'clients' })).result).toEqual(clientsTally);
    expect((await run({ family: 'workouts' })).result).toEqual(workoutsTally);
    expect(identityRows()).toEqual(identities);
    expect(stableTargets(targets())).toEqual(persistedStable);
    expect(ledgerCount()).toBe(ledger.length);
    expect(nullCount()).toBe(0);
    // Raw reruns refused on the restored C shape.
    const final = snapshot();
    refusedFile(cUpFile, NARROW_PREREQUISITE);
    expectUnchanged(final);
  });
  it('N/Q1 continues on C: the old writer admits a cross-family tuple after re-C and both readers page it', async () => {
    stage('a', 'workouts');
    const old = await run({ family: 'workouts' }, true);
    expect(old.failure).toBeUndefined();
    expect(old.result).toMatchObject({ staged: 2, reconstructed: 2, skipped: 0, failed: 0 });
    expect(identityRows('coach', 'intent', 'workouts').map((r: any[]) => r.slice(0, 4))).toEqual([
      ['workouts', 'a', 'truecoach', 'reconstructed'],
      ['workouts', 'w1', 'truecoach', 'reconstructed'],
    ]);
    expect(narrowDuplicates()).toEqual({ staging: 1, ledger: 0 });
    const expected = reconstructedTargets('intent', 'workouts');
    for (const isOld of [false, true]) {
      const page = await run({ action: 'entities', family: 'workouts', limit: 200 }, isOld);
      expect(page.failure).toBeUndefined();
      expect(ids(visible('workouts', page.result))).toEqual(expected);
      expect(cursorOf('workouts', page.result)).toBeNull();
      expect((await enumerate('workouts', undefined, isOld)).union).toEqual(expected);
    }
    // The clients reader still pages a, b, c: the cross-family row is invisible to it.
    const roster = await run({ action: 'roster', limit: 200 });
    expect(ids(visible('clients', roster.result))).toEqual(
      reconstructedTargets('intent', 'clients'),
    );
    expect(nullCount()).toBe(0);
  });
});
