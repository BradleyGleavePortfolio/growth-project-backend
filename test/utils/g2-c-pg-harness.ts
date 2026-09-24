/**
 * S7-3' G2 C/contract live-proof helpers: derived by substitution from the accepted N/Q1 harness
 * test/utils/g2-nq1-pg-harness.ts, which stays byte-identical. Same real psql, same real
 * generated Prisma clients in separate OS processes (test/utils/g2-tq0-worker.cjs, shared
 * unchanged), no transaction or query mocks; bound to the C-only identity guard
 * test/utils/g2-c-db.ts and the G2_C_* environment. Only test/rls-g2-c-contract.spec.ts
 * (via test/utils/g2-c-harness.ts) imports this.
 *
 * The "old" process role here is N/Q1 (the accepted N/Q1 head: N writer + Q1 readers with the
 * N client generated in that detached checkout), not T. `worker(..., true)` runs N/Q1. The
 * candidate is C: the same writer/readers on the contracted schema with the C client.
 * OLD_HEAD is a placeholder until the parent records N/Q1 acceptance (phase 2 fill).
 */
import { execFileSync, fork, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_C_ADMIN_ROLE,
  G2_C_MIGRATION_ROLE,
  G2_C_RUNTIME_ROLE,
  g2CTestTarget,
  withFixturePassword,
} from './g2-c-db';

export const root = resolve(__dirname, '..', '..');
export const OLD_HEAD = '29e60705d8c4e1228fd1d2f248c7e53b6b8e56dd';
export const E_MIGRATION = '20270118000000_scout_ledger_platform_expand';

const raw = process.env.G2_C_DATABASE_URL;
const password = process.env.G2_C_PASSWORD;
export const psql = process.env.G2_C_PSQL;
export const oldRoot = process.env.G2_C_OLD_ROOT;
export const oldClient = process.env.G2_C_OLD_CLIENT;
export const directory = process.env.G2_C_DATA_DIRECTORY;
export const expectedVersion = Number(process.env.G2_C_SERVER_VERSION ?? '170006');
if (!raw || !password || !psql || !oldRoot || !oldClient || !directory) {
  throw new Error(
    'C G2 proof requires explicit database, password, psql, data directory, N/Q1 source and N/Q1 client',
  );
}
export const target = g2CTestTarget(raw, process.env.G2_C_CONFIRM);
const psqlEnv = { PATH: process.env.PATH, LC_ALL: 'C', PGPASSWORD: password };
/** psql URL for a fixture matrix role; the password travels only in PGPASSWORD. */
const asRole = (role: string) => {
  const u = new URL(target.psqlUrl);
  u.username = role;
  return u.toString();
};
/** Every harness DDL/data statement runs as the non-superuser BYPASSRLS owner `postgres`. */
export const migrationUrl = asRole(G2_C_MIGRATION_ROLE);
/** Cluster superuser: lock-wait observation in pg_stat_activity only. */
const adminUrl = asRole(G2_C_ADMIN_ROLE);

const psqlRun = (url: string, args: string[], input?: string) =>
  execFileSync(psql!, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', ...args, url], {
    input,
    encoding: 'utf8',
    timeout: 60000,
    env: psqlEnv,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
export const sql = (text: string): string => psqlRun(migrationUrl, [], text);
export const sqlAdmin = (text: string): string => psqlRun(adminUrl, [], text);
/** Operator form: `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>`. The G2 files carry their own
 *  BEGIN/COMMIT, so --single-transaction is redundant there (psql only emits nested-transaction
 *  WARNINGs); it is kept so the harness runs the same command the recovery packet documents.
 *  Recovery semantics themselves are S1-owned; this helper asserts nothing about them. */
export const sqlFile = (file: string): string =>
  psqlRun(migrationUrl, ['--single-transaction', '-f', file]);
export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const json = (text: string) => JSON.parse(sql(text));
export const jsonAdmin = (text: string) => JSON.parse(sqlAdmin(text));
/** Fails when the statement succeeds; the PostgreSQL discriminator is in child stderr. */
export function refused(statement: string, message: string): void {
  let error: unknown;
  try {
    sql(statement);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error('SQL unexpectedly succeeded');
  expect(String(error)).toContain(message);
}

export const stageSql = resolve(root, 'prisma/migrations', E_MIGRATION);
export const upFile = resolve(stageSql, 'migration.sql');
export const downFile = resolve(stageSql, 'down.sql');
export const up = readFileSync(upFile, 'utf8');
export const down = readFileSync(downFile, 'utf8');
export const hasColumn = () =>
  sql(`SELECT count(*) FROM pg_attribute WHERE
  attrelid='public."ScoutReconstructionLedger"'::regclass AND attname='source_platform' AND NOT attisdropped`);
export const appliedMigrations = () =>
  sql(`SELECT count(*) FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);

/** Ledger rows in a scope, ordered deterministically; provenance column optional pre-E. */
export const records = (coach = 'coach', intent = 'intent', family?: string) =>
  json(
    `SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY entity_type,source_id,id),'[]')
  FROM "ScoutReconstructionLedger" l WHERE coach_id=${quote(coach)} AND intent_id=${quote(intent)}
  ${family ? `AND entity_type=${quote(family)}` : ''}`,
  );
export const allLedger = () =>
  json(`SELECT COALESCE(jsonb_agg(to_jsonb(l)
  ORDER BY coach_id,intent_id,entity_type,source_id,id),'[]') FROM "ScoutReconstructionLedger" l`);
export const targets = (coach = 'coach') =>
  json(`SELECT jsonb_build_object(
  'persons',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM "Person" p WHERE coach_id=${quote(coach)}),
  'entities',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM "ScoutReconstructedEntity" e WHERE coach_id=${quote(coach)}))`);
export const catalog = () =>
  sql(`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_array(oid,relname,relrowsecurity,relforcerowsecurity) ORDER BY relname)
    FROM pg_class WHERE oid IN ('public."ScoutIngestEntity"'::regclass,'public."ScoutReconstructionLedger"'::regclass,
      'public."Person"'::regclass,'public."ScoutReconstructedEntity"'::regclass)),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(indexrelid,pg_get_indexdef(indexrelid)) ORDER BY indexrelid)
    FROM pg_index WHERE indrelid IN ('public."ScoutIngestEntity"'::regclass,'public."ScoutReconstructionLedger"'::regclass,
      'public."Person"'::regclass,'public."ScoutReconstructedEntity"'::regclass)),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
    WHERE schemaname='public' AND tablename IN ('ScoutIngestEntity','ScoutReconstructionLedger','Person','ScoutReconstructedEntity')))`);

export function settle(coach = 'coach', intent = 'intent') {
  sql(`INSERT INTO "ScoutImport" (id,coach_id,intent_id,state,terminal_status)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},'settled','success')
    ON CONFLICT DO NOTHING`);
}
export function stage(
  source = 'a',
  family = 'clients',
  platform = 'truecoach',
  name = 'Synthetic A',
  coach = 'coach',
  intent = 'intent',
) {
  // Primary key includes family AND platform so a same-source collision can only fire on the
  // product's identity key (narrow before C, wide after), never on the harness's own id.
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    VALUES (${quote(`${coach}-${intent}-${family}-${platform}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},
    ${quote(source)},${quote(platform)},${quote(JSON.stringify({ name, client_id: 'client-new' }))})`);
}
/**
 * A canonical platform token (R CHECK `^[a-z0-9][a-z0-9._:-]{0,255}$`) with NO registered source
 * mapper. The product's own family dispatch (src/scout/reconstruct/families.ts, byte-identical on
 * the N and T heads) records such a row `skipped` with reason `unsupported_platform:<token>`; it is
 * the one non-success outcome the current product reaches from staged data alone (every registered
 * mapper is total, and a noncanonical token is a structural 409, not a ledger outcome).
 */
export const UNMAPPED_PLATFORM = 'auto:other.example';
export const UNMAPPED_REASON = `unsupported_platform:${UNMAPPED_PLATFORM}`;
/** Bulk synthetic staging through generate_series; names are synthetic, no customer data.
 *  `skipEvery` > 0 stages every k-th row under UNMAPPED_PLATFORM (a genuine, data-reachable
 *  `skipped`); the other rows carry `platform`. */
export function stageMany(
  count: number,
  family = 'clients',
  platform = 'truecoach',
  coach = 'coach',
  intent = 'intent',
  skipEvery = 0,
  prefix = 's',
) {
  sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
    SELECT ${quote(`${coach}-${intent}-${prefix}`)}||lpad(n::text,5,'0'),${quote(coach)},${quote(intent)},${quote(family)},
      ${quote(prefix)}||lpad(n::text,5,'0'),
      CASE WHEN ${skipEvery} > 0 AND n % ${skipEvery} = 0 THEN ${quote(UNMAPPED_PLATFORM)} ELSE ${quote(platform)} END,
      jsonb_build_object('name','Synthetic '||n,'client_id','client-'||n)
    FROM generate_series(1,${count}) n`);
}
/** How many of `count` rows `stageMany(..., skipEvery)` stages under UNMAPPED_PLATFORM. */
export const skippedOf = (count: number, skipEvery: number) =>
  skipEvery > 0 ? Math.floor(count / skipEvery) : 0;
export function legacy(
  status: string,
  platform: string | null | 'ABSENT' = null,
  source = 'a',
  family = 'clients',
  coach = 'coach',
  intent = 'intent',
) {
  const withColumn = platform !== 'ABSENT';
  sql(`INSERT INTO "ScoutReconstructionLedger"
    (id,coach_id,intent_id,entity_type,source_id,${withColumn ? 'source_platform,' : ''}status,target_id,reason)
    VALUES (${quote(`${coach}-${intent}-${family}-${source}`)},${quote(coach)},${quote(intent)},${quote(family)},${quote(source)},
    ${withColumn ? `${platform === null ? 'NULL' : quote(platform)},` : ''}${quote(status)},'saved-target','saved-reason')`);
}
export function resetData() {
  sql(`DELETE FROM "ScoutReconstructionLedger"; DELETE FROM "ScoutIngestEntity";
    DELETE FROM "Person"; DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "ScoutImport";`);
  settle();
}

export type Result = { result?: any; failure?: any; queries: string[]; events: any[]; pid: number };
let sequence = 0;
export function worker(options: Record<string, unknown> = {}, old = false) {
  const name = `g2c_${++sequence}`;
  const service = new URL(withFixturePassword(target.prismaUrl, password, G2_C_RUNTIME_ROLE));
  service.searchParams.set('application_name', name);
  const config = {
    root: old ? oldRoot : root,
    client: old ? oldClient : resolve(root, 'node_modules/.prisma/client'),
    url: service.toString(),
    coach: 'coach',
    intent: 'intent',
    family: 'clients',
    ...options,
  };
  const child = fork(resolve(root, 'test/utils/g2-tq0-worker.cjs'), [], {
    cwd: root,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: {
      ...process.env,
      G2_TQ0_WORKER: JSON.stringify(config),
      TS_NODE_PROJECT: resolve(root, 'tsconfig.json'),
    },
    silent: true,
  });
  let output = '';
  child.stdout!.on('data', (b) => {
    output += String(b);
  });
  child.stderr!.on('data', (b) => {
    output += String(b);
  });
  const timer = setTimeout(() => child.kill(), 90000);
  let readyResolve: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  const done = new Promise<Result>((resolveDone, reject) => {
    let result: Result | undefined;
    child.on('message', (message: any) => {
      if (message.ready) readyResolve();
      if (message.done) result = message;
    });
    child.on('error', reject);
    // 'exit' can precede delivery of the final IPC message; settle only after both the exit code
    // and the IPC channel close ('disconnect') are known.
    let exitCode: number | null | undefined;
    let disconnected = false;
    const settleWorker = () => {
      if (exitCode === undefined || !(disconnected || result)) return;
      const code = exitCode;
      clearTimeout(timer);
      if (code !== 0 || !result) {
        reject(new Error(`worker exited ${code}: ${output}`));
        return;
      }
      // Query shapes, outcomes, fixture identifiers and process IDs only; never parameters.
      console.warn(
        'PG17_PROCESS',
        JSON.stringify({
          name,
          old,
          options: { ...options, cursor: options.cursor ? '<cursor>' : undefined },
          result: result.result,
          failure: result.failure,
          queries: result.queries.length,
          pid: result.pid,
        }),
      );
      resolveDone(result);
    };
    child.on('disconnect', () => {
      disconnected = true;
      settleWorker();
    });
    child.on('exit', (code) => {
      exitCode = code;
      settleWorker();
    });
  });
  return {
    done,
    ready: options.pause
      ? Promise.race([
          ready,
          done.then(() => {
            throw new Error('barrier not reached');
          }),
        ])
      : Promise.resolve(),
    release: () => child.send('continue'),
    stop: () => child.kill(),
    name,
  };
}
export const run = (options: Record<string, unknown> = {}, old = false) =>
  worker(options, old).done;
export async function blocked(name: string) {
  for (let n = 0; n < 400; n++) {
    // Other roles' wait events are visible only to a superuser/pg_read_all_stats; observe as admin.
    const rows =
      jsonAdmin(`SELECT COALESCE(jsonb_agg(jsonb_build_object('wait',wait_event,'type',wait_event_type)),'[]')
      FROM pg_stat_activity WHERE application_name=${quote(name)} AND wait_event_type='Lock'`);
    if (rows.length > 0) {
      console.warn('PG17_BLOCKED', JSON.stringify({ name, rows }));
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('expected observed PostgreSQL lock wait');
}
/** A psql session (default: runtime role service_role) holding an open transaction until released. */
export function holdTransaction(statements: string, role: string = G2_C_RUNTIME_ROLE) {
  const holder = spawn(psql!, ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', asRole(role)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: psqlEnv,
  });
  let output = '';
  holder.stderr.on('data', (b) => {
    output += String(b);
  });
  const held = new Promise<void>((r, reject) => {
    holder.stdout.on('data', (b) => {
      if (String(b).includes('HELD')) r();
    });
    holder.on('exit', (code) => {
      if (code !== 0) reject(new Error(`holder exited ${code}: ${output}`));
    });
  });
  holder.stdin.write(`BEGIN; ${statements}; SELECT 'HELD';\n`);
  return {
    held,
    release: () => holder.stdin.end('COMMIT;\n'),
    // C addition: end the held transaction WITHOUT committing (an in-flight ingest that never lands).
    rollback: () => holder.stdin.end('ROLLBACK;\n'),
    kill: () => holder.kill(),
  };
}
export const holdAdvisory = (key: number) =>
  holdTransaction(`SELECT pg_advisory_xact_lock(${key})`, G2_C_MIGRATION_ROLE);
export const encoded = (s: string) => Buffer.from(s).toString('base64url');
/** Q0's roster legacy token: bare base64url(source_id). */
export const legacyRosterCursor = (s: string) => encoded(s);
export const legacyEntityCursor = (family: string, s: string) =>
  encoded(
    JSON.stringify({
      c: 'coach',
      i: 'intent',
      f: family,
      o: 'source_id:asc',
      s,
    }),
  );
export const v2 = (
  family: string,
  source = 'a',
  platform = 'truecoach',
  coach = 'coach',
  intent = 'intent',
) =>
  `v2.${encoded(
    JSON.stringify({
      v: 2,
      c: coach,
      i: intent,
      f: family,
      o: 'source_id:asc,source_platform:asc',
      s: source,
      p: platform,
    }),
  )}`;
export const gitShow = (spec: string) =>
  execFileSync('git', ['show', spec], { cwd: root, encoding: 'utf8' });
/** Prisma CLI as the migration role (`postgres`), exactly like the release mechanism. */
export function prisma(schemaRoot: string, args: string[]): { ok: boolean; output: string } {
  const url = withFixturePassword(target.prismaUrl, password, G2_C_MIGRATION_ROLE);
  try {
    const output = execFileSync(
      resolve(root, 'node_modules/.bin/prisma'),
      [...args, '--schema', 'prisma/schema.prisma'],
      {
        cwd: schemaRoot,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}
export function prismaMigrateDeploy(schemaRoot: string): string {
  const result = prisma(schemaRoot, ['migrate', 'deploy']);
  if (!result.ok) throw new Error(`prisma migrate deploy failed: ${result.output}`);
  return result.output;
}
