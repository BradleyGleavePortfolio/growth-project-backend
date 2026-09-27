/**
 * S8-F G2 live-proof helpers: derived by substitution and REDUCTION from the S8-B harness
 * test/utils/g2-s8b-pg-harness.ts (unchanged; it keeps governing the S8-B proof). Same real psql,
 * same real generated Prisma client in a separate OS process (the committed, unchanged
 * test/utils/g2-tq0-worker.cjs drives the real ScoutEntitiesService / ScoutRosterService readers),
 * no transaction or query mocks; bound to the S8-F-only identity guard test/utils/g2-s8f-db.ts and
 * the G2_S8F_* environment. Only test/rls-g2-s8f.spec.ts imports this.
 *
 * S8-F ships no migration and no writer, so there is NO "old" side here: the candidate client is
 * the only image, and the fixture rows a writer would have produced (typed ledger rows, native
 * WorkoutPlan/WorkoutProgram rows, ImportNativeProvenance rows) are seeded by SQL as the
 * non-superuser BYPASSRLS owner `postgres`. Synthetic identifiers only; no customer data.
 *
 * PREPARED, NOT EXECUTED by the S8-F source-preparation lane.
 */
import { execFileSync, fork } from 'child_process';
import { resolve } from 'path';
import {
  G2_S8F_ADMIN_ROLE,
  G2_S8F_MIGRATION_ROLE,
  G2_S8F_RUNTIME_ROLE,
  g2S8fTestTarget,
  withFixturePassword,
} from './g2-s8f-db';

export const root = resolve(__dirname, '..', '..');

const raw = process.env.G2_S8F_DATABASE_URL;
const password = process.env.G2_S8F_PASSWORD;
export const psql = process.env.G2_S8F_PSQL;
export const expectedVersion = Number(process.env.G2_S8F_SERVER_VERSION ?? '170006');
if (!raw || !password || !psql) {
  throw new Error('S8-F G2 proof requires explicit database, password and psql');
}
export const target = g2S8fTestTarget(raw, process.env.G2_S8F_CONFIRM);
const psqlEnv = { PATH: process.env.PATH, LC_ALL: 'C', PGPASSWORD: password };
/** psql URL for a fixture matrix role; the password travels only in PGPASSWORD. */
const asRole = (role: string) => {
  const u = new URL(target.psqlUrl);
  u.username = role;
  return u.toString();
};
/** Every harness data statement runs as the non-superuser BYPASSRLS owner `postgres`. */
export const migrationUrl = asRole(G2_S8F_MIGRATION_ROLE);
/** Cluster superuser: identity observation only (cluster_name, database comment). */
const adminUrl = asRole(G2_S8F_ADMIN_ROLE);

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

export type Result = { result?: any; failure?: any; queries: string[]; events: any[]; pid: number };
let sequence = 0;
/** One real reader call in an independent OS process with the candidate generated client.
 *  `options.action` ∈ `entities` | `roster`; see the unchanged test/utils/g2-tq0-worker.cjs. The
 *  worker never receives a raw payload, and the harness logs query shapes/outcomes only. */
export function worker(options: Record<string, unknown> = {}) {
  const name = `g2f_${++sequence}`;
  const service = new URL(withFixturePassword(target.prismaUrl, password, G2_S8F_RUNTIME_ROLE));
  service.searchParams.set('application_name', name);
  const config = {
    root,
    client: resolve(root, 'node_modules/.prisma/client'),
    url: service.toString(),
    coach: 'coach',
    intent: 'intent',
    family: 'workouts',
    action: 'entities',
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
  const done = new Promise<Result>((resolveDone, reject) => {
    let result: Result | undefined;
    child.on('message', (message: any) => {
      if (message.done) result = message;
    });
    child.on('error', reject);
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
  return { done, stop: () => child.kill(), name };
}
export const run = (options: Record<string, unknown> = {}) => worker(options).done;

// ─── Synthetic fixture seeding (owner role; BYPASSRLS; no customer data) ───────────────────────

/** Synthetic owner row (User is the FK target of WorkoutPlan/WorkoutProgram.coach_id). */
export function ensureUser(coach: string) {
  sql(`INSERT INTO "User" (id,supabase_id,email,name,role)
    VALUES (${quote(coach)},${quote(`sb-${coach}`)},${quote(`${coach}@synthetic.invalid`)},${quote(`Synthetic ${coach}`)},'coach')
    ON CONFLICT (id) DO NOTHING`);
}
/** Settled run row: the gate both readers re-run inside their one RepeatableRead snapshot. */
export function settle(coach = 'coach', intent = 'intent', terminal: string | null = 'success') {
  ensureUser(coach);
  sql(`INSERT INTO "ScoutImport" (id,coach_id,intent_id,state,terminal_status)
    VALUES (${quote(`${coach}-${intent}`)},${quote(coach)},${quote(intent)},
      ${terminal === null ? "'in_progress'" : "'settled'"},${terminal === null ? 'NULL' : quote(terminal)})
    ON CONFLICT DO NOTHING`);
}
/** One ledger row in the S8-B shape (nullable target_kind). `kind` null = legacy row. */
export function ledger(row: {
  source: string;
  status?: string;
  targetId?: string | null;
  kind?: string | null;
  family?: string;
  platform?: string;
  coach?: string;
  intent?: string;
}) {
  const coach = row.coach ?? 'coach';
  const intent = row.intent ?? 'intent';
  sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,target_kind)
    VALUES (gen_random_uuid(),${quote(coach)},${quote(intent)},${quote(row.family ?? 'workouts')},${quote(row.source)},
      ${quote(row.platform ?? 'truecoach')},${quote(row.status ?? 'reconstructed')},
      ${row.targetId === null || row.targetId === undefined ? 'NULL' : quote(row.targetId)},
      ${row.kind === null || row.kind === undefined ? 'NULL' : quote(row.kind)})`);
}
/** Generic evidence row (the legacy NULL-kind target of a `scout_entity` ledger row). */
export function evidence(id: string, source: string, coach = 'coach', family = 'workouts') {
  sql(`INSERT INTO "ScoutReconstructedEntity" (id,coach_id,source_platform,entity_type,source_id,client_source_id,label,created_at,updated_at)
    VALUES (${quote(id)},${quote(coach)},'truecoach',${quote(family)},${quote(source)},'tc_client_1',${quote(`Evidence ${source}`)},now(),now())`);
}
/** Native WorkoutPlan row; synthetic name; optionally archived. */
export function plan(id: string, coach = 'coach', name = `Plan ${id}`, archived = false) {
  ensureUser(coach);
  sql(`INSERT INTO "WorkoutPlan" (id,coach_id,name,type,created_at,updated_at,archived_at)
    VALUES (${quote(id)},${quote(coach)},${quote(name)},'strength',now(),now(),${archived ? 'now()' : 'NULL'})`);
}
/** Native WorkoutProgram row; owner = coach; default visibility; synthetic name. */
export function program(id: string, coach = 'coach', name = `Program ${id}`, archived = false) {
  ensureUser(coach);
  sql(`INSERT INTO "WorkoutProgram" (id,coach_id,owner_user_id,name,weeks,days_per_week,created_at,updated_at,archived_at)
    VALUES (${quote(id)},${quote(coach)},${quote(coach)},${quote(name)},1,1,now(),now(),${archived ? 'now()' : 'NULL'})`);
}
let provenanceSequence = 0;
/** One provenance record in the S8-B/S8-C writer's shape (no import_intent_id: the reader must
 *  not need one). `outcome` unresolved ⇒ native_id NULL + reason, per the shape CHECKs. */
export function vouch(row: {
  kind: string;
  nativeId: string | null;
  source: string;
  outcome?: string;
  coach?: string;
  family?: string;
  namespace?: string;
}) {
  const outcome = row.outcome ?? 'created';
  sql(`INSERT INTO "ImportNativeProvenance" (id,coach_id,import_intent_id,source_namespace,entity_type,source_id,native_kind,native_id,outcome,reason)
    VALUES (${quote(`prov-${++provenanceSequence}`)},${quote(row.coach ?? 'coach')},NULL,${quote(row.namespace ?? 'truecoach')},
      ${quote(row.family ?? 'workouts')},${quote(row.source)},${quote(row.kind)},
      ${row.nativeId === null ? 'NULL' : quote(row.nativeId)},${quote(outcome)},
      ${outcome === 'unresolved' ? "'fixture:unresolved'" : 'NULL'})`);
}
export function resetData() {
  sql(`DELETE FROM "ImportNativeProvenance"; DELETE FROM "ScoutReconstructionLedger";
    DELETE FROM "ScoutReconstructedEntity"; DELETE FROM "WorkoutPlan"; DELETE FROM "WorkoutProgram";
    DELETE FROM "Person"; DELETE FROM "ScoutImport";`);
}
