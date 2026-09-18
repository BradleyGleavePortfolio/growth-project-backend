// Actual E SQL + independent generated925/E Prisma clients. No DB mocks.
// Donor6b263c2 provided SQL-file, catalog, role-switch and loopback guard patterns.
import { execFileSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { g2LedgerTestTarget } from './utils/g2-ledger-db';

const root = resolve(__dirname, '..');
const raw = process.env.G2_TEST_DATABASE_URL;
const psql = process.env.G2_TEST_PSQL;
const oldModule = process.env.G2_OLD_CLIENT_MODULE;
const directory = process.env.G2_TEST_DATA_DIRECTORY;
if (!raw || !psql || !oldModule || !directory) {
  throw new Error(
    'G2-E live proof requires explicit disposable DB, psql, old client and server identity',
  );
}
const target = g2LedgerTestTarget(raw, process.env.G2_TEST_CONFIRM);
const environment = { PATH: process.env.PATH, LC_ALL: 'C' };
function sql(text: string): string {
  return execFileSync(psql!, ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-At', target.psqlUrl], {
    input: text,
    encoding: 'utf8',
    timeout: 40000,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
if (
  !directory.endsWith('/execution/c1-builder/pg-data') ||
  sql('SHOW data_directory') !== directory
) {
  throw new Error('G2-E disposable server identity mismatch');
}
const stage = resolve(root, 'prisma/migrations/20270118000000_scout_ledger_platform_expand');
const up = readFileSync(resolve(stage, 'migration.sql'), 'utf8');
const down = readFileSync(resolve(stage, 'down.sql'), 'utf8');
function refused(statement: string, message: string): void {
  try {
    sql(statement);
    throw new Error('SQL unexpectedly succeeded');
  } catch (error) {
    // Child process stderr contains the actual PostgreSQL discriminator.
    expect(String(error)).toContain(message);
  }
}
const hasColumn = () =>
  sql(`SELECT count(*) FROM pg_attribute WHERE
  attrelid='public."ScoutReconstructionLedger"'::regclass AND attname='source_platform' AND NOT attisdropped`);
const catalog = () =>
  sql(`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_array(oid,relname,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE oid IN ('public."ScoutIngestEntity"'::regclass,'public."ScoutReconstructionLedger"'::regclass)),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(indexrelid,pg_get_indexdef(indexrelid)) ORDER BY indexrelid)
    FROM pg_index WHERE indrelid IN ('public."ScoutIngestEntity"'::regclass,'public."ScoutReconstructionLedger"'::regclass)),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
    WHERE schemaname='public' AND tablename IN ('ScoutIngestEntity','ScoutReconstructionLedger')))`);
const rows = () =>
  sql(`SELECT COALESCE(jsonb_agg(to_jsonb(l)-'source_platform' ORDER BY id),'[]')
  FROM public."ScoutReconstructionLedger" l`);
const ledger = `INSERT INTO public."ScoutReconstructionLedger"
  (id,coach_id,intent_id,entity_type,source_id,status,reason)
  VALUES ('legacy','coach','intent','clients','legacy','skipped','retained reason')`;

beforeAll(() => {
  // Full base migration history is a separate recorded prerequisite, never
  // replaced with an invented minimal schema. No table reset or C1 DB access.
  expect(
    sql(`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL AND migration_name <> '20270118000000_scout_ledger_platform_expand'`),
  ).toBe('164');
  expect(readFileSync(resolve(oldModule!, 'schema.prisma'), 'utf8')).not.toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform/,
  );
  expect(readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8')).toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/,
  );
  sql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='g2_ledger_owner') THEN
      CREATE ROLE g2_ledger_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$;
  GRANT USAGE,CREATE ON SCHEMA public TO g2_ledger_owner;
  GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
  GRANT ALL ON public."ScoutIngestEntity",public."ScoutReconstructionLedger",
    public."Person",public."ScoutReconstructedEntity",public."ScoutImport",
    public."ScoutProgressSnapshot" TO service_role,anon,authenticated;`);
});
beforeEach(() => {
  sql(`DELETE FROM public."ScoutReconstructionLedger"; DELETE FROM public."ScoutIngestEntity";
    DELETE FROM public."Person"; DELETE FROM public."ScoutReconstructedEntity";
    DELETE FROM public."ScoutImport";`);
  if (hasColumn() === '1') sql(down);
});

describe('G2-E additive migration and fail-closed rollback', () => {
  it('adds only nullable no-default provenance and preserves rows, OIDs, keys and policies', () => {
    sql(ledger);
    const before = rows();
    const beforeCatalog = catalog();
    sql(up);
    expect(rows()).toBe(before);
    expect(catalog()).toBe(beforeCatalog);
    expect(
      sql(`SELECT is_nullable||':'||data_type||':'||COALESCE(column_default,'NONE')
      FROM information_schema.columns WHERE table_schema='public' AND table_name='ScoutReconstructionLedger'
      AND column_name='source_platform'`),
    ).toBe('YES:text:NONE');
    expect(
      sql('SELECT count(*) FROM public."ScoutReconstructionLedger" WHERE source_platform IS NULL'),
    ).toBe('1');
    sql(down);
    expect(hasColumn()).toBe('0');
    expect(rows()).toBe(before);
    sql(up);
    expect(catalog()).toBe(beforeCatalog);
  });
  it('supports privileged empty up/down/up but refuses raw up rerun atomically', () => {
    sql(up);
    sql(down);
    sql(up);
    sql(ledger);
    const beforeRows = rows();
    const before = catalog();
    refused(up, 'G2-E platform column already exists');
    expect(hasColumn()).toBe('1');
    expect(catalog()).toBe(before);
    expect(rows()).toBe(beforeRows);
    sql(down);
    refused(down, 'G2-E unexpected platform column prerequisite');
    expect(hasColumn()).toBe('0');
  });
  it('refuses any assigned provenance, even with no matching staging record', () => {
    sql(ledger);
    sql(up);
    sql(`UPDATE public."ScoutReconstructionLedger" SET source_platform='truecoach'`);
    const before = catalog();
    refused(down, 'G2-E refuses removal of assigned provenance');
    expect(sql(`SELECT source_platform FROM public."ScoutReconstructionLedger"`)).toBe('truecoach');
    expect(catalog()).toBe(before);
  });
  it.each([true, false])(
    'forced-RLS non-bypass owning role cannot drop hidden provenance (populated=%s)',
    (populated) => {
      sql(up);
      if (populated)
        sql(`${ledger}; UPDATE public."ScoutReconstructionLedger" SET source_platform='truecoach'`);
      sql(`ALTER TABLE public."ScoutIngestEntity" OWNER TO g2_ledger_owner;
      ALTER TABLE public."ScoutReconstructionLedger" OWNER TO g2_ledger_owner`);
      try {
        expect(
          sql(`SELECT rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname='g2_ledger_owner'`),
        ).toBe('false:false');
        expect(
          sql(`SET ROLE g2_ledger_owner; SELECT count(*) FROM public."ScoutReconstructionLedger"`),
        ).toBe('SET\n0');
        refused(`SET ROLE g2_ledger_owner;\n${down}`, 'row-level security');
        expect(hasColumn()).toBe('1');
        expect(sql(`SELECT count(*) FROM public."ScoutReconstructionLedger"`)).toBe(
          populated ? '1' : '0',
        );
      } finally {
        sql(`ALTER TABLE public."ScoutIngestEntity" OWNER TO "user";
        ALTER TABLE public."ScoutReconstructionLedger" OWNER TO "user"`);
      }
    },
  );
  it.each(['up', 'down'])('refuses a wrong public index owner in %s', (direction) => {
    if (direction === 'down') sql(up);
    sql(`ALTER INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key" RENAME TO g2_saved_key;
      CREATE TABLE public.g2_decoy (id TEXT);
      CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key" ON public.g2_decoy(id)`);
    try {
      refused(direction === 'up' ? up : down, 'G2-E unexpected identity prerequisite');
      expect(hasColumn()).toBe(direction === 'up' ? '0' : '1');
      expect(sql('SELECT count(*) FROM public.g2_decoy')).toBe('0');
    } finally {
      sql(`DROP TABLE public.g2_decoy;
        ALTER INDEX public.g2_saved_key RENAME TO "ScoutIngestEntity_coach_id_intent_id_source_id_key"`);
    }
  });
  it.each(['source_id, intent_id, coach_id', 'coach_id, intent_id, source_id) WHERE false --'])(
    'refuses wrong/partial key definitions without changing data: %s',
    (columns) => {
      sql(`ALTER INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key" RENAME TO g2_saved_key;
        CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
        ON public."ScoutIngestEntity" (${columns})`);
      try {
        refused(up, 'G2-E unexpected identity prerequisite');
        expect(hasColumn()).toBe('0');
      } finally {
        sql(`DROP INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key";
          ALTER INDEX public.g2_saved_key RENAME TO "ScoutIngestEntity_coach_id_intent_id_source_id_key"`);
      }
    },
  );
  it('schema-qualifies both directions despite search_path decoys', () => {
    sql(`CREATE SCHEMA g2_shadow;
      CREATE TABLE g2_shadow."ScoutReconstructionLedger" (source_platform TEXT);
      INSERT INTO g2_shadow."ScoutReconstructionLedger" VALUES ('untouched')`);
    try {
      sql(`SET search_path=g2_shadow,public;\n${up}`);
      expect(hasColumn()).toBe('1');
      sql(`SET search_path=g2_shadow,public;\n${down}`);
      expect(hasColumn()).toBe('0');
      expect(sql(`SELECT source_platform FROM g2_shadow."ScoutReconstructionLedger"`)).toBe(
        'untouched',
      );
    } finally {
      sql('DROP SCHEMA g2_shadow CASCADE');
    }
  });
  it.each([
    ["SET DEFAULT 'invalid'", 'DROP DEFAULT'],
    ['SET NOT NULL', 'DROP NOT NULL'],
    ['TYPE VARCHAR(50)', 'TYPE TEXT'],
  ])('refuses column-state drift without implicit contraction: %s', (change, restore) => {
    sql(up);
    sql(`ALTER TABLE public."ScoutReconstructionLedger" ALTER COLUMN source_platform ${change}`);
    refused(down, 'G2-E unexpected platform column prerequisite');
    expect(hasColumn()).toBe('1');
    sql(`ALTER TABLE public."ScoutReconstructionLedger" ALTER COLUMN source_platform ${restore}`);
  });
});

// Dedicated OS processes each load a separately generated client. Shared pinned
// Prisma runtime does not overwrite either client's generated schema/DMMF.
function client(module: string, mode: string): string {
  const program = `
    const {PrismaClient}=require(process.argv[1]);
    const {ScoutIngestService}=require('./src/scout/scout-ingest.service');
    const {ScoutReconstructService}=require('./src/scout/scout-reconstruct.service');
    const {ScoutRosterService}=require('./src/scout/scout-roster.service');
    const {ScoutEntitiesService}=require('./src/scout/scout-entities.service');
    const {ScoutService}=require('./src/scout/scout.service');
    const queries=[]; const events=[];
    const db=new PrismaClient({datasources:{db:{url:process.env.G2_SERVICE_URL}},
      log:[{emit:'event',level:'query'}]});
    db.$on('query', e=>queries.push(e.query));
    const analytics={capture:(...args)=>events.push(args)};
    (async()=>{
      const ingest=new ScoutIngestService(db,analytics);
      const reconstruct=new ScoutReconstructService(db,analytics);
      const dto={intent_id:'intent',entity_type:'clients',entities:[
        {sourceId:'a',sourcePlatform:'truecoach',capturedAt:'2026-09-18T00:00:00Z',payload:{name:'Synthetic A'}},
        {sourceId:'b',sourcePlatform:'truecoach',capturedAt:'2026-09-18T00:00:00Z',payload:{name:'Synthetic B'}},
        {sourceId:'skip',sourcePlatform:'unknown',capturedAt:'2026-09-18T00:00:00Z',payload:{}},
        {sourceId:'fail',sourcePlatform:'truecoach',capturedAt:'2026-09-18T00:00:00Z',payload:{name:'Synthetic fail'}}
      ]};
      const first=await ingest.ingest('coach',dto);
      const replay=await ingest.ingest('coach',dto);
      const narrow=await ingest.ingest('coach',{...dto,entity_type:'workouts',
        entities:[dto.entities[0],{...dto.entities[0],sourcePlatform:'other'}]});
      const result=await reconstruct.reconstruct('coach','intent');
      const rosterSvc=new ScoutRosterService(db,analytics);
      const roster=await rosterSvc.getRoster('coach','intent',undefined,1);
      const next=await rosterSvc.getRoster('coach','intent',roster.page.next_cursor,1);
      await ingest.ingest('coach',{...dto,entity_type:'workouts',entities:[
        {...dto.entities[0],sourceId:'workout',payload:{name:'Synthetic workout'}}
      ]});
      const workout=await reconstruct.reconstruct('coach','intent','workouts');
      const entities=await new ScoutEntitiesService(db,analytics).getEntities('coach','intent','workouts',undefined,1);
      const status=await new ScoutService(db,{pushToUser(){throw new Error('unexpected push')}},analytics)
        .getImportStatus('coach','intent');
      let denied;
      try {await rosterSvc.getRoster('other','intent',undefined,1);}
      catch(e){denied=e.getStatus();}
      const records=await db.scoutReconstructionLedger.findMany({orderBy:{source_id:'asc'}});
      await db.$disconnect();
      console.log('G2_RESULT='+JSON.stringify({first,replay,narrow,result,roster,next,workout,entities,
        status,denied,records,queries,mode:process.argv[2]}));
    })().catch(e=>{console.error(e);process.exit(1)});`;
  const service = new URL(target.prismaUrl);
  service.username = 'service_role';
  return execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', program, module, mode],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 40000,
      env: { ...process.env, G2_SERVICE_URL: service.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

describe('G2-E real old-client compatibility and RLS', () => {
  it.each(['old', 'expanded'])(
    'runs unchanged service paths with isolated %s client and nullable history',
    (version) => {
      sql(up);
      sql(`INSERT INTO public."ScoutImport" (id,coach_id,intent_id,state,terminal_status)
      VALUES ('settled','coach','intent','settled','success');
      CREATE FUNCTION public.g2_refuse_person() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_person_id='fail' THEN RAISE EXCEPTION 'synthetic target refusal'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER g2_target_refusal BEFORE INSERT OR UPDATE ON public."Person"
        FOR EACH ROW EXECUTE FUNCTION public.g2_refuse_person();`);
      try {
        const output = client(
          version === 'old' ? oldModule! : resolve(root, 'node_modules/.prisma/client'),
          version,
        );
        const encoded = output.split('\n').find((line) => line.startsWith('G2_RESULT='));
        expect(encoded).toBeDefined();
        const result = JSON.parse(encoded!.slice('G2_RESULT='.length));
        expect(result.first).toEqual({ received: 4, deduped: 0 });
        expect(result.replay).toEqual({ received: 4, deduped: 4 });
        expect(result.narrow).toEqual({ received: 2, deduped: 2 });
        expect(result.result).toMatchObject({ staged: 4, reconstructed: 2, skipped: 1, failed: 1 });
        expect(result.workout).toMatchObject({ staged: 1, reconstructed: 1 });
        expect(result.roster.page.has_more).toBe(true);
        expect(result.next.page.has_more).toBe(false);
        expect(result.entities.entities).toHaveLength(1);
        expect(result.status.entity_counts).toEqual([
          { entity_type: 'clients', committed: 4 },
          { entity_type: 'workouts', committed: 1 },
        ]);
        expect(result.denied).toBe(404);
        expect(
          sql(
            'SELECT count(*) FROM public."ScoutReconstructionLedger" WHERE source_platform IS NULL',
          ),
        ).toBe('5');
        expect(
          result.queries.some((q: string) => q.includes('ON CONFLICT') && q.includes('DO NOTHING')),
        ).toBe(true);
        expect(
          result.queries.some(
            (q: string) => q.includes('ScoutReconstructionLedger') && q.includes('INSERT'),
          ),
        ).toBe(true);
        const ledgerWrites: string[] = result.queries.filter((q: string) =>
          q.startsWith('INSERT INTO "public"."ScoutReconstructionLedger"'),
        );
        expect(ledgerWrites.length).toBeGreaterThan(0);
        for (const query of ledgerWrites) {
          expect(query).toContain('ON CONFLICT ("coach_id","intent_id","entity_type","source_id")');
          expect(query.split(' RETURNING ')[0]).not.toContain('"source_platform"');
        }
        expect(sql(`SELECT count(*) FROM public."Person" WHERE source_person_id='fail'`)).toBe('0');
        // Emit SQL shapes, not parameter payloads, for exact-run attribution.
        console.warn(`G2_${version}_SQL`, JSON.stringify(result.queries));
        if (version === 'expanded')
          expect(
            result.records.every((r: { source_platform: unknown }) => r.source_platform === null),
          ).toBe(true);
        else expect(result.records.every((r: object) => !('source_platform' in r))).toBe(true);
        // Simulate assigned provenance without deploying T: subsequent old/E
        // unchanged service updates must not erase that assignment.
        sql(
          `UPDATE public."ScoutReconstructionLedger" SET source_platform='truecoach' WHERE source_id='a'`,
        );
        const savedTargets = sql(`SELECT jsonb_agg(jsonb_build_array(id,target_id) ORDER BY id)
        FROM public."ScoutReconstructionLedger"`);
        client(
          version === 'old' ? oldModule! : resolve(root, 'node_modules/.prisma/client'),
          version,
        );
        expect(
          sql(`SELECT source_platform FROM public."ScoutReconstructionLedger" WHERE source_id='a'`),
        ).toBe('truecoach');
        expect(
          sql(`SELECT jsonb_agg(jsonb_build_array(id,target_id) ORDER BY id)
        FROM public."ScoutReconstructionLedger"`),
        ).toBe(savedTargets);
      } finally {
        sql(
          'DROP TRIGGER g2_target_refusal ON public."Person"; DROP FUNCTION public.g2_refuse_person()',
        );
      }
    },
  );
  it.each(['anon', 'authenticated'])(
    'retains hostile-policy CRUD denial on staging and ledger for %s',
    (role) => {
      sql(up);
      sql(ledger);
      sql(`INSERT INTO public."ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
      VALUES ('staged','coach','intent','clients','legacy','truecoach','{}')`);
      for (const table of ['ScoutIngestEntity', 'ScoutReconstructionLedger']) {
        sql(
          `CREATE POLICY g2_hostile ON public."${table}" AS PERMISSIVE FOR ALL TO ${role} USING(true) WITH CHECK(true)`,
        );
        try {
          expect(
            sql(`SELECT rolsuper||':'||rolbypassrls FROM pg_roles WHERE rolname='${role}'`),
          ).toBe('false:false');
          expect(sql(`SET ROLE ${role}; SELECT count(*) FROM public."${table}"`)).toBe('SET\n0');
          expect(
            sql(`SET ROLE ${role}; WITH changed AS (UPDATE public."${table}" SET coach_id='bad' RETURNING id)
          SELECT count(*) FROM changed`),
          ).toBe('SET\n0');
          expect(
            sql(`SET ROLE ${role}; WITH changed AS (DELETE FROM public."${table}" RETURNING id)
          SELECT count(*) FROM changed`),
          ).toBe('SET\n0');
          const insert =
            table === 'ScoutIngestEntity'
              ? `INSERT INTO public."${table}" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
             VALUES ('bad','bad','bad','clients','bad','truecoach','{}')`
              : ledger.replace("'legacy'", "'bad'");
          refused(`SET ROLE ${role}; ${insert}`, 'row-level security');
          expect(sql(`SELECT count(*) FROM public."${table}"`)).toBe('1');
        } finally {
          sql(`DROP POLICY g2_hostile ON public."${table}"`);
        }
      }
    },
  );
  it('bounds expansion lock wait and leaves the old writer transaction intact', async () => {
    const holder = spawn(psql!, ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-At', target.psqlUrl], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    holder.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      holder.stdout.on('data', (chunk) => {
        if (String(chunk).includes('G2_LOCKED')) resolveReady();
      });
      holder.once('error', reject);
      holder.once('exit', (code) => {
        if (code !== 0) reject(new Error(stderr));
      });
    });
    holder.stdin.write(`BEGIN; ${ledger}; SELECT 'G2_LOCKED';\n`);
    const timer = setTimeout(() => holder.kill(), 20000);
    try {
      await ready;
      const started = Date.now();
      refused(up, 'lock timeout');
      expect(Date.now() - started).toBeLessThan(15000);
      expect(hasColumn()).toBe('0');
      holder.stdin.end('COMMIT;\n');
      await new Promise<void>((resolveExit, reject) => {
        holder.once('exit', (code) => (code === 0 ? resolveExit() : reject(new Error(stderr))));
      });
      expect(sql('SELECT count(*) FROM public."ScoutReconstructionLedger"')).toBe('1');
      sql(up);
      expect(
        sql(
          'SELECT count(*) FROM public."ScoutReconstructionLedger" WHERE source_platform IS NULL',
        ),
      ).toBe('1');
    } finally {
      clearTimeout(timer);
      if (holder.exitCode === null) holder.kill();
    }
  }, 30000);
});
