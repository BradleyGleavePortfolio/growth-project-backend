/**
 * MWB-1 — Master Workout Builder data-model RLS policies.
 *
 * Verifies migration 20261215000000_mwb_1_data_model against a REAL PostgreSQL
 * instance (NO mocks). It exercises the four NEW MWB-1 tables —
 *   - WorkoutProgram                  (owner-self read/write + tenant-shared / sub-coach read overlay)
 *   - WorkoutPlanRevision             (child-via-plan: WorkoutPlan.coach_id + sub-coach-on-team)
 *   - WorkoutProgramRevision          (child-via-program: WorkoutProgram owner / tenant rules)
 *   - ClientWorkoutAssignmentSnapshot (child-via-assignment: client, assigning coach, client coach, sub-coach)
 * — and for each proves:
 *   - RLS is ENABLED *and* FORCED (relrowsecurity / relforcerowsecurity).
 *   - The canonical per-command policy set exists (service_role + 4 verbs).
 *   - service_role bypasses (Primitive A) for both read and write.
 *   - The owning coach can SELECT / INSERT / UPDATE / DELETE its own rows.
 *   - A tenant-scoped sub-coach can SELECT shared rows but cannot write outside
 *     its assigned scope.
 *   - A sub-coach with an OPEN SubCoachAssignment to a client can read that
 *     client's assignment snapshot, but NOT another client's.
 *   - anon (no GUCs) gets ZERO access on all four tables (read + write).
 *
 * This complements rls-tier3-workouts-policies.spec.ts (which covers the legacy
 * 7 workout/build-week tables) — this suite is dedicated to the MWB-1 additions
 * and the two new SECURITY DEFINER helpers app.is_subcoach_of(text) /
 * app.is_subcoach_on_coach_team(text).
 *
 * Principals are modeled with Postgres roles + the `app.current_user_id` /
 * `app.current_user_role` GUCs the helper functions read:
 *   - `service_role`        -> Primitive A bypass path.
 *   - `app_authenticated`   -> the `TO public` policy bucket (a normal request);
 *     identity is supplied per-statement via the GUCs.
 *   - anon                  -> `app_authenticated` with empty GUCs (helpers NULL).
 *
 * The suite is self-bootstrapping and idempotent: it (re)creates the minimal
 * prerequisite schema (public."User", the parent workout tables, the app helper
 * functions) and the test roles, then applies the migration SQL exactly as
 * Prisma would, then asserts. Re-running drops/recreates cleanly.
 *
 * Connection: RLS_MWB1_TEST_DATABASE_URL > RLS_FN_TEST_DATABASE_URL >
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
  '20261215000000_mwb_1_data_model',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_MWB1_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

// Minimal prerequisite schema: the app helper functions (mirrors PR-RLS-FN +
// the new MWB-1 helpers' DEPENDENCIES) and the parent tables the MWB-1 policies
// reference, with only the columns the policies read. The two NEW helpers
// app.is_subcoach_of / app.is_subcoach_on_coach_team are created BY the
// migration itself, so they are intentionally NOT defined here.
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

-- WorkoutPlanType enum (referenced by ClientWorkoutAssignmentSnapshot.plan_type).
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkoutPlanType') THEN
    CREATE TYPE "WorkoutPlanType" AS ENUM ('strength', 'cardio', 'mobility');
  END IF;
END
$do$;

-- SubCoachAssignment — read by app.is_subcoach_of(text).
CREATE TABLE IF NOT EXISTS public."SubCoachAssignment" (
  "id" text PRIMARY KEY,
  "head_coach_id" text NOT NULL,
  "sub_coach_id" text NOT NULL,
  "client_id" text NOT NULL,
  "unassigned_at" timestamp(3)
);

-- WorkoutPlan — parent of WorkoutPlanRevision (only columns the policy reads,
-- plus the additive MWB-1 columns the migration ALTERs onto it).
CREATE TABLE IF NOT EXISTS public."WorkoutPlan" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "name" text NOT NULL,
  "type" "WorkoutPlanType" NOT NULL DEFAULT 'strength',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" timestamp(3)
);

-- ClientWorkoutAssignment — parent of ClientWorkoutAssignmentSnapshot.
CREATE TABLE IF NOT EXISTS public."ClientWorkoutAssignment" (
  "id" text PRIMARY KEY,
  "workout_plan_id" text NOT NULL,
  "client_id" text NOT NULL,
  "assigned_by_coach_id" text NOT NULL,
  "scheduled_for" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const MWB1_TABLES = [
  'WorkoutProgram',
  'WorkoutPlanRevision',
  'WorkoutProgramRevision',
  'ClientWorkoutAssignmentSnapshot',
];

/**
 * Split a SQL file into top-level statements honoring dollar-quoted blocks and
 * single-quoted literals (so embedded ';' inside function bodies / comments are
 * not treated as statement terminators). Mirrors the Tier-3 spec splitter.
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

/** Count rows affected by an UPDATE/DELETE (blocked-by-USING reads as 0). */
async function rowsAffected(
  role: string,
  identity: { id?: string; userRole?: string },
  stmt: string,
): Promise<number> {
  const affected = await asPrincipal(role, identity, (tx) =>
    tx.$executeRawUnsafe(stmt),
  );
  return Number(affected);
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
      `TRUNCATE public."ClientWorkoutAssignmentSnapshot",
              public."WorkoutProgramRevision", public."WorkoutPlanRevision",
              public."ClientWorkoutAssignment", public."WorkoutPlan",
              public."WorkoutProgram", public."SubCoachAssignment",
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

/** True if the named function exists in schema app. */
async function functionExists(fnName: string): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 AS ok
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = $1`,
    fnName,
  )) as { ok: number }[];
  return rows.length > 0;
}

// Canonical identities reused across tables.
const OWNER = { id: 'u_owner', userRole: 'owner' };
// Head coach who owns the programs / plans / assignments under test.
const COACH = { id: 'u_coach', userRole: 'coach' };
// A second, unrelated head coach (foreign tenant) — must be denied.
const COACH2 = { id: 'u_coach2', userRole: 'coach' };
// Sub-coach on u_coach's team (User.coach_id = u_coach) with an OPEN
// SubCoachAssignment to u_alice (but NOT to u_bob).
const SUBCOACH = { id: 'u_subcoach', userRole: 'coach' };
const ALICE = { id: 'u_alice', userRole: 'student' };
const BOB = { id: 'u_bob', userRole: 'student' };
const ANON = {}; // no GUCs -> helpers return NULL

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Fail loudly (R0) if any of the 4 MWB-1 tables lacks ENABLED+FORCED RLS.
  for (const t of MWB1_TABLES) {
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
  // Base user graph:
  //   u_owner   — platform owner (Primitive B-style admin).
  //   u_coach   — head coach (tenant anchor for the programs under test).
  //   u_coach2  — a DIFFERENT head coach (foreign tenant).
  //   u_subcoach— a sub-coach on u_coach's team (coach_id = u_coach).
  //   u_alice   — student coached by u_coach; sub-coach has an OPEN assignment.
  //   u_bob     — student coached by u_coach; sub-coach has NO assignment.
  await seed([
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('u_owner',    NULL,      'owner'),
       ('u_coach',    NULL,      'coach'),
       ('u_coach2',   NULL,      'coach'),
       ('u_subcoach', 'u_coach', 'coach'),
       ('u_alice',    'u_coach', 'student'),
       ('u_bob',      'u_coach', 'student')`,
    // Sub-coach is actively assigned to alice (open) but NOT to bob.
    `INSERT INTO public."SubCoachAssignment"("id","head_coach_id","sub_coach_id","client_id","unassigned_at") VALUES
       ('sca_alice','u_coach','u_subcoach','u_alice',NULL)`,
  ]);
});

// ---------------------------------------------------------------------------
// 0) Helpers + helper-function existence (created BY the migration).
// ---------------------------------------------------------------------------
describe('MWB-1 RLS helpers (SECURITY DEFINER, pinned search_path)', () => {
  it('migration created app.is_subcoach_of(text)', async () => {
    expect(await functionExists('is_subcoach_of')).toBe(true);
  });

  it('migration created app.is_subcoach_on_coach_team(text)', async () => {
    expect(await functionExists('is_subcoach_on_coach_team')).toBe(true);
  });

  it('both helpers are SECURITY DEFINER with a pinned search_path', async () => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT p.proname, p.prosecdef, p.proconfig
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('is_subcoach_of','is_subcoach_on_coach_team')
        ORDER BY p.proname`,
    )) as { proname: string; prosecdef: boolean; proconfig: string[] | null }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      // search_path is pinned (SET search_path = public, pg_temp).
      expect((r.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 1) WorkoutProgram — owner-self read/write + tenant-shared / sub-coach read.
// ---------------------------------------------------------------------------
describe('WorkoutProgram (owner-self + tenant-shared/sub-coach read overlay)', () => {
  // Two programs owned by u_coach: one owner_only, one tenant_shared.
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutProgram"
         ("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
       VALUES
         ('wp_priv','u_coach','u_coach','owner_only','Private 12wk',12,4,CURRENT_TIMESTAMP),
         ('wp_shared','u_coach','u_coach','tenant_shared','Shared Library',8,3,CURRENT_TIMESTAMP)`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('WorkoutProgram');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the canonical 5 policies', async () => {
    const names = await policyNames('WorkoutProgram');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_workoutprogram_service_role_all',
        'p_workoutprogram_select',
        'p_workoutprogram_insert',
        'p_workoutprogram_update',
        'p_workoutprogram_delete',
      ]),
    );
    expect(names.length).toBe(5);
  });

  it('owner coach can read own private program', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'WorkoutProgram', 'wp_priv')).toBe(1);
  });

  it('owner coach can read own shared program', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'WorkoutProgram', 'wp_shared')).toBe(1);
  });

  it('sub-coach on the team can read a tenant_shared program', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'WorkoutProgram', 'wp_shared')).toBe(1);
  });

  it('sub-coach on the team CANNOT read an owner_only program', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'WorkoutProgram', 'wp_priv')).toBe(0);
  });

  it('a foreign coach (different tenant) cannot read either program', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'WorkoutProgram', 'wp_priv')).toBe(0);
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'WorkoutProgram', 'wp_shared')).toBe(0);
  });

  it('anonymous user gets ZERO access (no rows)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'WorkoutProgram')).toBe(0);
  });

  it('owner coach can INSERT a program owned by self', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."WorkoutProgram"("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
         VALUES ('wp_new','u_coach','u_coach','owner_only','New',6,3,CURRENT_TIMESTAMP)`),
    ).toBe(true);
  });

  it('a sub-coach CANNOT INSERT a program owned by the head coach (write outside scope)', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, SUBCOACH,
        `INSERT INTO public."WorkoutProgram"("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
         VALUES ('wp_hax','u_coach','u_coach','tenant_shared','Hax',6,3,CURRENT_TIMESTAMP)`),
    ).toBe(false);
  });

  it('a sub-coach UPDATE of a shared program affects zero rows (read-only scope)', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, SUBCOACH,
        `UPDATE public."WorkoutProgram" SET "name" = 'hax' WHERE "id" = 'wp_shared'`),
    ).toBe(0);
  });

  it('a sub-coach DELETE of a shared program affects zero rows', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, SUBCOACH,
        `DELETE FROM public."WorkoutProgram" WHERE "id" = 'wp_shared'`),
    ).toBe(0);
  });

  it('owner coach can UPDATE own program', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH,
        `UPDATE public."WorkoutProgram" SET "name" = 'Renamed' WHERE "id" = 'wp_priv'`),
    ).toBe(1);
  });

  it('owner coach can DELETE own program', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH,
        `DELETE FROM public."WorkoutProgram" WHERE "id" = 'wp_priv'`),
    ).toBe(1);
  });

  it('a foreign coach cannot INSERT a program owned by another user', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH2,
        `INSERT INTO public."WorkoutProgram"("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
         VALUES ('wp_f','u_coach','u_coach','owner_only','F',6,3,CURRENT_TIMESTAMP)`),
    ).toBe(false);
  });

  it('anonymous write is blocked', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, ANON,
        `INSERT INTO public."WorkoutProgram"("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
         VALUES ('wp_anon','u_coach','u_coach','owner_only','A',6,3,CURRENT_TIMESTAMP)`),
    ).toBe(false);
  });

  it('owner (platform admin) role can read any program', async () => {
    expect(await visibleCount(AUTHED_ROLE, OWNER, 'WorkoutProgram', 'wp_priv')).toBe(1);
  });

  it('service_role bypasses RLS for reads and writes', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'WorkoutProgram', 'wp_priv')).toBe(1);
    expect(
      await writeSucceeds(SERVICE_ROLE, {},
        `INSERT INTO public."WorkoutProgram"("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
         VALUES ('wp_svc','u_coach2','u_coach2','owner_only','Svc',6,3,CURRENT_TIMESTAMP)`),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) WorkoutPlanRevision — child-via-plan (WorkoutPlan.coach_id + sub-coach-on-team).
// ---------------------------------------------------------------------------
describe('WorkoutPlanRevision (child-via-plan + sub-coach-on-team)', () => {
  beforeEach(async () => {
    await seed([
      // A plan owned by head coach u_coach, and a foreign plan owned by u_coach2.
      `INSERT INTO public."WorkoutPlan"("id","coach_id","name","type") VALUES
         ('plan_coach','u_coach','Coach Plan','strength'),
         ('plan_foreign','u_coach2','Foreign Plan','strength')`,
      `INSERT INTO public."WorkoutPlanRevision"
         ("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
       VALUES
         ('rev_coach','plan_coach',1,'{}'::jsonb,'{}'::jsonb,'u_coach','coach','manual_edit'),
         ('rev_foreign','plan_foreign',1,'{}'::jsonb,'{}'::jsonb,'u_coach2','coach','manual_edit')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('WorkoutPlanRevision');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the canonical 5 policies', async () => {
    const names = await policyNames('WorkoutPlanRevision');
    expect(names.length).toBe(5);
    expect(names).toEqual(
      expect.arrayContaining([
        'p_workoutplanrevision_service_role_all',
        'p_workoutplanrevision_select',
        'p_workoutplanrevision_insert',
        'p_workoutplanrevision_update',
        'p_workoutplanrevision_delete',
      ]),
    );
  });

  it('parent-plan coach can read own plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'WorkoutPlanRevision', 'rev_coach')).toBe(1);
  });

  it('sub-coach on the team can read the head coach plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'WorkoutPlanRevision', 'rev_coach')).toBe(1);
  });

  it('a foreign coach cannot read the head coach plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'WorkoutPlanRevision', 'rev_coach')).toBe(0);
  });

  it('the head coach cannot read a foreign coach plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'WorkoutPlanRevision', 'rev_foreign')).toBe(0);
  });

  it('anonymous user gets ZERO access (no rows)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'WorkoutPlanRevision')).toBe(0);
  });

  it('parent-plan coach can INSERT a revision into own plan', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."WorkoutPlanRevision"("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
         VALUES ('rev_c2','plan_coach',2,'{}'::jsonb,'{}'::jsonb,'u_coach','coach','manual_edit')`),
    ).toBe(true);
  });

  it('sub-coach on the team can INSERT a revision into the head coach plan', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, SUBCOACH,
        `INSERT INTO public."WorkoutPlanRevision"("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
         VALUES ('rev_sc','plan_coach',3,'{}'::jsonb,'{}'::jsonb,'u_subcoach','sub_coach','manual_edit')`),
    ).toBe(true);
  });

  it('a foreign coach cannot INSERT a revision into the head coach plan', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH2,
        `INSERT INTO public."WorkoutPlanRevision"("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
         VALUES ('rev_f','plan_coach',4,'{}'::jsonb,'{}'::jsonb,'u_coach2','coach','manual_edit')`),
    ).toBe(false);
  });

  it('a foreign coach UPDATE affects zero rows (blocked via parent)', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH2,
        `UPDATE public."WorkoutPlanRevision" SET "cause" = 'hax' WHERE "id" = 'rev_coach'`),
    ).toBe(0);
  });

  it('a foreign coach DELETE affects zero rows (blocked via parent)', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH2,
        `DELETE FROM public."WorkoutPlanRevision" WHERE "id" = 'rev_coach'`),
    ).toBe(0);
  });

  it('service_role bypasses RLS for revision reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'WorkoutPlanRevision', 'rev_coach')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3) WorkoutProgramRevision — child-via-program (owner / tenant rules).
// ---------------------------------------------------------------------------
describe('WorkoutProgramRevision (child-via-program owner/tenant)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutProgram"
         ("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
       VALUES
         ('wprg_shared','u_coach','u_coach','tenant_shared','Shared',8,3,CURRENT_TIMESTAMP),
         ('wprg_foreign','u_coach2','u_coach2','owner_only','Foreign',8,3,CURRENT_TIMESTAMP)`,
      `INSERT INTO public."WorkoutProgramRevision"
         ("id","program_id","revision_index","structure_json","author_id","author_kind","cause")
       VALUES
         ('prev_shared','wprg_shared',1,'{}'::jsonb,'u_coach','coach','manual_edit'),
         ('prev_foreign','wprg_foreign',1,'{}'::jsonb,'u_coach2','coach','manual_edit')`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('WorkoutProgramRevision');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the canonical 5 policies', async () => {
    const names = await policyNames('WorkoutProgramRevision');
    expect(names.length).toBe(5);
    expect(names).toEqual(
      expect.arrayContaining([
        'p_workoutprogramrevision_service_role_all',
        'p_workoutprogramrevision_select',
        'p_workoutprogramrevision_insert',
        'p_workoutprogramrevision_update',
        'p_workoutprogramrevision_delete',
      ]),
    );
  });

  it('parent-program owner can read own program revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'WorkoutProgramRevision', 'prev_shared')).toBe(1);
  });

  it('sub-coach on the team can read a tenant_shared program revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'WorkoutProgramRevision', 'prev_shared')).toBe(1);
  });

  it('a foreign coach cannot read the tenant_shared program revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'WorkoutProgramRevision', 'prev_shared')).toBe(0);
  });

  it('anonymous user gets ZERO access (no rows)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'WorkoutProgramRevision')).toBe(0);
  });

  it('parent-program owner can INSERT a revision into own program', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."WorkoutProgramRevision"("id","program_id","revision_index","structure_json","author_id","author_kind","cause")
         VALUES ('prev_c2','wprg_shared',2,'{}'::jsonb,'u_coach','coach','manual_edit')`),
    ).toBe(true);
  });

  it('a sub-coach CANNOT INSERT a program revision (read-only on shared, write is owner-only)', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, SUBCOACH,
        `INSERT INTO public."WorkoutProgramRevision"("id","program_id","revision_index","structure_json","author_id","author_kind","cause")
         VALUES ('prev_sc','wprg_shared',3,'{}'::jsonb,'u_subcoach','sub_coach','manual_edit')`),
    ).toBe(false);
  });

  it('a foreign coach cannot INSERT a revision into a program they do not own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH2,
        `INSERT INTO public."WorkoutProgramRevision"("id","program_id","revision_index","structure_json","author_id","author_kind","cause")
         VALUES ('prev_f','wprg_shared',4,'{}'::jsonb,'u_coach2','coach','manual_edit')`),
    ).toBe(false);
  });

  it('a sub-coach UPDATE affects zero rows (write is owner-only)', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, SUBCOACH,
        `UPDATE public."WorkoutProgramRevision" SET "cause" = 'hax' WHERE "id" = 'prev_shared'`),
    ).toBe(0);
  });

  it('parent-program owner can DELETE own program revision', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH,
        `DELETE FROM public."WorkoutProgramRevision" WHERE "id" = 'prev_shared'`),
    ).toBe(1);
  });

  it('service_role bypasses RLS for program revision reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'WorkoutProgramRevision', 'prev_shared')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4) ClientWorkoutAssignmentSnapshot — child-via-assignment
//    (client, assigning coach, client's coach, sub-coach overlay).
// ---------------------------------------------------------------------------
describe('ClientWorkoutAssignmentSnapshot (child-via-assignment + sub-coach overlay)', () => {
  beforeEach(async () => {
    await seed([
      `INSERT INTO public."WorkoutPlan"("id","coach_id","name","type") VALUES
         ('plan_a','u_coach','Plan A','strength')`,
      // Assignment for alice (sub-coach IS assigned) and bob (sub-coach NOT assigned).
      `INSERT INTO public."ClientWorkoutAssignment"("id","workout_plan_id","client_id","assigned_by_coach_id") VALUES
         ('cwa_alice','plan_a','u_alice','u_coach'),
         ('cwa_bob','plan_a','u_bob','u_coach')`,
      `INSERT INTO public."ClientWorkoutAssignmentSnapshot"
         ("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version")
       VALUES
         ('snap_alice','cwa_alice','Plan A','strength','{}'::jsonb,'plan_a',1),
         ('snap_bob','cwa_bob','Plan A','strength','{}'::jsonb,'plan_a',1)`,
    ]);
  });

  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('ClientWorkoutAssignmentSnapshot');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the canonical 5 policies', async () => {
    const names = await policyNames('ClientWorkoutAssignmentSnapshot');
    expect(names.length).toBe(5);
    expect(names).toEqual(
      expect.arrayContaining([
        'p_clientworkoutassignmentsnapshot_service_role_all',
        'p_clientworkoutassignmentsnapshot_select',
        'p_clientworkoutassignmentsnapshot_insert',
        'p_clientworkoutassignmentsnapshot_update',
        'p_clientworkoutassignmentsnapshot_delete',
      ]),
    );
  });

  it('the assigned client can read their own snapshot', async () => {
    expect(await visibleCount(AUTHED_ROLE, ALICE, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(1);
  });

  it('the assigning coach can read the snapshot', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(1);
  });

  it("sub-coach with an OPEN assignment can read that client's snapshot", async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(1);
  });

  it("sub-coach CANNOT read a snapshot for a client they are NOT assigned to", async () => {
    // The sub-coach has no open SubCoachAssignment to u_bob. is_current_coach_of
    // also fails (sub-coach is not bob's User.coach_id; the head coach is).
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'ClientWorkoutAssignmentSnapshot', 'snap_bob')).toBe(0);
  });

  it('a foreign client (bob) cannot read alice snapshot', async () => {
    expect(await visibleCount(AUTHED_ROLE, BOB, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(0);
  });

  it('a foreign coach cannot read the snapshot', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(0);
  });

  it('anonymous user gets ZERO access (no rows)', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'ClientWorkoutAssignmentSnapshot')).toBe(0);
  });

  it('the assigning coach can INSERT a snapshot for the assignment', async () => {
    // Use cwa_bob's assignment with a fresh id (the unique key is assignment_id,
    // and we deleted nothing — so seed a new assignment to insert against).
    await seed([
      `INSERT INTO public."ClientWorkoutAssignment"("id","workout_plan_id","client_id","assigned_by_coach_id") VALUES
         ('cwa_new','plan_a','u_alice','u_coach')`,
    ]);
    expect(
      await writeSucceeds(AUTHED_ROLE, COACH,
        `INSERT INTO public."ClientWorkoutAssignmentSnapshot"("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version")
         VALUES ('snap_new','cwa_new','Plan A','strength','{}'::jsonb,'plan_a',1)`),
    ).toBe(true);
  });

  it("sub-coach with an OPEN assignment can INSERT a snapshot for that client", async () => {
    await seed([
      `INSERT INTO public."ClientWorkoutAssignment"("id","workout_plan_id","client_id","assigned_by_coach_id") VALUES
         ('cwa_sc','plan_a','u_alice','u_coach')`,
    ]);
    expect(
      await writeSucceeds(AUTHED_ROLE, SUBCOACH,
        `INSERT INTO public."ClientWorkoutAssignmentSnapshot"("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version")
         VALUES ('snap_sc','cwa_sc','Plan A','strength','{}'::jsonb,'plan_a',1)`),
    ).toBe(true);
  });

  it('the assigned client CANNOT INSERT a snapshot (write is coach-side)', async () => {
    await seed([
      `INSERT INTO public."ClientWorkoutAssignment"("id","workout_plan_id","client_id","assigned_by_coach_id") VALUES
         ('cwa_cli','plan_a','u_alice','u_coach')`,
    ]);
    expect(
      await writeSucceeds(AUTHED_ROLE, ALICE,
        `INSERT INTO public."ClientWorkoutAssignmentSnapshot"("id","assignment_id","plan_name","plan_type","exercises_json","source_plan_id","source_version")
         VALUES ('snap_cli','cwa_cli','Plan A','strength','{}'::jsonb,'plan_a',1)`),
    ).toBe(false);
  });

  it('a foreign coach DELETE affects zero rows (blocked via parent assignment)', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH2,
        `DELETE FROM public."ClientWorkoutAssignmentSnapshot" WHERE "id" = 'snap_alice'`),
    ).toBe(0);
  });

  it('the assigning coach can DELETE the snapshot', async () => {
    expect(
      await rowsAffected(AUTHED_ROLE, COACH,
        `DELETE FROM public."ClientWorkoutAssignmentSnapshot" WHERE "id" = 'snap_alice'`),
    ).toBe(1);
  });

  it('service_role bypasses RLS for snapshot reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'ClientWorkoutAssignmentSnapshot', 'snap_alice')).toBe(1);
  });
});
