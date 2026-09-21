// S5 G2 E → T/Q0 proof on the isolated PostgreSQL 17.6 lane (S1-provisioned,
// synthetic data only). Ordered stages in ONE file, run with --runInBand:
//   1. server/history identity;  2. E on a populated narrow base incl. O
//   writers/readers, RLS, down/up;  3. E recorded through `prisma migrate
//   deploy`;  4. T/Q0 writer/reader/cursor/accounting/concurrency proof;
//   5. rollout recovery (down refusal after claim, drained down, O on narrow,
//   re-apply, T reclaim). Later B/drain → R → N/Q1 → C stages are NOT claimed.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  allLedger, appliedMigrations, blocked, catalog, directory, down, encoded, expectedVersion, gitShow,
  hasColumn, holdAdvisory, holdTransaction, json, legacy, legacyEntityCursor, oldClient, oldRoot, OLD_HEAD, prisma, prismaMigrateDeploy,
  quote, records, refused, resetData, root, run, settle, sql, sqlAdmin, sqlFile, stage, stageMany, target, targets, up, upFile, v2, worker,
} from './utils/g2-pg17-harness';
import { G2_PG17_CLUSTER_MARKER, G2_PG17_DATABASE_MARKER } from './utils/g2-pg17-db';

jest.setTimeout(180000);
const E = '20270118000000_scout_ledger_platform_expand';
const ledgerKey = '"ScoutReconstructionLedger_coach_id_intent_id_entity_type_source"';
const ids = (rows: any[]) => rows.map((r) => r.id);
const last = <T,>(items: T[]) => items[items.length - 1];
const visible = (family: string, r: any) => (family === 'clients' ? r.persons : r.entities);
const cursorOf = (family: string, r: any) => (family === 'clients' ? r.page.next_cursor : r.next_cursor);
const actionOf = (family: string) => (family === 'clients' ? 'roster' : 'entities');
const nextLegacy = (family: string, s: string) => (family === 'clients' ? encoded(s) : legacyEntityCursor(family, s));

beforeAll(() => {
  // data_directory is readable only by pg_read_all_settings/superuser: observed via the admin connection.
  const identity = json(`SELECT jsonb_build_object('database',current_database(),'address',inet_server_addr(),
    'port',inet_server_port(),'directory',${quote(sqlAdmin(`SELECT current_setting('data_directory')`))},
    'version',current_setting('server_version_num'),'user',current_user,'super',
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassrls',
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),'owner',
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))`);
  // Every DDL/data statement of this proof runs as the NON-superuser, BYPASSRLS, owning
  // `postgres` role (Supabase shape); the cluster superuser only observes lock waits.
  // The port is whatever the operator double-confirmed through the guarded target (S1 chooses it).
  expect(identity).toMatchObject({ database: 'g2_s5_etq0_disposable', address: '127.0.0.1', port: target.port,
    directory, user: 'postgres', super: false, bypassrls: true, owner: 'postgres' });
  expect(sql(`SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'postgres'`)).toBe('0');
  expect(Number(identity.version)).toBe(expectedVersion);
  expect(Number(identity.version)).toBeGreaterThanOrEqual(170000);
  expect(Number(identity.version)).toBeLessThan(180000);
  expect(directory).toMatch(/\/pg17\/clusters\/s5$/);
  // Distinctive S5 fixture markers (pinned literals, not environment): the lane's cluster_name and
  // the disposable database's comment stamped by bootstrap. Proves the run used the marked fixture.
  expect(sql(`SELECT current_setting('cluster_name')`)).toBe(G2_PG17_CLUSTER_MARKER);
  expect(sql(`SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`))
    .toBe(G2_PG17_DATABASE_MARKER);
  console.warn('PG17_DATABASE', JSON.stringify(identity));
  // Bootstrap leaves the full 164-migration O history and NO E column/history.
  expect(appliedMigrations()).toBe('164');
  expect(sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(E)}`)).toBe('0');
  expect(hasColumn()).toBe('0');
  expect(readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8'))
    .not.toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform/);
  expect(readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8'))
    .toMatch(/model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/);
  // Actual O service source, byte-identical to the preserved head, in the old root.
  for (const file of ['scout-reconstruct.service.ts', 'scout-roster.service.ts', 'scout-entities.service.ts']) {
    expect(readFileSync(resolve(oldRoot!, 'src/scout', file), 'utf8')).toBe(gitShow(`${OLD_HEAD}:src/scout/${file}`));
  }
  expect(sql(`SELECT rolbypassrls||':'||rolcanlogin FROM pg_roles WHERE rolname='service_role'`)).toBe('true:true');
  expect(sql(`SELECT string_agg(rolsuper::text||':'||rolbypassrls::text,',' ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('anon','authenticated')`)).toBe('false:false,false:false');
  // Table privileges are granted (owner statement) so that the RLS stage proves POLICY denial,
  // not missing GRANTs; the fixture's Supabase-like default privileges are recorded, not relied on.
  sql(`GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
    GRANT ALL ON public."ScoutIngestEntity",public."ScoutReconstructionLedger",
      public."Person",public."ScoutReconstructedEntity",public."ScoutImport" TO service_role,anon,authenticated;`);
  console.warn('PG17_API_ROLE_TABLE_PRIVILEGES', sql(`SELECT string_agg(table_name||'='||privileges,' ' ORDER BY table_name) FROM (
    SELECT table_name, string_agg(privilege_type,',' ORDER BY privilege_type) privileges
    FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public'
    AND table_name IN ('ScoutIngestEntity','ScoutReconstructionLedger','Person','ScoutReconstructedEntity') GROUP BY 1) g`));
  sql(`ALTER TABLE "Person" ADD CONSTRAINT g2p_target_refusal CHECK (display_name IS DISTINCT FROM 'FAIL');
    ALTER TABLE "ScoutReconstructedEntity" ADD CONSTRAINT g2p_entity_refusal CHECK (label IS DISTINCT FROM 'FAIL');`);
  resetData();
});
afterAll(() => {
  sql(`ALTER TABLE "Person" DROP CONSTRAINT IF EXISTS g2p_target_refusal;
    ALTER TABLE "ScoutReconstructedEntity" DROP CONSTRAINT IF EXISTS g2p_entity_refusal;`);
  resetData();
  sql('DELETE FROM "ScoutImport"');
});

describe('stage 1: E on a populated narrow base with the actual O binary', () => {
  const coaches = ['coach', 'c2', 'c3', 'c4'];
  const families = ['clients', 'workouts', 'client_history'];
  let before: any[];
  let beforeCatalog: string;
  let oPages: Record<string, any[]>;
  const readAll = async (family: string) => {
    const pages: any[] = [];
    let after: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = (await run({ action: actionOf(family), family, cursor: after, limit: 7 }, true)).result;
      pages.push(page);
      const next = cursorOf(family, page);
      if (!next) break;
      after = next;
    }
    return pages;
  };

  it('populates synthetic legacy history without a provenance column and O reconstructs 600 staged rows', async () => {
    // 4 coaches × 2 intents × 3 families × 25 sources = 600 narrow legacy rows,
    // written by SQL exactly as an O deployment would have left them.
    for (const coach of coaches) for (const intent of ['intent', 'i2']) {
      settle(coach, intent);
      sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,status,target_id,reason)
        SELECT ${quote(coach)}||'-'||${quote(intent)}||'-'||f||'-'||lpad(n::text,5,'0'),${quote(coach)},${quote(intent)},f,
          'h'||lpad(n::text,5,'0'),CASE n % 3 WHEN 0 THEN 'skipped' WHEN 1 THEN 'failed' ELSE 'reconstructed' END,
          'legacy-target','legacy-reason'
        FROM generate_series(1,25) n, unnest(ARRAY['clients','workouts','client_history']) f`);
    }
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger"')).toBe('600');
    // Same source_id across all three families in one intent is legitimate narrow history.
    expect(sql(`SELECT count(DISTINCT entity_type) FROM "ScoutReconstructionLedger"
      WHERE coach_id='coach' AND intent_id='intent' AND source_id='h00001'`)).toBe('3');
    // O writer on the narrow base: 600 staged clients over two pages, every 50th refused by the target.
    stageMany(600, 'clients', 'truecoach', 'coach', 'intent', 50);
    const o = await run({}, true);
    expect(o.failure).toBeUndefined();
    // OBSERVED (PG17 populated base): the writer's summary is the ledger tally for the whole
    // coach/intent/family (ScoutReconstructService.tally groupBy status), so it INCLUDES the 25
    // pre-existing legacy rows (8 reconstructed / 8 skipped / 9 failed), not just this batch.
    expect(o.result).toEqual({ intent_id: 'intent', staged: 600, reconstructed: 588 + 8, skipped: 8, failed: 12 + 9 });
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE coach_id='coach' AND intent_id='intent'
      AND entity_type='clients' AND source_id LIKE 's%' GROUP BY status ORDER BY status`)).toBe('12\n588');
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('588');
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger"')).toBe('1200');
    oPages = { clients: await readAll('clients') };
    // Hidden legacy 'h*' rows (no Person) precede 's*' rows; page shapes are still deterministic.
    expect(oPages.clients.length).toBe(10);
    const union = new Set<string>();
    let after: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = (await run({ action: 'roster', cursor: after, limit: 200 }, true)).result;
      ids(page.persons).forEach((id: string) => union.add(id));
      if (!page.page.next_cursor) break;
      after = page.page.next_cursor;
    }
    expect(union.size).toBe(588);
    before = allLedger();
    beforeCatalog = catalog();
  });

  it('applies E: rows, OIDs, keys, RLS and policies preserved; column nullable without default', () => {
    sql(up);
    expect(hasColumn()).toBe('1');
    expect(allLedger().map((r: any) => { const { source_platform, ...rest } = r; return rest; })).toEqual(before);
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NOT NULL')).toBe('0');
    expect(catalog()).toBe(beforeCatalog);
    expect(sql(`SELECT is_nullable||':'||data_type||':'||COALESCE(column_default,'NONE')
      FROM information_schema.columns WHERE table_schema='public' AND table_name='ScoutReconstructionLedger'
      AND column_name='source_platform'`)).toBe('YES:text:NONE');
    expect(sql(`SELECT count(*) FROM pg_index WHERE indexrelid IN (
      'public."ScoutIngestEntity_coach_id_intent_id_source_id_key"'::regclass,
      'public.${ledgerKey}'::regclass) AND indisunique AND indisvalid`)).toBe('2');
    refused(up, 'G2-E platform column already exists');
    expect(catalog()).toBe(beforeCatalog);
  });

  it('keeps the actual O writer and readers working on E, creating NULL provenance', async () => {
    stageMany(30, 'workouts', 'truecoach', 'coach', 'intent', 0, 'w');
    const o = await run({ family: 'workouts' }, true);
    // Tally again includes the 25 legacy workouts rows for this coach/intent (8/8/9).
    expect(o.result).toEqual({ intent_id: 'intent', staged: 30, reconstructed: 30 + 8, skipped: 8, failed: 9 });
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE entity_type='workouts'
      AND source_id LIKE 'w%' AND source_platform IS NULL`)).toBe('30');
    expect(o.queries.filter((q) => q.startsWith('INSERT INTO "public"."ScoutReconstructionLedger"'))
      .every((q) => !q.includes('source_platform'))).toBe(true);
    // O replay on E is still idempotent and its page enumeration is byte-identical to pre-E.
    expect((await run({}, true)).result).toEqual({ intent_id: 'intent', staged: 600, reconstructed: 596, skipped: 8, failed: 21 });
    // OBSERVED: the O replay re-persists every target and bumps Person.updated_at; ids, order,
    // cursors and every other field of the enumeration are byte-identical to the pre-E pages.
    const replayPages = await readAll('clients');
    const stable = (pages: any[]) => pages.map((p) => ({ ...p, persons: p.persons.map(({ updated_at, ...rest }: any) => rest) }));
    expect(stable(replayPages)).toEqual(stable(oPages.clients));
    expect(replayPages.map((p) => p.page.next_cursor)).toEqual(oPages.clients.map((p: any) => p.page.next_cursor));
    const workoutPages = await readAll('workouts');
    expect(workoutPages.flatMap((p) => ids(p.entities))).toHaveLength(30);
    expect(last(workoutPages).next_cursor).toBeNull();
  });

  it('retains forced RLS denial for anon/authenticated on every touched table, even with a hostile claim', () => {
    const claims = `SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"service_role"}',false);`;
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['ScoutReconstructionLedger', 'ScoutIngestEntity', 'Person', 'ScoutReconstructedEntity']) {
        expect(last(sql(`SET ROLE ${role}; ${claims} SELECT count(*) FROM public."${table}"`).split('\n'))).toBe('0');
        expect(last(sql(`SET ROLE ${role}; WITH changed AS (UPDATE public."${table}" SET coach_id='stolen' RETURNING id)
          SELECT count(*) FROM changed`).split('\n'))).toBe('0');
        expect(last(sql(`SET ROLE ${role}; WITH changed AS (DELETE FROM public."${table}" RETURNING id)
          SELECT count(*) FROM changed`).split('\n'))).toBe('0');
      }
      refused(`SET ROLE ${role}; INSERT INTO public."ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
        VALUES ('bad','coach','intent','clients','bad','truecoach','skipped')`, 'row-level security');
      refused(`SET ROLE ${role}; INSERT INTO public."ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
        VALUES ('bad','coach','intent','clients','bad','truecoach','{}')`, 'row-level security');
    }
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger"')).toBe('1230');
    expect(last(sql(`SET ROLE service_role; SELECT count(*) FROM public."ScoutReconstructionLedger"`).split('\n'))).toBe('1230');
  });

  it.each(['up', 'down'])('refuses a wrong public index owner in %s on the populated base', (direction) => {
    if (direction === 'up') { sql(down); expect(hasColumn()).toBe('0'); }
    const before = catalog();
    sql(`ALTER INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key" RENAME TO g2p_saved_key;
      CREATE TABLE public.g2p_decoy (id TEXT);
      CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key" ON public.g2p_decoy(id)`);
    try {
      refused(direction === 'up' ? up : down, 'G2-E unexpected identity prerequisite');
      expect(hasColumn()).toBe(direction === 'up' ? '0' : '1');
      expect(sql('SELECT count(*) FROM public.g2p_decoy')).toBe('0');
      expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger"')).toBe('1230');
    } finally {
      sql(`DROP TABLE public.g2p_decoy;
        ALTER INDEX public.g2p_saved_key RENAME TO "ScoutIngestEntity_coach_id_intent_id_source_id_key"`);
      if (direction === 'up') sql(up);
    }
    expect(hasColumn()).toBe('1');
    expect(catalog()).toBe(before);
  });

  it('schema-qualifies both directions despite search_path decoys, leaving 1230 populated rows intact', () => {
    const rows = allLedger();
    sql(`CREATE SCHEMA g2p_shadow;
      CREATE TABLE g2p_shadow."ScoutReconstructionLedger" (source_platform TEXT);
      INSERT INTO g2p_shadow."ScoutReconstructionLedger" VALUES ('untouched')`);
    try {
      sql(`SET search_path=g2p_shadow,public;\n${down}`);
      expect(hasColumn()).toBe('0');
      sql(`SET search_path=g2p_shadow,public;\n${up}`);
      expect(hasColumn()).toBe('1');
      expect(sql(`SELECT source_platform FROM g2p_shadow."ScoutReconstructionLedger"`)).toBe('untouched');
      expect(allLedger()).toEqual(rows);
    } finally {
      sql('DROP SCHEMA g2p_shadow CASCADE');
    }
  });

  it.each([true, false])('forced-RLS non-bypass owning role cannot drop hidden provenance (populated=%s)', (populated) => {
    // down.sql relies on SET LOCAL row_security=off; a NOBYPASSRLS owner must be refused, not silently see 0 rows.
    if (populated) sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='truecoach' WHERE coach_id='c4' AND source_id='h00001' AND entity_type='clients'`);
    // ALTER TABLE ... OWNER TO requires the new owner to hold CREATE on the schema (PostgreSQL rule).
    sql(`CREATE ROLE g2p_ledger_owner NOLOGIN NOBYPASSRLS; GRANT g2p_ledger_owner TO postgres;
      GRANT USAGE, CREATE ON SCHEMA public TO g2p_ledger_owner;
      ALTER TABLE public."ScoutIngestEntity" OWNER TO g2p_ledger_owner;
      ALTER TABLE public."ScoutReconstructionLedger" OWNER TO g2p_ledger_owner`);
    // c4/h00001/clients exists once per intent (two intents), so a populated run hides 2 claims.
    const claimed = sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NOT NULL`);
    expect(claimed).toBe(populated ? '2' : '0');
    try {
      expect(sql(`SELECT rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname='g2p_ledger_owner'`)).toBe('false:false');
      // psql -q suppresses the SET tag; forced RLS hides every row from the non-bypass owner.
      expect(sql(`SET ROLE g2p_ledger_owner; SELECT count(*) FROM public."ScoutReconstructionLedger"`)).toBe('0');
      refused(`SET ROLE g2p_ledger_owner;\n${down}`, 'row-level security');
      expect(hasColumn()).toBe('1');
      expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NOT NULL`)).toBe(claimed);
    } finally {
      sql(`ALTER TABLE public."ScoutIngestEntity" OWNER TO postgres;
        ALTER TABLE public."ScoutReconstructionLedger" OWNER TO postgres;
        DROP OWNED BY g2p_ledger_owner; DROP ROLE g2p_ledger_owner;
        UPDATE "ScoutReconstructionLedger" SET source_platform=NULL`);
    }
  });

  it('rolls E back only while every provenance is NULL, preserving rows, then re-applies', () => {
    const rows = allLedger().map((r: any) => { const { source_platform, ...rest } = r; return rest; });
    sql(down);
    expect(hasColumn()).toBe('0');
    expect(allLedger()).toEqual(rows);
    expect(catalog()).toBe(beforeCatalog);
    refused(down, 'G2-E unexpected platform column prerequisite');
    sql(up);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='truecoach' WHERE coach_id='c4' AND source_id='h00001' AND entity_type='clients'`);
    refused(down, 'G2-E refuses removal of assigned provenance');
    expect(hasColumn()).toBe('1');
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL`);
    sql(down);
    expect(hasColumn()).toBe('0');
    expect(appliedMigrations()).toBe('164');
  });
});

describe('stage 2: E recorded through the real release mechanism', () => {
  it('prisma migrate deploy applies exactly E on the populated database and records history', () => {
    const output = prismaMigrateDeploy(root);
    expect(output).toContain(E);
    expect(appliedMigrations()).toBe('165');
    expect(hasColumn()).toBe('1');
    expect(sql(`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=${quote(E)}
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)).toBe('1');
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger"')).toBe('1230');
    expect(sql('SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NOT NULL')).toBe('0');
    // A second deploy is a no-op: the release script may run it on every deploy.
    expect(prismaMigrateDeploy(root)).toMatch(/No pending migrations/);
    expect(appliedMigrations()).toBe('165');
  });
});

describe('stage 3: T provenance, atomicity, accounting and collisions on PostgreSQL 17', () => {
  beforeEach(() => resetData());

  it('claims historical NULL history at volume with honest multi-page accounting and identical replay', async () => {
    // 1,050 staged rows > 2 reconstruct pages of 500; every 100th target refused; NULL legacy on 1..300.
    stageMany(1050, 'clients', 'truecoach', 'coach', 'intent', 100);
    sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,status,reason)
      SELECT 'legacy-'||n,'coach','intent','clients','s'||lpad(n::text,5,'0'),'failed','legacy' FROM generate_series(1,300) n`);
    const first = await run();
    expect(first.failure).toBeUndefined();
    expect(first.result).toEqual({ intent_id: 'intent', staged: 1050, reconstructed: 1040, skipped: 0, failed: 10 });
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='truecoach'`)).toBe('1050');
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NULL`)).toBe('0');
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE id LIKE 'legacy-%' AND status='reconstructed'`)).toBe('297');
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE id LIKE 'legacy-%' AND status='failed'`)).toBe('3');
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1040');
    const replay = await run();
    expect(replay.result).toEqual(first.result);
    expect(sql(`SELECT count(*) FROM "Person" WHERE coach_id='coach'`)).toBe('1040');
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger"`)).toBe('1050');
    expect(first.queries.filter((q) => q === 'ROLLBACK').length).toBeGreaterThanOrEqual(10);
  });

  it('claims only the exact coach/intent/family identity and leaves adjacent tenants untouched', async () => {
    stage();
    legacy('failed');
    settle('other', 'intent'); settle('coach', 'other');
    legacy('reconstructed', 'different', 'a', 'clients', 'other', 'intent');
    legacy('reconstructed', 'different', 'a', 'clients', 'coach', 'other');
    legacy('reconstructed', 'different', 'a', 'workouts', 'coach', 'intent');
    const adjacent = () => allLedger().filter((r: any) => !(r.coach_id === 'coach' && r.intent_id === 'intent' && r.entity_type === 'clients'));
    const before = adjacent();
    expect((await run()).result).toEqual({ intent_id: 'intent', staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(adjacent()).toEqual(before);
    expect(records()[0]).toMatchObject({ status: 'reconstructed', source_platform: 'truecoach' });
    const denied = await run({ coach: 'other' });
    expect(denied.result).toEqual({ intent_id: 'intent', staged: 0, reconstructed: 1, skipped: 0, failed: 0 });
    expect(adjacent()).toEqual(before);
  });

  it('creates every outcome with actual provenance, isolates failures and replays honestly', async () => {
    stage('a'); stage('b', 'clients', 'auto:coachrx.example.com');
    stage('c', 'clients', 'truecoach', 'FAIL'); stage('d');
    const first = await run();
    expect(first.failure).toBeUndefined();
    expect(first.result).toEqual({ intent_id: 'intent', staged: 4, reconstructed: 2, skipped: 1, failed: 1 });
    expect(records().map((r: any) => [r.source_id, r.status, r.source_platform])).toEqual([
      ['a', 'reconstructed', 'truecoach'], ['b', 'skipped', 'auto:coachrx.example.com'],
      ['c', 'failed', 'truecoach'], ['d', 'reconstructed', 'truecoach'],
    ]);
    expect((await run()).result).toEqual(first.result);
    expect(sql('SELECT count(*) FROM "Person"')).toBe('2');
    expect(first.queries.some((q) => q === 'ROLLBACK')).toBe(true);
    expect(first.queries.some((q) => q.includes('source_platform" IS NULL'))).toBe(true);
  });

  it.each(['reconstructed', 'skipped', 'failed'])('claims historical NULL on %s attempts', async (status) => {
    stage('a', 'clients', 'truecoach', status === 'failed' ? 'FAIL' : 'Synthetic');
    legacy('failed');
    const response = await run(status === 'skipped' ? { mapper: 'skip' } : {});
    expect(response.failure).toBeUndefined();
    expect(records()[0]).toMatchObject({ source_platform: 'truecoach', status });
  });

  it.each(['clients', 'workouts'])('rolls back new and pre-existing %s target changes on late mismatch', async (family) => {
    stage('a', family);
    legacy('skipped', 'different', 'a', family);
    const ledgerBefore = records();
    const emptyTargets = targets();
    expect((await run({ family })).failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
    expect(records()).toEqual(ledgerBefore);
    expect(targets()).toEqual(emptyTargets);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL`);
    expect((await run({ family })).failure).toBeUndefined();
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='different';
      UPDATE "ScoutIngestEntity" SET payload='{"name":"Changed name","client_id":"changed-link"}'`);
    const before = targets();
    const previous = records();
    const result = await run({ family });
    expect(result.failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
    expect(result.queries.some((q) => q === 'ROLLBACK')).toBe(true);
    expect(targets()).toEqual(before);
    expect(records()).toEqual(previous);
  });

  it('fail-stops mid-batch on a legacy provenance contradiction, keeping earlier committed rows and honest durable counts', async () => {
    for (const id of ['a', 'b', 'c', 'd']) stage(id);
    legacy('failed', 'different', 'c');
    const stopped = await run();
    expect(stopped.failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
    expect(stopped.result).toBeUndefined();
    expect(stopped.events).toEqual([]);
    expect(records().map((r: any) => [r.source_id, r.status, r.source_platform])).toEqual([
      ['a', 'reconstructed', 'truecoach'], ['b', 'reconstructed', 'truecoach'], ['c', 'failed', 'different'],
    ]);
    expect(sql('SELECT count(*) FROM "Person"')).toBe('2');
    // Operator resolution of the contradiction is explicit; the writer never normalizes it.
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE source_id='c'`);
    const resumed = await run();
    expect(resumed.result).toEqual({ intent_id: 'intent', staged: 4, reconstructed: 4, skipped: 0, failed: 0 });
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='truecoach'`)).toBe('4');
  });

  it.each(['skip', 'throw', 'database'])('preserves success and reason on %s failure/skip, but still checks mismatch', async (mode) => {
    stage();
    await run();
    sql(`UPDATE "ScoutReconstructionLedger" SET reason='retained-success',source_platform=NULL`);
    const success = records()[0];
    if (mode === 'database') sql(`UPDATE "ScoutIngestEntity" SET payload='{"name":"FAIL"}'`);
    const options = mode === 'database' ? {} : { mapper: mode };
    expect((await run(options)).result).toMatchObject({ reconstructed: 1, failed: 0, skipped: 0 });
    expect(records()[0]).toMatchObject({ status: 'reconstructed', target_id: success.target_id,
      reason: 'retained-success', source_platform: 'truecoach' });
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform='different'`);
    const previous = records();
    expect((await run(options)).failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
    expect(records()).toEqual(previous);
  });

  it('rejects invalid staging before writes and preserves narrow staging/ledger identities', async () => {
    stage('a', 'clients', 'TrueCoach');
    expect((await run()).failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
    expect(records()).toEqual([]);
    expect(targets()).toEqual({ persons: [], entities: [] });
    expect(() => stage('a', 'workouts', 'other')).toThrow(/ScoutIngestEntity_coach_id_intent_id_source_id_key/);
    sql(`UPDATE "ScoutIngestEntity" SET source_platform='truecoach'`);
    await run();
    expect(() => legacy('skipped', 'other')).toThrow(/ScoutReconstructionLedger_coach_id_intent_id_entity_type_source/);
    for (const bad of ['truecoach\n', 'true coach', 'Truecoach', '_x', '']) {
      sql(`UPDATE "ScoutIngestEntity" SET source_platform=${quote(bad)}`);
      const previous = records();
      expect((await run()).failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
      expect(records()).toEqual(previous);
    }
  });

  it('cross-intent same source: same platform converges on one Person, different platform mints a second', async () => {
    settle('coach', 'i2'); settle('coach', 'i3');
    stage('a', 'clients', 'truecoach', 'Synthetic', 'coach', 'intent');
    stage('a', 'clients', 'truecoach', 'Synthetic', 'coach', 'i2');
    stage('a', 'clients', 'conformance_alpha', 'Synthetic', 'coach', 'i3');
    expect((await run()).result).toMatchObject({ reconstructed: 1 });
    expect((await run({ intent: 'i2' })).result).toMatchObject({ reconstructed: 1 });
    expect((await run({ intent: 'i3' })).result).toMatchObject({ reconstructed: 1 });
    const persons = targets().persons;
    expect(persons.map((p: any) => p.source_platform).sort()).toEqual(['conformance_alpha', 'truecoach']);
    expect(records('coach', 'intent')[0].target_id).toBe(records('coach', 'i2')[0].target_id);
    expect(records('coach', 'i3')[0].target_id).not.toBe(records('coach', 'intent')[0].target_id);
    expect(allLedger().map((r: any) => `${r.intent_id}:${r.source_platform}`)).toEqual(['i2:truecoach', 'i3:conformance_alpha', 'intent:truecoach']);
    // Another coach's identical source id never touches this coach's roster.
    settle('other', 'intent');
    stage('a', 'clients', 'truecoach', 'Synthetic', 'other', 'intent');
    expect((await run({ coach: 'other' })).result).toMatchObject({ reconstructed: 1 });
    expect(targets().persons).toHaveLength(2);
    expect(targets('other').persons).toHaveLength(1);
  });

  it('characterizes the retained narrow ledger collision: one intent cannot carry two platforms for one source', async () => {
    // Staging's narrow key already refuses the second platform; the ledger key is equally narrow.
    stage('a', 'clients', 'truecoach');
    expect(() => stage('a', 'clients', 'conformance_alpha')).toThrow(/ScoutIngestEntity_coach_id_intent_id_source_id_key/);
    await run();
    expect(() => sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status)
      VALUES ('dup','coach','intent','clients','a','conformance_alpha','skipped')`)).toThrow(/ScoutReconstructionLedger_coach_id_intent_id_entity_type_source/);
    // EXPLICIT LIMITATION carried to R/N/C: wide identities are not permitted on E/T.
    expect(sql(`SELECT pg_get_indexdef('public.${ledgerKey}'::regclass)`))
      .toBe(`CREATE UNIQUE INDEX ${ledgerKey} ON public."ScoutReconstructionLedger" USING btree (coach_id, intent_id, entity_type, source_id)`);
  });

  it('characterizes actual O after T: provenance stays but O can downgrade success', async () => {
    stage();
    await run();
    const targetId = records()[0].target_id;
    sql(`UPDATE "ScoutIngestEntity" SET payload='{"name":"FAIL"}'`);
    const old = await run({}, true);
    expect(old.result).toMatchObject({ failed: 1, reconstructed: 0 });
    expect(records()[0]).toMatchObject({ status: 'failed', target_id: null, source_platform: 'truecoach' });
    expect(targets().persons[0].id).toBe(targetId);
    stage('b');
    await run({}, true);
    expect(records().find((r: any) => r.source_id === 'b').source_platform).toBeNull();
    // T then claims O's NULL row and restores the accounting without minting a second Person.
    sql(`UPDATE "ScoutIngestEntity" SET payload='{"name":"Synthetic","client_id":"client-new"}'`);
    expect((await run()).result).toEqual({ intent_id: 'intent', staged: 2, reconstructed: 2, skipped: 0, failed: 0 });
    expect(records().map((r: any) => r.source_platform)).toEqual(['truecoach', 'truecoach']);
    expect(targets().persons).toHaveLength(2);
  });
});

describe('stage 3b: deterministically coordinated T/T and O/T processes on PostgreSQL 17', () => {
  beforeEach(() => resetData());

  it.each([false, true])('concurrent success replays with %s old winner converge on one target', async (old) => {
    stage();
    const first = worker({ pause: 'before-ledger' }, old);
    await first.ready;
    const replay = worker();
    try {
      await blocked(replay.name);
      first.release();
      expect((await first.done).result).toMatchObject({ reconstructed: 1 });
      expect((await replay.done).result).toMatchObject({ reconstructed: 1 });
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ status: 'reconstructed', source_platform: 'truecoach' });
      expect(targets().persons).toHaveLength(1);
    } finally { first.stop(); replay.stop(); }
  });

  it('two absent skip inserts observe real P2002 contention and bounded full-transaction retry', async () => {
    stage('a', 'clients', 'unsupported');
    sql(`CREATE FUNCTION g2p_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(82017); RETURN NEW; END $$;
      CREATE TRIGGER g2p_insert_barrier BEFORE INSERT ON "ScoutReconstructionLedger"
      FOR EACH ROW EXECUTE FUNCTION g2p_insert_barrier()`);
    const holder = holdAdvisory(82017);
    await holder.held;
    const one = worker();
    const two = worker();
    try {
      await blocked(one.name);
      await blocked(two.name);
      holder.release();
      const results = await Promise.all([one.done, two.done]);
      for (const result of results) expect(result.result).toMatchObject({ skipped: 1, failed: 0 });
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ status: 'skipped', source_platform: 'unsupported' });
      expect(results.map((r) => r.queries.filter((q) => q === 'ROLLBACK').length).sort()).toEqual([0, 1]);
      expect(results.map((r) => r.queries.filter((q) => q === 'BEGIN').length).sort()).toEqual([1, 2]);
    } finally {
      one.stop(); two.stop(); holder.kill();
      sql(`DROP TRIGGER g2p_insert_barrier ON "ScoutReconstructionLedger"; DROP FUNCTION g2p_insert_barrier()`);
    }
  });

  it.each(['skip', 'throw', 'success'])('retries real PostgreSQL serialization failure once for %s', async (mode) => {
    stage();
    sql(`CREATE SEQUENCE g2p_attempt; GRANT USAGE,SELECT ON SEQUENCE g2p_attempt TO service_role;
      CREATE FUNCTION g2p_transient() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('g2p_attempt')=1 THEN RAISE EXCEPTION 'private transient detail' USING ERRCODE='40001'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER g2p_transient BEFORE INSERT ON "ScoutReconstructionLedger" FOR EACH ROW EXECUTE FUNCTION g2p_transient()`);
    try {
      const result = await run(mode === 'success' ? {} : { mapper: mode });
      expect(result.failure).toBeUndefined();
      expect(records()[0]).toMatchObject({ source_platform: 'truecoach',
        status: mode === 'skip' ? 'skipped' : mode === 'throw' ? 'failed' : 'reconstructed' });
      expect(sql('SELECT last_value FROM g2p_attempt')).toBe('2');
      expect(result.queries.filter((q) => q === 'ROLLBACK')).toHaveLength(1);
      expect(result.queries.filter((q) => q === 'BEGIN')).toHaveLength(2);
    } finally {
      sql(`DROP TRIGGER g2p_transient ON "ScoutReconstructionLedger"; DROP FUNCTION g2p_transient(); DROP SEQUENCE g2p_attempt`);
    }
  });

  it('exhausted real ledger serialization conflicts stop after two transactions with no invented tally', async () => {
    stage('a', 'clients', 'unsupported');
    sql(`CREATE SEQUENCE g2p_attempt; GRANT USAGE,SELECT ON SEQUENCE g2p_attempt TO service_role;
      CREATE FUNCTION g2p_transient() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('g2p_attempt'); RAISE EXCEPTION 'private transient detail' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER g2p_transient BEFORE INSERT ON "ScoutReconstructionLedger" FOR EACH ROW EXECUTE FUNCTION g2p_transient()`);
    try {
      const result = await run();
      expect(result.failure).toEqual({ status: 500, message: 'Internal server error', code: 'P2034' });
      expect(result.result).toBeUndefined();
      expect(result.events).toEqual([]);
      expect(sql('SELECT last_value FROM g2p_attempt')).toBe('2');
      expect(records()).toEqual([]);
      expect(result.queries.filter((q) => q === 'ROLLBACK')).toHaveLength(2);
    } finally {
      sql(`DROP TRIGGER g2p_transient ON "ScoutReconstructionLedger"; DROP FUNCTION g2p_transient(); DROP SEQUENCE g2p_attempt`);
    }
  });

  it.each([false, true])('success holds claim while a failing %s old writer waits', async (old) => {
    stage();
    const success = worker({ pause: 'claimed' });
    await success.ready;
    sql(`UPDATE "ScoutIngestEntity" SET payload='{"name":"FAIL"}'`);
    const failure = worker({}, old);
    try {
      await blocked(failure.name);
      success.release();
      expect((await success.done).failure).toBeUndefined();
      expect((await failure.done).failure).toBeUndefined();
      expect(records()[0]).toMatchObject({ status: old ? 'failed' : 'reconstructed', source_platform: 'truecoach' });
      expect(records()[0].target_id === null).toBe(old);
      expect(targets().persons).toHaveLength(1);
    } finally { success.stop(); failure.stop(); }
  });

  it.each([false, true])('success holds claim while a skipped %s old writer waits', async (old) => {
    stage();
    const success = worker({ pause: 'claimed' });
    await success.ready;
    const skip = worker({ mapper: 'skip' }, old);
    try {
      await blocked(skip.name);
      success.release();
      await Promise.all([success.done, skip.done]);
      expect(records()[0]).toMatchObject({ status: old ? 'skipped' : 'reconstructed', source_platform: 'truecoach' });
      expect(records()[0].target_id === null).toBe(old);
    } finally { success.stop(); skip.stop(); }
  });

  it.each(['skip', 'throw'])('T success upgrades serialized %s while target write is open', async (mode) => {
    stage();
    const success = worker({ pause: 'before-ledger' });
    await success.ready;
    try {
      expect((await run({ mapper: mode })).failure).toBeUndefined();
      expect(records()[0].status).toBe(mode === 'skip' ? 'skipped' : 'failed');
      success.release();
      expect((await success.done).failure).toBeUndefined();
      expect(records()[0]).toMatchObject({ status: 'reconstructed', source_platform: 'truecoach', reason: null });
    } finally { success.stop(); }
  });

  it('concurrent different-platform NULL claims serialize and the loser rolls back target changes', async () => {
    stage();
    legacy('failed');
    const first = worker({ pause: 'claimed' });
    await first.ready;
    sql(`UPDATE "ScoutIngestEntity" SET source_platform='conformance_alpha'`);
    const other = worker();
    try {
      await blocked(other.name);
      first.release();
      expect((await first.done).failure).toBeUndefined();
      expect((await other.done).failure).toEqual({ status: 409, message: 'reconstruction provenance conflict' });
      expect(records()[0].source_platform).toBe('truecoach');
      expect(targets().persons.map((p: any) => p.source_platform)).toEqual(['truecoach']);
    } finally { first.stop(); other.stop(); }
  });
});

describe('stage 4: Q0 real scoped reads, cursor boundaries and unchanged emission', () => {
  beforeEach(() => resetData());

  it.each(['clients', 'workouts'])('enumerates exact narrow-schema %s page union and retains NULL legacy history', async (family) => {
    for (const id of ['a', 'b', 'c']) stage(id, family);
    await run({ family });
    const targetIds = records('coach', 'intent', family).map((r: any) => r.target_id);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE source_id='a'`);
    const action = actionOf(family);
    const union: string[] = [];
    let after: string | undefined;
    for (const id of ['a', 'b', 'c']) {
      const page = await run({ action, family, cursor: after });
      expect(page.failure).toBeUndefined();
      union.push(...ids(visible(family, page.result)));
      const next = id === 'c' ? null : nextLegacy(family, id);
      expect(cursorOf(family, page.result)).toBe(next);
      expect(page.queries.some((q) => q.includes('REPEATABLE READ'))).toBe(true);
      after = next ?? undefined;
    }
    expect(union).toEqual(targetIds);
    const composite = await run({ action, family, cursor: v2(family) });
    expect(ids(visible(family, composite.result))).toEqual([targetIds[1]]);
    expect(cursorOf(family, composite.result)).toBe(nextLegacy(family, 'b'));
    expect((await run({ action, family, coach: 'foreign' })).failure?.status).toBe(404);
    expect((await run({ action, family, cursor: v2(family === 'clients' ? 'workouts' : 'clients') })).failure)
      .toEqual({ status: 400, message: 'malformed cursor' });
    sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id)
      VALUES ('foreign-coach','other','intent',${quote(family)},'z','truecoach','reconstructed',${quote(targetIds[0])}),
      ('foreign-intent','coach','other',${quote(family)},'z','truecoach','reconstructed',${quote(targetIds[0])}),
      ('foreign-family','coach','intent','client_history','z','truecoach','reconstructed',${quote(targetIds[0])})`);
    const scoped = await run({ action, family, cursor: v2(family), limit: 200 });
    expect(ids(visible(family, scoped.result))).toEqual(targetIds.slice(1));
    const table = family === 'clients' ? 'Person' : 'ScoutReconstructedEntity';
    sql(`UPDATE "${table}" SET coach_id='foreign' WHERE id=${quote(targetIds[1])};
      DELETE FROM "${table}" WHERE id=${quote(targetIds[2])}`);
    const hidden = await run({ action, family, cursor: v2(family), limit: 2 });
    expect(visible(family, hidden.result)).toEqual([]);
    expect(cursorOf(family, hidden.result)).toBeNull();
    if (family === 'clients') {
      sql(`UPDATE "Person" SET state='Deleted' WHERE id=${quote(targetIds[0])}`);
    } else {
      sql(`UPDATE "ScoutReconstructedEntity" SET entity_type='client_history' WHERE id=${quote(targetIds[0])}`);
    }
    expect(visible(family, (await run({ action, family, limit: 200 })).result)).toEqual([]);
  });

  it.each(['clients', 'workouts'])('characterizes %s ties ONLY in a temporary future-schema fixture', async (family) => {
    for (const id of ['a', 'b', 'c', 'd']) stage(id, family);
    await run({ family });
    const original = records('coach', 'intent', family);
    const definition = sql(`SELECT pg_get_indexdef('public.${ledgerKey}'::regclass)`);
    sql(`DROP INDEX public.${ledgerKey};
      UPDATE "ScoutReconstructionLedger" SET source_id='a',source_platform=CASE source_id
        WHEN 'a' THEN 'p1' WHEN 'b' THEN 'p2' ELSE 'p3' END WHERE source_id<>'d';
      UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE source_id='d'`);
    const action = actionOf(family);
    try {
      const page = (await run({ action, family, cursor: v2(family, 'a', 'p1') })).result;
      expect(ids(visible(family, page))).toEqual([original[1].target_id]);
      expect(cursorOf(family, page)).toBe(nextLegacy(family, 'a'));
      const chained = (await run({ action, family, cursor: cursorOf(family, page) })).result;
      // Explicit Q0 LIMITATION: legacy emission skips remaining tied p3; Q1 is required before widening.
      expect(ids(visible(family, chained))).toEqual([original[3].target_id]);
      expect(cursorOf(family, chained)).toBeNull();
      const exact = (await run({ action, family, cursor: v2(family, 'a', 'p2') })).result;
      expect(ids(visible(family, exact))).toEqual([original[2].target_id]);
    } finally {
      sql(`DELETE FROM "ScoutReconstructionLedger"; ${definition}`);
    }
  });

  it.each(['clients', 'workouts'])('bounds %s cursor tokens at 8,192 characters and rejects every malformed shape without reflection', async (family) => {
    stage('a', family);
    await run({ family });
    const action = actionOf(family);
    const long = 'x'.repeat(256);
    const longV2 = v2(family, long, 'p'.repeat(256), 'coach', 'intent');
    expect(longV2.length).toBeLessThanOrEqual(8192);
    // A scope mismatch on an otherwise valid maximal token is still a bounded 400.
    expect((await run({ action, family, cursor: `v2.${encoded(JSON.stringify({ v: 2, c: 'c'.repeat(256), i: 'i'.repeat(256), f: family,
      o: 'source_id:asc,source_platform:asc', s: long, p: 'p'.repeat(256) }))}` })).failure)
      .toEqual({ status: 400, message: 'malformed cursor' });
    const valid = await run({ action, family, cursor: v2(family, 'a', 'truecoach') });
    expect(valid.failure).toBeUndefined();
    expect(visible(family, valid.result)).toEqual([]);
    const malformed = [
      `${v2(family, 'a', 'truecoach')}x`.padEnd(8193, 'A'),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'TrueCoach' })),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a' })),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc', s: 'a', p: 'truecoach' })),
      'v2.' + encoded(JSON.stringify({ v: 1, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'truecoach' })),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'other', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'truecoach' })),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'truecoach', z: 1 })),
      'v2.' + encoded(JSON.stringify({ c: 'coach', v: 2, i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'truecoach' })),
      'v2.' + encoded('{"v":2,"c":"coach","i":"intent","f":"' + family + '","o":"source_id:asc,source_platform:asc","s":"a\u0000","p":"truecoach"}'),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: '\ud800', p: 'truecoach' })),
      'v2.' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
      'v2.' + encoded(JSON.stringify({ v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc', s: 'a', p: 'truecoach' })) + '=',
      family === 'clients' ? encoded('a\u0000') : encoded(JSON.stringify({ c: 'coach', i: 'intent', f: 'clients', o: 'source_id:asc', s: 'a' })),
      family === 'clients' ? encoded('a').padEnd(8193, 'B') : encoded('[]'),
    ];
    for (const cursor of malformed) {
      const result = await run({ action, family, cursor });
      expect(result.failure).toEqual({ status: 400, message: 'malformed cursor' });
      expect(JSON.stringify(result.failure)).not.toContain(cursor.slice(0, 40));
    }
    // Legacy roster tokens remain unbound raw source ids; entity legacy tokens remain scope-bound.
    const legacyPage = await run({ action, family, cursor: nextLegacy(family, '0') });
    expect(legacyPage.failure).toBeUndefined();
    expect(visible(family, legacyPage.result)).toHaveLength(1);
  });
});

describe('stage 5: rollout recovery boundaries after T has claimed provenance', () => {
  beforeEach(() => resetData());

  it('refuses destructive E rollback while any claim exists, keeps history, and only a drained ledger can roll back', async () => {
    stage('a'); stage('b');
    await run();
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform IS NOT NULL`)).toBe('2');
    const before = catalog();
    refused(down, 'G2-E refuses removal of assigned provenance');
    expect(hasColumn()).toBe('1');
    expect(catalog()).toBe(before);
    expect(appliedMigrations()).toBe('165');
    // Simulated operator drain (SQL cannot prove an actual writer drain): every claim removed.
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL`);
    const narrowRows = allLedger().map((r: any) => { const { source_platform, ...rest } = r; return rest; });
    sql(down);
    expect(hasColumn()).toBe('0');
    expect(allLedger()).toEqual(narrowRows);
    // FINDING (S1-owned): down.sql leaves the E history row applied, so the release mechanism
    // reports a false "up to date" and would NOT re-apply E.
    expect(appliedMigrations()).toBe('165');
    expect(prismaMigrateDeploy(root)).toMatch(/No pending migrations/);
    expect(hasColumn()).toBe('0');
    // S1's verified recovery semantics, re-proven here for E on the populated base: after a
    // SUCCESSFUL out-of-band down there is no failed history row, so `migrate resolve --rolled-back`
    // is refused (P3012) and history is untouched. It is NOT a recovery step for this state.
    const resolveAttempt = prisma(root, ['migrate', 'resolve', '--rolled-back', E]);
    console.warn('PG17_RESOLVE_ROLLED_BACK', JSON.stringify(resolveAttempt));
    expect(resolveAttempt.ok).toBe(false);
    expect(resolveAttempt.output).toMatch(/P3012/);
    expect(appliedMigrations()).toBe('165');
    expect(sql(`SELECT count(*) FROM "_prisma_migrations" WHERE rolled_back_at IS NOT NULL OR finished_at IS NULL`)).toBe('0');
    // O keeps working on the narrow schema; the T binary cannot run until E is restored.
    stage('c');
    expect((await run({}, true)).result).toEqual({ intent_id: 'intent', staged: 3, reconstructed: 3, skipped: 0, failed: 0 });
    const tOnNarrow = await run();
    expect(tOnNarrow.failure).toMatchObject({ status: 500, message: 'Internal server error' });
    expect(tOnNarrow.result).toBeUndefined();
    expect(records()).toHaveLength(3);
    // Forward repair is the operator form (psql -f migration.sql); it applies only while the column is
    // absent and is NOT idempotent: a rerun on applied E fails closed ('G2-E platform column already
    // exists', proven above). The only truth signal is the catalog, not Prisma history; afterwards T
    // reclaims every NULL row without minting new targets.
    sqlFile(upFile);
    expect(hasColumn()).toBe('1');
    expect(prismaMigrateDeploy(root)).toMatch(/No pending migrations/);
    expect((await run()).result).toEqual({ intent_id: 'intent', staged: 3, reconstructed: 3, skipped: 0, failed: 0 });
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='truecoach'`)).toBe('3');
    expect(targets().persons).toHaveLength(3);
    expect(appliedMigrations()).toBe('165');
  });

  it('E/down lock budgets fail atomically against a live writer transaction instead of queueing behind it', async () => {
    stage('lock');
    await run();
    expect(records()[0]).toMatchObject({ status: 'reconstructed', source_platform: 'truecoach' });
    const before = catalog();
    // Deterministic writer: a service_role transaction holding a ledger row lock (RowExclusiveLock
    // on the table) for as long as the test wants, like an in-flight O/T claim without a client timeout.
    const holder = holdTransaction(`UPDATE public."ScoutReconstructionLedger" SET reason='held' WHERE source_id='lock'`);
    await holder.held;
    try {
      const t0 = Date.now();
      refused(down, 'lock timeout');
      refused(up, 'lock timeout');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(5000);
      expect(elapsed).toBeLessThan(30000);
      expect(hasColumn()).toBe('1');
      expect(catalog()).toBe(before);
    } finally { holder.release(); }
    expect(records()[0]).toMatchObject({ status: 'reconstructed', source_platform: 'truecoach', reason: 'held' });
    // Both directions fail before any prerequisite check, so history and provenance are untouched.
    expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_platform='truecoach'`)).toBe('1');
    expect(appliedMigrations()).toBe('165');
  });

  it('characterizes down against an actual T claim transaction paused inside its interactive transaction', async () => {
    // Prisma interactive transactions have a 5 s default ceiling and E uses lock_timeout=5 s; which
    // budget expires first is a race. The branch is recorded, and EACH branch's terminal contract is
    // asserted after the worker has exited: worker result/failure, completion event, ledger rows,
    // target rows, catalog and history. Neither ordering is asserted to always win.
    stage('claimrace');
    const before = { ledger: records(), targets: targets(), catalog: catalog() };
    expect(before.ledger).toEqual([]);
    expect(before.targets).toEqual({ persons: [], entities: [] });
    const paused = worker({ pause: 'claimed' });
    await paused.ready;
    let branch = 'down-refused';
    let message = '';
    let outcome!: Result; // assigned inside try; the finally only stops the child
    try {
      try { sql(down); branch = 'down-applied'; } catch (e) { message = String(e); }
      console.warn('PG17_CLAIM_RACE', JSON.stringify({ branch, message: message.split('\n').find((l) => l.includes('ERROR')) ?? '' }));
      if (branch === 'down-refused') {
        // Either the lock budget fired or the claim was visible and refused; the column survives.
        expect(message).toMatch(/lock timeout|refuses removal of assigned provenance/);
        expect(hasColumn()).toBe('1');
        expect(catalog()).toBe(before.catalog);
      } else {
        // down can only have succeeded on a drained ledger: the paused claim must have rolled back.
        expect(hasColumn()).toBe('0');
        expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_id='claimrace'`)).toBe('0');
      }
      paused.release();
      outcome = await paused.done;
    } finally { paused.stop(); }
    console.warn('PG17_CLAIM_RACE_WORKER', JSON.stringify({ branch, result: outcome.result, failure: outcome.failure, events: outcome.events.length }));
    const ledger = records();
    const after = targets();
    if (branch === 'down-applied') {
      // OBSERVED on PG17 (runs 20260920T183610Z/184713Z/185210Z): Prisma's 5 s ceiling expires before
      // E's 5 s lock_timeout, the paused claim (Person + ledger row + claim) is rolled back, the drained
      // down succeeds, and the released T worker fails closed: its success transaction is already
      // closed, and the follow-up durable `failed` write hits the now-absent column (P2022) and
      // propagates instead of minting a row. This CHARACTERIZES a mixed E-down/T-live state that a
      // real rollout must never enter (T is drained by process control before any down); a 500 to the
      // caller is not acceptable production behaviour and is not endorsed by this assertion.
      expect(outcome.result).toBeUndefined();
      expect(outcome.failure).toEqual({ status: 500, message: 'Internal server error', code: 'P2022' });
      expect(outcome.events).toEqual([]);
      // Terminal state: no partial or durable ledger row, no orphan target, column absent, history untouched.
      expect(ledger).toEqual([]);
      expect(after).toEqual({ persons: [], entities: [] });
      expect(hasColumn()).toBe('0');
      expect(appliedMigrations()).toBe('165');
      // Forward repair (catalog is the only truth signal) restores the identical E catalog.
      sqlFile(upFile);
      expect(catalog()).toBe(before.catalog);
    } else {
      // down was refused, so E stayed. Two legal terminal outcomes for the released claim, each with
      // its own coupled ledger/target invariant:
      //  (a) the interactive transaction was still open: claim + target + `reconstructed` commit together;
      //  (b) the client ceiling had expired meanwhile: the success transaction rolled back (no target)
      //      and the worker recorded ONE durable `failed` row with reason error:Prisma.P2028.
      expect(outcome.failure).toBeUndefined();
      expect(hasColumn()).toBe('1');
      expect(catalog()).toBe(before.catalog);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ source_id: 'claimrace', source_platform: 'truecoach' });
      if (ledger[0].status === 'reconstructed') {
        expect(outcome.result).toEqual({ intent_id: 'intent', staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
        expect(outcome.events).toHaveLength(1);
        expect(after.entities).toEqual([]);
        expect(after.persons.map((p: any) => p.id)).toEqual([ledger[0].target_id]);
      } else {
        expect(ledger[0]).toMatchObject({ status: 'failed', target_id: null, reason: 'error:Prisma.P2028' });
        expect(outcome.result).toEqual({ intent_id: 'intent', staged: 1, reconstructed: 0, skipped: 0, failed: 1 });
        expect(outcome.events).toHaveLength(1);
        expect(after).toEqual({ persons: [], entities: [] });
      }
    }
    // Both branches converge: E applied, history unchanged, and a T replay reclaims the staged row into
    // exactly one reconstructed ledger row bound to exactly one Person, minting nothing else.
    expect(hasColumn()).toBe('1');
    expect(appliedMigrations()).toBe('165');
    expect((await run()).result).toEqual({ intent_id: 'intent', staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    const converged = records();
    expect(converged.map((r: any) => [r.source_id, r.status, r.source_platform])).toEqual([['claimrace', 'reconstructed', 'truecoach']]);
    expect(targets().persons.map((p: any) => p.id)).toEqual([converged[0].target_id]);
    expect(targets().entities).toEqual([]);
  });

  it('refuses down with a lock timeout while an actual T claim transaction outlives E\'s lock budget, and the released claim then commits intact', async () => {
    // Deterministic form of the refused branch above. Only the FIXTURE widens this one worker's
    // Prisma interactive-transaction ceiling (`txTimeout`, test/utils/g2-tq0-worker.cjs), so the
    // paused claim keeps its table/row locks past E's 5 s lock_timeout. Production T runs with
    // Prisma's default ceiling: this proves E/down's fail-closed lock budget and the integrity of a
    // claim that survives a refused down; it is NOT a production guarantee that in-flight T
    // transactions protect the ledger against a down (they do not; drain is a process boundary).
    stage('claimrace2');
    const before = catalog();
    expect(records()).toEqual([]);
    const paused = worker({ pause: 'claimed', txTimeout: 30000 });
    await paused.ready;
    let outcome!: Result; // assigned inside try; the finally only stops the child
    try {
      const t0 = Date.now();
      refused(down, 'lock timeout');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(5000);
      expect(elapsed).toBeLessThan(30000);
      // Refused before any prerequisite check: column, catalog and history untouched; the paused
      // claim is still uncommitted and invisible to other sessions.
      expect(hasColumn()).toBe('1');
      expect(catalog()).toBe(before);
      expect(appliedMigrations()).toBe('165');
      expect(sql(`SELECT count(*) FROM "ScoutReconstructionLedger" WHERE source_id='claimrace2'`)).toBe('0');
      expect(targets()).toEqual({ persons: [], entities: [] });
      paused.release();
      outcome = await paused.done;
    } finally { paused.stop(); }
    console.warn('PG17_CLAIM_REFUSED_WORKER', JSON.stringify({ result: outcome.result, failure: outcome.failure, events: outcome.events.length }));
    // Terminal contract: the claim commits whole (claim + target + reconstructed), one completion event,
    // and nothing about E changed.
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result).toEqual({ intent_id: 'intent', staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(outcome.events).toEqual([['coach', 'scout.reconstruct.completed',
      { intent_id: 'intent', entity_type: 'clients', staged: 1, reconstructed: 1, skipped: 0, failed: 0 }]]);
    const rows = records();
    expect(rows.map((r: any) => [r.source_id, r.status, r.source_platform, r.reason])).toEqual([['claimrace2', 'reconstructed', 'truecoach', null]]);
    expect(targets().persons.map((p: any) => p.id)).toEqual([rows[0].target_id]);
    expect(targets().entities).toEqual([]);
    expect(hasColumn()).toBe('1');
    expect(catalog()).toBe(before);
    expect(appliedMigrations()).toBe('165');
    // With the claim now committed, down is refused for the data reason, not the lock budget.
    refused(down, 'G2-E refuses removal of assigned provenance');
    expect(hasColumn()).toBe('1');
  });
});
