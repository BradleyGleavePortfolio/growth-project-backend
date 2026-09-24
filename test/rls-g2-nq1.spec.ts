// S7-3′ G2 N/Q1 proof on the isolated PostgreSQL 17 lane (S1-provisioned,
// synthetic data only). Ordered stages in ONE file, run with --runInBand, on a
// FRESH bootstrap whose "old" side is T: a detached checkout of the accepted R
// head 7d2895e1, whose `prisma migrate deploy` installed the whole accepted
// history (164 base + S1, C1, E, B, R = 169). N/Q1 ships NO migration, so the
// candidate's deploy must have nothing pending and the catalog must not move.
// Establishes only what is new in N/Q1: the final writer on the wide identity
// (N) and the scoped v2 cursor emission with legacy-token resolution (Q1).
//   1. N01 deploy exactness, N02 N on R with the T tally, N03 mixed T+N
//   processes, N04 narrow collision, N05 N on the E shape (negative), N06 N→T
//   rollback;  2. Q01 emission, Q02 chains, Q03 legacy resolution, Q04 ties,
//   Q05 scope, Q06 erasure, Q07 bounds.
// Accepted E/T-Q0, B and R proofs are neither rerun nor restated. Nothing here
// claims deployment, drain of any real database, or customer acceptance; C
// remains unimplemented and unclaimed.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  appliedMigrations,
  catalog,
  directory,
  E_MIGRATION,
  encoded,
  expectedVersion,
  hasColumn,
  json,
  legacyEntityCursor,
  legacyRosterCursor,
  OLD_HEAD,
  oldClient,
  prismaMigrateDeploy,
  quote,
  records,
  resetData,
  root,
  run,
  settle,
  skippedOf,
  sql,
  sqlAdmin,
  sqlFile,
  stage,
  stageMany,
  target,
  targets,
  UNMAPPED_PLATFORM,
  UNMAPPED_REASON,
  v2,
  blocked,
  worker,
} from './utils/g2-nq1-pg-harness';
import { G2_NQ1_CLUSTER_MARKER, G2_NQ1_DATABASE_MARKER } from './utils/g2-nq1-db';
import {
  B_MIGRATION,
  C1_MIGRATION,
  fence,
  identityRows,
  ledgerCount,
  ledgerIds,
  narrow,
  nullCount,
  nullify,
  R_MIGRATION,
  rDownFile,
  rUpFile,
  S1_MIGRATION,
  wide,
} from './utils/g2-nq1-harness';

jest.setTimeout(240000);
const EXPECTED_HISTORY = 169;
const ledgerKey = '"ScoutReconstructionLedger_coach_id_intent_id_entity_type_source"';
/** Prisma's rendered ORDER BY for a (source_id, source_platform) ascending page of `table`. */
const orderBy = (table: string) =>
  new RegExp(
    `ORDER BY (?:"public"\\.)?"${table}"\\."source_id" ASC, (?:"public"\\.)?"${table}"\\."source_platform" ASC`,
  );
const LEDGER_ORDER = orderBy('ScoutReconstructionLedger');
const STAGING_ORDER = orderBy('ScoutIngestEntity');
const MALFORMED = { status: 400, message: 'malformed cursor' };
const ids = (rows: any[]) => rows.map((r) => r.id);
const visible = (family: string, r: any) => (family === 'clients' ? r.persons : r.entities);
const cursorOf = (family: string, r: any) =>
  family === 'clients' ? r.page.next_cursor : r.next_cursor;
const actionOf = (family: string) => (family === 'clients' ? 'roster' : 'entities');
const nextLegacy = (family: string, s: string) =>
  family === 'clients' ? legacyRosterCursor(s) : legacyEntityCursor(family, s);
/** Ledger rows of a scope without the intent (so two intents' outcomes can be compared). */
const outcomes = (intent: string, family?: string) =>
  identityRows('coach', intent, family).map(([f, s, p, status, target_id]: string[]) => [
    f,
    s,
    p,
    status,
    target_id === null ? null : typeof target_id,
  ]);
/** The writer's summary without its intent id, so two intents' tallies can be compared. */
const tally = (result: any) => {
  const { intent_id, ...rest } = result;
  expect(typeof intent_id).toBe('string');
  return rest;
};
/** A page read touched the ledger page (target_id selected) or the staged count. */
const readPage = (queries: string[]) =>
  queries.some(
    (q) =>
      (q.includes('"ScoutReconstructionLedger"') && q.includes('"target_id"')) ||
      (q.includes('"ScoutIngestEntity"') && q.includes('COUNT')),
  );
const parsedCatalog = () => JSON.parse(catalog());
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
    database: 'g2_nq1_disposable',
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
  expect(directory).toMatch(/\/pg17\/clusters\/nq1\/pg-data$/);
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_NQ1_CLUSTER_MARKER);
  expect(
    sql(
      `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
    ),
  ).toBe(G2_NQ1_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Fresh T-shaped bootstrap: the accepted R head's whole history through its own
  // `prisma migrate deploy`; R's shape (column, fence, wide keys, NOT NULL) is present.
  expect(Number(appliedMigrations())).toBe(EXPECTED_HISTORY);
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN
    (${[S1_MIGRATION, C1_MIGRATION, E_MIGRATION, B_MIGRATION, R_MIGRATION].map(quote).join(',')})
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL`),
  ).toBe('5');
  expect(hasColumn()).toBe('1');
  expect(fence().triggers).toHaveLength(1);
  const installed = wide();
  expect(installed.indexes).toHaveLength(2);
  expect(installed.checks).toHaveLength(2);
  expect(installed.ledgerNotNull).toBe(true);
  expect(narrow()).toHaveLength(2);
  // N/Q1 ships no migration: the candidate's migration tree is the accepted R head's.
  expect(
    execFileSync('git', ['diff', '--stat', OLD_HEAD, 'HEAD', '--', 'prisma/migrations'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ).toBe('');
  // The candidate client is N's (required ledger provenance, both wide keys); the old client
  // is T's (optional ledger provenance, both wide keys).
  const client = readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8');
  expect(client).toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String(?!\?)/);
  expect(client).not.toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/);
  expect(client).toMatch(/map: "ScoutIngestEntity_identity_key"/);
  expect(client).toMatch(/map: "ScoutReconstructionLedger_identity_key"/);
  const old = readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8');
  expect(old).toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/);
  expect(old).toMatch(/map: "ScoutReconstructionLedger_identity_key"/);
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
  resetData();
  sql('DELETE FROM "ScoutImport"');
});

describe('stage 1: N — the final writer on the accepted R shape', () => {
  it('N01: prisma migrate deploy from the candidate has nothing pending; the catalog does not move; N writes the five-field identity', async () => {
    const before = { catalog: parsedCatalog(), wide: wide(), narrow: narrow(), fence: fence() };
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
    expect(appliedMigrations()).toBe(String(EXPECTED_HISTORY));
    expect(parsedCatalog()).toEqual(before.catalog);
    expect(wide()).toEqual(before.wide);
    expect(narrow()).toEqual(before.narrow);
    expect(fence()).toEqual(before.fence);
    // Same five-tuple on this fixture twice (same staged identity, T then N) is proven in N02;
    // here: N writes rows whose identity is the staged (source_platform, source_id).
    for (const id of ['a', 'b', 'c']) stage(id, 'clients');
    const n = await run();
    expect(n.failure).toBeUndefined();
    expect(n.result).toMatchObject({ reconstructed: 3 });
    expect(identityRows('coach', 'intent', 'clients').map((r: string[]) => r.slice(0, 4))).toEqual(
      ['a', 'b', 'c'].map((s) => ['clients', s, 'truecoach', 'reconstructed']),
    );
    expect(nullCount()).toBe(0);
    // The N process paged staging by (source_id, source_platform) and addressed the ledger by
    // the five-field selector (both provenance columns in one ledger predicate).
    expect(n.queries.some((q) => STAGING_ORDER.test(q))).toBe(true);
    expect(
      n.queries.some(
        (q) =>
          q.includes('"ScoutReconstructionLedger"') &&
          /"source_platform" = \$\d+/.test(q) &&
          /"source_id" = \$\d+/.test(q) &&
          /"entity_type" = \$\d+/.test(q),
      ),
    ).toBe(true);
    expect(
      n.queries.some((q) =>
        /INSERT INTO "public"\."ScoutReconstructionLedger" \([^)]*"source_platform"/.test(q),
      ),
    ).toBe(true);
    // Replay writes nothing and is identical.
    const rows = records();
    const replay = await run();
    expect(replay.result).toEqual(n.result);
    expect(records()).toEqual(rows);
  });
  it('N02: N on R, per family, matches the accepted T tally on an identical fixture; replay identical; ledger provenance is the staged provenance', async () => {
    for (const family of ['clients', 'workouts']) {
      const n = `n2-${family}`;
      const t = `t2-${family}`;
      settle('coach', n);
      settle('coach', t);
      // Every 6th row of both families is staged under the product's own unmapped canonical
      // platform: the family dispatch (identical on N and T) records it `skipped` with the exact
      // `unsupported_platform:<token>` reason. 24 rows, k=6 → floor(24/6)=4 skipped, 20 reconstructed.
      const skipEvery = 6;
      const skipped = skippedOf(24, skipEvery);
      stageMany(24, family, 'truecoach', 'coach', n, skipEvery);
      stageMany(24, family, 'truecoach', 'coach', t, skipEvery);
      const fromN = await run({ intent: n, family });
      const fromT = await run({ intent: t, family }, true);
      expect(fromN.failure).toBeUndefined();
      expect(fromT.failure).toBeUndefined();
      expect(tally(fromN.result)).toEqual(tally(fromT.result));
      expect(fromN.result).toEqual({
        intent_id: n,
        staged: 24,
        reconstructed: 24 - skipped,
        skipped,
        failed: 0,
      });
      expect(outcomes(n, family)).toEqual(outcomes(t, family));
      expect(outcomes(n, family)).toHaveLength(24);
      // The skipped rows are exactly the unmapped-platform rows: no target, the product's reason.
      expect(
        json(`SELECT COALESCE(jsonb_agg(jsonb_build_array(source_id,source_platform,status,target_id,reason)
        ORDER BY source_id),'[]') FROM "ScoutReconstructionLedger"
        WHERE intent_id=${quote(n)} AND status<>'reconstructed'`),
      ).toEqual(
        Array.from({ length: skipped }, (_, i) => [
          `s${String((i + 1) * skipEvery).padStart(5, '0')}`,
          UNMAPPED_PLATFORM,
          'skipped',
          null,
          UNMAPPED_REASON,
        ]),
      );
      expect(
        sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE intent_id=${quote(n)}
        AND status='reconstructed' AND (source_platform<>'truecoach' OR target_id IS NULL OR reason IS NOT NULL)`),
      ).toBe('0');
      // Provenance is the staged provenance, row for row.
      expect(
        sql(`SELECT count(*) FROM "ScoutReconstructionLedger" l JOIN "ScoutIngestEntity" s
        ON s.coach_id=l.coach_id AND s.intent_id=l.intent_id AND s.entity_type=l.entity_type AND s.source_id=l.source_id
        WHERE l.intent_id=${quote(n)} AND l.source_platform IS DISTINCT FROM s.source_platform`),
      ).toBe('0');
      const rows = records('coach', n, family);
      const replay = await run({ intent: n, family });
      expect(replay.result).toEqual(fromN.result);
      expect(records('coach', n, family)).toEqual(rows);
      // Exactly one ledger row per five-tuple, and per narrow key.
      expect(
        sql(`SELECT count(*) FROM (SELECT 1 FROM "ScoutReconstructionLedger" WHERE intent_id=${quote(n)}
        GROUP BY coach_id,intent_id,entity_type,source_id HAVING count(*)>1) d`),
      ).toBe('0');
    }
  });
  it('N03: mixed T and N processes on one staged row, both orders: one ledger row, one target, success dominates', async () => {
    // Each staged identity here sits beside a genuinely skipped sibling (the product's unmapped
    // canonical platform, see N02) so every mixed-writer pass carries one success and one
    // non-success outcome and the tally is {reconstructed: 1, skipped: 1} for BOTH writers.
    const mixed = { staged: 2, reconstructed: 1, skipped: 1, failed: 0 };
    const skippedRow = (source: string) => ['clients', source, UNMAPPED_PLATFORM, 'skipped', null];
    // (a) T paused after its staging read; N completes; T resumes and converges on N's row.
    resetData();
    stage('m1', 'clients');
    stage('m1-skip', 'clients', UNMAPPED_PLATFORM, 'Synthetic M1S');
    const tPaused = worker({ pause: 'staged' }, true);
    await tPaused.ready;
    const n1 = await run();
    expect(n1.result).toMatchObject(mixed);
    tPaused.release();
    const t1 = await tPaused.done;
    expect(t1.failure).toBeUndefined();
    expect(t1.result).toMatchObject(mixed);
    expect(ledgerIds(`source_id='m1'`)).toHaveLength(1);
    expect(ledgerIds(`source_id='m1-skip'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    expect(identityRows('coach', 'intent', 'clients').map((r: string[]) => r.slice(0, 4))).toEqual([
      ['clients', 'm1', 'truecoach', 'reconstructed'],
      skippedRow('m1-skip').slice(0, 4),
    ]);
    expect(sql(`SELECT reason FROM "ScoutReconstructionLedger" WHERE source_id='m1-skip'`)).toBe(
      UNMAPPED_REASON,
    );
    // (b) N paused inside its row transaction before the ledger write (target persisted,
    // uncommitted); T starts, waits on N's row lock; N resumes and commits; T converges.
    resetData();
    stage('m2', 'clients');
    const nPaused = worker({ pause: 'before-ledger', txTimeout: 60000 });
    await nPaused.ready;
    const tLate = worker({}, true);
    await blocked(tLate.name);
    nPaused.release();
    const [n2, t2] = await Promise.all([nPaused.done, tLate.done]);
    expect(n2.failure).toBeUndefined();
    expect(t2.failure).toBeUndefined();
    expect(n2.result).toMatchObject({ reconstructed: 1 });
    expect(t2.result).toMatchObject({ reconstructed: 1 });
    expect(ledgerIds(`source_id='m2'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    // (c) N paused after its staging read; T completes; N resumes: its wide-identity upsert
    // matches T's committed row (same staged platform) and precedence keeps success. The
    // genuinely skipped sibling converges too: one ledger row, still `skipped`, product reason.
    resetData();
    stage('m3', 'clients');
    stage('m3-skip', 'clients', UNMAPPED_PLATFORM, 'Synthetic M3S');
    const nStaged = worker({ pause: 'staged' });
    await nStaged.ready;
    const t3 = await run({}, true);
    expect(t3.result).toMatchObject(mixed);
    nStaged.release();
    const n3 = await nStaged.done;
    expect(n3.failure).toBeUndefined();
    expect(n3.result).toMatchObject(mixed);
    expect(ledgerIds(`source_id='m3'`)).toHaveLength(1);
    expect(ledgerIds(`source_id='m3-skip'`)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
    expect(sql(`SELECT reason FROM "ScoutReconstructionLedger" WHERE source_id='m3-skip'`)).toBe(
      UNMAPPED_REASON,
    );
    // (d) Success dominates a later non-success attempt from either writer. The same staged
    // identity cannot genuinely flip from success to a skip (the registered mappers are total
    // and deterministic), so the later refusal is the accepted, explicitly labelled fixture
    // mapper of the shared worker; it applies to the whole family, so the genuinely skipped
    // sibling takes the product's other precedence rule — a non-success outcome is replaced by
    // the last serialized non-success writer (status and null target unchanged, reason theirs).
    const [[, , , status, targetBefore]] = identityRows('coach', 'intent', 'clients');
    expect(status).toBe('reconstructed');
    expect(typeof targetBefore).toBe('string');
    const tSkip = await run({ mapper: 'skip' }, true);
    expect(tSkip.failure).toBeUndefined();
    const nSkip = await run({ mapper: 'skip' });
    expect(nSkip.failure).toBeUndefined();
    expect(identityRows('coach', 'intent', 'clients')).toEqual([
      ['clients', 'm3', 'truecoach', 'reconstructed', targetBefore],
      skippedRow('m3-skip'),
    ]);
    expect(sql(`SELECT reason FROM "ScoutReconstructionLedger" WHERE source_id='m3-skip'`)).toBe(
      'fixture:mapper-skip',
    );
    expect(sql(`SELECT reason FROM "ScoutReconstructionLedger" WHERE source_id='m3'`)).toBe('');
    // (e) The other order: a non-success outcome committed FIRST (by T, then by N) is replaced
    // by a later success from the other writer; the target is minted by the successful pass.
    for (const [first, then] of [
      [true, false],
      [false, true],
    ]) {
      resetData();
      stage('m4', 'clients');
      const refused = await run({ mapper: 'skip' }, first);
      expect(refused.failure).toBeUndefined();
      expect(refused.result).toMatchObject({ staged: 1, reconstructed: 0, skipped: 1 });
      expect(identityRows('coach', 'intent', 'clients')).toEqual([
        ['clients', 'm4', 'truecoach', 'skipped', null],
      ]);
      expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('0');
      const succeeded = await run({}, then);
      expect(succeeded.failure).toBeUndefined();
      expect(succeeded.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0 });
      const [[, , , after, targetAfter]] = identityRows('coach', 'intent', 'clients');
      expect(after).toBe('reconstructed');
      expect(typeof targetAfter).toBe('string');
      expect(ledgerIds(`source_id='m4'`)).toHaveLength(1);
      expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1');
      expect(sql(`SELECT reason FROM "ScoutReconstructionLedger" WHERE source_id='m4'`)).toBe('');
    }
    console.warn(
      'PG17_N03_QUERIES',
      JSON.stringify({
        t_after_n: t1.queries.length,
        n_paused_then_t: [n2.queries.length, t2.queries.length],
        t_rollbacks_after_waiting: t2.queries.filter((q) => q === 'ROLLBACK').length,
        n_after_t: n3.queries.length,
      }),
    );
  });
  it('N04: a same-source, different-platform staged row against a committed ledger row is a 409 with nothing written — for N and for T', async () => {
    for (const [intent, old] of [
      ['n4', false],
      ['t4', true],
    ] as [string, boolean][]) {
      settle('coach', intent);
      sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id)
      VALUES (${quote(`${intent}-shared`)},'coach',${quote(intent)},'clients','shared','truecoach','reconstructed','saved-target')`);
      stage('shared', 'clients', 'auto:other.example', 'Synthetic X', 'coach', intent);
      const before = { ledger: records('coach', intent), targets: targets(), count: ledgerCount() };
      const attempt = await run({ intent }, old);
      expect(attempt.result).toBeUndefined();
      expect(attempt.failure).toMatchObject({
        status: 409,
        message: 'reconstruction provenance conflict',
      });
      expect(records('coach', intent)).toEqual(before.ledger);
      expect(targets()).toEqual(before.targets);
      expect(ledgerCount()).toBe(before.count);
      expect(nullCount()).toBe(0);
    }
  });
  it('N05 (negative control, release-order precondition): on the E+B shape (R down) the N client fails closed on a NULL-provenance row; nothing is written; R up restores the shape', async () => {
    const installed = { wide: wide(), narrow: narrow(), fence: fence() };
    settle('coach', 'n5');
    stage('n5', 'clients', 'truecoach', 'Synthetic N5', 'coach', 'n5');
    expect((await run({ intent: 'n5' })).result).toMatchObject({ reconstructed: 1 });
    const written = records('coach', 'n5');
    sqlFile(rDownFile);
    try {
      expect(wide()).toEqual({ indexes: [], checks: [], ledgerNotNull: false });
      expect(nullify(`intent_id='n5'`)).toBe(1);
      const before = { targets: targets(), count: ledgerCount() };
      // Q1 reader: a NULL provenance row cannot be decoded by the N client → 500, no page.
      const read = await run({ action: 'roster', intent: 'n5', limit: 5 });
      expect(read.result).toBeUndefined();
      expect(read.failure).toMatchObject({ status: 500, message: 'Internal server error' });
      // N writer replay against the NULL row: fails closed (500 on the missing wide key /
      // undecodable row, or 409 on the narrow key), never a fabricated outcome, nothing written.
      const write = await run({ intent: 'n5' });
      expect(write.result).toBeUndefined();
      expect([409, 500]).toContain(write.failure?.status);
      console.warn('PG17_N05_WRITER', JSON.stringify(write.failure));
      expect(targets()).toEqual(before.targets);
      expect(ledgerCount()).toBe(before.count);
      expect(nullCount()).toBe(1);
      // The accepted T writer still reclaims the NULL row on E+B (R proof, restated only as
      // the recovery path this fixture uses to make R's entry gate admissible again).
      const t = await run({ intent: 'n5' }, true);
      expect(t.failure).toBeUndefined();
      expect(nullCount()).toBe(0);
    } finally {
      if (nullCount() > 0)
        sql(`DELETE FROM "ScoutReconstructionLedger" WHERE source_platform IS NULL`);
      sqlFile(rUpFile);
    }
    expect(wide().indexes.map((i: any[]) => [i[0], i[2], i[3], i[4]])).toEqual(
      installed.wide.indexes.map((i: any[]) => [i[0], i[2], i[3], i[4]]),
    );
    expect(wide().ledgerNotNull).toBe(true);
    expect(narrow()).toEqual(installed.narrow);
    expect(fence()).toEqual(installed.fence);
    expect(records('coach', 'n5')).toEqual(written);
    expect(prismaMigrateDeploy(root)).toContain('No pending migrations');
  });
  it('N06: rollback N→T — after N writes, T replays identically and the T/Q0 readers enumerate the same union as N/Q1', async () => {
    for (const family of ['clients', 'workouts']) {
      const intent = `n6-${family}`;
      settle('coach', intent);
      // clients: every 4th of 12 rows under the unmapped canonical platform → floor(12/4)=3 skipped,
      // 9 reconstructed (see N02); workouts stays all-success (12/0). The readers page only
      // `reconstructed` rows, so the visible union is the success count on both heads.
      const skipEvery = family === 'clients' ? 4 : 0;
      const skipped = skippedOf(12, skipEvery);
      const success = 12 - skipped;
      stageMany(12, family, 'truecoach', 'coach', intent, skipEvery);
      const n = await run({ intent, family });
      expect(n.failure).toBeUndefined();
      expect(n.result).toEqual({
        intent_id: intent,
        staged: 12,
        reconstructed: success,
        skipped,
        failed: 0,
      });
      expect(
        sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE intent_id=${quote(intent)}
        AND status='skipped' AND source_platform=${quote(UNMAPPED_PLATFORM)} AND reason=${quote(UNMAPPED_REASON)}`),
      ).toBe(String(skipped));
      const rows = records('coach', intent, family);
      const t = await run({ intent, family }, true);
      expect(t.failure).toBeUndefined();
      expect(t.result).toEqual(n.result);
      expect(records('coach', intent, family)).toEqual(rows);
      const action = actionOf(family);
      const fromQ1 = await run({ action, family, intent, limit: 200 });
      const fromQ0 = await run({ action, family, intent, limit: 200 }, true);
      expect(fromQ1.failure).toBeUndefined();
      expect(fromQ0.failure).toBeUndefined();
      expect(ids(visible(family, fromQ1.result))).toHaveLength(success);
      expect(ids(visible(family, fromQ1.result))).toEqual(ids(visible(family, fromQ0.result)));
      expect(cursorOf(family, fromQ1.result)).toBeNull();
      expect(cursorOf(family, fromQ0.result)).toBeNull();
    }
  });
});

describe('stage 2: Q1 — scoped v2 emission, legacy resolution, ties, scope, erasure, bounds', () => {
  beforeEach(() => resetData());

  it.each(['clients', 'workouts'])(
    'Q01: every non-final %s page emits the exact scoped v2 token; every page orders by (source_id, source_platform) under REPEATABLE READ',
    async (family) => {
      for (const id of ['a', 'b', 'c']) stage(id, family);
      await run({ family });
      const targetIds = records('coach', 'intent', family).map((r: any) => r.target_id);
      const action = actionOf(family);
      const union: string[] = [];
      let after: string | undefined;
      for (const id of ['a', 'b', 'c']) {
        const page = await run({ action, family, cursor: after });
        expect(page.failure).toBeUndefined();
        union.push(...ids(visible(family, page.result)));
        const next = id === 'c' ? null : v2(family, id, 'truecoach');
        expect(cursorOf(family, page.result)).toBe(next);
        expect(page.queries.some((q) => q.includes('REPEATABLE READ'))).toBe(true);
        expect(page.queries.some((q) => LEDGER_ORDER.test(q))).toBe(true);
        expect(
          page.queries.some(
            (q) =>
              q.includes('ORDER BY') &&
              !LEDGER_ORDER.test(q) &&
              q.includes('"ScoutReconstructionLedger"'),
          ),
        ).toBe(false);
        after = next ?? undefined;
      }
      expect(union).toEqual(targetIds);
      // A first page (no cursor) orders identically and its token is decodable by the same rules.
      const first = await run({ action, family, limit: 2 });
      expect(ids(visible(family, first.result))).toEqual(targetIds.slice(0, 2));
      expect(cursorOf(family, first.result)).toBe(v2(family, 'b', 'truecoach'));
    },
  );

  it.each(['clients', 'workouts'])(
    'Q02: %s tokens chain Q1→Q0→Q1 and Q0→Q1→Q0 at limit 1 without repeating or skipping a row',
    async (family) => {
      for (const id of ['a', 'b', 'c', 'd']) stage(id, family);
      await run({ family });
      const targetIds = records('coach', 'intent', family).map((r: any) => r.target_id);
      const action = actionOf(family);
      // Q1 → Q0 → Q1 → Q1
      let page = await run({ action, family });
      expect(ids(visible(family, page.result))).toEqual([targetIds[0]]);
      expect(cursorOf(family, page.result)).toBe(v2(family, 'a', 'truecoach'));
      page = await run({ action, family, cursor: cursorOf(family, page.result) }, true);
      expect(page.failure).toBeUndefined();
      expect(ids(visible(family, page.result))).toEqual([targetIds[1]]);
      expect(cursorOf(family, page.result)).toBe(nextLegacy(family, 'b'));
      page = await run({ action, family, cursor: cursorOf(family, page.result) });
      expect(page.failure).toBeUndefined();
      expect(ids(visible(family, page.result))).toEqual([targetIds[2]]);
      expect(cursorOf(family, page.result)).toBe(v2(family, 'c', 'truecoach'));
      page = await run({ action, family, cursor: cursorOf(family, page.result) });
      expect(ids(visible(family, page.result))).toEqual([targetIds[3]]);
      expect(cursorOf(family, page.result)).toBeNull();
      // Q0 → Q1 → Q0 → Q0
      page = await run({ action, family }, true);
      expect(ids(visible(family, page.result))).toEqual([targetIds[0]]);
      expect(cursorOf(family, page.result)).toBe(nextLegacy(family, 'a'));
      page = await run({ action, family, cursor: cursorOf(family, page.result) });
      expect(page.failure).toBeUndefined();
      expect(ids(visible(family, page.result))).toEqual([targetIds[1]]);
      expect(cursorOf(family, page.result)).toBe(v2(family, 'b', 'truecoach'));
      page = await run({ action, family, cursor: cursorOf(family, page.result) }, true);
      expect(page.failure).toBeUndefined();
      expect(ids(visible(family, page.result))).toEqual([targetIds[2]]);
      page = await run({ action, family, cursor: cursorOf(family, page.result) }, true);
      expect(ids(visible(family, page.result))).toEqual([targetIds[3]]);
      expect(cursorOf(family, page.result)).toBeNull();
      // The whole enumeration from either reader is the same union.
      expect((await enumerate(family)).union).toEqual(targetIds);
      expect((await enumerate(family, undefined, true)).union).toEqual(targetIds);
    },
  );

  it.each(['clients', 'workouts'])(
    'Q03: a legacy %s token resolves to the same page as its v2 boundary inside the scope; forged or foreign resolves to 400 before any page read',
    async (family) => {
      for (const id of ['a', 'b', 'c']) stage(id, family);
      await run({ family });
      const targetIds = records('coach', 'intent', family).map((r: any) => r.target_id);
      const action = actionOf(family);
      const fromLegacy = await run({ action, family, cursor: nextLegacy(family, 'a'), limit: 5 });
      const fromV2 = await run({ action, family, cursor: v2(family, 'a', 'truecoach'), limit: 5 });
      expect(fromLegacy.failure).toBeUndefined();
      expect(fromLegacy.result).toEqual(fromV2.result);
      expect(ids(visible(family, fromLegacy.result))).toEqual(targetIds.slice(1));
      // Resolution ran inside the snapshot as a scoped, bounded ledger lookup selecting only the
      // platform, before the page read.
      const resolveAt = fromLegacy.queries.findIndex(
        (q) =>
          q.includes('"ScoutReconstructionLedger"') &&
          q.includes('"source_platform"') &&
          !q.includes('"target_id"') &&
          /"source_id" = \$\d+/.test(q) &&
          /"entity_type" = \$\d+/.test(q) &&
          /"status" = \$\d+/.test(q),
      );
      const pageAt = fromLegacy.queries.findIndex(
        (q) => q.includes('"ScoutReconstructionLedger"') && q.includes('"target_id"'),
      );
      expect(resolveAt).toBeGreaterThanOrEqual(0);
      expect(pageAt).toBeGreaterThan(resolveAt);
      expect(
        fromLegacy.queries.slice(0, resolveAt).some((q) => q.includes('REPEATABLE READ')),
      ).toBe(true);
      // Forged (no such row), foreign (another intent's row), non-reconstructed (a skipped row):
      // 400 `malformed cursor`, no page or count query issued.
      settle('coach', 'other');
      stage('z', family, 'truecoach', 'Synthetic Z', 'coach', 'other');
      await run({ family, intent: 'other' });
      stage('k', family);
      await run({ family, mapper: 'skip' });
      expect(ledgerIds(`source_id='k' AND status='skipped'`)).toHaveLength(1);
      for (const s of ['forged', 'z', 'k']) {
        const refused = await run({ action, family, cursor: nextLegacy(family, s) });
        expect(refused.result).toBeUndefined();
        expect(refused.failure).toEqual(MALFORMED);
        expect(readPage(refused.queries)).toBe(false);
      }
      // A resolved legacy token restarts nothing: the Q1 page it yields carries a v2 token onward.
      const onward = await run({ action, family, cursor: nextLegacy(family, 'a') });
      expect(cursorOf(family, onward.result)).toBe(v2(family, 'b', 'truecoach'));
    },
  );

  it.each(['clients', 'workouts'])(
    'Q04: identity ties (same source_id, several platforms) enumerate every %s row exactly once at limit 1; Q0 accepts the v2 tokens; a tied legacy token is 400',
    async (family) => {
      for (const id of ['a', 'b', 'c', 'd']) stage(id, family);
      await run({ family });
      const original = records('coach', 'intent', family);
      const definition = sql(`SELECT pg_get_indexdef('public.${ledgerKey}'::regclass)`);
      const action = actionOf(family);
      // The retained narrow key forbids the tie on this shape; it is dropped ONLY inside this
      // case and restored in finally. Nothing about the narrow key's fate (C) is claimed.
      sql(`DROP INDEX public.${ledgerKey};
      UPDATE "ScoutReconstructionLedger" SET source_id='a',source_platform=CASE source_id
        WHEN 'a' THEN 'p1' WHEN 'b' THEN 'p2' ELSE 'p3' END WHERE source_id<>'d'`);
      try {
        expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_id='a'`)).toBe(
          '3',
        );
        const { union, tokens } = await enumerate(family);
        expect(union).toEqual(original.map((r: any) => r.target_id));
        expect(tokens).toEqual([
          v2(family, 'a', 'p1'),
          v2(family, 'a', 'p2'),
          v2(family, 'a', 'p3'),
          null,
        ]);
        // Q0 fed Q1's exact v2 tokens pages the same rows.
        const q0 = await run({ action, family, cursor: v2(family, 'a', 'p2') }, true);
        expect(q0.failure).toBeUndefined();
        expect(ids(visible(family, q0.result))).toEqual([original[2].target_id]);
        // The legacy format cannot name a tied boundary: 400, no page read, restart from the top.
        const tied = await run({ action, family, cursor: nextLegacy(family, 'a') });
        expect(tied.failure).toEqual(MALFORMED);
        expect(readPage(tied.queries)).toBe(false);
        // A legacy token for the untied row still resolves.
        const untied = await run({ action, family, cursor: nextLegacy(family, 'd') });
        expect(untied.failure).toBeUndefined();
        expect(visible(family, untied.result)).toEqual([]);
      } finally {
        sql(`DELETE FROM "ScoutReconstructionLedger"; ${definition}`);
      }
      expect(narrow()).toHaveLength(2);
    },
  );

  it.each(['clients', 'workouts'])(
    'Q05: a %s token outside its (coach, intent, family) scope, or on the other endpoint, is 400 with no page read; a token-less foreign coach is 404',
    async (family) => {
      for (const id of ['a', 'b']) stage(id, family);
      await run({ family });
      const action = actionOf(family);
      const otherFamily = family === 'clients' ? 'workouts' : 'clients';
      // A scope-bound token's own (c, i, f) must equal the request scope (brief: foreign coach or
      // intent → 400 `malformed cursor`; decodeScoutCursor runs before the settled-intent gate,
      // the same order as the accepted R reader). Both directions are refused identically: a
      // token for another scope presented here, and this scope's token presented by a foreign
      // coach or for a foreign intent. Every v2 token and the legacy entities token are
      // scope-bound; the legacy roster token is a bare source id and carries no scope (below).
      const foreign: Record<string, unknown>[] = [
        { cursor: v2(otherFamily, 'a') },
        { cursor: v2(family, 'a', 'truecoach', 'other') },
        { cursor: v2(family, 'a', 'truecoach', 'coach', 'other') },
        { cursor: nextLegacy(otherFamily, 'a') },
        { cursor: v2(family, 'a', 'TrueCoach') },
        { cursor: v2(family, 'a'), coach: 'foreign' },
        { cursor: v2(family, 'a'), intent: 'foreign' },
        ...(family === 'clients'
          ? []
          : [
              { cursor: nextLegacy(family, 'a'), coach: 'foreign' },
              { cursor: nextLegacy(family, 'a'), intent: 'foreign' },
            ]),
      ];
      for (const request of foreign) {
        const refused = await run({ action, family, ...request });
        expect(refused.result).toBeUndefined();
        expect(refused.failure).toEqual(MALFORMED);
        expect(readPage(refused.queries)).toBe(false);
        // No reflection: the rejection carries neither the token nor its decoded fields.
        expect(JSON.stringify(refused.failure)).not.toContain(String(request.cursor));
        expect(JSON.stringify(refused.failure)).not.toContain('foreign');
      }
      // Without a scope in hand (no token, or the scope-less legacy roster token) nothing can
      // mismatch at decode: the settled-intent gate is the uniform 404 (no existence oracle) for
      // a foreign coach and for a foreign intent, and no page is read.
      const gated: Record<string, unknown>[] = [
        { coach: 'foreign' },
        { intent: 'foreign' },
        ...(family === 'clients'
          ? [
              { cursor: nextLegacy(family, 'a'), coach: 'foreign' },
              { cursor: nextLegacy(family, 'a'), intent: 'foreign' },
            ]
          : []),
      ];
      for (const request of gated) {
        const refused = await run({ action, family, ...request });
        expect(refused.result).toBeUndefined();
        expect(refused.failure?.status).toBe(404);
        expect(readPage(refused.queries)).toBe(false);
      }
      const valid = await run({ action, family, cursor: v2(family, 'a') });
      expect(ids(visible(family, valid.result))).toHaveLength(1);
    },
  );

  it.each(['clients', 'workouts'])(
    'Q06: erased or re-scoped %s targets stay hidden while the cursor still advances to a final null',
    async (family) => {
      for (const id of ['a', 'b', 'c']) stage(id, family);
      await run({ family });
      const targetIds = records('coach', 'intent', family).map((r: any) => r.target_id);
      const action = actionOf(family);
      const table = family === 'clients' ? 'Person' : 'ScoutReconstructedEntity';
      sql(`UPDATE "${table}" SET coach_id='foreign' WHERE id=${quote(targetIds[1])};
      DELETE FROM "${table}" WHERE id=${quote(targetIds[2])}`);
      const hidden = await run({ action, family, cursor: v2(family, 'a'), limit: 1 });
      expect(visible(family, hidden.result)).toEqual([]);
      expect(cursorOf(family, hidden.result)).toBe(v2(family, 'b', 'truecoach'));
      const final = await run({
        action,
        family,
        cursor: cursorOf(family, hidden.result),
        limit: 1,
      });
      expect(visible(family, final.result)).toEqual([]);
      expect(cursorOf(family, final.result)).toBeNull();
      if (family === 'clients') {
        sql(`UPDATE "Person" SET state='Deleted' WHERE id=${quote(targetIds[0])}`);
      } else {
        sql(
          `UPDATE "ScoutReconstructedEntity" SET entity_type='client_history' WHERE id=${quote(targetIds[0])}`,
        );
      }
      const all = await run({ action, family, limit: 200 });
      expect(visible(family, all.result)).toEqual([]);
      expect(cursorOf(family, all.result)).toBeNull();
      // The ledger still accounts for all three: erasure hides targets, never history.
      expect(ledgerCount()).toBe(3);
    },
  );

  it.each(['clients', 'workouts'])(
    'Q07: %s tokens are bounded at 8,192 characters for Q1 and Q0; every malformed shape is a 400 without reflection',
    async (family) => {
      stage('a', family);
      await run({ family });
      const action = actionOf(family);
      const long = 'x'.repeat(256);
      const longV2 = v2(family, long, 'p'.repeat(256), 'coach', 'intent');
      expect(longV2.length).toBeLessThanOrEqual(8192);
      for (const old of [false, true]) {
        const accepted = await run({ action, family, cursor: longV2 }, old);
        expect(accepted.failure).toBeUndefined();
        expect(visible(family, accepted.result)).toEqual([]);
        expect(cursorOf(family, accepted.result)).toBeNull();
      }
      const maximal = `v2.${encoded(
        JSON.stringify({
          v: 2,
          c: 'c'.repeat(256),
          i: 'i'.repeat(256),
          f: family,
          o: 'source_id:asc,source_platform:asc',
          s: long,
          p: 'p'.repeat(256),
        }),
      )}`;
      expect(maximal.length).toBeLessThanOrEqual(8192);
      expect((await run({ action, family, cursor: maximal })).failure).toEqual(MALFORMED);
      const envelope = (patch: Record<string, unknown>) =>
        'v2.' +
        encoded(
          JSON.stringify({
            v: 2,
            c: 'coach',
            i: 'intent',
            f: family,
            o: 'source_id:asc,source_platform:asc',
            s: 'a',
            p: 'truecoach',
            ...patch,
          }),
        );
      // Shapes the accepted Q0 proof already refuses (Q0 is exercised on exactly those); Q1 must
      // refuse them and every additional shape below identically, without a page read.
      const shared = [
        `${v2(family, 'a', 'truecoach')}x`.padEnd(8193, 'A'),
        envelope({ p: 'TrueCoach' }),
        envelope({ p: undefined }),
        envelope({ o: 'source_id:asc' }),
        envelope({ v: 1 }),
        envelope({ i: 'other' }),
      ];
      const q1Only = [
        'A'.repeat(8193),
        envelope({ s: '' }),
        envelope({ s: 'a\u0000' }),
        envelope({ c: 'other' }),
        envelope({ f: family === 'clients' ? 'workouts' : 'clients' }),
        'v2.' + encoded('"a"'),
        'v2.' + encoded('[]'),
        'v2.!!!',
        'v2.',
        family === 'clients' ? encoded('a\u0000') : encoded('{"c":"coach"}'),
        encoded(
          JSON.stringify({ c: 'coach', i: 'intent', f: family, o: 'source_id:asc', s: 'a' }),
        ) + '=',
      ];
      for (const cursor of [...shared, ...q1Only]) {
        for (const old of shared.includes(cursor) ? [false, true] : [false]) {
          const refused = await run({ action, family, cursor }, old);
          expect(refused.result).toBeUndefined();
          expect(refused.failure).toEqual(MALFORMED);
          expect(JSON.stringify(refused.failure)).not.toContain(cursor.slice(0, 64));
          if (!old) expect(readPage(refused.queries)).toBe(false);
        }
      }
      const valid = await run({ action, family, cursor: v2(family, 'a', 'truecoach') });
      expect(valid.failure).toBeUndefined();
      expect(visible(family, valid.result)).toEqual([]);
    },
  );
});
