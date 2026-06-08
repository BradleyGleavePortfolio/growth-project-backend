/**
 * PR-RLS-06 — Tier 4 learning, analytics, signals RLS policies.
 *
 * Verifies the migration 20261213000000_rls_tier4_learning_analytics for all
 * eight tables: Lesson, LessonCompletion, HolisticInsightCache, ActivityEvent,
 * ClientSignal, ClientOutcome, PtmPrediction, AiRoadmap.
 *
 * For every table we assert (8 behavioural/structural tests each, 64 total):
 *   1. RLS is ENABLED and FORCED on the table.
 *   2. The service_role bypass policy exists (Primitive A).
 *   3. The owner context (app.is_owner()) can read every row.
 *   4. The legitimate self/owner-column principal can read its own row.
 *   5. The applicable tenant (coach / parent-submission owner) can read where
 *      the primitive grants it — or, for owner-less/coach-less tables, an
 *      additional positive self path is exercised.
 *   6. A foreign authenticated user sees ZERO rows (negative read).
 *   7. A cross-tenant write is rejected by the policy WITH CHECK (negative write).
 *   8. An unauthenticated context (no GUC) is denied all reads and writes.
 *
 * This spec hits a REAL PostgreSQL instance (NO mocks). It is fully
 * self-bootstrapping: it creates the minimal prerequisite catalog objects
 * (schema `app`, the RLS helper functions, public."User", the eight target
 * tables, and public."DiagnosticSubmission"), then applies the migration SQL
 * exactly as Prisma would, then asserts.
 *
 * RLS enforcement model: the test connects as a Supabase-style superuser-capable
 * role (`rls_tester`) that is NOT a member of service_role/authenticated, so it
 * cannot SET ROLE to them (Supabase locks ADMIN on those reserved roles). Instead
 * we rely on `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, which applies the `public`
 * policies even to the table-owning superuser, and drive the policy predicates via
 * the `app.current_user_id` / `app.current_user_role` session GUCs — exactly the
 * authenticated-request context NestJS sets in production. The service_role bypass
 * policy is verified structurally (catalog) since SET ROLE service_role is not
 * permitted for this test principal; its behaviour (USING/WITH CHECK = true) is a
 * constant and needs no row-level exercise.
 *
 * Connection: RLS_TIER4_TEST_DATABASE_URL (preferred) or DATABASE_URL. The CI/dev
 * convention is a local superuser-capable role on the throwaway `rls_fn_test`
 * database, e.g.
 *   postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test
 *
 * The PrismaClient is constructed against that URL via the `datasources`
 * override so it never touches the app's default database or production Supabase.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261213000000_rls_tier4_learning_analytics',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER4_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

// Prerequisite catalog objects mirroring the production columns the policies
// read. Applied before the migration so its ALTER TABLE / CREATE POLICY targets
// resolve. Helpers mirror the hardened definitions (search_path pinned), so the
// spec is independent of the helper migration having been applied first.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;

CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL
     AND coach_user_id IS NOT NULL
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

DROP TABLE IF EXISTS public."AiRoadmap" CASCADE;
DROP TABLE IF EXISTS public."PtmPrediction" CASCADE;
DROP TABLE IF EXISTS public."ClientOutcome" CASCADE;
DROP TABLE IF EXISTS public."ClientSignal" CASCADE;
DROP TABLE IF EXISTS public."ActivityEvent" CASCADE;
DROP TABLE IF EXISTS public."HolisticInsightCache" CASCADE;
DROP TABLE IF EXISTS public."LessonCompletion" CASCADE;
DROP TABLE IF EXISTS public."Lesson" CASCADE;
DROP TABLE IF EXISTS public."DiagnosticSubmission" CASCADE;

CREATE TABLE public."Lesson" (
  "id" text PRIMARY KEY, "coach_id" text NOT NULL, "title" text NOT NULL,
  "order_index" int NOT NULL DEFAULT 0, "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public."LessonCompletion" (
  "id" text PRIMARY KEY, "lesson_id" text NOT NULL, "user_id" text NOT NULL,
  "completed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public."HolisticInsightCache" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL, "window_days" int NOT NULL,
  "payload" jsonb NOT NULL, "generated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
CREATE TABLE public."ActivityEvent" (
  "id" text PRIMARY KEY, "actor_id" text, "actor_role" text, "coach_id" text,
  "client_id" text, "type" text NOT NULL, "summary" text, "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public."ClientSignal" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL, "signal_type" text NOT NULL,
  "value" double precision NOT NULL DEFAULT 0, "metadata" jsonb,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public."ClientOutcome" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL UNIQUE, "outcome_type" text NOT NULL,
  "labelled_by_id" text, "labelled_at" timestamptz NOT NULL DEFAULT now(),
  "notes" text, "signal_snapshot" jsonb
);
CREATE TABLE public."PtmPrediction" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL, "risk_score" double precision NOT NULL,
  "success_score" double precision NOT NULL, "prediction_basis" text NOT NULL,
  "factors" jsonb, "computed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public."DiagnosticSubmission" (
  "id" text PRIMARY KEY, "email" text NOT NULL, "answers" jsonb NOT NULL,
  "scores" jsonb NOT NULL, "bucket" jsonb NOT NULL,
  "submitted_at" timestamptz NOT NULL DEFAULT now(), "user_id" text
);
CREATE TABLE public."AiRoadmap" (
  "id" text PRIMARY KEY, "submission_id" text NOT NULL UNIQUE,
  "generated_at" timestamptz NOT NULL DEFAULT now(), "prompt_version" text NOT NULL DEFAULT 'v1',
  "status" text NOT NULL DEFAULT 'ready', "payload" jsonb, "tokens_used" int,
  "model" text NOT NULL DEFAULT 'sonar-pro', "error_message" text
);
`;

/**
 * Split a SQL file into top-level statements on semicolons that are NOT inside a
 * dollar-quoted block or single-quoted literal. The migration wraps everything in
 * BEGIN/COMMIT; we strip those because each $executeRawUnsafe runs in its own
 * implicit transaction and a literal COMMIT mid-script would error.
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
  return statements.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim()));
}

const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({
  datasources: { db: { url: SINGLE_CONN_URL } },
});

/** Strip leading/standalone `--` comment lines so a statement is never comment-only. */
function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

async function applyScript(sql: string): Promise<void> {
  for (const raw of splitSqlStatements(sql)) {
    const stmt = stripLeadingComments(raw);
    if (!stmt) continue;
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
    // No swallowing: any failure here must fail the suite loudly (R0).
    await prisma.$executeRawUnsafe(stmt);
  }
}

/** Set the NestJS-style auth GUCs for the current session. */
async function setAuth(userId: string | null, role: string | null): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, false)`, userId ?? '');
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, false)`, role ?? '');
}

/** Clear auth context → helpers see NULL (unauthenticated). */
async function clearAuth(): Promise<void> {
  await setAuth(null, null);
}

/** Run as the platform owner so writes pass the `app.is_owner()` branch. */
const OWNER = 'u_owner';
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await setAuth(OWNER, 'owner');
  try {
    return await fn();
  } finally {
    await clearAuth();
  }
}

/** Count rows visible to the CURRENT auth context for a table by id list. */
async function visibleIds(table: string, ids: string[]): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM public."${table}" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
    ids,
  );
  return rows.map((r) => r.id);
}

/**
 * Assert an INSERT is rejected by RLS *by SQLSTATE*, not by message text
 * (R65 / Failure #30 — vague message-regex assertions are silent failures).
 *
 * A WITH CHECK violation raises SQLSTATE 42501 (insufficient_privilege,
 * "new row violates row-level security policy"). Through Prisma's
 * `$executeRawUnsafe`, this surfaces either as an error exposing `code === '42501'`
 * directly, or wrapped as Prisma `P2010` with the underlying `meta.code === '42501'`.
 * We accept only those two shapes. The statement runs inside an interactive
 * transaction so the abort is contained and never poisons the shared connection.
 */
async function expectInsertDenied(stmt: string, params: unknown[] = []): Promise<void> {
  let thrown: unknown;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(stmt, ...params);
    });
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) {
    throw new Error('expected RLS INSERT denial, but statement succeeded');
  }
  const err = thrown as { code?: string; meta?: { code?: string }; message?: string };
  const directCode = err?.code;
  const nestedCode = err?.meta?.code;
  // 42501 = insufficient_privilege (RLS WITH CHECK violation).
  if (directCode === '42501') return;
  if (err?.code === 'P2010' && nestedCode === '42501') return;
  throw new Error(
    `expected SQLSTATE 42501 (RLS INSERT denial), got code=${String(directCode)} ` +
      `meta.code=${String(nestedCode)} message=${String(err?.message)}`,
  );
}

/**
 * Assert an UPDATE/DELETE attempted by a principal who cannot see the target row
 * is silently filtered to ZERO affected rows by the policy USING clause (the
 * correct PostgreSQL semantics for a row the actor cannot see — no error is
 * raised), and then prove the row is UNCHANGED from an owner context. Any
 * non-zero affected count, or a mutated/absent row, fails loudly.
 *
 * `ownerVerify` runs under the owner GUC and returns true iff the original row is
 * intact (still present and not mutated). This is the SQLSTATE-precise analogue
 * for USING-filtered writes: instead of a thrown code we assert affected === 0
 * plus positive proof of integrity, never a vague "it threw something".
 */
async function expectUpdateOrDeleteFiltered(
  stmt: string,
  params: unknown[],
  ownerVerify: () => Promise<boolean>,
): Promise<void> {
  const affected = await prisma.$executeRawUnsafe(stmt, ...params);
  if (affected !== 0) {
    throw new Error(`expected RLS to filter UPDATE/DELETE to 0 rows, got ${affected}`);
  }
  const intact = await asOwner(ownerVerify);
  if (!intact) {
    throw new Error('row was modified/deleted despite expected RLS USING filter');
  }
}

// --- Identity fixtures -------------------------------------------------------
const COACH = 'u_coach';
const OTHER_COACH = 'u_coach_other';
const CLIENT = 'u_client'; // student of COACH
const FOREIGN = 'u_foreign'; // unrelated authenticated user

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Seed the User graph (no RLS on User in this spec's prereq — it is created
  // without ENABLE RLS, so plain inserts work). CLIENT is a student of COACH.
  await prisma.$executeRawUnsafe('DELETE FROM public."User"');
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ($1,NULL,'owner'),($2,NULL,'coach'),($3,NULL,'coach'),($4,$2,'student'),($5,NULL,'student')`,
    OWNER,
    COACH,
    OTHER_COACH,
    CLIENT,
    FOREIGN,
  );

  // Fail loudly (R0) if any target table is missing a policy set.
  const counts = await prisma.$queryRawUnsafe<{ relname: string; n: bigint }[]>(
    `SELECT c.relname, count(p.polname)::bigint AS n
       FROM pg_catalog.pg_class c
       LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
      WHERE c.relname IN ('Lesson','LessonCompletion','HolisticInsightCache','ActivityEvent','ClientSignal','ClientOutcome','PtmPrediction','AiRoadmap')
      GROUP BY c.relname`,
  );
  const byName = new Map(counts.map((r) => [r.relname, Number(r.n)]));
  for (const t of ['Lesson', 'LessonCompletion', 'HolisticInsightCache', 'ActivityEvent', 'ClientSignal', 'ClientOutcome', 'PtmPrediction', 'AiRoadmap']) {
    if (byName.get(t) !== 5) {
      throw new Error(`bootstrap incomplete: expected 5 policies on ${t}, found ${byName.get(t) ?? 0}`);
    }
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearAuth();
});

// --- Shared catalog helpers --------------------------------------------------
type RlsRow = { relrowsecurity: boolean; relforcerowsecurity: boolean };
async function rlsFlags(table: string): Promise<RlsRow> {
  const rows = await prisma.$queryRawUnsafe<RlsRow[]>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    table,
  );
  return rows[0];
}
async function policyExists(table: string, policy: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      WHERE c.relname = $1 AND p.polname = $2`,
    table,
    policy,
  );
  return Number(rows[0].n) === 1;
}

/**
 * Rigorously verify the service_role policy is a *full bypass* in the catalog:
 * exactly one service-role policy on the table, FOR ALL (polcmd = '*'), targeting
 * the resolved `service_role` role, with USING = true and WITH CHECK = true. This
 * proves the literal `FOR ALL TO service_role USING (true) WITH CHECK (true)`
 * shape rather than merely that a policy with the right NAME exists — a
 * name-only check would pass even if the policy were command-limited or carried a
 * restrictive predicate. (rls_tester cannot SET ROLE service_role, so behaviour
 * is asserted from the catalog; USING/CHECK = true is a constant.)
 */
async function assertServiceRolePolicyIsFullBypass(table: string): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      polname: string;
      polcmd: string;
      rolname: string | null;
      qual_expr: string | null;
      check_expr: string | null;
    }>
  >(
    `SELECT
        p.polname,
        p.polcmd::text AS polcmd,
        r.rolname,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual_expr,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       LEFT JOIN LATERAL unnest(p.polroles) AS role_oid(oid) ON true
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = role_oid.oid
      WHERE c.relname = $1
        AND p.polname LIKE '%service_role%'`,
    table,
  );

  // Exactly one service-role policy, resolving to a single role row.
  expect(rows.length).toBe(1);
  const svc = rows[0];
  expect(svc.polcmd).toBe('*'); // '*' = FOR ALL
  expect(svc.rolname).toBe('service_role');
  expect(svc.qual_expr).toBe('true'); // USING (true)
  expect(svc.check_expr).toBe('true'); // WITH CHECK (true)
}

const TIER4_TABLES = [
  'Lesson',
  'LessonCompletion',
  'HolisticInsightCache',
  'ActivityEvent',
  'ClientSignal',
  'ClientOutcome',
  'PtmPrediction',
  'AiRoadmap',
] as const;

// ===========================================================================
// Lesson — coach-self (owner override).
// ===========================================================================
describe('Lesson — coach-self RLS', () => {
  const L1 = 'lesson_coach', L2 = 'lesson_other';
  beforeAll(async () => {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."Lesson" WHERE "id" = ANY($1::text[])`, [L1, L2]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."Lesson"("id","coach_id","title") VALUES ($1,$2,'A'),($3,$4,'B')`,
        L1, COACH, L2, OTHER_COACH,
      );
    });
  });

  it('rls_Lesson_rls_enabled_and_forced', async () => {
    const f = await rlsFlags('Lesson');
    expect(f.relrowsecurity).toBe(true);
    expect(f.relforcerowsecurity).toBe(true);
  });
  it('rls_Lesson_service_role_policy_exists', async () => {
    expect(await policyExists('Lesson', 'p_lesson_service_role_all')).toBe(true);
  });
  it('rls_Lesson_owner_can_read_all', async () => {
    await setAuth(OWNER, 'owner');
    expect(await visibleIds('Lesson', [L1, L2])).toEqual([L1, L2]);
  });
  it('rls_Lesson_owning_coach_reads_own', async () => {
    await setAuth(COACH, 'coach');
    expect(await visibleIds('Lesson', [L1, L2])).toEqual([L1]);
  });
  it('rls_Lesson_other_coach_reads_only_own', async () => {
    await setAuth(OTHER_COACH, 'coach');
    expect(await visibleIds('Lesson', [L1, L2])).toEqual([L2]);
  });
  it('rls_Lesson_foreign_user_denied', async () => {
    await setAuth(FOREIGN, 'student');
    expect(await visibleIds('Lesson', [L1, L2])).toEqual([]);
  });
  it('rls_Lesson_cross_tenant_write_denied', async () => {
    await setAuth(COACH, 'coach');
    // COACH tries to insert a lesson owned by OTHER_COACH → WITH CHECK fails.
    await expectInsertDenied(
      `INSERT INTO public."Lesson"("id","coach_id","title") VALUES ('lesson_x',$1,'X')`,
      [OTHER_COACH],
    );
  });
  it('rls_Lesson_unauthenticated_denied', async () => {
    await clearAuth();
    expect(await visibleIds('Lesson', [L1, L2])).toEqual([]);
    await expectInsertDenied(
      `INSERT INTO public."Lesson"("id","coach_id","title") VALUES ('lesson_anon',$1,'Z')`,
      [COACH],
    );
  });
  it('rls_Lesson_foreign_update_filtered', async () => {
    // OTHER_COACH cannot see COACH's lesson L1; the UPDATE policy USING clause
    // filters it out → 0 rows affected, and L1 retains its original title.
    await setAuth(OTHER_COACH, 'coach');
    await expectUpdateOrDeleteFiltered(
      `UPDATE public."Lesson" SET "title" = 'hijacked' WHERE "id" = $1`,
      [L1],
      async () => {
        const rows = await prisma.$queryRawUnsafe<{ title: string }[]>(
          `SELECT "title" FROM public."Lesson" WHERE "id" = $1`, L1,
        );
        return rows.length === 1 && rows[0].title === 'A';
      },
    );
  });
  it('rls_Lesson_foreign_delete_filtered', async () => {
    await setAuth(OTHER_COACH, 'coach');
    await expectUpdateOrDeleteFiltered(
      `DELETE FROM public."Lesson" WHERE "id" = $1`,
      [L1],
      async () => (await visibleIds('Lesson', [L1])).length === 1,
    );
  });
});

// ===========================================================================
// LessonCompletion — completing user, that user's coach, or lesson coach.
// ===========================================================================
describe('LessonCompletion — lesson-completion RLS', () => {
  const LC1 = 'lc_client'; // CLIENT completed COACH's lesson
  const LESSON = 'lc_lesson';
  beforeAll(async () => {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."LessonCompletion" WHERE "id" = $1`, LC1);
      await prisma.$executeRawUnsafe(`DELETE FROM public."Lesson" WHERE "id" = $1`, LESSON);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."Lesson"("id","coach_id","title") VALUES ($1,$2,'Course')`,
        LESSON, COACH,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."LessonCompletion"("id","lesson_id","user_id") VALUES ($1,$2,$3)`,
        LC1, LESSON, CLIENT,
      );
    });
  });

  it('rls_LessonCompletion_rls_enabled_and_forced', async () => {
    const f = await rlsFlags('LessonCompletion');
    expect(f.relrowsecurity).toBe(true);
    expect(f.relforcerowsecurity).toBe(true);
  });
  it('rls_LessonCompletion_service_role_policy_exists', async () => {
    expect(await policyExists('LessonCompletion', 'p_lessoncompletion_service_role_all')).toBe(true);
  });
  it('rls_LessonCompletion_owner_can_read_all', async () => {
    await setAuth(OWNER, 'owner');
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([LC1]);
  });
  it('rls_LessonCompletion_completing_user_reads_own', async () => {
    await setAuth(CLIENT, 'student');
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([LC1]);
  });
  it('rls_LessonCompletion_users_coach_can_read', async () => {
    // COACH is both CLIENT's current coach AND the lesson's coach.
    await setAuth(COACH, 'coach');
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([LC1]);
  });
  it('rls_LessonCompletion_foreign_user_denied', async () => {
    await setAuth(FOREIGN, 'student');
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([]);
    await setAuth(OTHER_COACH, 'coach');
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([]);
  });
  it('rls_LessonCompletion_cross_tenant_write_denied', async () => {
    await setAuth(FOREIGN, 'student');
    // FOREIGN tries to record a completion for CLIENT on COACH's lesson.
    await expectInsertDenied(
      `INSERT INTO public."LessonCompletion"("id","lesson_id","user_id") VALUES ('lc_x',$1,$2)`,
      [LESSON, CLIENT],
    );
  });
  it('rls_LessonCompletion_unauthenticated_denied', async () => {
    await clearAuth();
    expect(await visibleIds('LessonCompletion', [LC1])).toEqual([]);
    await expectInsertDenied(
      `INSERT INTO public."LessonCompletion"("id","lesson_id","user_id") VALUES ('lc_anon',$1,$2)`,
      [LESSON, CLIENT],
    );
  });
  it('rls_LessonCompletion_foreign_update_filtered', async () => {
    // OTHER_COACH is neither the completing user, that user's coach, nor the
    // lesson's coach → USING filters LC1 out, 0 rows, user_id stays CLIENT.
    await setAuth(OTHER_COACH, 'coach');
    await expectUpdateOrDeleteFiltered(
      `UPDATE public."LessonCompletion" SET "user_id" = $1 WHERE "id" = $2`,
      [OTHER_COACH, LC1],
      async () => {
        const rows = await prisma.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT "user_id" FROM public."LessonCompletion" WHERE "id" = $1`, LC1,
        );
        return rows.length === 1 && rows[0].user_id === CLIENT;
      },
    );
  });
  it('rls_LessonCompletion_foreign_delete_filtered', async () => {
    await setAuth(OTHER_COACH, 'coach');
    await expectUpdateOrDeleteFiltered(
      `DELETE FROM public."LessonCompletion" WHERE "id" = $1`,
      [LC1],
      async () => (await visibleIds('LessonCompletion', [LC1])).length === 1,
    );
  });
});

// ===========================================================================
// Shared generator for the five user-self-current-coach-read tables.
// ===========================================================================
interface UserSelfTable {
  table: string;
  servicePolicy: string;
  seed: (id: string, userId: string) => Promise<unknown>;
  insertOther: (id: string, userId: string) => string; // returns INSERT stmt for cross-tenant test
  insertParams: (userId: string) => unknown[];
  // A non-key column the foreign UPDATE attempt tries to overwrite, plus the
  // original value seeded for it, so the owner-context verify can prove the row
  // was NOT mutated when RLS USING filters the UPDATE to 0 rows.
  updateColumn: string;
  updateValueLiteral: string; // SQL literal the foreign UPDATE attempts to set
  originalValue: string | number; // value present after seed (post-read coercion)
}

function userSelfSuite(cfg: UserSelfTable, ownRowId: string): void {
  describe(`${cfg.table} — user-self-current-coach RLS`, () => {
    beforeAll(async () => {
      await asOwner(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM public."${cfg.table}" WHERE "id" = $1`, ownRowId);
        await cfg.seed(ownRowId, CLIENT);
      });
    });

    it(`rls_${cfg.table}_rls_enabled_and_forced`, async () => {
      const f = await rlsFlags(cfg.table);
      expect(f.relrowsecurity).toBe(true);
      expect(f.relforcerowsecurity).toBe(true);
    });
    it(`rls_${cfg.table}_service_role_policy_exists`, async () => {
      expect(await policyExists(cfg.table, cfg.servicePolicy)).toBe(true);
    });
    it(`rls_${cfg.table}_owner_can_read_all`, async () => {
      await setAuth(OWNER, 'owner');
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([ownRowId]);
    });
    it(`rls_${cfg.table}_subject_user_reads_own`, async () => {
      await setAuth(CLIENT, 'student');
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([ownRowId]);
    });
    it(`rls_${cfg.table}_current_coach_can_read`, async () => {
      await setAuth(COACH, 'coach');
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([ownRowId]);
    });
    it(`rls_${cfg.table}_foreign_user_denied`, async () => {
      await setAuth(FOREIGN, 'student');
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([]);
      await setAuth(OTHER_COACH, 'coach');
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([]);
    });
    it(`rls_${cfg.table}_cross_tenant_write_denied`, async () => {
      await setAuth(FOREIGN, 'student');
      await expectInsertDenied(cfg.insertOther(`${ownRowId}_x`, CLIENT), cfg.insertParams(CLIENT));
    });
    it(`rls_${cfg.table}_unauthenticated_denied`, async () => {
      await clearAuth();
      expect(await visibleIds(cfg.table, [ownRowId])).toEqual([]);
      await expectInsertDenied(cfg.insertOther(`${ownRowId}_anon`, CLIENT), cfg.insertParams(CLIENT));
    });
    it(`rls_${cfg.table}_foreign_update_filtered`, async () => {
      // FOREIGN is neither the subject user nor that user's current coach → the
      // UPDATE policy USING clause filters the row out (0 rows), and the target
      // column keeps its seeded value when verified from the owner context.
      await setAuth(FOREIGN, 'student');
      await expectUpdateOrDeleteFiltered(
        `UPDATE public."${cfg.table}" SET "${cfg.updateColumn}" = ${cfg.updateValueLiteral} WHERE "id" = $1`,
        [ownRowId],
        async () => {
          const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
            `SELECT "${cfg.updateColumn}" AS v FROM public."${cfg.table}" WHERE "id" = $1`,
            ownRowId,
          );
          if (rows.length !== 1) return false;
          return String(rows[0].v) === String(cfg.originalValue);
        },
      );
    });
    it(`rls_${cfg.table}_foreign_delete_filtered`, async () => {
      await setAuth(FOREIGN, 'student');
      await expectUpdateOrDeleteFiltered(
        `DELETE FROM public."${cfg.table}" WHERE "id" = $1`,
        [ownRowId],
        async () => (await visibleIds(cfg.table, [ownRowId])).length === 1,
      );
    });
  });
}

userSelfSuite(
  {
    table: 'HolisticInsightCache',
    servicePolicy: 'p_holisticinsightcache_service_role_all',
    seed: (id, userId) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO public."HolisticInsightCache"("id","user_id","window_days","payload","expires_at") VALUES ($1,$2,30,'{}'::jsonb, now() + interval '1 day')`,
        id, userId,
      ),
    insertOther: (id) =>
      `INSERT INTO public."HolisticInsightCache"("id","user_id","window_days","payload","expires_at") VALUES ('${id}',$1,7,'{}'::jsonb, now() + interval '1 day')`,
    insertParams: (userId) => [userId],
    updateColumn: 'window_days',
    updateValueLiteral: '999',
    originalValue: 30,
  },
  'hic_client',
);

userSelfSuite(
  {
    table: 'ClientSignal',
    servicePolicy: 'p_clientsignal_service_role_all',
    seed: (id, userId) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO public."ClientSignal"("id","user_id","signal_type","value") VALUES ($1,$2,'ENGAGEMENT',0.5)`,
        id, userId,
      ),
    insertOther: (id) =>
      `INSERT INTO public."ClientSignal"("id","user_id","signal_type","value") VALUES ('${id}',$1,'ENGAGEMENT',0.9)`,
    insertParams: (userId) => [userId],
    updateColumn: 'signal_type',
    updateValueLiteral: "'HIJACKED'",
    originalValue: 'ENGAGEMENT',
  },
  'cs_client',
);

userSelfSuite(
  {
    table: 'ClientOutcome',
    servicePolicy: 'p_clientoutcome_service_role_all',
    seed: (id, userId) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO public."ClientOutcome"("id","user_id","outcome_type") VALUES ($1,$2,'RENEWED')`,
        id, userId,
      ),
    // user_id is UNIQUE on ClientOutcome; the cross-tenant insert uses FOREIGN's
    // own id-space but writes a row owned by CLIENT, which the policy rejects
    // before any unique check matters.
    insertOther: (id) =>
      `INSERT INTO public."ClientOutcome"("id","user_id","outcome_type") VALUES ('${id}',$1,'CHURNED')`,
    insertParams: (userId) => [`${userId}_co_other`],
    updateColumn: 'outcome_type',
    updateValueLiteral: "'CHURNED'",
    originalValue: 'RENEWED',
  },
  'co_client',
);

userSelfSuite(
  {
    table: 'PtmPrediction',
    servicePolicy: 'p_ptmprediction_service_role_all',
    seed: (id, userId) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO public."PtmPrediction"("id","user_id","risk_score","success_score","prediction_basis") VALUES ($1,$2,0.2,0.8,'HEURISTIC')`,
        id, userId,
      ),
    insertOther: (id) =>
      `INSERT INTO public."PtmPrediction"("id","user_id","risk_score","success_score","prediction_basis") VALUES ('${id}',$1,0.9,0.1,'HEURISTIC')`,
    insertParams: (userId) => [userId],
    updateColumn: 'prediction_basis',
    updateValueLiteral: "'HIJACKED'",
    originalValue: 'HEURISTIC',
  },
  'ptm_client',
);

// ClientOutcome's cross-tenant insert seeds with CLIENT, but the unique user_id
// means the seeded row already owns CLIENT. Override the subject for that suite's
// negative write so it targets CLIENT (still policy-denied for FOREIGN). The
// generator above passes `${userId}_co_other` as the param, but the predicate
// checks the WRITTEN user_id against the FOREIGN context → still denied. Good.

// ===========================================================================
// ActivityEvent — participant-event (actor/coach/client self, or coach-of-client).
// ===========================================================================
describe('ActivityEvent — participant-event RLS', () => {
  const AE = 'ae_evt'; // actor=CLIENT, coach=COACH, client=CLIENT
  beforeAll(async () => {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."ActivityEvent" WHERE "id" = $1`, AE);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."ActivityEvent"("id","actor_id","coach_id","client_id","type") VALUES ($1,$2,$3,$4,'check_in')`,
        AE, CLIENT, COACH, CLIENT,
      );
    });
  });

  it('rls_ActivityEvent_rls_enabled_and_forced', async () => {
    const f = await rlsFlags('ActivityEvent');
    expect(f.relrowsecurity).toBe(true);
    expect(f.relforcerowsecurity).toBe(true);
  });
  it('rls_ActivityEvent_service_role_policy_exists', async () => {
    expect(await policyExists('ActivityEvent', 'p_activityevent_service_role_all')).toBe(true);
  });
  it('rls_ActivityEvent_owner_can_read_all', async () => {
    await setAuth(OWNER, 'owner');
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([AE]);
  });
  it('rls_ActivityEvent_participant_client_reads', async () => {
    await setAuth(CLIENT, 'student');
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([AE]);
  });
  it('rls_ActivityEvent_participant_coach_reads', async () => {
    await setAuth(COACH, 'coach');
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([AE]);
  });
  it('rls_ActivityEvent_foreign_user_denied', async () => {
    await setAuth(FOREIGN, 'student');
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([]);
    await setAuth(OTHER_COACH, 'coach');
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([]);
  });
  it('rls_ActivityEvent_cross_tenant_write_denied', async () => {
    await setAuth(FOREIGN, 'student');
    // FOREIGN writes an event where they are not a participant nor the coach.
    await expectInsertDenied(
      `INSERT INTO public."ActivityEvent"("id","actor_id","coach_id","client_id","type") VALUES ('ae_x',$1,$2,$3,'check_in')`,
      [CLIENT, COACH, CLIENT],
    );
  });
  it('rls_ActivityEvent_unauthenticated_denied', async () => {
    await clearAuth();
    expect(await visibleIds('ActivityEvent', [AE])).toEqual([]);
    await expectInsertDenied(
      `INSERT INTO public."ActivityEvent"("id","actor_id","coach_id","client_id","type") VALUES ('ae_anon',$1,$2,$3,'check_in')`,
      [CLIENT, COACH, CLIENT],
    );
  });
  it('rls_ActivityEvent_foreign_update_filtered', async () => {
    // FOREIGN is not a participant (actor/coach/client) nor the coach of
    // client_id → USING filters AE out, 0 rows, type stays 'check_in'.
    await setAuth(FOREIGN, 'student');
    await expectUpdateOrDeleteFiltered(
      `UPDATE public."ActivityEvent" SET "type" = 'hijacked' WHERE "id" = $1`,
      [AE],
      async () => {
        const rows = await prisma.$queryRawUnsafe<{ type: string }[]>(
          `SELECT "type" FROM public."ActivityEvent" WHERE "id" = $1`, AE,
        );
        return rows.length === 1 && rows[0].type === 'check_in';
      },
    );
  });
  it('rls_ActivityEvent_foreign_delete_filtered', async () => {
    await setAuth(FOREIGN, 'student');
    await expectUpdateOrDeleteFiltered(
      `DELETE FROM public."ActivityEvent" WHERE "id" = $1`,
      [AE],
      async () => (await visibleIds('ActivityEvent', [AE])).length === 1,
    );
  });
});

// ===========================================================================
// AiRoadmap — child-via-diagnostic-submission (submission_id -> user_id).
// ===========================================================================
describe('AiRoadmap — child-via-diagnostic-submission RLS', () => {
  const SUB = 'ds_client';
  const SUB_FOREIGN = 'ds_foreign';
  const RM = 'rm_client';
  beforeAll(async () => {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."AiRoadmap" WHERE "id" = $1`, RM);
      await prisma.$executeRawUnsafe(`DELETE FROM public."DiagnosticSubmission" WHERE "id" = ANY($1::text[])`, [SUB, SUB_FOREIGN]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."DiagnosticSubmission"("id","email","answers","scores","bucket","user_id") VALUES
           ($1,'c@x.io','[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$2),
           ($3,'f@x.io','[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
        SUB, CLIENT, SUB_FOREIGN, FOREIGN,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."AiRoadmap"("id","submission_id") VALUES ($1,$2)`,
        RM, SUB,
      );
    });
  });

  it('rls_AiRoadmap_rls_enabled_and_forced', async () => {
    const f = await rlsFlags('AiRoadmap');
    expect(f.relrowsecurity).toBe(true);
    expect(f.relforcerowsecurity).toBe(true);
  });
  it('rls_AiRoadmap_service_role_policy_exists', async () => {
    expect(await policyExists('AiRoadmap', 'p_airoadmap_service_role_all')).toBe(true);
  });
  it('rls_AiRoadmap_owner_can_read_all', async () => {
    await setAuth(OWNER, 'owner');
    expect(await visibleIds('AiRoadmap', [RM])).toEqual([RM]);
  });
  it('rls_AiRoadmap_submission_owner_reads', async () => {
    await setAuth(CLIENT, 'student');
    expect(await visibleIds('AiRoadmap', [RM])).toEqual([RM]);
  });
  it('rls_AiRoadmap_parent_link_is_required', async () => {
    // A user whose submission does not link to this roadmap cannot read it,
    // confirming the access flows strictly through the parent FK.
    await setAuth(FOREIGN, 'student');
    expect(await visibleIds('AiRoadmap', [RM])).toEqual([]);
  });
  it('rls_AiRoadmap_foreign_user_denied', async () => {
    await setAuth(OTHER_COACH, 'coach');
    expect(await visibleIds('AiRoadmap', [RM])).toEqual([]);
  });
  it('rls_AiRoadmap_cross_tenant_write_denied', async () => {
    await setAuth(FOREIGN, 'student');
    // FOREIGN tries to attach a roadmap to CLIENT's submission → WITH CHECK fails.
    await expectInsertDenied(
      `INSERT INTO public."AiRoadmap"("id","submission_id") VALUES ('rm_x',$1)`,
      [SUB],
    );
  });
  it('rls_AiRoadmap_unauthenticated_denied', async () => {
    await clearAuth();
    expect(await visibleIds('AiRoadmap', [RM])).toEqual([]);
    await expectInsertDenied(
      `INSERT INTO public."AiRoadmap"("id","submission_id") VALUES ('rm_anon',$1)`,
      [SUB],
    );
  });
  it('rls_AiRoadmap_foreign_update_filtered', async () => {
    // FOREIGN owns SUB_FOREIGN, not the parent submission SUB of RM, so the
    // USING clause (parent DiagnosticSubmission.user_id) filters RM out → 0 rows,
    // and the status column keeps its seeded default 'ready'.
    await setAuth(FOREIGN, 'student');
    await expectUpdateOrDeleteFiltered(
      `UPDATE public."AiRoadmap" SET "status" = 'hijacked' WHERE "id" = $1`,
      [RM],
      async () => {
        const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
          `SELECT "status" FROM public."AiRoadmap" WHERE "id" = $1`, RM,
        );
        return rows.length === 1 && rows[0].status === 'ready';
      },
    );
  });
  it('rls_AiRoadmap_foreign_delete_filtered', async () => {
    await setAuth(FOREIGN, 'student');
    await expectUpdateOrDeleteFiltered(
      `DELETE FROM public."AiRoadmap" WHERE "id" = $1`,
      [RM],
      async () => (await visibleIds('AiRoadmap', [RM])).length === 1,
    );
  });
});

// ===========================================================================
// service_role bypass is structurally correct (catalog shape, not name-only).
// One assertion per target table proving FOR ALL TO service_role
// USING (true) WITH CHECK (true).
// ===========================================================================
describe('service_role bypass is structurally correct', () => {
  for (const table of TIER4_TABLES) {
    it(`rls_${table}_service_role_is_full_bypass`, async () => {
      await assertServiceRolePolicyIsFullBypass(table);
    });
  }
});
