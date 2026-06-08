/**
 * PR-RLS-02 — Tier 2 coach/team admin RLS policies.
 *
 * Exercises the migration 20261212010000_rls_tier2_coach_team against a REAL
 * PostgreSQL instance (NO mocks). The suite is fully self-bootstrapping: it
 * creates the minimal prerequisite catalog objects (schema `app`, the RLS
 * helper functions, a non-superuser `app_user` role that policies are FORCE'd
 * against, the `service_role`, public."User", public."TeamSubCoachAssignment",
 * and the eight in-scope tables), then applies the migration SQL exactly as
 * Prisma would, then asserts policy behavior.
 *
 * Why a dedicated non-privileged role: ENABLE + FORCE ROW LEVEL SECURITY is
 * still bypassed by the table owner / superuser. To prove the policies actually
 * gate access we run every assertion through `app_user` (BYPASSRLS off, not the
 * owner) via SET ROLE, and prove the service_role bypass via SET ROLE service_role.
 *
 * Connection: RLS_TIER2_TEST_DATABASE_URL (preferred), RLS_FN_TEST_DATABASE_URL,
 * or DATABASE_URL. The CI/dev convention is a local superuser-capable role on a
 * throwaway database, e.g.
 *   postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_tier2_test
 * The PrismaClient is constructed against that URL via the `datasources`
 * override so it never touches the app's default database or production Supabase.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261212010000_rls_tier2_coach_team',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER2_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_tier2_test';

// Prerequisite catalog objects the migration and assertions depend on. Mirrors
// the production column shapes the policies actually read. Applied before the
// migration so its ALTER TABLE / CREATE POLICY statements have valid targets.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

-- Non-privileged role the policies are enforced against (FORCE RLS still lets
-- the owner/superuser bypass, so assertions SET ROLE to this).
-- The connected test login must be able to SET ROLE into both app_user and
-- service_role. If this run creates the roles, grant the creator membership
-- WITH ADMIN OPTION so the SET LOCAL ROLE calls in the suite succeed without a
-- superuser. On clusters where the roles already exist (owned by another
-- principal), a one-time "GRANT app_user, service_role TO <login>" must be run
-- by a role administrator before the suite can pass.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
    EXECUTE format('GRANT app_user TO %I WITH ADMIN OPTION', CURRENT_USER);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
    EXECUTE format('GRANT service_role TO %I WITH ADMIN OPTION', CURRENT_USER);
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public."TeamSubCoachAssignment" (
  "id" text PRIMARY KEY,
  "head_coach_id" text NOT NULL,
  "sub_coach_id" text NOT NULL,
  "archived_at" timestamptz
);

CREATE TABLE IF NOT EXISTS public."CoachAlert" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "client_id" text NOT NULL,
  "alert_type" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'warning',
  "message" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CoachNudge" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "client_id" text,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CoachGuideline" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "client_id" text,
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CoachOnboardingProgress" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL UNIQUE,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "current_step" integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public."CoachEffectivenessScore" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "score" double precision NOT NULL,
  "bucket" text NOT NULL,
  "basis" text NOT NULL DEFAULT 'v1',
  "computed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CoachAvailability" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "day_of_week" integer NOT NULL,
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "session_type_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."CoachAvailabilityOverride" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "date" date NOT NULL,
  "start_minute" integer,
  "end_minute" integer,
  "kind" text NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."TeamAuditEvent" (
  "id" text PRIMARY KEY,
  "head_coach_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "target_client_id" text,
  "event_kind" text NOT NULL,
  "summary" text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);

-- Repair prerequisite tables that may already exist with an incomplete shape on
-- a shared throwaway database. CREATE TABLE IF NOT EXISTS is a no-op against an
-- existing table, so any column the migration's policies read must be added
-- idempotently here or every policy predicate fails with SQLSTATE 42703. The
-- head_coach_id column stays nullable: RLS treats a missing head-coach link as
-- "no visibility" (the predicate simply evaluates false), and adding a NOT NULL
-- constraint would break other PRs that share this database.
ALTER TABLE public."TeamSubCoachAssignment" ADD COLUMN IF NOT EXISTS "head_coach_id" text;
ALTER TABLE public."TeamSubCoachAssignment" ADD COLUMN IF NOT EXISTS "sub_coach_id" text;
ALTER TABLE public."TeamSubCoachAssignment" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

-- The policies reference these tables by unqualified name only inside the
-- predicate subquery (public."TeamSubCoachAssignment"); grant the app role the
-- table privileges so RLS — not a missing GRANT — is what governs the outcome.
GRANT USAGE ON SCHEMA app TO app_user, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_role;

-- RLS helper functions (text-based app.current_user_id convention), matching
-- the hardened definitions from PR-RLS-FN (20261212000000).
CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;

CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL
     AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" u
       WHERE u."id" = client_user_id
         AND u."coach_id" = coach_user_id
         AND u."role" = 'student'
     )
$fn$;

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;

-- The helper functions read GUCs but the SECURITY DEFINER one queries public."User";
-- make sure the app role can execute them.
GRANT EXECUTE ON FUNCTION app.current_user_role() TO app_user, service_role;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_user, service_role;
GRANT EXECUTE ON FUNCTION app.is_owner() TO app_user, service_role;
GRANT EXECUTE ON FUNCTION app.is_user_coached_by(text, text) TO app_user, service_role;
GRANT EXECUTE ON FUNCTION app.is_current_coach_of(text) TO app_user, service_role;
`;

/**
 * Split a SQL file into top-level statements on semicolons that are NOT inside a
 * dollar-quoted block ($$...$$ or $tag$...$tag$) or a single-quoted literal.
 * Mirrors the proven splitter from rls-helper-search-path.spec.ts so function
 * bodies and BEGIN/COMMIT wrappers are handled identically.
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

function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

// Pin the pool to a single connection so session GUCs / SET ROLE are
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
    // No swallowing: any failure here must fail the suite loudly (R0).
    await prisma.$executeRawUnsafe(stmt);
  }
}

/** Identity actors used across the suite. */
const OWNER = 'u_owner';
const COACH_A = 'coach_A';
const COACH_B = 'coach_B';
const CLIENT_A = 'client_A'; // coached by COACH_A
const CLIENT_B = 'client_B'; // coached by COACH_B
const HEAD = 'head_coach';
const SUB = 'sub_coach'; // assigned under HEAD (assistant_coach)
const STRANGER = 'stranger';

/**
 * Run `body` with the session acting AS the given app identity. Wraps in an
 * interactive transaction so SET LOCAL ROLE + GUCs are scoped and any RLS
 * violation rolls back cleanly without poisoning the shared connection.
 */
async function asUser<T>(
  role: 'app_user' | 'service_role',
  userId: string | null,
  userRole: string | null,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, userId ?? '');
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, userRole ?? '');
    return body(tx);
  });
}

/** Count rows visible to the given actor (RLS-gated SELECT). */
async function countVisible(
  role: 'app_user' | 'service_role',
  userId: string | null,
  userRole: string | null,
  table: string,
  whereId: string,
): Promise<number> {
  return asUser(role, userId, userRole, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public."${table}" WHERE "id" = $1`,
      whereId,
    );
    return Number(rows[0].n);
  });
}

/**
 * Assert that a promised query is rejected by RLS, checking the underlying
 * PostgreSQL SQLSTATE rather than matching on error text. A WITH CHECK violation
 * (e.g. INSERT/UPDATE writing a row the policy forbids) raises SQLSTATE 42501
 * (insufficient_privilege); a misconfigured/recursive policy raises 42P17. The
 * Prisma raw-query path surfaces the database error as code P2010 with the
 * native SQLSTATE under meta.code, but some driver paths surface the SQLSTATE
 * directly on err.code — accept either deterministically.
 */
async function expectRlsDenied(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error('Expected RLS denial but query succeeded');
  } catch (err: unknown) {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    const sqlstate = e.meta?.code ?? '';
    if (e.code === 'P2010' && (sqlstate === '42501' || sqlstate === '42P17')) return;
    if (e.code === '42501' || e.code === '42P17') return;
    throw new Error(
      `Expected SQLSTATE 42501 (RLS denial); got code=${e.code ?? 'undefined'} ` +
        `meta.code=${sqlstate || 'undefined'} message=${e.message ?? ''}`,
    );
  }
}

/**
 * Assert that an INSERT is rejected by RLS. PostgreSQL raises SQLSTATE 42501
 * when the WITH CHECK predicate fails on INSERT, so this asserts that specific
 * SQLSTATE via expectRlsDenied rather than a fragile message regex.
 */
async function expectInsertDenied(
  role: 'app_user' | 'service_role',
  userId: string | null,
  userRole: string | null,
  stmt: string,
  ...params: unknown[]
): Promise<void> {
  await expectRlsDenied(
    asUser(role, userId, userRole, async (tx) => {
      await tx.$executeRawUnsafe(stmt, ...params);
    }),
  );
}

/**
 * Assert that an UPDATE affects ZERO rows under RLS. When the USING predicate
 * hides the target row, PostgreSQL silently updates 0 rows (it does NOT raise),
 * which is the correct denial outcome for a user who cannot even see the row.
 * $executeRawUnsafe returns the affected-row count, so we assert it is 0.
 */
async function expectUpdateNoOp(
  role: 'app_user' | 'service_role',
  userId: string | null,
  userRole: string | null,
  stmt: string,
  ...params: unknown[]
): Promise<void> {
  const affected = await asUser(role, userId, userRole, async (tx) => {
    return tx.$executeRawUnsafe(stmt, ...params);
  });
  expect(affected).toBe(0);
}

/**
 * Assert that a DELETE affects ZERO rows under RLS. Every DELETE policy in this
 * migration is USING-only (a DELETE has no WITH CHECK), so when the target row
 * is invisible to the actor the row is filtered out of the command's view and
 * PostgreSQL deletes 0 rows rather than raising. $executeRawUnsafe returns the
 * affected-row count, so we assert it is 0. Callers should additionally confirm
 * via service_role that the row still exists, proving the data was untouched.
 */
async function expectDeleteNoOp(
  role: 'app_user' | 'service_role',
  userId: string | null,
  userRole: string | null,
  stmt: string,
  ...params: unknown[]
): Promise<void> {
  const affected = await asUser(role, userId, userRole, async (tx) => {
    return tx.$executeRawUnsafe(stmt, ...params);
  });
  expect(affected).toBe(0);
}

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Confirm every table actually has RLS enabled+forced (fail loudly otherwise).
  const tables = [
    'CoachAlert',
    'CoachNudge',
    'CoachGuideline',
    'CoachOnboardingProgress',
    'CoachEffectivenessScore',
    'CoachAvailability',
    'CoachAvailabilityOverride',
    'TeamAuditEvent',
  ];
  const rlsRows = await prisma.$queryRawUnsafe<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    tables,
  );
  for (const t of tables) {
    const r = rlsRows.find((x) => x.relname === t);
    if (!r || !r.relrowsecurity || !r.relforcerowsecurity) {
      throw new Error(`bootstrap incomplete: RLS not enabled+forced on ${t}`);
    }
  }

  // Seed identity graph (as superuser/owner of the connection — RLS does not
  // gate these tables for the connection role, and User/TSCA carry their own
  // policies from other PRs which are out of scope here).
  await prisma.$executeRawUnsafe('DELETE FROM public."TeamSubCoachAssignment"');
  await prisma.$executeRawUnsafe('DELETE FROM public."User"');
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('${OWNER}', NULL, 'owner'),
       ('${COACH_A}', NULL, 'coach'),
       ('${COACH_B}', NULL, 'coach'),
       ('${CLIENT_A}', '${COACH_A}', 'student'),
       ('${CLIENT_B}', '${COACH_B}', 'student'),
       ('${HEAD}', NULL, 'coach'),
       ('${SUB}', NULL, 'coach'),
       ('${STRANGER}', NULL, 'coach')`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."TeamSubCoachAssignment"("id","head_coach_id","sub_coach_id","archived_at")
       VALUES ('tsca1','${HEAD}','${SUB}',NULL)`,
  );
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Per-table data seeded fresh before each describe-block's tests run, so a
 * write-denial test that (correctly) changes nothing cannot leak into a later
 * read assertion.
 *
 * The connection role is NOT guaranteed to be a superuser / BYPASSRLS role, and
 * the eight in-scope tables are FORCE ROW LEVEL SECURITY — so an unprivileged
 * connection role is itself subject to the policies and could not seed arbitrary
 * rows. We therefore run every privileged seed/cleanup write inside a
 * `service_role` transaction, which the migration's service_role bypass policy
 * permits. This mirrors how the production NestJS service connection behaves.
 */
async function privileged(stmt: string, ...params: unknown[]): Promise<void> {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
    await tx.$executeRawUnsafe(stmt, ...params);
  });
}

/** Alias used at row-seed sites for readability. */
async function seed(stmt: string, ...params: unknown[]): Promise<void> {
  await privileged(stmt, ...params);
}

// =====================================================================
// CoachAlert — client-self-or-coach
// =====================================================================
describe('PR-RLS-02: CoachAlert (client-self-or-coach)', () => {
  const ROW = 'alert_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachAlert"');
    await seed(
      `INSERT INTO public."CoachAlert"("id","coach_id","client_id","alert_type","severity","message")
         VALUES ($1,$2,$3,'consecutive_misses','warning','m')`,
      ROW,
      COACH_A,
      CLIENT_A,
    );
  });

  it('positive own-read: the owning coach can read its alert', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachAlert', ROW)).toBe(1);
  });
  it('positive own-read: the alert client can read it', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachAlert', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachAlert', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachAlert', ROW)).toBe(0);
  });
  it('coach-of-client access: current coach of the client can read', async () => {
    // COACH_A coaches CLIENT_A via app.is_current_coach_of even if coach_id differed.
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachAlert', ROW)).toBe(1);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachAlert', ROW)).toBe(1);
  });
  it('INSERT denial: a stranger cannot insert for someone else', async () => {
    await expectInsertDenied(
      'app_user',
      STRANGER,
      'coach',
      `INSERT INTO public."CoachAlert"("id","coach_id","client_id","alert_type","message")
         VALUES ('alert_evil','${COACH_A}','${CLIENT_A}','x','m')`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the alert', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachAlert" SET "message" = 'h' WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the alert', async () => {
    // DELETE policy is USING-only; the foreign coach cannot see the row so the
    // DELETE filters to zero rows affected. Then prove the row is untouched.
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachAlert" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachAlert', ROW)).toBe(1);
  });
});

// =====================================================================
// CoachNudge — client-self-or-coach
// =====================================================================
describe('PR-RLS-02: CoachNudge (client-self-or-coach)', () => {
  const ROW = 'nudge_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachNudge"');
    await seed(
      `INSERT INTO public."CoachNudge"("id","coach_id","client_id","title","body")
         VALUES ($1,$2,$3,'t','b')`,
      ROW,
      COACH_A,
      CLIENT_A,
    );
  });

  it('positive own-read: the owning coach can read its nudge', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachNudge', ROW)).toBe(1);
  });
  it('positive own-read: the nudge client can read it', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachNudge', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachNudge', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachNudge', ROW)).toBe(0);
  });
  it('coach-of-client access: current coach of the client can read', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachNudge', ROW)).toBe(1);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachNudge', ROW)).toBe(1);
  });
  it('INSERT denial: a stranger cannot insert for someone else', async () => {
    await expectInsertDenied(
      'app_user',
      STRANGER,
      'coach',
      `INSERT INTO public."CoachNudge"("id","coach_id","client_id","title","body")
         VALUES ('nudge_evil','${COACH_A}','${CLIENT_A}','t','b')`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the nudge', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachNudge" SET "body" = 'h' WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the nudge', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachNudge" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachNudge', ROW)).toBe(1);
  });
});

// =====================================================================
// CoachGuideline — client-self-or-coach
// =====================================================================
describe('PR-RLS-02: CoachGuideline (client-self-or-coach)', () => {
  const ROW = 'guideline_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachGuideline"');
    await seed(
      `INSERT INTO public."CoachGuideline"("id","coach_id","client_id","content")
         VALUES ($1,$2,$3,'c')`,
      ROW,
      COACH_A,
      CLIENT_A,
    );
  });

  it('positive own-read: the owning coach can read its guideline', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachGuideline', ROW)).toBe(1);
  });
  it('positive own-read: the guideline client can read it', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachGuideline', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachGuideline', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachGuideline', ROW)).toBe(0);
  });
  it('coach-of-client access: current coach of the client can read', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachGuideline', ROW)).toBe(1);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachGuideline', ROW)).toBe(1);
  });
  it('INSERT denial: a stranger cannot insert for someone else', async () => {
    await expectInsertDenied(
      'app_user',
      STRANGER,
      'coach',
      `INSERT INTO public."CoachGuideline"("id","coach_id","client_id","content")
         VALUES ('guideline_evil','${COACH_A}','${CLIENT_A}','c')`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the guideline', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachGuideline" SET "content" = 'h' WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the guideline', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachGuideline" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachGuideline', ROW)).toBe(1);
  });
});

// =====================================================================
// CoachOnboardingProgress — coach-self
// =====================================================================
describe('PR-RLS-02: CoachOnboardingProgress (coach-self)', () => {
  const ROW = 'onboarding_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachOnboardingProgress"');
    await seed(
      `INSERT INTO public."CoachOnboardingProgress"("id","coach_id","current_step")
         VALUES ($1,$2,2)`,
      ROW,
      COACH_A,
    );
  });

  it('positive own-read: the owning coach can read its onboarding row', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachOnboardingProgress', ROW)).toBe(1);
  });
  it('negative foreign-read: another coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachOnboardingProgress', ROW)).toBe(0);
  });
  it('cross-tenant: a client of another coach sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachOnboardingProgress', ROW)).toBe(0);
  });
  it('coach-of-client access: a client cannot read the coach onboarding row', async () => {
    // CoachOnboardingProgress is coach-self only — even the coach's own client is denied.
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachOnboardingProgress', ROW)).toBe(0);
  });
  it('owner read: the platform owner can read any onboarding row', async () => {
    expect(await countVisible('app_user', OWNER, 'owner', 'CoachOnboardingProgress', ROW)).toBe(1);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachOnboardingProgress', ROW)).toBe(1);
  });
  it('INSERT denial: a coach cannot insert an onboarding row for another coach', async () => {
    await expectInsertDenied(
      'app_user',
      COACH_B,
      'coach',
      `INSERT INTO public."CoachOnboardingProgress"("id","coach_id","current_step")
         VALUES ('onboarding_evil','${COACH_A}',1)`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the onboarding row', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachOnboardingProgress" SET "current_step" = 9 WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the onboarding row', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachOnboardingProgress" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachOnboardingProgress', ROW)).toBe(1);
  });
});

// =====================================================================
// CoachEffectivenessScore — coach-self-read, owner-write
// =====================================================================
describe('PR-RLS-02: CoachEffectivenessScore (coach-self-read, owner-write)', () => {
  const ROW = 'score_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachEffectivenessScore"');
    await seed(
      `INSERT INTO public."CoachEffectivenessScore"("id","coach_id","score","bucket")
         VALUES ($1,$2,0.8,'consistent')`,
      ROW,
      COACH_A,
    );
  });

  it('positive own-read: the scored coach can read their own score', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'CoachEffectivenessScore', ROW)).toBe(1);
  });
  it('negative foreign-read: another coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachEffectivenessScore', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachEffectivenessScore', ROW)).toBe(0);
  });
  it('coach-of-client access: a client cannot read the coach score', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachEffectivenessScore', ROW)).toBe(0);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachEffectivenessScore', ROW)).toBe(1);
  });
  it('INSERT denial: a coach cannot insert (fabricate) their own score', async () => {
    await expectInsertDenied(
      'app_user',
      COACH_A,
      'coach',
      `INSERT INTO public."CoachEffectivenessScore"("id","coach_id","score","bucket")
         VALUES ('score_evil','${COACH_A}',1.0,'high-performer')`,
    );
  });
  it('UPDATE denial: a coach cannot update (inflate) their own score', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_A,
      'coach',
      `UPDATE public."CoachEffectivenessScore" SET "score" = 1.0 WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a coach cannot delete their own score', async () => {
    // Owner-only write: the scored coach is not the owner, so the DELETE USING
    // (app.is_owner()) hides the row and zero rows are removed.
    await expectDeleteNoOp(
      'app_user',
      COACH_A,
      'coach',
      `DELETE FROM public."CoachEffectivenessScore" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachEffectivenessScore', ROW)).toBe(1);
  });
  it('owner-write: the owner CAN insert a score', async () => {
    await asUser('app_user', OWNER, 'owner', async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO public."CoachEffectivenessScore"("id","coach_id","score","bucket")
           VALUES ('score_owner','${COACH_B}',0.5,'developing')`,
      );
    });
    expect(await countVisible('service_role', null, null, 'CoachEffectivenessScore', 'score_owner')).toBe(1);
  });
});

// =====================================================================
// CoachAvailability — coach-self + head-coach SELECT-only (decision lock)
// =====================================================================
describe('PR-RLS-02: CoachAvailability (coach-self + head SELECT-only)', () => {
  const ROW = 'avail_row_1'; // owned by SUB (the assistant coach)
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachAvailability"');
    await seed(
      `INSERT INTO public."CoachAvailability"("id","coach_id","day_of_week","start_minute","end_minute")
         VALUES ($1,$2,1,540,720)`,
      ROW,
      SUB,
    );
  });

  it('positive own-read: the owning (sub) coach can read its availability', async () => {
    expect(await countVisible('app_user', SUB, 'coach', 'CoachAvailability', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachAvailability', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachAvailability', ROW)).toBe(0);
  });
  it('coach-of-client access: a client cannot read coach availability', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachAvailability', ROW)).toBe(0);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachAvailability', ROW)).toBe(1);
  });
  it('INSERT denial: a coach cannot insert availability for another coach', async () => {
    await expectInsertDenied(
      'app_user',
      COACH_B,
      'coach',
      `INSERT INTO public."CoachAvailability"("id","coach_id","day_of_week","start_minute","end_minute")
         VALUES ('avail_evil','${SUB}',2,0,60)`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the availability', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachAvailability" SET "end_minute" = 999 WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the availability', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachAvailability" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachAvailability', ROW)).toBe(1);
  });

  // ---- Decision-lock EXTRA tests ----
  it('decision lock (a): the assistant_coach CAN fully CRUD their OWN availability', async () => {
    await asUser('app_user', SUB, 'coach', async (tx) => {
      // INSERT own
      await tx.$executeRawUnsafe(
        `INSERT INTO public."CoachAvailability"("id","coach_id","day_of_week","start_minute","end_minute")
           VALUES ('avail_sub_own','${SUB}',3,600,660)`,
      );
      // UPDATE own
      await tx.$executeRawUnsafe(
        `UPDATE public."CoachAvailability" SET "end_minute" = 700 WHERE "id" = 'avail_sub_own'`,
      );
      // SELECT own
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM public."CoachAvailability" WHERE "id" = 'avail_sub_own' AND "end_minute" = 700`,
      );
      expect(Number(rows[0].n)).toBe(1);
      // DELETE own
      await tx.$executeRawUnsafe(`DELETE FROM public."CoachAvailability" WHERE "id" = 'avail_sub_own'`);
    });
    expect(await countVisible('service_role', null, null, 'CoachAvailability', 'avail_sub_own')).toBe(0);
  });
  it('decision lock (b): the head_coach can SELECT a team sub-coach availability but NOT write it', async () => {
    // SELECT-only: head can read the sub's row.
    expect(await countVisible('app_user', HEAD, 'coach', 'CoachAvailability', ROW)).toBe(1);
    // ...but cannot UPDATE it (no write predicate for the head coach).
    await expectUpdateNoOp(
      'app_user',
      HEAD,
      'coach',
      `UPDATE public."CoachAvailability" SET "end_minute" = 999 WHERE "id" = '${ROW}'`,
    );
    // ...and cannot DELETE it: the DELETE USING is coach_id = current_user only
    // (no head-coach predicate), so the head coach filters to zero rows affected.
    await expectDeleteNoOp(
      'app_user',
      HEAD,
      'coach',
      `DELETE FROM public."CoachAvailability" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachAvailability', ROW)).toBe(1);
  });
});

// =====================================================================
// CoachAvailabilityOverride — coach-self + head-coach SELECT-only (decision lock)
// =====================================================================
describe('PR-RLS-02: CoachAvailabilityOverride (coach-self + head SELECT-only)', () => {
  const ROW = 'override_row_1'; // owned by SUB (the assistant coach)
  beforeEach(async () => {
    await privileged('DELETE FROM public."CoachAvailabilityOverride"');
    await seed(
      `INSERT INTO public."CoachAvailabilityOverride"("id","coach_id","date","kind")
         VALUES ($1,$2,'2026-01-01','holiday')`,
      ROW,
      SUB,
    );
  });

  it('positive own-read: the owning (sub) coach can read its override', async () => {
    expect(await countVisible('app_user', SUB, 'coach', 'CoachAvailabilityOverride', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'CoachAvailabilityOverride', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'CoachAvailabilityOverride', ROW)).toBe(0);
  });
  it('coach-of-client access: a client cannot read coach override', async () => {
    expect(await countVisible('app_user', CLIENT_A, 'student', 'CoachAvailabilityOverride', ROW)).toBe(0);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'CoachAvailabilityOverride', ROW)).toBe(1);
  });
  it('INSERT denial: a coach cannot insert an override for another coach', async () => {
    await expectInsertDenied(
      'app_user',
      COACH_B,
      'coach',
      `INSERT INTO public."CoachAvailabilityOverride"("id","coach_id","date","kind")
         VALUES ('override_evil','${SUB}','2026-02-02','block')`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the override', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."CoachAvailabilityOverride" SET "note" = 'h' WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the override', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."CoachAvailabilityOverride" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachAvailabilityOverride', ROW)).toBe(1);
  });

  // ---- Decision-lock EXTRA tests ----
  it('decision lock (a): the assistant_coach CAN fully CRUD their OWN override', async () => {
    await asUser('app_user', SUB, 'coach', async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO public."CoachAvailabilityOverride"("id","coach_id","date","kind","note")
           VALUES ('override_sub_own','${SUB}','2026-03-03','block','x')`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE public."CoachAvailabilityOverride" SET "note" = 'y' WHERE "id" = 'override_sub_own'`,
      );
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM public."CoachAvailabilityOverride" WHERE "id" = 'override_sub_own' AND "note" = 'y'`,
      );
      expect(Number(rows[0].n)).toBe(1);
      await tx.$executeRawUnsafe(`DELETE FROM public."CoachAvailabilityOverride" WHERE "id" = 'override_sub_own'`);
    });
    expect(await countVisible('service_role', null, null, 'CoachAvailabilityOverride', 'override_sub_own')).toBe(0);
  });
  it('decision lock (b): the head_coach can SELECT a team sub-coach override but NOT write it', async () => {
    expect(await countVisible('app_user', HEAD, 'coach', 'CoachAvailabilityOverride', ROW)).toBe(1);
    await expectUpdateNoOp(
      'app_user',
      HEAD,
      'coach',
      `UPDATE public."CoachAvailabilityOverride" SET "note" = 'h' WHERE "id" = '${ROW}'`,
    );
    // DELETE USING is coach_id = current_user only, so the head coach deletes
    // zero rows; the sub-coach's row is preserved.
    await expectDeleteNoOp(
      'app_user',
      HEAD,
      'coach',
      `DELETE FROM public."CoachAvailabilityOverride" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'CoachAvailabilityOverride', ROW)).toBe(1);
  });
});

// =====================================================================
// TeamAuditEvent — head-coach-audit
// =====================================================================
describe('PR-RLS-02: TeamAuditEvent (head-coach-audit)', () => {
  const ROW = 'audit_row_1';
  beforeEach(async () => {
    await privileged('DELETE FROM public."TeamAuditEvent"');
    // head_coach_id = HEAD, actor = SUB, target client = CLIENT_A (coached by COACH_A).
    await seed(
      `INSERT INTO public."TeamAuditEvent"("id","head_coach_id","actor_user_id","target_client_id","event_kind","summary")
         VALUES ($1,$2,$3,$4,'sub_coach_assigned','s')`,
      ROW,
      HEAD,
      SUB,
      CLIENT_A,
    );
  });

  it('positive own-read: the head coach can read its audit event', async () => {
    expect(await countVisible('app_user', HEAD, 'coach', 'TeamAuditEvent', ROW)).toBe(1);
  });
  it('positive own-read: the acting user can read the event they performed', async () => {
    expect(await countVisible('app_user', SUB, 'coach', 'TeamAuditEvent', ROW)).toBe(1);
  });
  it('negative foreign-read: an unrelated coach sees nothing', async () => {
    expect(await countVisible('app_user', COACH_B, 'coach', 'TeamAuditEvent', ROW)).toBe(0);
  });
  it('cross-tenant: a foreign client sees nothing', async () => {
    expect(await countVisible('app_user', CLIENT_B, 'student', 'TeamAuditEvent', ROW)).toBe(0);
  });
  it('coach-of-client access: the target client current coach can read', async () => {
    expect(await countVisible('app_user', COACH_A, 'coach', 'TeamAuditEvent', ROW)).toBe(1);
  });
  it('service role bypass: service_role reads regardless of context', async () => {
    expect(await countVisible('service_role', null, null, 'TeamAuditEvent', ROW)).toBe(1);
  });
  it('INSERT denial: a stranger cannot insert an audit event for another team', async () => {
    await expectInsertDenied(
      'app_user',
      STRANGER,
      'coach',
      `INSERT INTO public."TeamAuditEvent"("id","head_coach_id","actor_user_id","event_kind","summary")
         VALUES ('audit_evil','${HEAD}','${HEAD}','tier_changed','s')`,
    );
  });
  it('UPDATE denial: a foreign coach cannot update the audit event', async () => {
    await expectUpdateNoOp(
      'app_user',
      COACH_B,
      'coach',
      `UPDATE public."TeamAuditEvent" SET "summary" = 'h' WHERE "id" = '${ROW}'`,
    );
  });
  it('DELETE denial: a foreign coach cannot delete the audit event', async () => {
    await expectDeleteNoOp(
      'app_user',
      COACH_B,
      'coach',
      `DELETE FROM public."TeamAuditEvent" WHERE "id" = '${ROW}'`,
    );
    expect(await countVisible('service_role', null, null, 'TeamAuditEvent', ROW)).toBe(1);
  });
});

// =====================================================================
// service_role bypass policies — catalog-level shape verification
//
// Runtime read access is not sufficient proof: it must be the case that every
// in-scope table carries EXACTLY ONE service_role bypass policy that is
// FOR ALL (polcmd='*'), granted to role service_role, with USING (true) and
// WITH CHECK (true). We assert this structurally against pg_policy so a policy
// that is accidentally narrowed (e.g. FOR SELECT, or USING (false)) is caught.
// =====================================================================
describe('PR-RLS-02: service_role policies — catalog shape', () => {
  const IN_SCOPE_TABLES = [
    'CoachAlert',
    'CoachNudge',
    'CoachGuideline',
    'CoachOnboardingProgress',
    'CoachEffectivenessScore',
    'CoachAvailability',
    'CoachAvailabilityOverride',
    'TeamAuditEvent',
  ];

  async function fetchServiceRolePolicies(): Promise<
    Array<{
      table_name: string;
      polname: string;
      cmd: string;
      rolname: string;
      qual: string;
      withcheck: string;
    }>
  > {
    return prisma.$queryRawUnsafe<
      Array<{
        table_name: string;
        polname: string;
        cmd: string;
        rolname: string;
        qual: string;
        withcheck: string;
      }>
    >(`
      SELECT
        c.relname AS table_name,
        p.polname,
        p.polcmd::text AS cmd,
        r.rolname,
        pg_get_expr(p.polqual, p.polrelid) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = ANY(p.polroles)
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'CoachAlert','CoachNudge','CoachGuideline','CoachOnboardingProgress',
          'CoachEffectivenessScore','CoachAvailability','CoachAvailabilityOverride','TeamAuditEvent'
        )
        AND r.rolname = 'service_role'
      ORDER BY c.relname, p.polname;
    `);
  }

  it('exactly one service_role bypass policy exists per in-scope table', async () => {
    const rows = await fetchServiceRolePolicies();
    expect(rows).toHaveLength(8);
    const tables = rows.map((r) => r.table_name).sort();
    expect(tables).toEqual([...IN_SCOPE_TABLES].sort());
  });

  it('every service_role policy is FOR ALL granted to role service_role', async () => {
    const rows = await fetchServiceRolePolicies();
    for (const row of rows) {
      expect(row.cmd).toBe('*'); // polcmd '*' == FOR ALL
      expect(row.rolname).toBe('service_role');
    }
  });

  it('every service_role policy has USING (true) and WITH CHECK (true)', async () => {
    const rows = await fetchServiceRolePolicies();
    for (const row of rows) {
      expect(row.qual).toBe('true');
      expect(row.withcheck).toBe('true');
    }
  });
});
