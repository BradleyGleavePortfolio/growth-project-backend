/**
 * S11 G2 live-proof helpers (the ONE S11 harness, docs/decisions/2026-09-26-s11-journey.md
 * D-S11-6): derived by literal substitution from the landed S9-C harness
 * test/utils/g2-s9c-pg-harness.ts (as landed at 92b96715), which stays byte-identical. Only the lane
 * descriptor differs (G2_S11_* environment, base pin, expected migration count). Same real psql,
 * same real generated Prisma client in separate OS processes (test/utils/g2-s11-worker.cjs drives
 * the real pairing, lifecycle, ingest, progress, settle and read services), no transaction or query
 * mocks; bound to the S11-only identity guard test/utils/g2-s11-db.ts. Two worker processes are two
 * server hosts (D-S11-6). Imported only by test/rls-g2-s11.spec.ts and the S11 real-PG specs under
 * test/scout/s11/ (via test/utils/g2-s11-harness.ts).
 *
 * There is no OLD side: S11-A1 ships no migration, so the base 711c1f8f prisma tree (the landed
 * S10-B tree, through the accepted S10-B observation migration) is the only schema; the accepted
 * S7-L run objects, the S8-B native provenance objects and the S10-B declaration/observation/
 * settled-basis tables are the proof target. No up/down file helpers are carried.
 */
import { execFileSync, fork, spawn } from 'child_process';
import { resolve } from 'path';
import {
  G2_S11_ADMIN_ROLE,
  G2_S11_MIGRATION_ROLE,
  G2_S11_RUNTIME_ROLE,
  G2_S11_BASE_HEAD,
  G2_S11_CANDIDATE_HEAD_ENV,
  g2S11CandidateHead,
  g2S11TestTarget,
  withFixturePassword,
} from './g2-s11-db';

export const root = resolve(__dirname, '..', '..');
/** Base pin (kept identical in test/utils/g2-s11-bootstrap.sh and test/utils/g2-s11-db-guard.spec.ts). */
export const BASE_HEAD: string = G2_S11_BASE_HEAD;
export const S8B_MIGRATION = '20270122000000_scout_native_provenance_expand';
export const S7L_MIGRATION = '20270123000000_scout_run_lifecycle_expand';
export const S10B_MIGRATION = '20270124000000_scout_run_observation_expand';
/** The S10-B run declaration / observation / settled-basis tables (present, RLS on, runtime-revoked). */
export const S10B_TABLES = ['ScoutRunDeclaration', 'ScoutRunObservation', 'ScoutRunSettledBasis'];
/** 172 accepted migrations through S8-B and S7-L plus S10-B = 173 (the last is S10-B); S11-A1 adds none. */
export const EXPECTED_MIGRATIONS = 173;

const raw = process.env.G2_S11_DATABASE_URL;
const password = process.env.G2_S11_PASSWORD;
export const psql = process.env.G2_S11_PSQL;
export const directory = process.env.G2_S11_DATA_DIRECTORY;
export const expectedVersion = Number(process.env.G2_S11_SERVER_VERSION ?? '170006');
if (!raw || !password || !psql || !directory) {
  throw new Error('S11 G2 proof requires explicit database, password, psql and data directory');
}
export const target = g2S11TestTarget(raw, process.env.G2_S11_CONFIRM);
/** The attested candidate head this run is bound to: the runtime root must be exactly there, clean. */
export const candidateHead = g2S11CandidateHead(
  process.env[G2_S11_CANDIDATE_HEAD_ENV],
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
);
const psqlEnv = { PATH: process.env.PATH, LC_ALL: 'C', PGPASSWORD: password };
/** psql URL for a fixture matrix role; the password travels only in PGPASSWORD. */
const asRole = (role: string) => {
  const u = new URL(target.psqlUrl);
  u.username = role;
  return u.toString();
};
/** Every harness DDL/data statement runs as the non-superuser BYPASSRLS owner `postgres`. */
export const migrationUrl = asRole(G2_S11_MIGRATION_ROLE);
/** Cluster superuser: lock-wait observation in pg_stat_activity only. */
const adminUrl = asRole(G2_S11_ADMIN_ROLE);

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
export const appliedMigrations = () =>
  sql(`SELECT count(*) FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);

export type Result = {
  result?: any;
  failure?: any;
  queries: string[];
  events: any[];
  pushes: number;
  /** S11-A1: extension-session mints by the pairing stub (0 for every non-redeem action). */
  mints: number;
  /** S11-A1 fix 3: each push as CALLED on the injected notifications stand-in. */
  pushCalls: { userId: string; kind: string | null }[];
  /** S11-A1 fix 3: every call that reached a spied outbound channel method or transport. */
  outbound: { channel: string; method: string; recipient: unknown }[];
  /** S11-A1 fix 3: the channel methods and transports the worker replaced (non-vacuity). */
  outboundSpied: string[];
  sideEffectLoads: Record<string, number>;
  pid: number;
  families?: string[];
};
let sequence = 0;
/** One real `ScoutReconstructService.reconstruct(coach, intent, family)` call in an independent OS
 *  process with the candidate generated client. `options.spec` / `options.rules` are the raw
 *  fixture source-mapping spec and native rule set the worker parses through the real S8-A /
 *  S9-C parses and injects as the owned family registry AND the facts-service registries; see
 *  test/utils/g2-s11-worker.cjs. */
export function worker(options: Record<string, unknown> = {}) {
  const name = `g2g_${++sequence}`;
  const service = new URL(withFixturePassword(target.prismaUrl, password, G2_S11_RUNTIME_ROLE));
  service.searchParams.set('application_name', name);
  const config = {
    root,
    client: resolve(root, 'node_modules/.prisma/client'),
    head: candidateHead,
    url: service.toString(),
    coach: 'coach',
    intent: 'intent',
    action: 'status',
    family: 'workouts',
    ...options,
  };
  const child = fork(resolve(root, 'test/utils/g2-s11-worker.cjs'), [], {
    cwd: root,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: {
      ...process.env,
      G2_S11_WORKER: JSON.stringify(config),
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
  // Fixture barrier (carried from the N/Q1 harness): `options.pause` names the phase the worker
  // pauses at; `ready` settles when it has, `resume()` releases it.
  let readyResolve: (phase: string) => void = () => undefined;
  const ready = new Promise<string>((r) => {
    readyResolve = r;
  });
  const done = new Promise<Result>((resolveDone, reject) => {
    let result: Result | undefined;
    child.on('message', (message: any) => {
      if (message.done) result = message;
      if (message.ready) readyResolve(message.ready);
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
          options: { ...options, spec: undefined, rules: undefined },
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
  return { done, ready, resume: () => child.send({}), stop: () => child.kill(), name };
}
export const run = (options: Record<string, unknown> = {}) => worker(options).done;
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
export function holdTransaction(statements: string, role: string = G2_S11_RUNTIME_ROLE) {
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
  const url = withFixturePassword(target.prismaUrl, password, G2_S11_MIGRATION_ROLE);
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
