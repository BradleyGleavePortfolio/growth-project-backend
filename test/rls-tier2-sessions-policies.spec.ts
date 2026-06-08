/**
 * PR-RLS-03 — Tier 2 scheduling / sessions RLS policies.
 *
 * Verifies migration 20261213000000_rls_tier2_sessions against a REAL
 * PostgreSQL instance (NO mocks). The suite is fully self-bootstrapping: it
 * creates the minimal prerequisite catalog objects (schema `app`, the helper
 * functions PR-RLS-FN ships, public."User", and the three in-scope tables with
 * the exact columns the policies read), grants table privileges to the
 * Supabase-convention roles (authenticated / anon / service_role) so that RLS —
 * not a missing GRANT — is the only gate, then applies the migration SQL
 * exactly as Prisma would and asserts behaviour.
 *
 * Coverage per table (CoachingSession, SessionParticipant, SessionType):
 *   1. table exists with ENABLE + FORCE row level security
 *   2. exactly five policies present, each with a COMMENT
 *   3. owner (app.is_owner()) can read
 *   4. service_role bypasses RLS for ALL commands
 *   5. positive tenant access (coach / participant) can read
 *   6. foreign authenticated user is denied read
 *   7. cross-tenant write is denied (INSERT WITH CHECK)
 *   8. unauthenticated (anon, no GUC) is denied read
 * → 8 tests × 3 tables = 24 enforcement tests, plus structural checks.
 *
 * RLS enforcement is exercised via `SET ROLE authenticated|anon|service_role`
 * (non-superuser, non-BYPASSRLS roles) combined with the
 * `app.current_user_id` / `app.current_user_role` session GUCs the helpers
 * read. The bootstrapping superuser would otherwise bypass RLS, so every
 * enforcement assertion runs inside an explicit role switch that is always
 * reset, even on failure.
 *
 * Connection: RLS_T2_SESSIONS_TEST_DATABASE_URL (preferred),
 * RLS_FN_TEST_DATABASE_URL, or DATABASE_URL. The CI/dev convention is a local
 * superuser-capable role on a throwaway database, e.g.
 *   postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test
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
  '20261213000000_rls_tier2_sessions',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_T2_SESSIONS_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

// Prerequisite catalog objects the policies depend on, mirroring the exact
// production columns the policy predicates read. Applied before the migration
// so the migration's ALTER TABLE / CREATE POLICY statements have valid targets.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

-- Helper functions (PR-RLS-FN). Recreated verbatim so dependencies resolve on
-- a clean database; CREATE OR REPLACE is a no-op where they already exist.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL AND coach_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."User" u
     WHERE u."id" = client_user_id AND u."coach_id" = coach_user_id AND u."role" = 'student'
  )
$fn$;
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;

CREATE TABLE IF NOT EXISTS public."SessionType" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL
);
CREATE TABLE IF NOT EXISTS public."CoachingSession" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "client_id" text,
  "session_type_id" text,
  "title" text NOT NULL DEFAULT 't'
);
CREATE TABLE IF NOT EXISTS public."SessionParticipant" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'observer'
);

-- Supabase-convention roles. These pre-exist on a Supabase database; create
-- them defensively for a vanilla Postgres test instance. They are NOSUPERUSER
-- NOBYPASSRLS so RLS is actually enforced against them.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$do$;

GRANT USAGE ON SCHEMA app, public TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_user_role(), app.is_owner(), app.is_current_coach_of(text) TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."SessionType", public."CoachingSession", public."SessionParticipant", public."User" TO authenticated, anon, service_role;
`;

/**
 * Split a SQL file into top-level statements on semicolons that are NOT inside a
 * dollar-quoted block ($$...$$ or $tag$...$tag$) or a single-quoted literal.
 * Prisma applies migrations as a single script, but $executeRawUnsafe runs one
 * statement at a time, so we honour dollar-quoting to keep function/DO bodies
 * intact and strip the wrapping BEGIN/COMMIT (each exec autocommits).
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

/** Strip leading/standalone `--` comment lines so a statement is never comment-only. */
function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

// Pin the pool to a single connection so session GUCs and role switches are
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

/**
 * Run `work` while impersonating `role` with the given auth GUCs, always
 * resetting the role afterwards (even on failure) so the shared single
 * connection is never left poisoned. GUCs are set LOCAL-style (is_local=false
 * but reset explicitly in clearAuthContext) and the role is reset in finally.
 */
async function asRole<T>(
  role: 'authenticated' | 'anon' | 'service_role',
  guc: { userId?: string; userRole?: string },
  work: () => Promise<T>,
): Promise<T> {
  await prisma.$executeRawUnsafe(
    `SELECT set_config('app.current_user_id', $1, false)`,
    guc.userId ?? '',
  );
  await prisma.$executeRawUnsafe(
    `SELECT set_config('app.current_user_role', $1, false)`,
    guc.userRole ?? '',
  );
  await prisma.$executeRawUnsafe(`SET ROLE ${role}`);
  try {
    return await work();
  } finally {
    await prisma.$executeRawUnsafe('RESET ROLE');
  }
}

async function clearAuthContext(): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id', '', false)`);
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role', '', false)`);
}

/** Count rows visible for `id` under the current role/GUC context. */
async function visibleCount(table: string, id: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public."${table}" WHERE "id" = $1`,
    id,
  );
  return Number(rows[0].n);
}

// Stable identities reused across tests. coachC coaches clientCl; foreignU is
// unrelated; obsU is a non-lead participant on coachC's session.
const COACH = 'u_coachC';
const CLIENT = 'u_clientCl';
const FOREIGN = 'u_foreignU';
const OBSERVER = 'u_observerU';
const OTHER_COACH = 'u_coachOther';

// Dedicated identities for the SessionParticipant write-authorization matrix
// (Fix 3 regression). coachA owns sessRA; its lead client clientA is currently
// coached by coachB (NOT coachA), so coachB satisfies
// app.is_current_coach_of(clientA) WITHOUT being sessRA.coach_id — this proves
// the is_current_coach_of write path independently of the direct coach_id match
// (the audit's missing coverage). userB has NO relationship to sessRA.
const COACH_A = 'u_coachA'; // owning coach of sessRA
const COACH_B = 'u_coachB'; // current coach of clientA, but NOT sessRA.coach_id
const CLIENT_A = 'u_clientA'; // lead client of sessRA, coached by coachB
const USER_B = 'u_userB'; // foreign authenticated user, no link to sessRA

// Seed ids.
const ST_OWN = 'st_own'; // SessionType owned by COACH
const ST_OTHER = 'st_other'; // SessionType owned by OTHER_COACH
const SESS = 'sess_main'; // CoachingSession coach=COACH client=CLIENT
const SESS_OTHER = 'sess_other'; // CoachingSession coach=OTHER_COACH
const PART_OBS = 'part_obs'; // participant OBSERVER on SESS
const PART_OTHER = 'part_other'; // participant on SESS_OTHER

// SessionParticipant write-matrix fixtures.
const ST_A = 'st_a'; // SessionType owned by COACH_A
const SESS_RA = 'sess_ra'; // CoachingSession coach=COACH_A client=CLIENT_A
const PART_RA_USERB = 'part_ra_userb'; // pre-seeded participant (userB) on sessRA, for UPDATE/DELETE-deny
const PART_RA_CLIENT = 'part_ra_client'; // pre-seeded self-participation (clientA) on sessRA

async function seed(): Promise<void> {
  // Seed as service_role (bypasses RLS) so fixtures land regardless of policy.
  await prisma.$executeRawUnsafe('SET ROLE service_role');
  try {
    await prisma.$executeRawUnsafe('DELETE FROM public."SessionParticipant"');
    await prisma.$executeRawUnsafe('DELETE FROM public."CoachingSession"');
    await prisma.$executeRawUnsafe('DELETE FROM public."SessionType"');
    await prisma.$executeRawUnsafe('DELETE FROM public."User"');
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","coach_id","role") VALUES
        ($1,NULL,'coach'),($2,$1,'student'),($3,NULL,'student'),($4,NULL,'coach'),($5,NULL,'student'),
        ($6,NULL,'coach'),($7,NULL,'coach'),($8,$7,'student'),($9,NULL,'student')`,
      COACH,
      CLIENT,
      FOREIGN,
      OTHER_COACH,
      OBSERVER,
      COACH_A, // $6 owns sessRA
      COACH_B, // $7 is current coach of clientA
      CLIENT_A, // $8 coach_id = COACH_B
      USER_B, // $9 unrelated
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."SessionType"("id","coach_id") VALUES ($1,$2),($3,$4),($5,$6)`,
      ST_OWN,
      COACH,
      ST_OTHER,
      OTHER_COACH,
      ST_A,
      COACH_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."CoachingSession"("id","coach_id","client_id","title") VALUES
        ($1,$2,$3,'main'),($4,$5,NULL,'other'),($6,$7,$8,'ra')`,
      SESS,
      COACH,
      CLIENT,
      SESS_OTHER,
      OTHER_COACH,
      SESS_RA,
      COACH_A, // sessRA.coach_id = COACH_A (NOT COACH_B)
      CLIENT_A, // sessRA.client_id = CLIENT_A (coached by COACH_B)
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES
        ($1,$2,$3,'observer'),($4,$5,$6,'observer'),($7,$8,$9,'observer'),($10,$11,$12,'attendee')`,
      PART_OBS,
      SESS,
      OBSERVER,
      PART_OTHER,
      SESS_OTHER,
      FOREIGN,
      PART_RA_USERB, // userB pre-placed on sessRA (only service_role could do this)
      SESS_RA,
      USER_B,
      PART_RA_CLIENT, // clientA self-participation on sessRA
      SESS_RA,
      CLIENT_A,
    );
  } finally {
    await prisma.$executeRawUnsafe('RESET ROLE');
  }
}

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Fail loudly (R0) if the migration did not install every policy.
  const created = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('CoachingSession','SessionParticipant','SessionType')`,
  );
  if (Number(created[0].n) !== 15) {
    throw new Error(`bootstrap incomplete: expected 15 policies, found ${created[0].n}`);
  }
  await seed();
}, 60_000);

beforeEach(async () => {
  // Re-seed to a known fixture state before EVERY test so the mutating
  // enforcement cases (positive INSERT, service-role UPDATE/DELETE bypass,
  // affected-row assertions) are order-independent and deterministic. seed()
  // runs as service_role and fully resets the three tables + User.
  await seed();
  await clearAuthContext();
});

afterAll(async () => {
  await prisma.$disconnect();
});

type RelRow = { relrowsecurity: boolean; relforcerowsecurity: boolean };

async function relSecurity(table: string): Promise<RelRow | undefined> {
  const rows = await prisma.$queryRawUnsafe<RelRow[]>(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
    table,
  );
  return rows[0];
}

async function policyNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
    `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=$1 ORDER BY policyname`,
    table,
  );
  return rows.map((r) => r.policyname);
}

async function commentedPolicyCount(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_policy pol
       JOIN pg_class c ON c.oid = pol.polrelid
       JOIN pg_description d ON d.objoid = pol.oid
      WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
    table,
  );
  return Number(rows[0].n);
}

/**
 * Run an INSERT expected to SUCCEED under the current role context (positive
 * WITH CHECK / service-role bypass path). Returns true on success. This helper
 * is NOT a denial classifier — any error propagates so a positive-path test
 * fails loudly. Negative INSERT denials are asserted via expectInsertDenied,
 * which is SQLSTATE-precise (R65 / Failure #30 / Failure #36: no message regex).
 */
async function insertExpectingSuccess(sql: string, params: string[]): Promise<boolean> {
  await prisma.$executeRawUnsafe(sql, ...params);
  return true;
}

/**
 * The PostgreSQL SQLSTATE for an RLS WITH CHECK violation. Prisma surfaces the
 * underlying driver error code on `.meta.code`/`.code` and ALWAYS embeds the
 * five-character SQLSTATE in the error message, so an assertion can be precise
 * rather than vague (R65 / Failure #30 / Failure #36 — no `toBeDefined()`).
 */
const RLS_VIOLATION_SQLSTATE = '42501';

/** SQLSTATEs that unambiguously denote an RLS authorization denial. */
const RLS_DENIAL_SQLSTATES = new Set(['42501', '42P17']);

type CapturedError = {
  message: string;
  /** SQLSTATE if discoverable from the Prisma error envelope or message text. */
  code: string | undefined;
  /** true iff `code` is an RLS denial SQLSTATE (classification is SQLSTATE-only). */
  isRls: boolean;
};

/**
 * Extract the underlying PostgreSQL SQLSTATE from a Prisma error. Prisma wraps
 * raw-query driver errors as `P2010` on `.code`, embedding the real DB SQLSTATE
 * (e.g. 42501 for an RLS violation) in `.meta.code` and in the message text. We
 * therefore look for the DB SQLSTATE in meta/message FIRST and only fall back to
 * the top-level Prisma envelope code, so assertions check the precise Postgres
 * code rather than the generic Prisma wrapper code.
 */
function extractPgCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const meta = (err as { meta?: { code?: unknown } }).meta;
    const metaCode = meta?.code;
    if (typeof metaCode === 'string' && /^[0-9A-Z]{5}$/.test(metaCode)) {
      return metaCode;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const sqlState = /\b(42501|42P17)\b/.exec(msg);
  if (sqlState) return sqlState[1];
  if (err && typeof err === 'object') {
    const topCode = (err as { code?: unknown }).code;
    if (typeof topCode === 'string' && /^[0-9A-Z]{5}$/.test(topCode)) {
      return topCode;
    }
  }
  return undefined;
}

/**
 * Run an INSERT expected to be DENIED by RLS. Denial is classified by SQLSTATE
 * ONLY (42501 insufficient_privilege from a WITH CHECK violation, or 42P17 from
 * a malformed policy) — there is no message-text regex anywhere in the deny
 * path. Returns the captured error so the caller can assert on the precise
 * SQLSTATE. If the statement unexpectedly SUCCEEDS, or fails with a non-RLS
 * SQLSTATE, this throws loudly so the suite fails — a silent pass would re-hide
 * the IDOR bug (R0 / R65 / Failure #30 / Failure #36).
 */
async function expectInsertDenied(sql: string, params: string[]): Promise<CapturedError> {
  try {
    await prisma.$executeRawUnsafe(sql, ...params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = extractPgCode(err);
    const isRls = code !== undefined && RLS_DENIAL_SQLSTATES.has(code);
    if (!isRls) {
      // Not the SQLSTATE-classified deny path we expected — surface the real
      // failure (R65: no swallow) with the extracted code for diagnosis.
      throw new Error(
        `expected SQLSTATE 42501 (RLS denial); got code=${code ?? 'undefined'} message=${message}`,
      );
    }
    return { message, code, isRls };
  }
  throw new Error(
    `expected INSERT to be denied by RLS but it SUCCEEDED: ${sql} [${params.join(', ')}]`,
  );
}

/**
 * Run an UPDATE/DELETE under the current role context and return how many rows
 * it affected. A USING-clause RLS denial does NOT raise in PostgreSQL — it
 * filters the target rows to zero — so an authorization-denied write returns 0.
 * `$executeRawUnsafe` resolves to the affected-row count.
 */
async function execAffected(sql: string, params: string[]): Promise<number> {
  const affected = await prisma.$executeRawUnsafe(sql, ...params);
  return Number(affected);
}

describe('PR-RLS-03: Tier 2 sessions RLS — structural', () => {
  it.each([['CoachingSession'], ['SessionParticipant'], ['SessionType']])(
    '%s has RLS enabled and forced',
    async (table) => {
      const rel = await relSecurity(table);
      expect(rel).toBeDefined();
      expect(rel!.relrowsecurity).toBe(true);
      expect(rel!.relforcerowsecurity).toBe(true);
    },
  );

  it.each([
    ['CoachingSession', 'coachingsession'],
    ['SessionParticipant', 'sessionparticipant'],
    ['SessionType', 'sessiontype'],
  ])('%s has the five canonical policies, all commented', async (table, slug) => {
    const names = await policyNames(table);
    expect(names).toEqual(
      [
        `p_${slug}_delete`,
        `p_${slug}_insert`,
        `p_${slug}_select`,
        `p_${slug}_service_role_all`,
        `p_${slug}_update`,
      ].sort(),
    );
    expect(await commentedPolicyCount(table)).toBe(5);
  });
});

describe('PR-RLS-03: CoachingSession — client-self-or-coach', () => {
  it('owner can read any session', async () => {
    const n = await asRole('authenticated', { userId: 'admin', userRole: 'owner' }, () =>
      visibleCount('CoachingSession', SESS_OTHER),
    );
    expect(n).toBe(1);
  });

  it('service_role bypasses RLS for ALL commands', async () => {
    const n = await asRole('service_role', {}, () => visibleCount('CoachingSession', SESS_OTHER));
    expect(n).toBe(1);
  });

  it('the session coach can read their session', async () => {
    const n = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      visibleCount('CoachingSession', SESS),
    );
    expect(n).toBe(1);
  });

  it('the lead client can read their session', async () => {
    const n = await asRole('authenticated', { userId: CLIENT, userRole: 'student' }, () =>
      visibleCount('CoachingSession', SESS),
    );
    expect(n).toBe(1);
  });

  it('a foreign user is denied read of an unrelated session', async () => {
    const n = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      visibleCount('CoachingSession', SESS),
    );
    expect(n).toBe(0);
  });

  it('a foreign user cannot INSERT a cross-tenant session (WITH CHECK denies)', async () => {
    const err = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      expectInsertDenied(
        `INSERT INTO public."CoachingSession"("id","coach_id","client_id","title") VALUES ($1,$2,$3,'x')`,
        ['sess_evil', COACH, CLIENT],
      ),
    );
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('the session coach CAN INSERT a session they own (positive WITH CHECK)', async () => {
    const ok = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      insertExpectingSuccess(
        `INSERT INTO public."CoachingSession"("id","coach_id","client_id","title") VALUES ($1,$2,$3,'mine')`,
        ['sess_coach_new', COACH, CLIENT],
      ),
    );
    expect(ok).toBe(true);
  });

  it('an unauthenticated anon user is denied read', async () => {
    const n = await asRole('anon', {}, () => visibleCount('CoachingSession', SESS));
    expect(n).toBe(0);
  });
});

describe('PR-RLS-03: SessionParticipant — session-participant primitive', () => {
  it('owner can read any participant row', async () => {
    const n = await asRole('authenticated', { userId: 'admin', userRole: 'owner' }, () =>
      visibleCount('SessionParticipant', PART_OBS),
    );
    expect(n).toBe(1);
  });

  it('service_role bypasses RLS for ALL commands', async () => {
    const n = await asRole('service_role', {}, () => visibleCount('SessionParticipant', PART_OTHER));
    expect(n).toBe(1);
  });

  it('a participant can read their own row even when not the session coach/client', async () => {
    const n = await asRole('authenticated', { userId: OBSERVER, userRole: 'student' }, () =>
      visibleCount('SessionParticipant', PART_OBS),
    );
    expect(n).toBe(1);
  });

  it('the parent session coach can read participant rows of that session', async () => {
    const n = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      visibleCount('SessionParticipant', PART_OBS),
    );
    expect(n).toBe(1);
  });

  it('a foreign user is denied read of a participant row on an unrelated session', async () => {
    const n = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      visibleCount('SessionParticipant', PART_OBS),
    );
    expect(n).toBe(0);
  });

  it('the parent session coach CAN INSERT a participant on their session (positive WITH CHECK)', async () => {
    const ok = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      insertExpectingSuccess(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'observer')`,
        ['part_new_ok', SESS, FOREIGN],
      ),
    );
    expect(ok).toBe(true);
  });

  it('a foreign user cannot INSERT a participant onto a session they cannot access (WITH CHECK denies)', async () => {
    const err = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      expectInsertDenied(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'observer')`,
        ['part_evil', SESS, OBSERVER],
      ),
    );
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('an unauthenticated anon user is denied read', async () => {
    const n = await asRole('anon', {}, () => visibleCount('SessionParticipant', PART_OBS));
    expect(n).toBe(0);
  });
});

describe('PR-RLS-03: SessionType — coach-self', () => {
  it('owner can read any session type', async () => {
    const n = await asRole('authenticated', { userId: 'admin', userRole: 'owner' }, () =>
      visibleCount('SessionType', ST_OTHER),
    );
    expect(n).toBe(1);
  });

  it('service_role bypasses RLS for ALL commands', async () => {
    const n = await asRole('service_role', {}, () => visibleCount('SessionType', ST_OTHER));
    expect(n).toBe(1);
  });

  it('the owning coach can read their session type', async () => {
    const n = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      visibleCount('SessionType', ST_OWN),
    );
    expect(n).toBe(1);
  });

  it('the owning coach CAN INSERT a session type they own (positive WITH CHECK)', async () => {
    const ok = await asRole('authenticated', { userId: COACH, userRole: 'coach' }, () =>
      insertExpectingSuccess(`INSERT INTO public."SessionType"("id","coach_id") VALUES ($1,$2)`, [
        'st_coach_new',
        COACH,
      ]),
    );
    expect(ok).toBe(true);
  });

  it('a different coach is denied read of another coach session type', async () => {
    const n = await asRole('authenticated', { userId: OTHER_COACH, userRole: 'coach' }, () =>
      visibleCount('SessionType', ST_OWN),
    );
    expect(n).toBe(0);
  });

  it("the client of a coach cannot read that coach's session type (coach-self, not tenant-wide)", async () => {
    const n = await asRole('authenticated', { userId: CLIENT, userRole: 'student' }, () =>
      visibleCount('SessionType', ST_OWN),
    );
    expect(n).toBe(0);
  });

  it('a coach cannot INSERT a session type owned by another coach (WITH CHECK denies)', async () => {
    const err = await asRole('authenticated', { userId: OTHER_COACH, userRole: 'coach' }, () =>
      expectInsertDenied(`INSERT INTO public."SessionType"("id","coach_id") VALUES ($1,$2)`, [
        'st_evil',
        COACH,
      ]),
    );
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('an unauthenticated anon user is denied read', async () => {
    const n = await asRole('anon', {}, () => visibleCount('SessionType', ST_OWN));
    expect(n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — per-table UPDATE-deny / DELETE-deny enforcement matrix.
//
// A foreign authenticated user who does not own / cannot access a row must NOT
// be able to UPDATE or DELETE it. Under PostgreSQL RLS, a USING-clause denial
// does NOT raise — it filters the candidate rows to zero — so the precise,
// non-vague assertion is "affected rows === 0" (Failure #30 / #36: no
// rejects.toBeDefined()). INSERT denials DO raise 42501 (WITH CHECK), asserted
// separately via expectInsertDenied.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR-RLS-03: CoachingSession — UPDATE/DELETE deny + service-role bypass', () => {
  it('a foreign user UPDATE on a session they cannot access affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      execAffected(`UPDATE public."CoachingSession" SET "title" = 'hacked' WHERE "id" = $1`, [SESS]),
    );
    expect(affected).toBe(0);
  });

  it('a foreign user DELETE on a session they cannot access affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      execAffected(`DELETE FROM public."CoachingSession" WHERE "id" = $1`, [SESS]),
    );
    expect(affected).toBe(0);
  });

  it('a foreign user INSERT of a cross-tenant session is denied with SQLSTATE 42501', async () => {
    const err = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      expectInsertDenied(
        `INSERT INTO public."CoachingSession"("id","coach_id","client_id","title") VALUES ($1,$2,$3,'x')`,
        ['cs_evil_upd', COACH, CLIENT],
      ),
    );
    expect(err.isRls).toBe(true);
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('service_role can INSERT a session no authenticated user could', async () => {
    const ok = await asRole('service_role', {}, () =>
      insertExpectingSuccess(
        `INSERT INTO public."CoachingSession"("id","coach_id","client_id","title") VALUES ($1,$2,$3,'svc')`,
        ['cs_svc_only', COACH_A, CLIENT_A],
      ),
    );
    expect(ok).toBe(true);
  });

  it('service_role can UPDATE any session (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`UPDATE public."CoachingSession" SET "title" = 'svc-upd' WHERE "id" = $1`, [SESS]),
    );
    expect(affected).toBe(1);
  });

  it('service_role can DELETE any session (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`DELETE FROM public."CoachingSession" WHERE "id" = $1`, [SESS_OTHER]),
    );
    expect(affected).toBe(1);
  });
});

describe('PR-RLS-03: SessionType — UPDATE/DELETE deny + service-role bypass', () => {
  it('a non-owning coach UPDATE on another coach session type affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: OTHER_COACH, userRole: 'coach' }, () =>
      execAffected(`UPDATE public."SessionType" SET "coach_id" = $1 WHERE "id" = $2`, [OTHER_COACH, ST_OWN]),
    );
    expect(affected).toBe(0);
  });

  it('a non-owning coach DELETE on another coach session type affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: OTHER_COACH, userRole: 'coach' }, () =>
      execAffected(`DELETE FROM public."SessionType" WHERE "id" = $1`, [ST_OWN]),
    );
    expect(affected).toBe(0);
  });

  it('a non-owning coach INSERT of a session type for another coach is denied with 42501', async () => {
    const err = await asRole('authenticated', { userId: OTHER_COACH, userRole: 'coach' }, () =>
      expectInsertDenied(`INSERT INTO public."SessionType"("id","coach_id") VALUES ($1,$2)`, [
        'st_evil_upd',
        COACH,
      ]),
    );
    expect(err.isRls).toBe(true);
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('service_role can INSERT a session type no authenticated user could', async () => {
    const ok = await asRole('service_role', {}, () =>
      insertExpectingSuccess(`INSERT INTO public."SessionType"("id","coach_id") VALUES ($1,$2)`, ['st_svc_only', COACH]),
    );
    expect(ok).toBe(true);
  });

  it('service_role can UPDATE any session type (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`UPDATE public."SessionType" SET "coach_id" = $1 WHERE "id" = $2`, [COACH, ST_OTHER]),
    );
    expect(affected).toBe(1);
  });

  it('service_role can DELETE any session type (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`DELETE FROM public."SessionType" WHERE "id" = $1`, [ST_OTHER]),
    );
    expect(affected).toBe(1);
  });
});

describe('PR-RLS-03: SessionParticipant — UPDATE/DELETE deny + service-role bypass', () => {
  it('a foreign user UPDATE on a participant row of an inaccessible session affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      execAffected(`UPDATE public."SessionParticipant" SET "role" = 'admin' WHERE "id" = $1`, [PART_OBS]),
    );
    expect(affected).toBe(0);
  });

  it('a foreign user DELETE on a participant row of an inaccessible session affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: FOREIGN, userRole: 'student' }, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "id" = $1`, [PART_OBS]),
    );
    expect(affected).toBe(0);
  });

  it('service_role can INSERT a participant no authenticated user could', async () => {
    const ok = await asRole('service_role', {}, () =>
      insertExpectingSuccess(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'observer')`,
        ['sp_svc_only', SESS_RA, USER_B + '_x'],
      ),
    );
    expect(ok).toBe(true);
  });

  it('service_role can UPDATE any participant (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`UPDATE public."SessionParticipant" SET "role" = 'svc' WHERE "id" = $1`, [PART_OBS]),
    );
    expect(affected).toBe(1);
  });

  it('service_role can DELETE any participant (bypass)', async () => {
    const affected = await asRole('service_role', {}, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "id" = $1`, [PART_OTHER]),
    );
    expect(affected).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — SessionParticipant IDOR REGRESSION (the exact bug R2 fixes).
//
// A foreign authenticated user userB with NO relationship to sessRA (coach
// coachA, lead client clientA) must not be able to write participant rows on
// it — NOT EVEN A ROW WITH user_id = themselves. This is the precise self-row
// IDOR that the old `"user_id" = app.current_user_id()` write predicate allowed.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR-RLS-03: SessionParticipant IDOR regression — foreign self-write denied', () => {
  it('userB INSERT of THEMSELVES into sessRA is denied with SQLSTATE 42501 (the fixed bug)', async () => {
    const err = await asRole('authenticated', { userId: USER_B, userRole: 'student' }, () =>
      expectInsertDenied(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'observer')`,
        ['sp_idor_self', SESS_RA, USER_B],
      ),
    );
    expect(err.isRls).toBe(true);
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('userB UPDATE of a pre-existing participant row on sessRA affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: USER_B, userRole: 'student' }, () =>
      execAffected(`UPDATE public."SessionParticipant" SET "role" = 'admin' WHERE "session_id" = $1`, [SESS_RA]),
    );
    expect(affected).toBe(0);
  });

  it('userB DELETE of participant rows on sessRA affects 0 rows', async () => {
    const affected = await asRole('authenticated', { userId: USER_B, userRole: 'student' }, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "session_id" = $1`, [SESS_RA]),
    );
    expect(affected).toBe(0);
  });

  it('the pre-seeded userB participant row on sessRA is still intact after the denied writes', async () => {
    const n = await asRole('service_role', {}, () => visibleCount('SessionParticipant', PART_RA_USERB));
    expect(n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — SessionParticipant: the is_current_coach_of(client_id) write path,
// proven INDEPENDENTLY of the direct coach_id match. coachB is the current
// coach of clientA (sessRA's lead client) but is NOT sessRA.coach_id (= coachA),
// so success here can only come from the app.is_current_coach_of branch.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR-RLS-03: SessionParticipant — coach-of-client write path (independent of coach_id)', () => {
  it('coachB does NOT match sessRA.coach_id but IS the current coach of its lead client (precondition)', async () => {
    const rows = await asRole('service_role', {}, async () =>
      prisma.$queryRawUnsafe<{ coach_id: string; client_id: string }[]>(
        `SELECT "coach_id","client_id" FROM public."CoachingSession" WHERE "id" = $1`,
        SESS_RA,
      ),
    );
    expect(rows[0].coach_id).toBe(COACH_A);
    expect(rows[0].client_id).toBe(CLIENT_A);
    // clientA is coached by coachB, not coachA.
    const coached = await asRole('authenticated', { userId: COACH_B, userRole: 'coach' }, () =>
      prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT app.is_current_coach_of($1) AS ok`, CLIENT_A),
    );
    expect(coached[0].ok).toBe(true);
  });

  it('coachB CAN INSERT a participant onto sessRA via the is_current_coach_of path', async () => {
    const ok = await asRole('authenticated', { userId: COACH_B, userRole: 'coach' }, () =>
      insertExpectingSuccess(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'observer')`,
        ['sp_by_coachB', SESS_RA, USER_B],
      ),
    );
    expect(ok).toBe(true);
  });

  it('coachB CAN UPDATE a participant on sessRA via the is_current_coach_of path', async () => {
    const affected = await asRole('authenticated', { userId: COACH_B, userRole: 'coach' }, () =>
      execAffected(`UPDATE public."SessionParticipant" SET "role" = 'lead' WHERE "id" = $1`, [PART_RA_USERB]),
    );
    expect(affected).toBe(1);
  });

  it('coachB CAN DELETE a participant on sessRA via the is_current_coach_of path', async () => {
    const affected = await asRole('authenticated', { userId: COACH_B, userRole: 'coach' }, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "id" = $1`, [PART_RA_USERB]),
    );
    expect(affected).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3 — SessionParticipant: lead-client self-service scheduling.
// Per REORG_DECISIONS_LOCKED.md the lead client may add/remove THEMSELVES only.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR-RLS-03: SessionParticipant — lead-client self-service (self only)', () => {
  it('the lead client CAN INSERT themselves (user_id = client_id) onto their session', async () => {
    // PART_RA_CLIENT already occupies clientA's self-row; use a distinct id, same user.
    const ok = await asRole('authenticated', { userId: CLIENT_A, userRole: 'student' }, () =>
      insertExpectingSuccess(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'attendee')`,
        ['sp_client_self2', SESS_RA, CLIENT_A],
      ),
    );
    expect(ok).toBe(true);
  });

  it('the lead client CANNOT INSERT another user as a participant (denied 42501)', async () => {
    const err = await asRole('authenticated', { userId: CLIENT_A, userRole: 'student' }, () =>
      expectInsertDenied(
        `INSERT INTO public."SessionParticipant"("id","session_id","user_id","role") VALUES ($1,$2,$3,'attendee')`,
        ['sp_client_other', SESS_RA, USER_B],
      ),
    );
    expect(err.isRls).toBe(true);
    expect(err.code).toBe(RLS_VIOLATION_SQLSTATE);
  });

  it('the lead client CAN DELETE their own self-participation row', async () => {
    const affected = await asRole('authenticated', { userId: CLIENT_A, userRole: 'student' }, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "id" = $1`, [PART_RA_CLIENT]),
    );
    expect(affected).toBe(1);
  });

  it("the lead client CANNOT DELETE another participant's row (affects 0 rows)", async () => {
    const affected = await asRole('authenticated', { userId: CLIENT_A, userRole: 'student' }, () =>
      execAffected(`DELETE FROM public."SessionParticipant" WHERE "id" = $1`, [PART_RA_USERB]),
    );
    expect(affected).toBe(0);
  });
});

describe('PR-RLS-03: service_role policies — catalog shape', () => {
  it('all 3 service_role policies are FOR ALL TO service_role USING (true) WITH CHECK (true)', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{
      table_name: string;
      polname: string;
      cmd: string;
      rolname: string;
      qual: string;
      withcheck: string;
    }>>(`
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
        AND c.relname IN ('CoachingSession','SessionParticipant','SessionType')
        AND r.rolname = 'service_role'
      ORDER BY c.relname, p.polname;
    `);

    expect(rows).toHaveLength(3);
    const byTable = Object.fromEntries(rows.map(r => [r.table_name, r]));

    for (const tbl of ['CoachingSession', 'SessionParticipant', 'SessionType'] as const) {
      const row = byTable[tbl];
      expect(row).toBeDefined();
      expect(row.polname).toBe(`p_${tbl.toLowerCase()}_service_role_all`);
      expect(row.cmd).toBe('*');
      expect(row.rolname).toBe('service_role');
      expect(row.qual).toBe('true');
      expect(row.withcheck).toBe('true');
    }
  });
});
