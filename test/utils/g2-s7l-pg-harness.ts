/**
 * S7-L G2 live-proof helpers: derived as code patterns from the accepted S8-B harness
 * test/utils/g2-s8b-pg-harness.ts (itself a substitution of the N/Q1 harness), which stays
 * byte-identical. Same real psql, same real generated Prisma clients in separate OS processes
 * (test/utils/g2-s7l-worker.cjs drives the real ScoutLifecycleService / ScoutIngestService /
 * ScoutService writers and readers with IPC barriers), no transaction or query mocks; bound to the
 * S7-L-only identity guard test/utils/g2-s7l-db.ts and the G2_S7L_* environment. Only
 * test/rls-g2-s7l.spec.ts (via test/utils/g2-s7l-harness.ts) imports this.
 *
 * The "old" process role here is the S7-L base head (OLD_HEAD: the accepted S8-B head 93389265)
 * with the OLD client generated in that detached checkout, i.e. an image that knows nothing about
 * the ScoutImport lifecycle columns or the lifecycle module. `worker(..., true)` runs it. The
 * barrier helpers (`ready`/`release`) follow the N/Q1 pattern because L07-L10 pause real writers
 * at the §3.1 gate.
 */
import { execFileSync, fork, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  G2_S7L_ADMIN_ROLE,
  G2_S7L_MIGRATION_ROLE,
  G2_S7L_RUNTIME_ROLE,
  g2S7lTestTarget,
  withFixturePassword,
} from './g2-s7l-db';

export const root = resolve(__dirname, '..', '..');
/** OLD side pin (kept identical in test/utils/g2-s7l-bootstrap.sh and g2-s7l-old-root.sh). */
export const OLD_HEAD = '93389265a846095b846fa8f1fb0dad782fb6ee9f';
export const S7L_MIGRATION = '20270123000000_scout_run_lifecycle_expand';

const raw = process.env.G2_S7L_DATABASE_URL;
const password = process.env.G2_S7L_PASSWORD;
export const psql = process.env.G2_S7L_PSQL;
export const oldRoot = process.env.G2_S7L_OLD_ROOT;
export const oldClient = process.env.G2_S7L_OLD_CLIENT;
export const directory = process.env.G2_S7L_DATA_DIRECTORY;
export const expectedVersion = Number(process.env.G2_S7L_SERVER_VERSION ?? '170006');
if (!raw || !password || !psql || !oldRoot || !oldClient || !directory) {
  throw new Error(
    'S7-L G2 proof requires explicit database, password, psql, data directory, OLD source and OLD client',
  );
}
export const target = g2S7lTestTarget(raw, process.env.G2_S7L_CONFIRM);
const psqlEnv = { PATH: process.env.PATH, LC_ALL: 'C', PGPASSWORD: password };
/** psql URL for a fixture matrix role; the password travels only in PGPASSWORD. */
const asRole = (role: string) => {
  const u = new URL(target.psqlUrl);
  u.username = role;
  return u.toString();
};
/** Every harness DDL/data statement runs as the non-superuser BYPASSRLS owner `postgres`. */
export const migrationUrl = asRole(G2_S7L_MIGRATION_ROLE);
/** Cluster superuser: lock-wait observation in pg_stat_activity only. */
const adminUrl = asRole(G2_S7L_ADMIN_ROLE);

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
/** The same statement text as another fixture-matrix role (runtime `service_role`, or an API
 *  role reached through SET ROLE from the owner session in the statement itself). */
export const sqlAs = (role: string, text: string): string => psqlRun(asRole(role), [], text);
/** Operator form: `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>`. S7-L's files carry
 *  their own BEGIN/COMMIT, so --single-transaction is redundant (psql only emits nested-transaction
 *  WARNINGs); it is kept so the harness runs the same command the CI dry-run and the recovery
 *  packet document. */
export const sqlFile = (file: string): string =>
  psqlRun(migrationUrl, ['--single-transaction', '-f', file]);
export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const json = (text: string) => JSON.parse(sql(text));
export const jsonAdmin = (text: string) => JSON.parse(sqlAdmin(text));
/** Fails when the statement succeeds; the PostgreSQL discriminator is in child stderr. */
export function refused(statement: string, message: string, role?: string): void {
  let error: unknown;
  try {
    if (role) sqlAs(role, statement);
    else sql(statement);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error('SQL unexpectedly succeeded');
  expect(String(error)).toContain(message);
}
/** Fails when the file applies; used for the refusing entry gates of up and down. */
export function refusedFile(file: string, message: string): void {
  let error: unknown;
  try {
    sqlFile(file);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error('SQL file unexpectedly applied');
  expect(String(error)).toContain(message);
}

export const stageSql = resolve(root, 'prisma/migrations', S7L_MIGRATION);
export const upFile = resolve(stageSql, 'migration.sql');
export const downFile = resolve(stageSql, 'down.sql');
export const up = readFileSync(upFile, 'utf8');
export const down = readFileSync(downFile, 'utf8');
export const appliedMigrations = () =>
  sql(`SELECT count(*) FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);

export type Result = { result?: any; failure?: any; queries: string[]; events: any[]; pid: number };
let sequence = 0;
/** One real service call in an independent OS process with the OLD (pre-S7-L) or the candidate
 *  generated client. `options.action` ∈ start | cancel | ingest | progress | complete | status |
 *  fence | settled; `options.pause` ∈ before-gate | gated | locked; see
 *  test/utils/g2-s7l-worker.cjs. */
export function worker(options: Record<string, unknown> = {}, old = false) {
  const name = `g2l_${++sequence}`;
  const service = new URL(withFixturePassword(target.prismaUrl, password, G2_S7L_RUNTIME_ROLE));
  service.searchParams.set('application_name', name);
  const config = {
    root: old ? oldRoot : root,
    client: old ? oldClient : resolve(root, 'node_modules/.prisma/client'),
    url: service.toString(),
    coach: 'coach',
    intent: 'intent',
    action: 'status',
    ...options,
  };
  const child = fork(resolve(root, 'test/utils/g2-s7l-worker.cjs'), [], {
    cwd: root,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: {
      ...process.env,
      G2_S7L_WORKER: JSON.stringify(config),
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
  let readyResolve: () => void = () => undefined;
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
          options,
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
export function holdTransaction(statements: string, role: string = G2_S7L_RUNTIME_ROLE) {
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
  return { held, release: () => holder.stdin.end('COMMIT;\n'), kill: () => holder.kill() };
}
export const gitShow = (spec: string) =>
  execFileSync('git', ['show', spec], { cwd: root, encoding: 'utf8' });
/** Prisma CLI as the migration role (`postgres`), exactly like the release mechanism. */
export function prisma(schemaRoot: string, args: string[]): { ok: boolean; output: string } {
  const url = withFixturePassword(target.prismaUrl, password, G2_S7L_MIGRATION_ROLE);
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
