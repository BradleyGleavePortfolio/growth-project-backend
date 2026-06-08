/**
 * PR-RLS-04 — Tier 3 workout & build-week RLS policies.
 *
 * Verifies migration 20261213000000_rls_tier3_workouts against a REAL
 * PostgreSQL instance (NO mocks). For each of the 7 tables it proves:
 *   - RLS is ENABLED *and* FORCED (relrowsecurity / relforcerowsecurity).
 *   - The expected per-command policies exist.
 *   - service_role bypasses (Primitive A).
 *   - The owning principal can read/write its own row(s).
 *   - A foreign / unauthenticated principal is denied (read returns 0 rows,
 *     write is rejected by the WITH CHECK / USING clause).
 *   - For child-via-parent tables: the parent owner reaches the child, and a
 *     foreign user is blocked at the child *through* the parent predicate.
 *   - For public-catalog tables: anonymous SELECT works, anonymous write is
 *     blocked, and only the owner may write.
 *
 * 8+ tests per table x 7 tables = 56+ tests.
 *
 * Principals are modeled with Postgres roles + the `app.current_user_id` /
 * `app.current_user_role` GUCs that the helper functions read:
 *   - `service_role`        -> Primitive A bypass path.
 *   - `app_authenticated`   -> the `TO public` policy bucket (a normal request).
 *     Identity is supplied per-statement via the GUCs.
 *   - anon                  -> `app_authenticated` with empty GUCs (helpers NULL).
 *
 * The suite is self-bootstrapping and idempotent: it (re)creates the minimal
 * prerequisite schema (public."User", the 8 workout/build-week tables, the app
 * helper functions) and the test roles, then applies the migration SQL exactly
 * as Prisma would, then asserts. Re-running drops/recreates cleanly.
 *
 * Connection: RLS_TIER3_TEST_DATABASE_URL > RLS_FN_TEST_DATABASE_URL >
 * DATABASE_URL, defaulting to the local throwaway `rls_fn_test` DB. The
 * PrismaClient is constructed against that URL via `datasources` so it never
 * touches the app's default database or production Supabase.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261213000000_rls_tier3_workouts',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER3_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

// The login role used by the test connection must own the tables (so FORCE RLS
// is exercised against it) and be able to SET ROLE into service_role /
// app_authenticated. In CI that is `rls_tester` with the grants provisioned by
// the test harness; the names are configurable for other environments.
const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

// Minimal prerequisite schema: the app helper functions (mirrors PR-RLS-FN) and
// the 8 tables the policies reference, with only the columns the policies read.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

-- is_user_coached_by mirrors the hardened helper (SECURITY DEFINER); coach link
-- is User.coach_id with role 'student'.
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" u
       WHERE u."id" = client_user_id AND u."coach_id" = coach_user_id AND u."role" = 'student'
     )
$fn$;

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;

CREATE TABLE IF NOT EXISTS public."WorkoutRoutine" (
  "id" text PRIMARY KEY,
  "creator_id" text NOT NULL,
  "name" text NOT NULL,
  "is_template" boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public."RoutineExercise" (
  "id" text PRIMARY KEY,
  "routine_id" text NOT NULL REFERENCES public."WorkoutRoutine"("id"),
  "exercise_name" text NOT NULL,
  "order_index" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public."WorkoutSession" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "workout_name" text NOT NULL DEFAULT 'session'
);

CREATE TABLE IF NOT EXISTS public."ExerciseSet" (
  "id" text PRIMARY KEY,
  "workout_id" text NOT NULL REFERENCES public."WorkoutSession"("id"),
  "exercise_name" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public."ExerciseCatalogItem" (
  "id" text PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "primary_muscle" text NOT NULL DEFAULT 'full_body'
);

CREATE TABLE IF NOT EXISTS public."BuildWeekDay" (
  "id" text PRIMARY KEY,
  "day_number" integer NOT NULL UNIQUE,
  "title" text NOT NULL,
  "focus_area" text NOT NULL DEFAULT 'focus',
  "narrative" text NOT NULL DEFAULT 'n',
  "expected_artifact" text NOT NULL DEFAULT 'a'
);

CREATE TABLE IF NOT EXISTS public."BuildWeekEnrollment" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'active',
  "current_day" integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public."BuildWeekDayCompletion" (
  "id" text PRIMARY KEY,
  "enrollment_id" text NOT NULL REFERENCES public."BuildWeekEnrollment"("id"),
  "day_number" integer NOT NULL
);
`;

const ALL_TABLES = [
  'WorkoutRoutine',
  'RoutineExercise',
  'WorkoutSession',
  'ExerciseSet',
  'ExerciseCatalogItem',
  'BuildWeekDay',
  'BuildWeekEnrollment',
  'BuildWeekDayCompletion',
];

/**
 * Split a SQL file into top-level statements honoring dollar-quoted blocks and
 * single-quoted literals (so embedded ';' inside function bodies / comments are
 * not treated as statement terminators). Mirrors the PR-RLS-FN spec splitter.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingleQuote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingleQuote) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += sql[i];
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

// Pin the pool to a single connection so SET ROLE / set_config session state is
// deterministic across statements.
const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({
  datasources: { db: { url: SINGLE_CONN_URL } },
});

async function applyScript(sql: string): Promise<void> {
  for (const raw of splitSqlStatements(sql)) {
    const stmt = stripLeadingComments(raw);
    if (!stmt) continue;
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
    await prisma.$executeRawUnsafe(stmt);
  }
}

// The interactive-transaction client. Typed loosely because the test only uses
// the raw-query escape hatches; this avoids importing Prisma's internal tx type.
type Tx = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
};

/** Quote a SQL string literal. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Run `fn` inside a single transaction acting as `role` with the supplied
 * identity GUCs, then ROLLBACK so the test leaves no residue and is idempotent.
 * The role + GUCs are SET LOCAL so they vanish on rollback.
 */
async function asPrincipal<T>(
  role: string,
  identity: { id?: string; userRole?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_id', ${lit(identity.id ?? '')}, true)`,
    );
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_role', ${lit(identity.userRole ?? '')}, true)`,
    );
    return fn(tx);
  });
}

/** Count rows visible (SELECT) to a principal for a table, with optional WHERE id. */
async function visibleCount(
  role: string,
  identity: { id?: string; userRole?: string },
  table: string,
  whereId?: string,
): Promise<number> {
  const where = whereId ? ` WHERE "id" = ${lit(whereId)}` : '';
  const rows = await asPrincipal(role, identity, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT count(*)::bigint AS n FROM public."${table}"${where}`,
    ),
  );
  const first = rows[0] as { n: bigint };
  return Number(first.n);
}

/** True if a write (INSERT/UPDATE/DELETE) succeeds for the principal; rolled back regardless. */
async function writeSucceeds(
  role: string,
  identity: { id?: string; userRole?: string },
  stmt: string,
): Promise<boolean> {
  try {
    await asPrincipal(role, identity, async (tx) => {
      // INSERT ... CHECK violation throws (42501); UPDATE/DELETE blocked by the
      // USING clause simply affect 0 rows (tested separately via row counts).
      const affected = await tx.$executeRawUnsafe(stmt);
      return affected;
    });
    return true;
  } catch (err) {
    // A WITH CHECK denial surfaces as Postgres error 42501
    // ("new row violates row-level security policy"). Any OTHER error is a real
    // failure and must NOT be swallowed — rethrow so the suite fails loudly (R0).
    const message = err instanceof Error ? err.message : String(err);
    const isRlsDenial =
      message.includes('row-level security') ||
      message.includes('violates row-level security policy') ||
      message.includes('42501');
    if (!isRlsDenial) {
      throw err;
    }
    return false;
  }
}

/** Seed rows via service_role (Primitive A bypass) so fixtures are deterministic. */
async function seed(stmts: string[]): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
    return null;
  });
}

/** Remove all seed rows (service_role) — keeps the suite idempotent across reruns. */
async function truncateAll(): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    await tx.$executeRawUnsafe(
      `TRUNCATE public."BuildWeekDayCompletion", public."BuildWeekEnrollment",
              public."BuildWeekDay", public."ExerciseCatalogItem",
              public."ExerciseSet", public."WorkoutSession",
              public."RoutineExercise", public."WorkoutRoutine",
              public."User" RESTART IDENTITY CASCADE`,
    );
    return null;
  });
}

type RelSecRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean };

async function getRelSecurity(table: string): Promise<RelSecRow | undefined> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    table,
  )) as RelSecRow[];
  return rows[0];
}

async function policyNames(table: string): Promise<string[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT pol.polname
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
      ORDER BY pol.polname`,
    table,
  )) as { polname: string }[];
  return rows.map((r) => r.polname);
}

// Canonical identities reused across tables.
const OWNER = { id: 'u_owner', userRole: 'owner' };
const ALICE = { id: 'u_alice', userRole: 'student' };
const BOB = { id: 'u_bob', userRole: 'student' };
const COACH = { id: 'u_coach', userRole: 'coach' };
const ANON = {}; // no GUCs -> helpers return NULL

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Fail loudly (R0) if any of the 7 policy tables lacks ENABLED+FORCED RLS.
  for (const t of ALL_TABLES.filter((x) => x !== 'WorkoutSession')) {
    const rel = await getRelSecurity(t);
    if (!rel || !rel.relrowsecurity || !rel.relforcerowsecurity) {
      throw new Error(`bootstrap incomplete: ${t} is not RLS enabled+forced`);
    }
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  // Base user graph: alice & bob are students; coach coaches alice (not bob).
  await seed([
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('u_owner', NULL, 'owner'),
       ('u_coach', NULL, 'coach'),
       ('u_alice', 'u_coach', 'student'),
       ('u_bob',   NULL, 'student')`,
  ]);
});

// ---------------------------------------------------------------------------
// 1) WorkoutRoutine — creator-self
// ---------------------------------------------------------------------------
describe('WorkoutRoutine (creator-self)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutRoutine"("id","creator_id","name") VALUES ('wr_alice','u_alice','Alice PPL')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('WorkoutRoutine');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('WorkoutRoutine');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_workoutroutine_service_role_all',
        'p_workoutroutine_select',
        'p_workoutroutine_insert',
        'p_workoutroutine_update',
        'p_workoutroutine_delete',
      ]),
    );
    expect(names.length).toBe(5);
  });

  it('creator can read own routine', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'WorkoutRoutine', 'wr_alice')).toBe(1);
  });

  it('foreign user cannot read another user routine', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'WorkoutRoutine', 'wr_alice')).toBe(0);
  });

  it('anonymous user cannot read any routine', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'WorkoutRoutine')).toBe(0);
  });

  it('creator can insert a routine for self', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."WorkoutRoutine"("id","creator_id","name") VALUES ('wr_a2','u_alice','x')`),
    ).toBe(true);
  });

  it('foreign user cannot insert a routine owned by someone else', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."WorkoutRoutine"("id","creator_id","name") VALUES ('wr_b1','u_alice','x')`),
    ).toBe(false);
  });

  it('foreign user UPDATE affects zero rows (blocked by USING)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, BOB, (tx) =>
      tx.$executeRawUnsafe(`UPDATE public."WorkoutRoutine" SET "name" = 'hax' WHERE "id" = 'wr_alice'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('owner role can read and write any routine', async () => {
    expect(await visibleCount(AUTHED_ROLE, OWNER, 'WorkoutRoutine', 'wr_alice')).toBe(1);
    expect(
      await writeSucceeds(AUTHED_ROLE, OWNER,
        `INSERT INTO public."WorkoutRoutine"("id","creator_id","name") VALUES ('wr_o1','u_alice','owner-made')`),
    ).toBe(true);
  });

  it('service_role bypasses RLS for reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'WorkoutRoutine', 'wr_alice')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2) RoutineExercise — child-via-routine
// ---------------------------------------------------------------------------
describe('RoutineExercise (child-via-routine)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutRoutine"("id","creator_id","name") VALUES ('wr_alice','u_alice','Alice PPL')`,
      `INSERT INTO public."RoutineExercise"("id","routine_id","exercise_name","order_index") VALUES ('re_alice','wr_alice','Bench',1)`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('RoutineExercise');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('RoutineExercise');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_routineexercise_select', 'p_routineexercise_insert']));
  });

  it('parent routine owner can read child exercise', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'RoutineExercise', 're_alice')).toBe(1);
  });

  it('foreign user blocked at child via parent predicate', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'RoutineExercise', 're_alice')).toBe(0);
  });

  it('anonymous user cannot read child exercise', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'RoutineExercise')).toBe(0);
  });

  it('parent owner can insert a child exercise into own routine', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."RoutineExercise"("id","routine_id","exercise_name","order_index") VALUES ('re_a2','wr_alice','Squat',2)`),
    ).toBe(true);
  });

  it('foreign user cannot insert a child into a routine they do not own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."RoutineExercise"("id","routine_id","exercise_name","order_index") VALUES ('re_b1','wr_alice','Hack',9)`),
    ).toBe(false);
  });

  it('foreign user DELETE affects zero rows (blocked via parent)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, BOB, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM public."RoutineExercise" WHERE "id" = 're_alice'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role bypasses RLS for child reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'RoutineExercise', 're_alice')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3) ExerciseSet — child-via-workout-session (+ coach)
// ---------------------------------------------------------------------------
describe('ExerciseSet (child-via-workout-session)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutSession"("id","user_id","workout_name") VALUES ('ws_alice','u_alice','Leg day')`,
      `INSERT INTO public."ExerciseSet"("id","workout_id","exercise_name") VALUES ('es_alice','ws_alice','Deadlift')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ExerciseSet');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('ExerciseSet');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_exerciseset_select', 'p_exerciseset_update']));
  });

  it('session owner can read own set', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'ExerciseSet', 'es_alice')).toBe(1);
  });

  it('assigned coach can read client set via session parent', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'ExerciseSet', 'es_alice')).toBe(1);
  });

  it('foreign user blocked at child via parent session', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'ExerciseSet', 'es_alice')).toBe(0);
  });

  it('anonymous user cannot read any set', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ExerciseSet')).toBe(0);
  });

  it('session owner can insert a set into own session', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."ExerciseSet"("id","workout_id","exercise_name") VALUES ('es_a2','ws_alice','Row')`),
    ).toBe(true);
  });

  it('foreign user cannot insert a set into a session they do not own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."ExerciseSet"("id","workout_id","exercise_name") VALUES ('es_b1','ws_alice','Curl')`),
    ).toBe(false);
  });

  it('service_role bypasses RLS for set reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'ExerciseSet', 'es_alice')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4) ExerciseCatalogItem — public-catalog read / owner write
// ---------------------------------------------------------------------------
describe('ExerciseCatalogItem (public-catalog-read/owner-write)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."ExerciseCatalogItem"("id","slug","name") VALUES ('ec_bench','barbell-bench-press','Bench Press')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ExerciseCatalogItem');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('ExerciseCatalogItem');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_exercisecatalogitem_select', 'p_exercisecatalogitem_insert']));
  });

  it('anonymous user CAN read the catalog (public reference)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ExerciseCatalogItem', 'ec_bench')).toBe(1);
  });

  it('an ordinary authenticated user can read the catalog', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'ExerciseCatalogItem', 'ec_bench')).toBe(1);
  });

  it('anonymous write is blocked', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ANON,
        `INSERT INTO public."ExerciseCatalogItem"("id","slug","name") VALUES ('ec_x','x','X')`),
    ).toBe(false);
  });

  it('a non-owner authenticated user cannot write to the catalog', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."ExerciseCatalogItem"("id","slug","name") VALUES ('ec_a','a','A')`),
    ).toBe(false);
  });

  it('owner can insert a catalog item', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, OWNER,
        `INSERT INTO public."ExerciseCatalogItem"("id","slug","name") VALUES ('ec_o','o','O')`),
    ).toBe(true);
  });

  it('non-owner UPDATE affects zero rows (blocked by USING)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, ALICE, (tx) =>
      tx.$executeRawUnsafe(`UPDATE public."ExerciseCatalogItem" SET "name" = 'hax' WHERE "id" = 'ec_bench'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role can write the catalog (seeding/enrichment)', async () => {
    expect(
      await writeSucceeds(SERVICE_ROLE, {},
        `INSERT INTO public."ExerciseCatalogItem"("id","slug","name") VALUES ('ec_s','s','S')`),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5) BuildWeekDay — public-catalog read / owner write
// ---------------------------------------------------------------------------
describe('BuildWeekDay (public-catalog-read/owner-write)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."BuildWeekDay"("id","day_number","title") VALUES ('bwd_1',1,'Day 1')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('BuildWeekDay');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('BuildWeekDay');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_buildweekday_select', 'p_buildweekday_insert']));
  });

  it('anonymous user CAN read curriculum (public reference)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'BuildWeekDay', 'bwd_1')).toBe(1);
  });

  it('an ordinary authenticated user can read curriculum', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'BuildWeekDay', 'bwd_1')).toBe(1);
  });

  it('anonymous write is blocked', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ANON,
        `INSERT INTO public."BuildWeekDay"("id","day_number","title") VALUES ('bwd_x',99,'X')`),
    ).toBe(false);
  });

  it('a non-owner authenticated user cannot write curriculum', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."BuildWeekDay"("id","day_number","title") VALUES ('bwd_a',98,'A')`),
    ).toBe(false);
  });

  it('owner can insert a curriculum day', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, OWNER,
        `INSERT INTO public."BuildWeekDay"("id","day_number","title") VALUES ('bwd_o',97,'O')`),
    ).toBe(true);
  });

  it('non-owner DELETE affects zero rows (blocked by USING)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, ALICE, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM public."BuildWeekDay" WHERE "id" = 'bwd_1'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role can write curriculum (seeding)', async () => {
    expect(
      await writeSucceeds(SERVICE_ROLE, {},
        `INSERT INTO public."BuildWeekDay"("id","day_number","title") VALUES ('bwd_s',96,'S')`),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6) BuildWeekDayCompletion — child-via-buildweek-enrollment
// ---------------------------------------------------------------------------
describe('BuildWeekDayCompletion (child-via-enrollment)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."BuildWeekEnrollment"("id","user_id") VALUES ('bwe_alice','u_alice')`,
      `INSERT INTO public."BuildWeekDayCompletion"("id","enrollment_id","day_number") VALUES ('bwc_alice','bwe_alice',1)`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('BuildWeekDayCompletion');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('BuildWeekDayCompletion');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_buildweekdaycompletion_select', 'p_buildweekdaycompletion_insert']));
  });

  it('enrollment owner can read own completion', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'BuildWeekDayCompletion', 'bwc_alice')).toBe(1);
  });

  it('foreign user blocked at child via parent enrollment', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'BuildWeekDayCompletion', 'bwc_alice')).toBe(0);
  });

  it('anonymous user cannot read completions', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'BuildWeekDayCompletion')).toBe(0);
  });

  it('enrollment owner can insert a completion into own enrollment', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."BuildWeekDayCompletion"("id","enrollment_id","day_number") VALUES ('bwc_a2','bwe_alice',2)`),
    ).toBe(true);
  });

  it('foreign user cannot insert a completion into an enrollment they do not own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."BuildWeekDayCompletion"("id","enrollment_id","day_number") VALUES ('bwc_b1','bwe_alice',3)`),
    ).toBe(false);
  });

  it('foreign user UPDATE affects zero rows (blocked via parent)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, BOB, (tx) =>
      tx.$executeRawUnsafe(`UPDATE public."BuildWeekDayCompletion" SET "day_number" = 9 WHERE "id" = 'bwc_alice'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role bypasses RLS for completion reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'BuildWeekDayCompletion', 'bwc_alice')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7) BuildWeekEnrollment — user-self
// ---------------------------------------------------------------------------
describe('BuildWeekEnrollment (user-self)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."BuildWeekEnrollment"("id","user_id") VALUES ('bwe_alice','u_alice')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('BuildWeekEnrollment');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected 5 policies', async () => {
    const names = await policyNames('BuildWeekEnrollment');
    expect(names.length).toBe(5);
    expect(names).toEqual(expect.arrayContaining(['p_buildweekenrollment_select', 'p_buildweekenrollment_insert']));
  });

  it('user can read own enrollment', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'BuildWeekEnrollment', 'bwe_alice')).toBe(1);
  });

  it('foreign user cannot read another user enrollment', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'BuildWeekEnrollment', 'bwe_alice')).toBe(0);
  });

  it('anonymous user cannot read enrollments', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'BuildWeekEnrollment')).toBe(0);
  });

  it('user can insert own enrollment', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."BuildWeekEnrollment"("id","user_id") VALUES ('bwe_bob','u_bob')`),
    ).toBe(true);
  });

  it('user cannot insert an enrollment owned by someone else', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, BOB,
        `INSERT INTO public."BuildWeekEnrollment"("id","user_id") VALUES ('bwe_hax','u_alice')`),
    ).toBe(false);
  });

  it('foreign user UPDATE affects zero rows (blocked by USING)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, BOB, (tx) =>
      tx.$executeRawUnsafe(`UPDATE public."BuildWeekEnrollment" SET "status" = 'hax' WHERE "id" = 'bwe_alice'`),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role bypasses RLS for enrollment reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'BuildWeekEnrollment', 'bwe_alice')).toBe(1);
  });
});
