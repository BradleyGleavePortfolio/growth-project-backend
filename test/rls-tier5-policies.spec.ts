/**
 * PR-RLS-07 — Tier 5 notifications / community / infra RLS policies.
 *
 * Verifies the migration 20261213000000_rls_tier5_notifications_community for
 * all six Tier-5 tables:
 *   EmailSendLog, NotificationDeliveryLog, NotificationDigestLog,
 *   CommunityWin, HabitLog, _prisma_migrations.
 *
 * For every table we assert the canonical RLS contract with REAL PostgreSQL
 * (NO mocks):
 *   1. RLS is ENABLED (and FORCED for the five application tables).
 *   2. The five expected policies exist (service_role_all + S/I/U/D), each with
 *      a COMMENT.
 *   3. service_role can read/write (positive service path).
 *   4. The legitimate owner/self/coach principal can read its own row.
 *   5. A foreign (unrelated) user gets ZERO rows on SELECT (negative read).
 *   6. A foreign user's cross-tenant INSERT is rejected (negative write).
 *   7. The backend owner principal (app.is_owner()) can read.
 *   8. An unauthenticated principal is denied (zero rows / rejected write).
 *
 * PLUS table-specific extras:
 *   * CommunityWin cohort-membership read-visibility (assigned coach reads a
 *     roster member's win; current-coach moderation; public-visibility).
 *   * _prisma_migrations: a subsequent (dummy) migration INSERT still SUCCEEDS
 *     with the policy enabled — proving the migration runner is not broken.
 *
 * Auth context is simulated exactly as the NestJS RLS middleware does, via the
 * `app.current_user_id` / `app.current_user_role` session GUCs. Each principal
 * runs under the appropriate Postgres role (service_role / authenticated / anon)
 * via SET LOCAL ROLE inside a transaction, so RLS evaluates the same predicates
 * production does.
 *
 * Connection: RLS_TIER5_TEST_DATABASE_URL (preferred) or DATABASE_URL. The
 * CI/dev convention is a local owner-capable role on the throwaway
 * `rls_tier5_test` database, e.g.
 *   postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_tier5_test
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261213000000_rls_tier5_notifications_community',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER5_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_tier5_test';

// ---------------------------------------------------------------------------
// Prerequisite catalog: the helper functions (search_path-hardened in
// 20261212000000) plus the production columns the policies read. Applied before
// the migration so its ALTER TABLE / CREATE POLICY targets exist. Mirrors the
// self-bootstrapping convention of test/rls-helper-search-path.spec.ts.
// ---------------------------------------------------------------------------
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL,
  "name" text
);
-- The throwaway DB may already carry a leaner "User" from a sibling RLS suite
-- (CREATE TABLE IF NOT EXISTS is then a no-op). Reconcile the columns this suite
-- reads/writes so seeding succeeds regardless of pre-existing shape.
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "coach_id" text;
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "role" text;
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "name" text;
CREATE TABLE IF NOT EXISTS public."Habit" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "name" text NOT NULL DEFAULT 'habit'
);
CREATE TABLE IF NOT EXISTS public."CoachingSession" (
  "id" text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public."EmailSendLog" (
  "id" text PRIMARY KEY,
  "idempotency_key" text UNIQUE NOT NULL,
  "template_key" text NOT NULL,
  "recipient_email" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sending',
  "provider_message_id" text,
  "error" text,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public."NotificationDeliveryLog" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public."NotificationDigestLog" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "digest_kind" text NOT NULL,
  "window_date" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sending',
  "sent_at" timestamptz,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public."CommunityWin" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "coach_id" text,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "visibility" text NOT NULL DEFAULT 'circle',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public."HabitLog" (
  "id" text PRIMARY KEY,
  "habit_id" text NOT NULL,
  "date" date NOT NULL DEFAULT now(),
  "value" double precision,
  "completed" boolean NOT NULL DEFAULT false,
  "logged_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" varchar(36) PRIMARY KEY,
  "checksum" varchar(64) NOT NULL,
  "finished_at" timestamptz,
  "migration_name" varchar(255) NOT NULL,
  "logs" text,
  "rolled_back_at" timestamptz,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "applied_steps_count" integer NOT NULL DEFAULT 0
);

-- The Supabase grant layer that RLS sits on top of. Without table GRANTs the
-- authenticated/anon roles would be denied by privilege checks before RLS even
-- runs, which would mask policy behavior. service_role gets full DML; tenant
-- roles get DML and rely on RLS to filter rows.
GRANT USAGE ON SCHEMA app TO service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role, authenticated, anon;

-- Helper functions: search_path-hardened forms, identical to migration
-- 20261212000000. is_user_coached_by is the out-of-scope dependency.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL AND coach_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."User" u
     WHERE u."id" = client_user_id AND u."coach_id" = coach_user_id AND u."role" = 'student')
$fn$;
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;
-- Functions are owned by the connecting role; SECURITY DEFINER on is_user_coached_by
-- runs as that role, which can read public."User".
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO service_role, authenticated, anon;
`;

// ---------------------------------------------------------------------------
// SQL statement splitter — dollar-quote aware. Identical semantics to the
// helper-search-path spec so function bodies survive intact.
// ---------------------------------------------------------------------------
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
    await prisma.$executeRawUnsafe(stmt); // R0: failures bubble up loudly
  }
}

type Principal = {
  role: 'service_role' | 'authenticated' | 'anon';
  userId?: string | null;
  userRole?: string | null;
};

/**
 * Run `fn` inside a transaction with the given Postgres role and RLS auth GUCs,
 * then ROLL BACK so the case is isolated. Returns whatever `fn` returns.
 * SET LOCAL confines the role/GUC changes to the transaction.
 */
async function asPrincipal<T>(
  p: Principal,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${p.role}`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_id', $1, true)`,
      p.userId ?? '',
    );
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_user_role', $1, true)`,
      p.userRole ?? '',
    );
    return fn(tx);
  });
}

/** Count rows visible to `p` from `table` (optionally narrowed by id). */
async function visibleCount(p: Principal, table: string, id?: string): Promise<number> {
  return asPrincipal(p, async (tx) => {
    const where = id ? ` WHERE "id" = '${id}'` : '';
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public."${table}"${where}`,
    );
    return Number(rows[0].n);
  });
}

// Sentinel thrown to force a successful-write probe to ROLL BACK, so an allowed
// INSERT never pollutes the shared fixtures (the transaction is aborted on throw).
const ROLLBACK_SENTINEL = '__rls_probe_rollback__';

/**
 * SQLSTATE-precise RLS-denial assertion. A WITH CHECK violation (INSERT, or the
 * post-image of an UPDATE) surfaces through Prisma either as a
 * PrismaClientKnownRequestError `P2010` carrying the underlying PostgreSQL
 * SQLSTATE in `meta.code`, or — depending on the raw path — with the SQLSTATE on
 * `err.code` directly. We accept 42501 (insufficient_privilege / RLS WITH CHECK
 * violation) and 42P17 (invalid policy expression), pinning the precise rejection
 * class instead of regex-matching the human-readable message.
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
 * Assert an INSERT performed as `p` is rejected by RLS (WITH CHECK violation).
 * Delegates to the SQLSTATE-precise `expectRlsDenied` so every cross-tenant
 * INSERT-deny path pins SQLSTATE 42501 rather than matching the message text.
 */
async function expectInsertDenied(p: Principal, insertSql: string): Promise<void> {
  await expectRlsDenied(
    asPrincipal(p, async (tx) => {
      await tx.$executeRawUnsafe(insertSql);
    }),
  );
}

/**
 * SQLSTATE-precise denial assertion. A WITH CHECK violation surfaces through
 * Prisma as a PrismaClientKnownRequestError whose underlying PostgreSQL SQLSTATE
 * is carried in `err.meta.code`. We assert on the exact SQLSTATE (42501 =
 * insufficient_privilege / RLS WITH CHECK violation) rather than regex-matching
 * the human-readable message, so the test pins the precise rejection class.
 */
async function expectInsertDeniedWithSqlstate(
  expectedSqlstate: string,
  p: Principal,
  insertSql: string,
): Promise<void> {
  let caught: unknown;
  try {
    await asPrincipal(p, async (tx) => {
      await tx.$executeRawUnsafe(insertSql);
    });
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(
      `Expected INSERT to be denied with SQLSTATE ${expectedSqlstate}, but it succeeded`,
    );
  }
  expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  const meta = (caught as Prisma.PrismaClientKnownRequestError).meta as
    | { code?: string }
    | undefined;
  expect(meta?.code).toBe(expectedSqlstate);
}

/**
 * Run an UPDATE/DELETE as `p` and return the number of rows it affected. A
 * USING-clause denial filters the row out of the command's scope, so the
 * statement affects 0 rows WITHOUT throwing — the correct PostgreSQL RLS
 * semantics for UPDATE/DELETE (distinct from a WITH CHECK throw on INSERT).
 */
async function affectedRows(p: Principal, sql: string): Promise<number> {
  return asPrincipal(p, async (tx) => {
    const n = await tx.$executeRawUnsafe(sql);
    return Number(n);
  });
}

/** Read a single column of a row as service_role (BYPASSRLS), for verify-after. */
async function readColumnAsService(
  table: string,
  column: string,
  id: string,
): Promise<string | null> {
  return asPrincipal(SVC, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ v: string | null }[]>(
      `SELECT "${column}" AS v FROM public."${table}" WHERE "id" = $1`,
      id,
    );
    return rows.length ? rows[0].v : null;
  });
}

/**
 * Assert an INSERT performed as `p` succeeds, then ALWAYS roll it back so the
 * write does not leak into other tests. The insert runs first; if it is rejected
 * the real DB error surfaces (test fails). If it succeeds we throw the sentinel
 * to abort the transaction — so a clean run resolves with the sentinel and any
 * other error (e.g. an RLS denial) propagates as a genuine failure.
 */
async function expectInsertAllowed(p: Principal, insertSql: string): Promise<void> {
  let inserted = false;
  try {
    await asPrincipal(p, async (tx) => {
      await tx.$executeRawUnsafe(insertSql);
      inserted = true;
      throw new Error(ROLLBACK_SENTINEL); // force rollback of the successful write
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK_SENTINEL) {
      throw err; // a real DB/RLS error — the insert was NOT allowed
    }
  }
  expect(inserted).toBe(true);
}

// Seed identifiers reused across suites.
const SVC: Principal = { role: 'service_role' };
const OWNER: Principal = { role: 'authenticated', userId: 'u_owner', userRole: 'owner' };
const ANON: Principal = { role: 'anon' };

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);

  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Clean slate (the throwaway DB may be reused across runs). This runs AFTER
  // the migration so RLS is already active; we therefore delete as service_role
  // (BYPASSRLS) so the cleanup is not silently filtered to zero rows by FORCE
  // RLS — which would otherwise leave stale fixtures and break re-runs. SET LOCAL
  // scopes the role change to this transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE service_role`);
    for (const t of [
      'HabitLog',
      'NotificationDeliveryLog',
      'NotificationDigestLog',
      'CommunityWin',
      'EmailSendLog',
      'Habit',
      'CoachingSession',
      'User',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM public."${t}"`);
    }
    await tx.$executeRawUnsafe(`DELETE FROM "_prisma_migrations"`);
  });

  // ---- Fixture data ------------------------------------------------------
  // Seed as service_role, mirroring the production write path: the app/jobs
  // write these rows under Supabase service_role (BYPASSRLS) via the
  // *_service_role_all policy. Seeding as the plain owner would be denied by
  // FORCE RLS on the five application tables, so we use the same role real
  // writes use. SET LOCAL keeps the role change scoped to this transaction.
  //
  // coachA coaches clientA (student). clientB is unrelated; coachB unrelated.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE service_role`);
    await tx.$executeRawUnsafe(`
      INSERT INTO public."User"("id","coach_id","role","name") VALUES
        ('coachA', NULL, 'coach', 'Coach A'),
        ('coachB', NULL, 'coach', 'Coach B'),
        ('clientA', 'coachA', 'student', 'Client A'),
        ('clientB', 'coachB', 'student', 'Client B')
    `);
    // coach_id is populated so seeding works even when the throwaway DB already
    // carries the production-shaped CoachingSession (coach_id NOT NULL); the
    // self-bootstrapped CREATE TABLE IF NOT EXISTS is a no-op in that case.
    await tx.$executeRawUnsafe(
      `INSERT INTO public."CoachingSession"("id","coach_id") VALUES ('sess1','coachA')`,
    );
    // EmailSendLog: one ops row (no owner column).
    await tx.$executeRawUnsafe(`
      INSERT INTO public."EmailSendLog"("id","idempotency_key","template_key","recipient_email","status")
      VALUES ('email1','idem-1','welcome','a@example.com','sent')
    `);
    // NotificationDeliveryLog: owned by clientA.
    await tx.$executeRawUnsafe(`
      INSERT INTO public."NotificationDeliveryLog"("id","user_id","session_id","kind")
      VALUES ('ndl1','clientA','sess1','booking_reminder_24h')
    `);
    // NotificationDigestLog: owned by clientA.
    await tx.$executeRawUnsafe(`
      INSERT INTO public."NotificationDigestLog"("id","user_id","digest_kind","window_date","status")
      VALUES ('ndg1','clientA','client_daily','2026-06-08','sent')
    `);
    // CommunityWin: a circle win by clientA, stamped with coachA (cohort owner).
    await tx.$executeRawUnsafe(`
      INSERT INTO public."CommunityWin"("id","user_id","coach_id","title","description","visibility")
      VALUES ('win_circle','clientA','coachA','Hit a PR','Squatted 100kg','circle')
    `);
    // CommunityWin: a public win by clientB / coachB.
    await tx.$executeRawUnsafe(`
      INSERT INTO public."CommunityWin"("id","user_id","coach_id","title","description","visibility")
      VALUES ('win_public','clientB','coachB','Ran 5k','First 5k ever','public')
    `);
    // HabitLog via Habit owned by clientA.
    await tx.$executeRawUnsafe(
      `INSERT INTO public."Habit"("id","user_id","name") VALUES ('habitA','clientA','Water')`,
    );
    await tx.$executeRawUnsafe(`
      INSERT INTO public."HabitLog"("id","habit_id","date","completed")
      VALUES ('hl1','habitA','2026-06-08', true)
    `);
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Schema-level assertions reused per table.
// ---------------------------------------------------------------------------
async function getRlsFlags(table: string): Promise<{ enabled: boolean; forced: boolean }> {
  const rows = await prisma.$queryRawUnsafe<{ e: boolean; f: boolean }[]>(
    `SELECT relrowsecurity AS e, relforcerowsecurity AS f
       FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
    table,
  );
  return { enabled: rows[0].e, forced: rows[0].f };
}

async function policyNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
    `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
    table,
  );
  return rows.map((r) => r.policyname);
}

async function policyComment(policy: string, table: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ d: string | null }[]>(
    `SELECT pg_catalog.obj_description(pol.oid, 'pg_policy') AS d
       FROM pg_policy pol
       JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = $1 AND pol.polname = $2`,
    table,
    policy,
  );
  return rows[0]?.d ?? null;
}

// ===========================================================================
// EmailSendLog — service-role-only (+ owner admin).
// ===========================================================================
describe('PR-RLS-07: EmailSendLog (service-role-only)', () => {
  const T = 'EmailSendLog';
  const prefix = 'p_emailsendlog';

  it('rls_EmailSendLog_rls_enabled_and_forced', async () => {
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(true);
  });

  it('rls_EmailSendLog_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls_EmailSendLog_service_role_can_read', async () => {
    expect(await visibleCount(SVC, T)).toBe(1);
  });

  it('rls_EmailSendLog_service_role_can_write', async () => {
    await expectInsertAllowed(
      SVC,
      `INSERT INTO public."EmailSendLog"("id","idempotency_key","template_key","recipient_email") VALUES ('email_svc','idem-svc','welcome','svc@example.com')`,
    );
  });

  it('rls_EmailSendLog_owner_can_access', async () => {
    expect(await visibleCount(OWNER, T)).toBe(1);
  });

  it('rls_EmailSendLog_foreign_user_denied', async () => {
    // A regular authenticated user (non-owner) sees zero email rows.
    expect(
      await visibleCount({ role: 'authenticated', userId: 'clientA', userRole: 'student' }, T),
    ).toBe(0);
  });

  it('rls_EmailSendLog_cross_tenant_write_denied', async () => {
    await expectInsertDenied(
      { role: 'authenticated', userId: 'clientA', userRole: 'student' },
      `INSERT INTO public."EmailSendLog"("id","idempotency_key","template_key","recipient_email") VALUES ('email_x','idem-x','welcome','x@example.com')`,
    );
  });

  it('rls_EmailSendLog_foreign_update_denied', async () => {
    // Non-owner is filtered out by the UPDATE USING predicate (app.is_owner()),
    // so 0 rows are affected and the row is unchanged when re-read as service_role.
    const before = await readColumnAsService(T, 'status', 'email1');
    expect(before).toBe('sent');
    const affected = await affectedRows(
      { role: 'authenticated', userId: 'clientA', userRole: 'student' },
      `UPDATE public."EmailSendLog" SET "status" = 'tampered' WHERE "id" = 'email1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'status', 'email1')).toBe('sent');
  });

  it('rls_EmailSendLog_foreign_delete_denied', async () => {
    // Non-owner is filtered out by the DELETE USING predicate, so 0 rows are
    // affected and the row still exists when re-read as service_role.
    const affected = await affectedRows(
      { role: 'authenticated', userId: 'clientA', userRole: 'student' },
      `DELETE FROM public."EmailSendLog" WHERE "id" = 'email1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'id', 'email1')).toBe('email1');
  });

  it('rls_EmailSendLog_unauthenticated_denied', async () => {
    expect(await visibleCount(ANON, T)).toBe(0);
  });
});

// ===========================================================================
// NotificationDeliveryLog — user-self-owner on user_id.
// ===========================================================================
describe('PR-RLS-07: NotificationDeliveryLog (user-self-owner)', () => {
  const T = 'NotificationDeliveryLog';
  const prefix = 'p_notificationdeliverylog';
  const SELF: Principal = { role: 'authenticated', userId: 'clientA', userRole: 'student' };
  const FOREIGN: Principal = { role: 'authenticated', userId: 'clientB', userRole: 'student' };

  it('rls_NotificationDeliveryLog_rls_enabled_and_forced', async () => {
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(true);
  });

  it('rls_NotificationDeliveryLog_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls_NotificationDeliveryLog_service_role_can_access', async () => {
    expect(await visibleCount(SVC, T)).toBe(1);
  });

  it('rls_NotificationDeliveryLog_owner_can_access', async () => {
    // Both the backend owner and the row's user see it.
    expect(await visibleCount(OWNER, T)).toBe(1);
    expect(await visibleCount(SELF, T, 'ndl1')).toBe(1);
  });

  it('rls_NotificationDeliveryLog_self_can_write', async () => {
    await expectInsertAllowed(
      SELF,
      `INSERT INTO public."NotificationDeliveryLog"("id","user_id","session_id","kind") VALUES ('ndl_self','clientA','sess1','booking_reminder_1h')`,
    );
  });

  it('rls_NotificationDeliveryLog_foreign_user_denied', async () => {
    expect(await visibleCount(FOREIGN, T, 'ndl1')).toBe(0);
  });

  it('rls_NotificationDeliveryLog_cross_tenant_write_denied', async () => {
    // clientB tries to write a row scoped to clientA.
    await expectInsertDenied(
      FOREIGN,
      `INSERT INTO public."NotificationDeliveryLog"("id","user_id","session_id","kind") VALUES ('ndl_x','clientA','sess1','booking_reminder_1h')`,
    );
  });

  it('rls_NotificationDeliveryLog_foreign_update_denied', async () => {
    // clientB is filtered out by the UPDATE USING predicate on clientA's row,
    // so 0 rows are affected and the row is unchanged when re-read as service_role.
    const before = await readColumnAsService(T, 'kind', 'ndl1');
    expect(before).toBe('booking_reminder_24h');
    const affected = await affectedRows(
      FOREIGN,
      `UPDATE public."NotificationDeliveryLog" SET "kind" = 'tampered' WHERE "id" = 'ndl1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'kind', 'ndl1')).toBe('booking_reminder_24h');
  });

  it('rls_NotificationDeliveryLog_foreign_delete_denied', async () => {
    // clientB is filtered out by the DELETE USING predicate on clientA's row,
    // so 0 rows are affected and the row still exists when re-read as service_role.
    const affected = await affectedRows(
      FOREIGN,
      `DELETE FROM public."NotificationDeliveryLog" WHERE "id" = 'ndl1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'id', 'ndl1')).toBe('ndl1');
  });

  it('rls_NotificationDeliveryLog_unauthenticated_denied', async () => {
    expect(await visibleCount(ANON, T, 'ndl1')).toBe(0);
  });
});

// ===========================================================================
// NotificationDigestLog — user-self-owner on user_id.
// ===========================================================================
describe('PR-RLS-07: NotificationDigestLog (user-self-owner)', () => {
  const T = 'NotificationDigestLog';
  const prefix = 'p_notificationdigestlog';
  const SELF: Principal = { role: 'authenticated', userId: 'clientA', userRole: 'student' };
  const FOREIGN: Principal = { role: 'authenticated', userId: 'clientB', userRole: 'student' };

  it('rls_NotificationDigestLog_rls_enabled_and_forced', async () => {
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(true);
  });

  it('rls_NotificationDigestLog_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls_NotificationDigestLog_service_role_can_access', async () => {
    expect(await visibleCount(SVC, T)).toBe(1);
  });

  it('rls_NotificationDigestLog_owner_can_access', async () => {
    expect(await visibleCount(OWNER, T)).toBe(1);
    expect(await visibleCount(SELF, T, 'ndg1')).toBe(1);
  });

  it('rls_NotificationDigestLog_self_can_write', async () => {
    await expectInsertAllowed(
      SELF,
      `INSERT INTO public."NotificationDigestLog"("id","user_id","digest_kind","window_date") VALUES ('ndg_self','clientA','weekly_client','2026-06-15')`,
    );
  });

  it('rls_NotificationDigestLog_foreign_user_denied', async () => {
    expect(await visibleCount(FOREIGN, T, 'ndg1')).toBe(0);
  });

  it('rls_NotificationDigestLog_cross_tenant_write_denied', async () => {
    await expectInsertDenied(
      FOREIGN,
      `INSERT INTO public."NotificationDigestLog"("id","user_id","digest_kind","window_date") VALUES ('ndg_x','clientA','weekly_client','2026-06-15')`,
    );
  });

  it('rls_NotificationDigestLog_foreign_update_denied', async () => {
    // clientB is filtered out by the UPDATE USING predicate on clientA's row,
    // so 0 rows are affected and the row is unchanged when re-read as service_role.
    const before = await readColumnAsService(T, 'status', 'ndg1');
    expect(before).toBe('sent');
    const affected = await affectedRows(
      FOREIGN,
      `UPDATE public."NotificationDigestLog" SET "status" = 'tampered' WHERE "id" = 'ndg1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'status', 'ndg1')).toBe('sent');
  });

  it('rls_NotificationDigestLog_foreign_delete_denied', async () => {
    // clientB is filtered out by the DELETE USING predicate on clientA's row,
    // so 0 rows are affected and the row still exists when re-read as service_role.
    const affected = await affectedRows(
      FOREIGN,
      `DELETE FROM public."NotificationDigestLog" WHERE "id" = 'ndg1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'id', 'ndg1')).toBe('ndg1');
  });

  it('rls_NotificationDigestLog_unauthenticated_denied', async () => {
    expect(await visibleCount(ANON, T, 'ndg1')).toBe(0);
  });
});

// ===========================================================================
// CommunityWin — community-win (author + cohort coach + public + owner).
// ===========================================================================
describe('PR-RLS-07: CommunityWin (community-win + cohort visibility)', () => {
  const T = 'CommunityWin';
  const prefix = 'p_communitywin';
  const AUTHOR: Principal = { role: 'authenticated', userId: 'clientA', userRole: 'student' };
  const COACH: Principal = { role: 'authenticated', userId: 'coachA', userRole: 'coach' };
  const FOREIGN: Principal = { role: 'authenticated', userId: 'clientB', userRole: 'student' };

  it('rls_CommunityWin_rls_enabled_and_forced', async () => {
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(true);
  });

  it('rls_CommunityWin_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls_CommunityWin_service_role_can_access', async () => {
    expect(await visibleCount(SVC, T)).toBe(2);
  });

  it('rls_CommunityWin_owner_can_access', async () => {
    // Backend owner sees all; author sees their own circle win.
    expect(await visibleCount(OWNER, T)).toBe(2);
    expect(await visibleCount(AUTHOR, T, 'win_circle')).toBe(1);
  });

  it('rls_CommunityWin_cohort_coach_read_visibility', async () => {
    // The assigned/current coach (coachA) reads the roster member's circle win
    // — this is the cohort-membership read path (coach_id stamp + is_current_coach_of).
    expect(await visibleCount(COACH, T, 'win_circle')).toBe(1);
  });

  it('rls_CommunityWin_public_visibility_is_world_readable', async () => {
    // Any authenticated user sees a visibility='public' win, even a foreign one.
    expect(await visibleCount(FOREIGN, T, 'win_public')).toBe(1);
  });

  it('rls_CommunityWin_author_can_write', async () => {
    await expectInsertAllowed(
      AUTHOR,
      `INSERT INTO public."CommunityWin"("id","user_id","coach_id","title","description","visibility") VALUES ('win_new','clientA','coachA','New win','desc','circle')`,
    );
  });

  it('rls_CommunityWin_foreign_user_denied', async () => {
    // clientB (different cohort) cannot see clientA's circle (non-public) win.
    expect(await visibleCount(FOREIGN, T, 'win_circle')).toBe(0);
  });

  it('rls_CommunityWin_cross_tenant_write_denied', async () => {
    // clientB forging a circle win as clientA under coachA's cohort is rejected.
    await expectInsertDenied(
      FOREIGN,
      `INSERT INTO public."CommunityWin"("id","user_id","coach_id","title","description","visibility") VALUES ('win_x','clientA','coachA','Forged','x','circle')`,
    );
  });

  // ----- IDOR regression: public visibility is NEVER a write authorization path.
  // win_public is a visibility='public' win owned by clientB (coach coachB).
  // clientA is a foreign authenticated user (not the author, not coachB, not
  // clientB's current coach). Pre-fix, the write policies' ("visibility"='public')
  // OR-clause let clientA forge/mutate/delete it; these three tests pin the fix.

  it('foreign authenticated user cannot insert visibility=public win for another user (IDOR regression)', async () => {
    // clientA tries to INSERT a public win attributed to clientB. The WITH CHECK
    // predicate must reject it with SQLSTATE 42501, NOT regex on the message.
    await expectInsertDeniedWithSqlstate(
      '42501',
      AUTHOR,
      `INSERT INTO public."CommunityWin"("id","user_id","coach_id","title","description","visibility") VALUES ('win_forged_pub','clientB',NULL,'Forged public win','x','public')`,
    );
    // Belt-and-braces: the forged row must not exist (verify as BYPASSRLS).
    expect(await readColumnAsService('CommunityWin', 'id', 'win_forged_pub')).toBeNull();
  });

  it('foreign authenticated user cannot update another user\'s visibility=public win (IDOR regression)', async () => {
    // clientA attempts to overwrite clientB's public win. The UPDATE USING
    // predicate filters the row out of scope, so 0 rows are affected (no throw),
    // and the row content is unchanged when re-read as service_role.
    const before = await readColumnAsService('CommunityWin', 'title', 'win_public');
    expect(before).toBe('Ran 5k');
    const affected = await affectedRows(
      AUTHOR,
      `UPDATE public."CommunityWin" SET "title" = 'HACKED BY FOREIGN USER' WHERE "id" = 'win_public'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService('CommunityWin', 'title', 'win_public')).toBe('Ran 5k');
  });

  it('foreign authenticated user cannot delete another user\'s visibility=public win (IDOR regression)', async () => {
    // clientA attempts to delete clientB's public win. The DELETE USING predicate
    // filters the row out of scope, so 0 rows are affected (no throw), and the
    // row still exists when re-read as service_role.
    const affected = await affectedRows(
      AUTHOR,
      `DELETE FROM public."CommunityWin" WHERE "id" = 'win_public'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService('CommunityWin', 'id', 'win_public')).toBe('win_public');
  });

  it('rls_CommunityWin_unauthenticated_denied', async () => {
    // anon sees no rows (the public win requires an authenticated principal).
    expect(await visibleCount(ANON, T, 'win_circle')).toBe(0);
    expect(await visibleCount(ANON, T, 'win_public')).toBe(0);
  });
});

// ===========================================================================
// HabitLog — child-via-habit (ownership via Habit.user_id).
// ===========================================================================
describe('PR-RLS-07: HabitLog (child-via-habit)', () => {
  const T = 'HabitLog';
  const prefix = 'p_habitlog';
  const OWNER_OF_HABIT: Principal = { role: 'authenticated', userId: 'clientA', userRole: 'student' };
  const COACH: Principal = { role: 'authenticated', userId: 'coachA', userRole: 'coach' };
  const FOREIGN: Principal = { role: 'authenticated', userId: 'clientB', userRole: 'student' };

  it('rls_HabitLog_rls_enabled_and_forced', async () => {
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(true);
  });

  it('rls_HabitLog_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls_HabitLog_service_role_can_access', async () => {
    expect(await visibleCount(SVC, T)).toBe(1);
  });

  it('rls_HabitLog_owner_can_access', async () => {
    // Backend owner + the habit's owning user can read the log.
    expect(await visibleCount(OWNER, T)).toBe(1);
    expect(await visibleCount(OWNER_OF_HABIT, T, 'hl1')).toBe(1);
  });

  it('rls_HabitLog_current_coach_can_read', async () => {
    // The habit owner's current coach reads the child log (parent FK predicate).
    expect(await visibleCount(COACH, T, 'hl1')).toBe(1);
  });

  it('rls_HabitLog_owner_can_write', async () => {
    await expectInsertAllowed(
      OWNER_OF_HABIT,
      `INSERT INTO public."HabitLog"("id","habit_id","date","completed") VALUES ('hl_self','habitA','2026-06-09', true)`,
    );
  });

  it('rls_HabitLog_foreign_user_denied', async () => {
    expect(await visibleCount(FOREIGN, T, 'hl1')).toBe(0);
  });

  it('rls_HabitLog_cross_tenant_write_denied', async () => {
    // clientB writing a log under clientA's habit is rejected by the parent predicate.
    await expectInsertDenied(
      FOREIGN,
      `INSERT INTO public."HabitLog"("id","habit_id","date","completed") VALUES ('hl_x','habitA','2026-06-09', true)`,
    );
  });

  it('rls_HabitLog_foreign_update_denied', async () => {
    // clientB is filtered out by the UPDATE USING parent-FK predicate on clientA's
    // habit log, so 0 rows are affected and the row is unchanged via service_role.
    const before = await readColumnAsService(T, 'habit_id', 'hl1');
    expect(before).toBe('habitA');
    const affected = await affectedRows(
      FOREIGN,
      `UPDATE public."HabitLog" SET "habit_id" = 'habitB' WHERE "id" = 'hl1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'habit_id', 'hl1')).toBe('habitA');
  });

  it('rls_HabitLog_foreign_delete_denied', async () => {
    // clientB is filtered out by the DELETE USING parent-FK predicate on clientA's
    // habit log, so 0 rows are affected and the row still exists via service_role.
    const affected = await affectedRows(
      FOREIGN,
      `DELETE FROM public."HabitLog" WHERE "id" = 'hl1'`,
    );
    expect(affected).toBe(0);
    expect(await readColumnAsService(T, 'id', 'hl1')).toBe('hl1');
  });

  it('rls_HabitLog_unauthenticated_denied', async () => {
    expect(await visibleCount(ANON, T, 'hl1')).toBe(0);
  });
});

// ===========================================================================
// _prisma_migrations — service-role-only migration metadata. SPECIAL HANDLING.
// ===========================================================================
describe('PR-RLS-07: _prisma_migrations (service-role-only, ENABLE-not-FORCE)', () => {
  const T = '_prisma_migrations';
  const prefix = 'p_prisma_migrations';

  it('rls__prisma_migrations_rls_enabled_but_not_forced', async () => {
    // CRITICAL: ENABLE without FORCE. FORCE would subject the table owner — the
    // role Prisma's migration runner connects as — to RLS and break
    // `prisma migrate deploy` on any non-superuser owner deployment.
    const { enabled, forced } = await getRlsFlags(T);
    expect(enabled).toBe(true);
    expect(forced).toBe(false);
  });

  it('rls__prisma_migrations_has_five_commented_policies', async () => {
    const names = await policyNames(T);
    expect(names).toEqual([
      `${prefix}_delete`,
      `${prefix}_insert`,
      `${prefix}_select`,
      `${prefix}_service_role_all`,
      `${prefix}_update`,
    ]);
    for (const n of names) {
      expect((await policyComment(n, T))?.startsWith('PR-RLS-07')).toBe(true);
    }
  });

  it('rls__prisma_migrations_service_role_can_access', async () => {
    // service_role can read the metadata (used by introspection/ops tooling).
    const n = await asPrincipal(SVC, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "_prisma_migrations"`,
      );
      return Number(rows[0].n);
    });
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('rls__prisma_migrations_owner_can_access', async () => {
    // Backend owner principal (authenticated + role=owner) reads via the owner policy.
    const n = await asPrincipal(OWNER, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "_prisma_migrations"`,
      );
      return Number(rows[0].n);
    });
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('rls__prisma_migrations_foreign_user_denied', async () => {
    // A regular authenticated user sees zero migration rows.
    const n = await asPrincipal(
      { role: 'authenticated', userId: 'clientA', userRole: 'student' },
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "_prisma_migrations"`,
        );
        return Number(rows[0].n);
      },
    );
    expect(n).toBe(0);
  });

  it('rls__prisma_migrations_cross_tenant_write_denied', async () => {
    // A non-owner authenticated user cannot write deployment bookkeeping.
    await expectInsertDenied(
      { role: 'authenticated', userId: 'clientA', userRole: 'student' },
      `INSERT INTO "_prisma_migrations"("id","checksum","migration_name","applied_steps_count") VALUES ('forged','x','forged_migration',1)`,
    );
  });

  it('rls__prisma_migrations_foreign_update_denied', async () => {
    // ENABLE-not-FORCE: the table owner bypasses RLS, but a NON-owner authenticated
    // user is still subject to the UPDATE USING predicate (app.is_owner()). We seed
    // a bookkeeping row as service_role, then a foreign user's UPDATE affects 0 rows
    // and leaves the row unchanged when re-read as service_role. Cleaned up after.
    const rowId = 'rls07-upd-' + Date.now();
    await asPrincipal(SVC, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"("id","checksum","migration_name","applied_steps_count") VALUES ($1,'seedck','20261213_seed',1)`,
        rowId,
      );
    });
    try {
      const before = await readColumnAsService('_prisma_migrations', 'checksum', rowId);
      expect(before).toBe('seedck');
      const affected = await affectedRows(
        { role: 'authenticated', userId: 'clientA', userRole: 'student' },
        `UPDATE "_prisma_migrations" SET "checksum" = 'tampered' WHERE "id" = '${rowId}'`,
      );
      expect(affected).toBe(0);
      expect(await readColumnAsService('_prisma_migrations', 'checksum', rowId)).toBe('seedck');
    } finally {
      await asPrincipal(SVC, async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE "id" = $1`, rowId);
      });
    }
  });

  it('rls__prisma_migrations_foreign_delete_denied', async () => {
    // A NON-owner authenticated user is filtered out by the DELETE USING predicate,
    // so the seeded bookkeeping row survives a foreign delete attempt (0 affected).
    const rowId = 'rls07-del-' + Date.now();
    await asPrincipal(SVC, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"("id","checksum","migration_name","applied_steps_count") VALUES ($1,'seedck','20261213_seed',1)`,
        rowId,
      );
    });
    try {
      const affected = await affectedRows(
        { role: 'authenticated', userId: 'clientA', userRole: 'student' },
        `DELETE FROM "_prisma_migrations" WHERE "id" = '${rowId}'`,
      );
      expect(affected).toBe(0);
      expect(await readColumnAsService('_prisma_migrations', 'id', rowId)).toBe(rowId);
    } finally {
      await asPrincipal(SVC, async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE "id" = $1`, rowId);
      });
    }
  });

  it('rls__prisma_migrations_unauthenticated_denied', async () => {
    const n = await asPrincipal(ANON, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "_prisma_migrations"`,
      );
      return Number(rows[0].n);
    });
    expect(n).toBe(0);
  });

  it('rls__prisma_migrations_followup_migration_still_applies', async () => {
    // THE foot-gun test: the migration runner (the table OWNER role) must still
    // be able to record a subsequent migration with RLS enabled. Because the
    // table is ENABLE-only (NOT FORCE), the owner bypasses RLS — exactly the
    // production behavior. We run OUTSIDE asPrincipal (no SET ROLE) so the
    // statement executes as the connection's owner role, mirroring how Prisma
    // connects via DIRECT_URL.
    const dummyId = 'rls07-followup-' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"("id","checksum","migration_name","applied_steps_count","finished_at")
         VALUES ($1,'feedface','20261214000000_dummy_followup',1, now())`,
      dummyId,
    );
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE "id" = $1`,
      dummyId,
    );
    expect(Number(rows[0].n)).toBe(1);
    // The owner can also UPDATE its own bookkeeping (Prisma stamps finished_at).
    await prisma.$executeRawUnsafe(
      `UPDATE "_prisma_migrations" SET "applied_steps_count" = 1 WHERE "id" = $1`,
      dummyId,
    );
    // Cleanup so the suite is idempotent across reruns.
    await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE "id" = $1`, dummyId);
  });
});

// ===========================================================================
// service_role policies — full catalog-shape assertion via pg_policy.
// Proves each *_service_role_all policy is FOR ALL TO service_role
// USING (true) WITH CHECK (true), straight from the live catalog (not just the
// policy name / comment checks done per-table above).
// ===========================================================================
describe('PR-RLS-07: service_role policies — catalog shape', () => {
  it('all 6 service_role policies are FOR ALL TO service_role USING (true) WITH CHECK (true)', async () => {
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
        AND c.relname IN (
          'EmailSendLog','NotificationDeliveryLog','NotificationDigestLog',
          'CommunityWin','HabitLog','_prisma_migrations'
        )
        AND r.rolname = 'service_role'
      ORDER BY c.relname, p.polname;
    `);

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.polname.endsWith('_service_role_all')).toBe(true);
      expect(row.cmd).toBe('*');
      expect(row.rolname).toBe('service_role');
      expect(row.qual).toBe('true');
      expect(row.withcheck).toBe('true');
    }
  });
});
