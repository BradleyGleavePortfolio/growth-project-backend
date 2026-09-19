// T/Q0 proof: real PostgreSQL15, actual old/T services and separate generated
// clients/processes. No transaction/query mocks. Run only with explicit inputs.
import { execFileSync, fork, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { g2Tq0TestTarget } from './utils/g2-tq0-db';

const root = resolve(__dirname, '..');
const raw = process.env.G2_TQ0_DATABASE_URL;
const psql = process.env.G2_TEST_PSQL;
const oldRoot = process.env.G2_TQ0_OLD_ROOT;
const oldClient = process.env.G2_TQ0_OLD_CLIENT;
const directory = process.env.G2_TEST_DATA_DIRECTORY;
if (!raw || !psql || !oldRoot || !oldClient || !directory) {
  throw new Error('T/Q0 proof requires explicit database, server, old source and old client');
}
const target = g2Tq0TestTarget(raw, process.env.G2_TQ0_CONFIRM);
const sql = (text: string): string => execFileSync(
  psql!, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', target.psqlUrl],
  { input: text, encoding: 'utf8', timeout: 40000, env: { PATH: process.env.PATH, LC_ALL: 'C' } },
).trim();
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const json = (text: string) => JSON.parse(sql(text));
const records = () => json(`SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY source_id,id),'[]')
  FROM "ScoutReconstructionLedger" l`);
const targets = () => json(`SELECT jsonb_build_object(
  'persons',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM "Person" p),
  'entities',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM "ScoutReconstructedEntity" e))`);
function stage(source = 'a', family = 'clients', platform = 'truecoach', name = 'Synthetic A',
  coach = 'coach', intent = 'intent') {
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify({ name, client_id: 'client-new' }))})`);
}
function legacy(status: string, platform: string | null = null, source = 'a', family = 'clients') {
  sql(`INSERT INTO "ScoutReconstructionLedger"
    (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,reason)
    VALUES (${quote(source)},'coach','intent',${quote(family)},${quote(source)},
    ${platform === null ? 'NULL' : quote(platform)},${quote(status)},'saved-target','saved-reason')`);
}
type Result = { result?: any; failure?: any; queries: string[]; events: any[]; pid: number };
let sequence = 0;
function worker(options: Record<string, unknown> = {}, old = false) {
  const service = new URL(target.prismaUrl);
  service.username = 'service_role';
  const name = `g2t_${++sequence}`;
  service.searchParams.set('application_name', name);
  const config = {
    root: old ? oldRoot : root,
    client: old ? oldClient : resolve(root, 'node_modules/.prisma/client'),
    url: service.toString(), coach: 'coach', intent: 'intent', family: 'clients', ...options,
  };
  const child = fork(resolve(__dirname, 'utils/g2-tq0-worker.cjs'), [], {
    cwd: root, execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, G2_TQ0_WORKER: JSON.stringify(config), TS_NODE_PROJECT: resolve(root, 'tsconfig.json') },
    silent: true,
  });
  let output = '';
  child.stdout!.on('data', (b) => { output += String(b); });
  child.stderr!.on('data', (b) => { output += String(b); });
  const timer = setTimeout(() => child.kill(), 30000);
  let readyResolve: () => void;
  const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady; });
  const done = new Promise<Result>((resolveDone, reject) => {
    let result: Result | undefined;
    child.on('message', (message: any) => {
      if (message.ready) readyResolve();
      if (message.done) result = message;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !result) { reject(new Error(`worker exited ${code}: ${output}`)); return; }
      // Query shapes, outcomes, fixture identifiers and process IDs are retained.
      console.warn('TQ0_PROCESS', JSON.stringify({ name, old, options, ...result }));
      resolveDone(result);
    });
  });
  // Ensure an early child failure rejects barriers rather than hanging the test.
  return { done, ready: options.pause
    ? Promise.race([ready, done.then(() => { throw new Error('barrier not reached'); })])
    : Promise.resolve(),
    release: () => child.send('continue'), stop: () => child.kill(), name };
}
const run = (options: Record<string, unknown> = {}, old = false) => worker(options, old).done;
async function blocked(name: string) {
  for (let n = 0; n < 100; n++) {
    const rows = json(`SELECT COALESCE(jsonb_agg(jsonb_build_object('query',query,
      'wait',wait_event,'type',wait_event_type)),'[]') FROM pg_stat_activity
      WHERE application_name=${quote(name)} AND wait_event_type='Lock'`);
    if (rows.length > 0) {
      console.warn('TQ0_BLOCKED', JSON.stringify({ name, rows }));
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('expected observed PostgreSQL lock wait');
}
const encoded = (s: string) => Buffer.from(s).toString('base64url');
const v2 = (family: string, source = 'a', platform = 'truecoach') => `v2.${encoded(JSON.stringify({
  v: 2, c: 'coach', i: 'intent', f: family, o: 'source_id:asc,source_platform:asc',
  s: source, p: platform,
}))}`;

beforeAll(() => {
  const identity = json(`SELECT jsonb_build_object('database',current_database(),
    'address',inet_server_addr(),'port',inet_server_port(),'directory',current_setting('data_directory'),
    'version',current_setting('server_version_num'),'user',current_user)`);
  expect(identity).toMatchObject({ database: 'g2_tq0_disposable', address: '127.0.0.1',
    port: 55439, directory, user: 'user' });
  expect(Number(identity.version)).toBeGreaterThanOrEqual(150000);
  expect(Number(identity.version)).toBeLessThan(160000);
  expect(directory).toMatch(/\/execution\/c1-builder\/pg-data$/);
  expect(sql(`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL`)).toBe('165');
  expect(readFileSync(resolve(oldClient!, 'schema.prisma'), 'utf8')).not.toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform/,
  );
  expect(readFileSync(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8')).toMatch(
    /model ScoutReconstructionLedger \{[^}]*source_platform\s+String\?/,
  );
  // Proves an actual old service, not a T service merely handed the old client.
  expect(readFileSync(resolve(oldRoot!, 'src/scout/scout-reconstruct.service.ts'), 'utf8')).toBe(
    execFileSync('git', ['show', '925780e0a1906593e5383c618311b6b17364b8dc:src/scout/scout-reconstruct.service.ts'],
      { cwd: root, encoding: 'utf8' }),
  );
  console.warn('TQ0_DATABASE', JSON.stringify(identity));
  sql(`ALTER TABLE "Person" ADD CONSTRAINT g2t_target_refusal CHECK (display_name IS DISTINCT FROM 'FAIL');
    ALTER TABLE "ScoutReconstructedEntity" ADD CONSTRAINT g2t_entity_refusal CHECK (label IS DISTINCT FROM 'FAIL');`);
});
beforeEach(() => {
  sql(`DELETE FROM "ScoutReconstructionLedger"; DELETE FROM "ScoutIngestEntity";
    DELETE FROM "Person"; DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutImport";
    INSERT INTO "ScoutImport" (id,coach_id,intent_id,state,terminal_status)
    VALUES ('settled','coach','intent','settled','success');`);
});
afterAll(() => {
  sql(`ALTER TABLE "Person" DROP CONSTRAINT IF EXISTS g2t_target_refusal;
    ALTER TABLE "ScoutReconstructedEntity" DROP CONSTRAINT IF EXISTS g2t_entity_refusal;
    DELETE FROM "ScoutReconstructionLedger"; DELETE FROM "ScoutIngestEntity";
    DELETE FROM "Person"; DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutImport";`);
});

describe('T provenance, atomicity and actual old binaries', () => {
  it('claims only the exact coach/intent/family identity and leaves adjacent tenants untouched', async () => {
    stage();
    legacy('failed');
    sql(`INSERT INTO "ScoutReconstructionLedger"
      (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,reason)
      VALUES ('other-coach','other','intent','clients','a','different','reconstructed','foreign','keep'),
      ('other-intent','coach','other','clients','a','different','reconstructed','foreign','keep'),
      ('other-family','coach','intent','workouts','a','different','reconstructed','foreign','keep')`);
    const before = records().filter((r: any) => r.id !== 'a');
    expect((await run()).result).toEqual({
      intent_id: 'intent', staged: 1, reconstructed: 1, skipped: 0, failed: 0,
    });
    expect(records().filter((r: any) => r.id !== 'a')).toEqual(before);
    const denied = await run({ coach: 'other' });
    expect(denied.failure?.status).toBe(409);
    expect(records().filter((r: any) => r.id !== 'a')).toEqual(before);
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
    expect((await run({ family })).failure).toEqual({
      status: 409, message: 'reconstruction provenance conflict',
    });
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
    expect(targets()).toEqual(before); // Includes names, labels, links and timestamps.
    expect(records()).toEqual(previous);
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
    expect(() => stage('a', 'workouts', 'other')).toThrow();
    sql(`UPDATE "ScoutIngestEntity" SET source_platform='truecoach'`);
    await run();
    expect(() => legacy('skipped', 'other')).toThrow();
    expect(sql(`SELECT count(*) FROM pg_index WHERE indexrelid IN (
      'public."ScoutIngestEntity_coach_id_intent_id_source_id_key"'::regclass,
      'public."ScoutReconstructionLedger_coach_id_intent_id_entity_type_source"'::regclass)
      AND indisunique AND indisvalid`)).toBe('2');
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
    expect(old.queries.filter((q) => q.startsWith('INSERT INTO "public"."ScoutReconstructionLedger"'))
      .every((q) => !q.includes('source_platform'))).toBe(true);
    // O still creates NULL rows after rollback to the old binary.
    stage('b');
    await run({}, true);
    expect(records().find((r: any) => r.source_id === 'b').source_platform).toBeNull();
  });
});

describe('deterministically coordinated T/T and O/T processes', () => {
  it.each([false, true])('concurrent success replays with %s old winner converge on one target', async (old) => {
    stage();
    const first = worker({ pause: 'before-ledger' }, old);
    await first.ready;
    const replay = worker();
    try {
      await blocked(replay.name); // The real Person upsert waits for its winner.
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
    // Advisory barrier is a TEST-ONLY trigger on this disposable database.
    // Both Prisma no-op upserts have read absence before their INSERT waits.
    sql(`CREATE FUNCTION g2t_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(82002); RETURN NEW; END $$;
      CREATE TRIGGER g2t_insert_barrier BEFORE INSERT ON "ScoutReconstructionLedger"
      FOR EACH ROW EXECUTE FUNCTION g2t_insert_barrier()`);
    const holder = spawn(psql!, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', target.psqlUrl],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const held = new Promise<void>((r) => holder.stdout.on('data', (b) => {
      if (String(b).includes('HELD')) r();
    }));
    holder.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(82002); SELECT 'HELD';\n");
    await held;
    const one = worker();
    const two = worker();
    try {
      await blocked(one.name);
      await blocked(two.name);
      holder.stdin.end('COMMIT;\n');
      const results = await Promise.all([one.done, two.done]);
      for (const result of results) expect(result.result).toMatchObject({ skipped: 1, failed: 0 });
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ status: 'skipped', source_platform: 'unsupported' });
      // The loser rolled back its failed INSERT and retried exactly once.
      expect(results.map((r) => r.queries.filter((q) => q === 'ROLLBACK').length).sort())
        .toEqual([0, 1]);
      expect(results.map((r) => r.queries.filter((q) => q === 'BEGIN').length).sort())
        .toEqual([1, 2]);
    } finally {
      one.stop(); two.stop(); holder.kill();
      sql(`DROP TRIGGER g2t_insert_barrier ON "ScoutReconstructionLedger"; DROP FUNCTION g2t_insert_barrier()`);
    }
  });

  it.each(['skip', 'throw', 'success'])('retries real PostgreSQL serialization failure once for %s', async (mode) => {
    stage();
    sql(`CREATE SEQUENCE g2t_attempt;
      GRANT USAGE,SELECT ON SEQUENCE g2t_attempt TO service_role;
      CREATE FUNCTION g2t_transient() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('g2t_attempt')=1 THEN
        RAISE EXCEPTION 'private transient detail' USING ERRCODE='40001';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER g2t_transient BEFORE INSERT ON "ScoutReconstructionLedger"
      FOR EACH ROW EXECUTE FUNCTION g2t_transient()`);
    try {
      const result = await run(mode === 'success' ? {} : { mapper: mode });
      expect(result.failure).toBeUndefined();
      expect(records()[0]).toMatchObject({ source_platform: 'truecoach',
        status: mode === 'skip' ? 'skipped' : mode === 'throw' ? 'failed' : 'reconstructed' });
      expect(sql('SELECT last_value FROM g2t_attempt')).toBe('2');
      expect(result.queries.filter((q) => q === 'ROLLBACK')).toHaveLength(1);
      expect(result.queries.filter((q) => q === 'BEGIN')).toHaveLength(2);
    } finally {
      sql(`DROP TRIGGER g2t_transient ON "ScoutReconstructionLedger"; DROP FUNCTION g2t_transient();
        DROP SEQUENCE g2t_attempt`);
    }
  });

  it('exhausted real ledger serialization conflicts stop after two transactions with no invented tally', async () => {
    stage('a', 'clients', 'unsupported');
    sql(`CREATE SEQUENCE g2t_attempt;
      GRANT USAGE,SELECT ON SEQUENCE g2t_attempt TO service_role;
      CREATE FUNCTION g2t_transient() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('g2t_attempt');
        RAISE EXCEPTION 'private transient detail' USING ERRCODE='40001';
      END $$;
      CREATE TRIGGER g2t_transient BEFORE INSERT ON "ScoutReconstructionLedger"
      FOR EACH ROW EXECUTE FUNCTION g2t_transient()`);
    try {
      const result = await run();
      expect(result.failure).toEqual({ status: 500, message: 'Internal server error', code: 'P2034' });
      expect(result.result).toBeUndefined();
      expect(result.events).toEqual([]);
      expect(sql('SELECT last_value FROM g2t_attempt')).toBe('2');
      expect(records()).toEqual([]);
      expect(result.queries.filter((q) => q === 'ROLLBACK')).toHaveLength(2);
    } finally {
      sql(`DROP TRIGGER g2t_transient ON "ScoutReconstructionLedger"; DROP FUNCTION g2t_transient();
        DROP SEQUENCE g2t_attempt`);
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
      expect(records()[0]).toMatchObject({
        status: old ? 'failed' : 'reconstructed', source_platform: 'truecoach',
      });
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
      expect(records()[0]).toMatchObject({
        status: old ? 'skipped' : 'reconstructed', source_platform: 'truecoach',
      });
      expect(records()[0].target_id === null).toBe(old);
    } finally { success.stop(); skip.stop(); }
  });

  it.each(['skip', 'throw'])('T success upgrades serialized %s while target write is open', async (mode) => {
    stage();
    const success = worker({ pause: 'before-ledger' });
    await success.ready; // Real target upsert has completed inside the open transaction.
    const nonSuccess = mode === 'skip' ? { mapper: 'skip' } : { mapper: 'throw' };
    try {
      expect((await run(nonSuccess)).failure).toBeUndefined();
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

describe('Q0 real scoped reads and unchanged emission', () => {
  it.each(['clients', 'workouts'])('characterizes %s ties ONLY in a temporary future-schema fixture', async (family) => {
    for (const id of ['a', 'b', 'c', 'd']) stage(id, family);
    await run({ family });
    const original = records();
    const key = '"ScoutReconstructionLedger_coach_id_intent_id_entity_type_source"';
    const definition = sql(`SELECT pg_get_indexdef('public.${key}'::regclass)`);
    // Never a shipped migration: restore the exact key in finally after
    // removing only this case's disposable ledger rows.
    sql(`DROP INDEX public.${key};
      UPDATE "ScoutReconstructionLedger" SET source_id='a',source_platform=CASE source_id
        WHEN 'a' THEN 'p1' WHEN 'b' THEN 'p2' ELSE 'p3' END WHERE source_id<>'d';
      UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE source_id='d'`);
    const action = family === 'clients' ? 'roster' : 'entities';
    const visible = (r: any) => family === 'clients' ? r.persons : r.entities;
    const cursor = (r: any) => family === 'clients' ? r.page.next_cursor : r.next_cursor;
    try {
      const page = (await run({ action, family, cursor: v2(family, 'a', 'p1') })).result;
      expect(visible(page).map((r: any) => r.id)).toEqual([original[1].target_id]);
      expect(cursor(page)).toBe(family === 'clients' ? encoded('a') :
        encoded(JSON.stringify({ c: 'coach', i: 'intent', f: family, o: 'source_id:asc', s: 'a' })));
      const chained = (await run({ action, family, cursor: cursor(page) })).result;
      // Explicit Q0 LIMITATION: legacy emission skips remaining tied p3.
      // This is NOT a claim of complete pagination after C; Q1 is required.
      expect(visible(chained).map((r: any) => r.id)).toEqual([original[3].target_id]);
      expect(cursor(chained)).toBeNull();
      const exact = (await run({ action, family, cursor: v2(family, 'a', 'p2') })).result;
      expect(visible(exact).map((r: any) => r.id)).toEqual([original[2].target_id]);
    } finally {
      sql(`DELETE FROM "ScoutReconstructionLedger"; ${definition}`);
    }
  });

  it.each(['clients', 'workouts'])('enumerates exact narrow-schema %s page union and retains NULL legacy history', async (family) => {
    for (const id of ['a', 'b', 'c']) stage(id, family);
    await run({ family });
    const ids = records().map((r: any) => r.target_id);
    sql(`UPDATE "ScoutReconstructionLedger" SET source_platform=NULL WHERE source_id='a'`);
    const action = family === 'clients' ? 'roster' : 'entities';
    const visible = (r: any) => family === 'clients' ? r.persons : r.entities;
    const cursor = (r: any) => family === 'clients' ? r.page.next_cursor : r.next_cursor;
    const union: string[] = [];
    let after: string | undefined;
    for (const id of ['a', 'b', 'c']) {
      const page = await run({ action, family, cursor: after });
      expect(page.failure).toBeUndefined();
      union.push(...visible(page.result).map((r: any) => r.id));
      const next = id === 'c' ? null : family === 'clients' ? encoded(id) :
        encoded(JSON.stringify({ c: 'coach', i: 'intent', f: family, o: 'source_id:asc', s: id }));
      expect(cursor(page.result)).toBe(next);
      expect(page.queries.some((q) => q.includes('REPEATABLE READ'))).toBe(true);
      after = next ?? undefined;
    }
    expect(union).toEqual(ids);
    const composite = await run({ action, family, cursor: v2(family) });
    expect(visible(composite.result).map((r: any) => r.id)).toEqual([ids[1]]);
    expect(cursor(composite.result)).toBe(family === 'clients' ? encoded('b') :
      encoded(JSON.stringify({ c: 'coach', i: 'intent', f: family, o: 'source_id:asc', s: 'b' })));
    expect((await run({ action, family, coach: 'foreign' })).failure?.status).toBe(404);
    expect((await run({ action, family, cursor: v2(family === 'clients' ? 'workouts' : 'clients') })).failure)
      .toEqual({ status: 400, message: 'malformed cursor' });
    // Forged adjacent ledger scopes deliberately reference THIS tenant's
    // legitimate targets: only correct query scope can exclude them.
    sql(`INSERT INTO "ScoutReconstructionLedger"
      (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id)
      VALUES ('foreign-coach','other','intent',${quote(family)},'z','truecoach','reconstructed',${quote(ids[0])}),
      ('foreign-intent','coach','other',${quote(family)},'z','truecoach','reconstructed',${quote(ids[0])}),
      ('foreign-family','coach','intent','client_history','z','truecoach','reconstructed',${quote(ids[0])})`);
    const scoped = await run({ action, family, cursor: v2(family), limit: 200 });
    expect(visible(scoped.result).map((r: any) => r.id)).toEqual(ids.slice(1));
    // Ledger progression survives erased / foreign targets without widening scope.
    const table = family === 'clients' ? 'Person' : 'ScoutReconstructedEntity';
    sql(`UPDATE "${table}" SET coach_id='foreign' WHERE id=${quote(ids[1])};
      DELETE FROM "${table}" WHERE id=${quote(ids[2])}`);
    const hidden = await run({ action, family, cursor: v2(family), limit: 2 });
    expect(visible(hidden.result)).toEqual([]);
    expect(cursor(hidden.result)).toBeNull();
    if (family === 'clients') {
      sql(`UPDATE "Person" SET state='Deleted' WHERE id=${quote(ids[0])}`);
      expect(visible((await run({ action, family, limit: 200 })).result)).toEqual([]);
    } else {
      sql(`UPDATE "ScoutReconstructedEntity" SET entity_type='client_history' WHERE id=${quote(ids[0])}`);
      expect(visible((await run({ action, family, limit: 200 })).result)).toEqual([]);
    }
  });
});
