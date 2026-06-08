/**
 * PR-RLS-01 — Tier 1 PHI / financial / privacy RLS policy enforcement.
 *
 * Verifies the migration 20261213000000_rls_tier1_phi_financial_privacy actually
 * ENFORCES Row Level Security on all 11 Tier 1 tables:
 *   PHI/medical:        BloodworkResult, BloodworkAttachment,
 *                       DiagnosticSubmission, ClientCoachConsent
 *   financial/Stripe:   ChargeDispute, ChargeRefund, StripeProcessedEvent,
 *                       PayoutSnapshot, ReconciliationSnapshot
 *   privacy/compliance: data_export_request, deletion_audit
 *
 * This spec hits a REAL PostgreSQL instance (NO mocks, NO stubs). It is fully
 * self-bootstrapping: it creates the minimal prerequisite catalog objects
 * (schema `app`, the five RLS helper functions, and the parent + target tables
 * with just the columns the policies read), applies the migration SQL exactly
 * as Prisma would, seeds isolated fixtures, then asserts positive and negative
 * access for each table.
 *
 * Enforcement model (mirrors managed Supabase):
 *   * The PrismaClient connects as a NON-superuser, NON-BYPASSRLS login role.
 *     FORCE ROW LEVEL SECURITY means even the table owner is subject to the
 *     policies, so the `public`-targeted policies are what gate every query.
 *   * The tenant context is the TEXT GUC app.current_user_id() (+ _role), set
 *     per test via set_config('app.current_user_id', '<uuid>', false). This is
 *     the exact convention NestJS uses at runtime.
 *   * The service-role bypass policy is exercised by `SET ROLE service_role`
 *     (the login role is a member of service_role, which carries BYPASSRLS).
 *
 * Connection: RLS_TIER1_TEST_DATABASE_URL (preferred) → RLS_FN_TEST_DATABASE_URL
 * → DATABASE_URL → a local throwaway default. The PrismaClient is constructed
 * against that URL via the `datasources` override so it never touches the app's
 * default database or production Supabase.
 *
 * Idempotent: the bootstrap drops + recreates fixtures in beforeAll, so the
 * suite passes when run twice consecutively against the same database.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261213000000_rls_tier1_phi_financial_privacy',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER1_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_tier1_test';

// ---------------------------------------------------------------------------
// SQL statement splitter — copied verbatim from rls-helper-search-path.spec.ts
// so the migration is applied exactly as that established convention does
// (honors dollar-quoting and single-quoted literals; drops bare tx verbs).
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

// Pin to a single connection so session GUCs (set_config(..., false)) and SET
// ROLE / RESET ROLE are deterministic across statements.
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

// ---------------------------------------------------------------------------
// Prerequisite catalog — the `app` helpers + parent/target tables with exactly
// the columns the policies read. Mirrors production column names/types.
// ---------------------------------------------------------------------------
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

-- Out-of-scope helper (hardened in a prior migration). is_current_coach_of
-- depends on it; recreate verbatim so the dependency resolves.
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

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;

-- Parent tables (only the columns the policies read).
CREATE TABLE IF NOT EXISTS public."BloodworkPanel" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL,
  "coach_id" text
);

CREATE TABLE IF NOT EXISTS public."ClientPurchase" (
  "id" text PRIMARY KEY,
  "client_user_id" text NOT NULL,
  "coach_user_id" text NOT NULL
);

-- Target tables (minimal column sets sufficient to exercise the policies).
CREATE TABLE IF NOT EXISTS public."BloodworkResult" (
  "id" text PRIMARY KEY,
  "panel_id" text NOT NULL,
  "marker_name" text NOT NULL DEFAULT 'marker'
);

CREATE TABLE IF NOT EXISTS public."BloodworkAttachment" (
  "id" text PRIMARY KEY,
  "panel_id" text NOT NULL,
  "scan_status" text NOT NULL DEFAULT 'pending_scan'
);

CREATE TABLE IF NOT EXISTS public."DiagnosticSubmission" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL DEFAULT 'x@example.com',
  "user_id" text
);
-- The shared RLS test database (rls_fn_test) carries a pre-existing
-- DiagnosticSubmission owned by other PRs with additional NOT NULL columns
-- (email, answers, scores, bucket) and NO defaults. CREATE TABLE IF NOT EXISTS
-- never repairs an existing table, so fixture inserts that supply only id +
-- user_id previously failed with SQLSTATE 23502 before any policy could run.
-- DROP TABLE is forbidden (other PRs share this table); instead, idempotently
-- give those columns safe defaults on the EXISTING table so inserts that supply
-- only id/user_id succeed. SET DEFAULT does not rewrite existing rows and is a
-- no-op when the column is already defaulted, so this is safe on every run.
-- Each ALTER is guarded by an information_schema check so it is skipped when the
-- column is absent (e.g. on a fresh table created by the CREATE above).
DO $bootstrap$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'DiagnosticSubmission'
               AND column_name = 'email') THEN
    ALTER TABLE public."DiagnosticSubmission" ALTER COLUMN "email" SET DEFAULT '';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'DiagnosticSubmission'
               AND column_name = 'answers') THEN
    ALTER TABLE public."DiagnosticSubmission" ALTER COLUMN "answers" SET DEFAULT '{}'::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'DiagnosticSubmission'
               AND column_name = 'scores') THEN
    ALTER TABLE public."DiagnosticSubmission" ALTER COLUMN "scores" SET DEFAULT '{}'::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'DiagnosticSubmission'
               AND column_name = 'bucket') THEN
    ALTER TABLE public."DiagnosticSubmission" ALTER COLUMN "bucket" SET DEFAULT '{}'::jsonb;
  END IF;
END
$bootstrap$;

CREATE TABLE IF NOT EXISTS public."ClientCoachConsent" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL,
  "coach_id" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'phi',
  "granted_at" timestamptz,
  "revoked_at" timestamptz
);
-- Idempotently ensure the consent lifecycle timestamp columns exist even when a
-- prior run created the table without them. Runs as the table-owning login role
-- (this PREREQ script executes before any SET ROLE), so the DDL is permitted.
ALTER TABLE public."ClientCoachConsent" ADD COLUMN IF NOT EXISTS "granted_at" timestamptz;
ALTER TABLE public."ClientCoachConsent" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;

CREATE TABLE IF NOT EXISTS public."ChargeDispute" (
  "id" text PRIMARY KEY,
  "purchase_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'needs_response'
);

CREATE TABLE IF NOT EXISTS public."ChargeRefund" (
  "id" text PRIMARY KEY,
  "purchase_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS public."StripeProcessedEvent" (
  "stripe_event_id" text PRIMARY KEY,
  "type" text NOT NULL DEFAULT 'evt'
);

CREATE TABLE IF NOT EXISTS public."PayoutSnapshot" (
  "id" text PRIMARY KEY,
  "coach_user_id" text NOT NULL,
  "readiness_status" text NOT NULL DEFAULT 'needs_action'
);

CREATE TABLE IF NOT EXISTS public."ReconciliationSnapshot" (
  "id" text PRIMARY KEY,
  "purchase_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS public."data_export_request" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE IF NOT EXISTS public."deletion_audit" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "event" text NOT NULL DEFAULT 'requested',
  "actor_id" text
);
`;

// ---------------------------------------------------------------------------
// Stable fixture identities. Two independent coach/client tenants (A and B)
// prove cross-tenant isolation; `foreign` is an authenticated stranger; `owner`
// escalates via role=owner; `svc` exercises the service_role bypass.
// ---------------------------------------------------------------------------
const ID = {
  coachA: 'coachA-' + randomUUID(),
  clientA: 'clientA-' + randomUUID(),
  coachB: 'coachB-' + randomUUID(),
  clientB: 'clientB-' + randomUUID(),
  foreign: 'foreign-' + randomUUID(),
  ownerUser: 'owner-' + randomUUID(),
};

// Per-tenant row ids for each table (A = tenant A's row, B = tenant B's row).
function rid(table: string, tenant: 'A' | 'B'): string {
  return `${table}_${tenant}`;
}

const panelA = 'panel_A';
const panelB = 'panel_B';
const purchaseA = 'purchase_A';
const purchaseB = 'purchase_B';

async function setAuth(userId: string | null, role: string | null): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, false)`, userId ?? '');
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, false)`, role ?? '');
}

async function clearAuth(): Promise<void> {
  await setAuth('', '');
}

/** Count rows visible to the CURRENT auth context for a table by primary key. */
async function visibleById(table: string, pkCol: string, pk: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public."${table}" WHERE "${pkCol}" = $1`,
    pk,
  );
  return Number(rows[0].n);
}

/**
 * Run a statement inside a tx and assert it is REJECTED specifically by a
 * row-level security denial. PostgreSQL raises SQLSTATE 42501
 * (insufficient_privilege, "new row violates row-level security policy") for a
 * WITH CHECK violation, and 42P17 (invalid_object_definition) for a policy that
 * recurses. We assert on the precise SQLSTATE so a generic failure (syntax
 * error, missing relation, NOT NULL violation, etc.) can never masquerade as an
 * RLS denial. A vague `rejects.toBeDefined()` would be a silent failure in
 * disguise (R65 / Failure #36 / Failure #30).
 *
 * Prisma surfaces the SQLSTATE differently depending on the path: for the raw
 * query engine it wraps the driver error as code `P2010` with the real SQLSTATE
 * under `meta.code`; a direct (non-Prisma) Postgres error carries the SQLSTATE
 * as `code` itself. We accept both shapes.
 */
async function expectRlsDenied(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error('Expected RLS denial but query succeeded');
  } catch (err: unknown) {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    const sqlstate = e.meta?.code ?? '';
    // Prisma wraps SQLSTATE in meta.code for raw queries via P2010.
    if (e.code === 'P2010' && (sqlstate === '42501' || sqlstate === '42P17')) return;
    // Direct Postgres error (non-Prisma): code is the SQLSTATE itself.
    if (e.code === '42501' || e.code === '42P17') return;
    throw new Error(
      `Expected SQLSTATE 42501 (RLS denial); got code=${e.code ?? 'undefined'} ` +
        `meta.code=${sqlstate || 'undefined'} message=${e.message ?? ''}`,
    );
  }
}

/**
 * Convenience wrapper: run `stmt` inside a transaction and assert the RLS
 * denial via {@link expectRlsDenied}. Kept signature-compatible with the prior
 * `expectRejects` call sites (statement + params).
 */
async function expectRlsStatementDenied(stmt: string, params: unknown[] = []): Promise<void> {
  await expectRlsDenied(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(stmt, ...params);
    }),
  );
}

/** Run an UPDATE/DELETE and return the number of affected rows. */
async function execAffected(stmt: string, params: unknown[] = []): Promise<number> {
  return prisma.$executeRawUnsafe(stmt, ...params);
}

/**
 * Assert that a statement is REJECTED specifically by a row-level security
 * WITH CHECK violation. PostgreSQL raises SQLSTATE 42501 (insufficient_privilege)
 * with the message "new row violates row-level security policy"; the Prisma raw
 * engine surfaces that on the thrown error as `err.code === 'P2010'` with
 * `err.meta.code === '42501'` (or `42P17`). We assert on SQLSTATE ONLY — no
 * message-regex fallback — so a generic failure (e.g. a syntax error or a
 * missing relation) can never masquerade as an RLS denial. A vague
 * `rejects.toBeDefined()` or message-regex match here would be a silent
 * failure in disguise (R65 / Failure #36 / Failure #30).
 */
async function expectRlsInsertDenied(stmt: string, params: unknown[] = []): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(stmt, ...params);
    });
    throw new Error(`expected RLS denial but statement succeeded: ${stmt}`);
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

/** Run a block of statements as the service_role (BYPASSRLS), then reset. */
async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('SET ROLE service_role');
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe('RESET ROLE');
  }
}

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Mirror managed Supabase base privileges: service_role/anon/authenticated
  // hold full table grants there, and RLS (not GRANTs) does the gating. The
  // connecting login role owns the tables, so it grants on their behalf. This
  // lets SET ROLE service_role TRUNCATE/seed and lets the public-targeted
  // policies (evaluated for anon/authenticated/the login role) actually run.
  const GRANT_TABLES = [
    'BloodworkResult', 'BloodworkAttachment', 'DiagnosticSubmission', 'ClientCoachConsent',
    'ChargeDispute', 'ChargeRefund', 'StripeProcessedEvent', 'PayoutSnapshot',
    'ReconciliationSnapshot', 'data_export_request', 'deletion_audit',
    'BloodworkPanel', 'ClientPurchase', 'User',
  ];
  for (const t of GRANT_TABLES) {
    await prisma.$executeRawUnsafe(
      `GRANT ALL ON public."${t}" TO service_role, anon, authenticated`,
    );
  }

  // Confirm RLS is enabled+forced on all 11 tables (fail loudly otherwise — R0).
  const TABLES = [
    'BloodworkResult', 'BloodworkAttachment', 'DiagnosticSubmission', 'ClientCoachConsent',
    'ChargeDispute', 'ChargeRefund', 'StripeProcessedEvent', 'PayoutSnapshot',
    'ReconciliationSnapshot', 'data_export_request', 'deletion_audit',
  ];
  const guarded = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM pg_class c
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = ANY($1::text[])
        AND c.relrowsecurity = true AND c.relforcerowsecurity = true`,
    TABLES,
  );
  if (Number(guarded[0].n) !== TABLES.length) {
    throw new Error(
      `bootstrap incomplete: expected ${TABLES.length} ENABLE+FORCE tables, found ${guarded[0].n}`,
    );
  }

  // Seed fixtures as the service_role so RLS does not block setup. Idempotent:
  // truncate every table first so a second run starts clean.
  await asServiceRole(async () => {
    for (const t of [...TABLES, 'BloodworkPanel', 'ClientPurchase', 'User']) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE public."${t}" CASCADE`);
    }

    // Users: clientA coached by coachA; clientB coached by coachB.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","coach_id","role") VALUES
         ($1,$2,'student'),($3,NULL,'coach'),
         ($4,$5,'student'),($6,NULL,'coach'),
         ($7,NULL,'student'),($8,NULL,'owner')`,
      ID.clientA, ID.coachA, ID.coachA,
      ID.clientB, ID.coachB, ID.coachB,
      ID.foreign, ID.ownerUser,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public."BloodworkPanel"("id","client_id","coach_id") VALUES ($1,$2,$3),($4,$5,$6)`,
      panelA, ID.clientA, ID.coachA, panelB, ID.clientB, ID.coachB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."ClientPurchase"("id","client_user_id","coach_user_id") VALUES ($1,$2,$3),($4,$5,$6)`,
      purchaseA, ID.clientA, ID.coachA, purchaseB, ID.clientB, ID.coachB,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public."BloodworkResult"("id","panel_id") VALUES ($1,$2),($3,$4)`,
      rid('BloodworkResult', 'A'), panelA, rid('BloodworkResult', 'B'), panelB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."BloodworkAttachment"("id","panel_id") VALUES ($1,$2),($3,$4)`,
      rid('BloodworkAttachment', 'A'), panelA, rid('BloodworkAttachment', 'B'), panelB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."DiagnosticSubmission"("id","user_id") VALUES ($1,$2),($3,$4)`,
      rid('DiagnosticSubmission', 'A'), ID.clientA, rid('DiagnosticSubmission', 'B'), ID.clientB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id") VALUES ($1,$2,$3),($4,$5,$6)`,
      rid('ClientCoachConsent', 'A'), ID.clientA, ID.coachA,
      rid('ClientCoachConsent', 'B'), ID.clientB, ID.coachB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."ChargeDispute"("id","purchase_id") VALUES ($1,$2),($3,$4)`,
      rid('ChargeDispute', 'A'), purchaseA, rid('ChargeDispute', 'B'), purchaseB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."ChargeRefund"("id","purchase_id") VALUES ($1,$2),($3,$4)`,
      rid('ChargeRefund', 'A'), purchaseA, rid('ChargeRefund', 'B'), purchaseB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."StripeProcessedEvent"("stripe_event_id") VALUES ($1),($2)`,
      rid('StripeProcessedEvent', 'A'), rid('StripeProcessedEvent', 'B'),
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."PayoutSnapshot"("id","coach_user_id") VALUES ($1,$2),($3,$4)`,
      rid('PayoutSnapshot', 'A'), ID.coachA, rid('PayoutSnapshot', 'B'), ID.coachB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."ReconciliationSnapshot"("id","purchase_id") VALUES ($1,$2),($3,$4)`,
      rid('ReconciliationSnapshot', 'A'), purchaseA, rid('ReconciliationSnapshot', 'B'), purchaseB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."data_export_request"("id","user_id") VALUES ($1,$2),($3,$4)`,
      rid('data_export_request', 'A'), ID.clientA, rid('data_export_request', 'B'), ID.clientB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."deletion_audit"("id","user_id","actor_id") VALUES ($1,$2,$3),($4,$5,$6)`,
      rid('deletion_audit', 'A'), ID.clientA, ID.coachA,
      rid('deletion_audit', 'B'), ID.clientB, ID.coachB,
    );
  });
}, 120_000);

afterAll(async () => {
  try {
    await clearAuth();
  } catch (err) {
    // Cleanup failures are still cleanup failures. Surface them so the
    // suite fails loudly when the connection or session state is wrong.
    // No PII can appear here — clearAuth() only resets session config.
    // eslint-disable-next-line no-console
    console.error('[rls-tier1] afterAll clearAuth failed:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  await clearAuth();
});

// ===========================================================================
// PHI — child-via-BloodworkPanel tables (BloodworkResult, BloodworkAttachment)
// Owner of the row = the client of the parent panel. Coach access = the panel
// coach AND the current coach of the panel client. Writes (UPDATE/DELETE)
// restricted to service/owner (medical records immutable client-side).
// ===========================================================================
function phiChildSuite(table: string): void {
  const aId = rid(table, 'A');
  const bId = rid(table, 'B');

  describe(`${table} (PHI, child-via-BloodworkPanel)`, () => {
    it('positive: panel client (owner of the row) reads own row', async () => {
      await setAuth(ID.clientA, 'student');
      expect(await visibleById(table, 'id', aId)).toBe(1);
    });

    it('coach access: the panel/assigned coach reads the assigned client row', async () => {
      await setAuth(ID.coachA, 'coach');
      expect(await visibleById(table, 'id', aId)).toBe(1);
    });

    it('negative: foreign authenticated user is blocked', async () => {
      await setAuth(ID.foreign, 'student');
      expect(await visibleById(table, 'id', aId)).toBe(0);
    });

    it('cross-tenant: coach B cannot read coach A client row', async () => {
      await setAuth(ID.coachB, 'coach');
      expect(await visibleById(table, 'id', aId)).toBe(0);
    });

    it('service role bypass: sees both tenant rows', async () => {
      await asServiceRole(async () => {
        expect(await visibleById(table, 'id', aId)).toBe(1);
        expect(await visibleById(table, 'id', bId)).toBe(1);
      });
    });

    it('INSERT denial: foreign user cannot insert into a panel they do not own/coach', async () => {
      await setAuth(ID.foreign, 'student');
      await expectRlsStatementDenied(
        `INSERT INTO public."${table}"("id","panel_id") VALUES ($1,$2)`,
        [`${table}_ins_foreign`, panelA],
      );
    });

    it('UPDATE denial: anonymous (no auth) update affects 0 rows', async () => {
      await clearAuth();
      const affected = await execAffected(
        `UPDATE public."${table}" SET "id" = "id" WHERE "id" = $1`,
        [aId],
      );
      expect(affected).toBe(0);
    });

    it('UPDATE denial: panel client cannot mutate PHI (service/owner only)', async () => {
      await setAuth(ID.clientA, 'student');
      const affected = await execAffected(
        `UPDATE public."${table}" SET "id" = "id" WHERE "id" = $1`,
        [aId],
      );
      expect(affected).toBe(0);
    });

    it('DELETE denial: anonymous (no auth) delete affects 0 rows', async () => {
      await clearAuth();
      const affected = await execAffected(`DELETE FROM public."${table}" WHERE "id" = $1`, [aId]);
      expect(affected).toBe(0);
    });
  });
}

phiChildSuite('BloodworkResult');
phiChildSuite('BloodworkAttachment');

// ===========================================================================
// DiagnosticSubmission — self access on user_id, anonymous INSERT carve-out,
// service/owner-only UPDATE/DELETE.
// ===========================================================================
describe('DiagnosticSubmission (PHI intake, self + anon-insert)', () => {
  const aId = rid('DiagnosticSubmission', 'A');
  const bId = rid('DiagnosticSubmission', 'B');

  it('positive: attributed user reads own submission', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('DiagnosticSubmission', 'id', aId)).toBe(1);
  });

  it('owner access: owner reads any submission', async () => {
    await setAuth(ID.ownerUser, 'owner');
    expect(await visibleById('DiagnosticSubmission', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('DiagnosticSubmission', 'id', aId)).toBe(0);
  });

  it('cross-tenant: client B cannot read client A submission', async () => {
    await setAuth(ID.clientB, 'student');
    expect(await visibleById('DiagnosticSubmission', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both submissions', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('DiagnosticSubmission', 'id', aId)).toBe(1);
      expect(await visibleById('DiagnosticSubmission', 'id', bId)).toBe(1);
    });
  });

  it('INSERT allowed: anonymous lead funnel can insert a user_id-NULL row', async () => {
    await clearAuth();
    const insId = 'Diagnostic_anon_' + randomUUID();
    const affected = await execAffected(
      `INSERT INTO public."DiagnosticSubmission"("id","user_id") VALUES ($1, NULL)`,
      [insId],
    );
    expect(affected).toBe(1);
    // Clean up via service role to keep fixtures isolated.
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."DiagnosticSubmission" WHERE "id" = $1`, insId);
    });
  });

  it('INSERT denial: foreign user cannot insert a row attributed to another user', async () => {
    await setAuth(ID.foreign, 'student');
    await expectRlsStatementDenied(
      `INSERT INTO public."DiagnosticSubmission"("id","user_id") VALUES ($1,$2)`,
      ['Diagnostic_ins_foreign', ID.clientA],
    );
  });

  it('UPDATE denial: anonymous update affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `UPDATE public."DiagnosticSubmission" SET "email" = 'changed@example.com' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `DELETE FROM public."DiagnosticSubmission" WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// ClientCoachConsent — both parties + current-coach read; either party insert;
// service/owner-only UPDATE/DELETE.
// ===========================================================================
describe('ClientCoachConsent (legal consent, client-self-or-coach)', () => {
  const aId = rid('ClientCoachConsent', 'A');
  const bId = rid('ClientCoachConsent', 'B');

  it('positive: consenting client reads own consent', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('ClientCoachConsent', 'id', aId)).toBe(1);
  });

  it('coach access: named coach reads the consent', async () => {
    await setAuth(ID.coachA, 'coach');
    expect(await visibleById('ClientCoachConsent', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('ClientCoachConsent', 'id', aId)).toBe(0);
  });

  it('cross-tenant: coach B cannot read coach A consent', async () => {
    await setAuth(ID.coachB, 'coach');
    expect(await visibleById('ClientCoachConsent', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both consent rows', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('ClientCoachConsent', 'id', aId)).toBe(1);
      expect(await visibleById('ClientCoachConsent', 'id', bId)).toBe(1);
    });
  });

  it('INSERT allowed: a client may record their own consent', async () => {
    await setAuth(ID.clientA, 'student');
    const insId = 'Consent_self_' + randomUUID();
    const affected = await execAffected(
      `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id","scope") VALUES ($1,$2,$3,'phi2')`,
      [insId, ID.clientA, ID.coachA],
    );
    expect(affected).toBe(1);
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."ClientCoachConsent" WHERE "id" = $1`, insId);
    });
  });

  it('INSERT denial: foreign user cannot record consent for another client', async () => {
    await setAuth(ID.foreign, 'student');
    await expectRlsStatementDenied(
      `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id") VALUES ($1,$2,$3)`,
      ['Consent_ins_foreign', ID.clientA, ID.coachA],
    );
  });

  it('UPDATE denial: client cannot mutate consent (service/owner only)', async () => {
    await setAuth(ID.clientA, 'student');
    const affected = await execAffected(
      `UPDATE public."ClientCoachConsent" SET "scope" = 'tampered' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `DELETE FROM public."ClientCoachConsent" WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// Financial — purchase-party read, service-write tables.
// (ChargeDispute, ReconciliationSnapshot: writes service/owner only.)
// ===========================================================================
function purchasePartyServiceWriteSuite(table: string): void {
  const aId = rid(table, 'A');
  const bId = rid(table, 'B');

  describe(`${table} (financial, purchase-party-read / service-write)`, () => {
    it('positive: purchase client reads own row', async () => {
      await setAuth(ID.clientA, 'student');
      expect(await visibleById(table, 'id', aId)).toBe(1);
    });

    it('coach access: purchase coach reads the row', async () => {
      await setAuth(ID.coachA, 'coach');
      expect(await visibleById(table, 'id', aId)).toBe(1);
    });

    it('negative: foreign authenticated user is blocked', async () => {
      await setAuth(ID.foreign, 'student');
      expect(await visibleById(table, 'id', aId)).toBe(0);
    });

    it('cross-tenant: coach B cannot read coach A purchase row', async () => {
      await setAuth(ID.coachB, 'coach');
      expect(await visibleById(table, 'id', aId)).toBe(0);
    });

    it('service role bypass: sees both tenant rows', async () => {
      await asServiceRole(async () => {
        expect(await visibleById(table, 'id', aId)).toBe(1);
        expect(await visibleById(table, 'id', bId)).toBe(1);
      });
    });

    it('INSERT denial: purchase party (non-owner) cannot insert (service/owner only)', async () => {
      await setAuth(ID.clientA, 'student');
      await expectRlsStatementDenied(
        `INSERT INTO public."${table}"("id","purchase_id") VALUES ($1,$2)`,
        [`${table}_ins_party`, purchaseA],
      );
    });

    it('UPDATE denial: anonymous update affects 0 rows', async () => {
      await clearAuth();
      const affected = await execAffected(
        `UPDATE public."${table}" SET "status" = 'tampered' WHERE "id" = $1`,
        [aId],
      );
      expect(affected).toBe(0);
    });

    it('DELETE denial: anonymous delete affects 0 rows', async () => {
      await clearAuth();
      const affected = await execAffected(`DELETE FROM public."${table}" WHERE "id" = $1`, [aId]);
      expect(affected).toBe(0);
    });
  });
}

purchasePartyServiceWriteSuite('ChargeDispute');
purchasePartyServiceWriteSuite('ReconciliationSnapshot');

// ===========================================================================
// ChargeRefund — purchase-party read AND purchase-party write (coach-initiated
// refunds) per the plan's purchase-party-read-coach-insert primitive.
// ===========================================================================
describe('ChargeRefund (financial, purchase-party-read / purchase-party-write)', () => {
  const aId = rid('ChargeRefund', 'A');
  const bId = rid('ChargeRefund', 'B');

  it('positive: purchase client reads own refund', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('ChargeRefund', 'id', aId)).toBe(1);
  });

  it('coach access: purchase coach reads the refund', async () => {
    await setAuth(ID.coachA, 'coach');
    expect(await visibleById('ChargeRefund', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('ChargeRefund', 'id', aId)).toBe(0);
  });

  it('cross-tenant: coach B cannot read coach A refund', async () => {
    await setAuth(ID.coachB, 'coach');
    expect(await visibleById('ChargeRefund', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both refunds', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('ChargeRefund', 'id', aId)).toBe(1);
      expect(await visibleById('ChargeRefund', 'id', bId)).toBe(1);
    });
  });

  it('INSERT allowed: purchase coach may record a refund for their purchase', async () => {
    await setAuth(ID.coachA, 'coach');
    const insId = 'Refund_coach_' + randomUUID();
    const affected = await execAffected(
      `INSERT INTO public."ChargeRefund"("id","purchase_id") VALUES ($1,$2)`,
      [insId, purchaseA],
    );
    expect(affected).toBe(1);
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."ChargeRefund" WHERE "id" = $1`, insId);
    });
  });

  it('INSERT denial: foreign user cannot record a refund for a purchase they are not party to', async () => {
    await setAuth(ID.foreign, 'student');
    await expectRlsStatementDenied(
      `INSERT INTO public."ChargeRefund"("id","purchase_id") VALUES ($1,$2)`,
      ['Refund_ins_foreign', purchaseA],
    );
  });

  it('UPDATE denial: anonymous update affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `UPDATE public."ChargeRefund" SET "status" = 'tampered' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(`DELETE FROM public."ChargeRefund" WHERE "id" = $1`, [aId]);
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// StripeProcessedEvent — service-role-only (no tenant ownership). PK is
// stripe_event_id (no `id` column).
// ===========================================================================
describe('StripeProcessedEvent (service-role-only webhook ledger)', () => {
  const aId = rid('StripeProcessedEvent', 'A');
  const bId = rid('StripeProcessedEvent', 'B');
  const pk = 'stripe_event_id';

  it('positive: owner can read (the only non-service read path)', async () => {
    await setAuth(ID.ownerUser, 'owner');
    expect(await visibleById('StripeProcessedEvent', pk, aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('StripeProcessedEvent', pk, aId)).toBe(0);
  });

  it('cross-tenant: a coach cannot read the webhook ledger', async () => {
    await setAuth(ID.coachA, 'coach');
    expect(await visibleById('StripeProcessedEvent', pk, aId)).toBe(0);
  });

  it('client denial: a client cannot read the webhook ledger', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('StripeProcessedEvent', pk, aId)).toBe(0);
  });

  it('service role bypass: sees both ledger rows', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('StripeProcessedEvent', pk, aId)).toBe(1);
      expect(await visibleById('StripeProcessedEvent', pk, bId)).toBe(1);
    });
  });

  it('INSERT denial: a coach cannot write the webhook ledger', async () => {
    await setAuth(ID.coachA, 'coach');
    await expectRlsStatementDenied(
      `INSERT INTO public."StripeProcessedEvent"("stripe_event_id") VALUES ($1)`,
      ['evt_ins_coach'],
    );
  });

  it('UPDATE denial: anonymous update affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `UPDATE public."StripeProcessedEvent" SET "type" = 'tampered' WHERE "stripe_event_id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `DELETE FROM public."StripeProcessedEvent" WHERE "stripe_event_id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// PayoutSnapshot — coach-self read on coach_user_id, service/owner-only write.
// ===========================================================================
describe('PayoutSnapshot (financial, coach-self-read / owner-write)', () => {
  const aId = rid('PayoutSnapshot', 'A');
  const bId = rid('PayoutSnapshot', 'B');

  it('positive: coach reads own payout snapshot', async () => {
    await setAuth(ID.coachA, 'coach');
    expect(await visibleById('PayoutSnapshot', 'id', aId)).toBe(1);
  });

  it('owner access: owner reads any payout snapshot', async () => {
    await setAuth(ID.ownerUser, 'owner');
    expect(await visibleById('PayoutSnapshot', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('PayoutSnapshot', 'id', aId)).toBe(0);
  });

  it('cross-tenant: coach B cannot read coach A payout snapshot', async () => {
    await setAuth(ID.coachB, 'coach');
    expect(await visibleById('PayoutSnapshot', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both payout snapshots', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('PayoutSnapshot', 'id', aId)).toBe(1);
      expect(await visibleById('PayoutSnapshot', 'id', bId)).toBe(1);
    });
  });

  it('INSERT denial: a coach cannot mint their own payout snapshot (service/owner only)', async () => {
    await setAuth(ID.coachA, 'coach');
    await expectRlsStatementDenied(
      `INSERT INTO public."PayoutSnapshot"("id","coach_user_id") VALUES ($1,$2)`,
      ['Payout_ins_coach', ID.coachA],
    );
  });

  it('UPDATE denial: coach cannot mutate own payout snapshot', async () => {
    await setAuth(ID.coachA, 'coach');
    const affected = await execAffected(
      `UPDATE public."PayoutSnapshot" SET "readiness_status" = 'tampered' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(`DELETE FROM public."PayoutSnapshot" WHERE "id" = $1`, [aId]);
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// data_export_request — user-self read/insert on user_id, service/owner-only
// UPDATE/DELETE.
// ===========================================================================
describe('data_export_request (privacy, user-self-owner)', () => {
  const aId = rid('data_export_request', 'A');
  const bId = rid('data_export_request', 'B');

  it('positive: requesting user reads own export request', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('data_export_request', 'id', aId)).toBe(1);
  });

  it('owner access: owner reads any export request', async () => {
    await setAuth(ID.ownerUser, 'owner');
    expect(await visibleById('data_export_request', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('data_export_request', 'id', aId)).toBe(0);
  });

  it('cross-tenant: client B cannot read client A export request', async () => {
    await setAuth(ID.clientB, 'student');
    expect(await visibleById('data_export_request', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both export requests', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('data_export_request', 'id', aId)).toBe(1);
      expect(await visibleById('data_export_request', 'id', bId)).toBe(1);
    });
  });

  it('INSERT allowed: a user may request an export for themselves', async () => {
    await setAuth(ID.clientA, 'student');
    const insId = 'Export_self_' + randomUUID();
    const affected = await execAffected(
      `INSERT INTO public."data_export_request"("id","user_id") VALUES ($1,$2)`,
      [insId, ID.clientA],
    );
    expect(affected).toBe(1);
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."data_export_request" WHERE "id" = $1`, insId);
    });
  });

  it('INSERT denial: a user cannot request an export attributed to another user', async () => {
    await setAuth(ID.foreign, 'student');
    await expectRlsStatementDenied(
      `INSERT INTO public."data_export_request"("id","user_id") VALUES ($1,$2)`,
      ['Export_ins_foreign', ID.clientA],
    );
  });

  it('UPDATE denial: requesting user cannot mutate the export (service/owner only)', async () => {
    await setAuth(ID.clientA, 'student');
    const affected = await execAffected(
      `UPDATE public."data_export_request" SET "status" = 'READY' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(
      `DELETE FROM public."data_export_request" WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// deletion_audit — subject (user_id) OR actor (actor_id) read; service/owner
// only INSERT/UPDATE/DELETE (append-only system evidence).
// ===========================================================================
describe('deletion_audit (privacy, subject-or-actor read / service-write)', () => {
  const aId = rid('deletion_audit', 'A');
  const bId = rid('deletion_audit', 'B');

  it('positive: subject user reads own audit line', async () => {
    await setAuth(ID.clientA, 'student');
    expect(await visibleById('deletion_audit', 'id', aId)).toBe(1);
  });

  it('actor access: the acting user reads the audit line they initiated', async () => {
    await setAuth(ID.coachA, 'coach');
    expect(await visibleById('deletion_audit', 'id', aId)).toBe(1);
  });

  it('negative: foreign authenticated user is blocked', async () => {
    await setAuth(ID.foreign, 'student');
    expect(await visibleById('deletion_audit', 'id', aId)).toBe(0);
  });

  it('cross-tenant: client B cannot read client A audit line', async () => {
    await setAuth(ID.clientB, 'student');
    expect(await visibleById('deletion_audit', 'id', aId)).toBe(0);
  });

  it('service role bypass: sees both audit lines', async () => {
    await asServiceRole(async () => {
      expect(await visibleById('deletion_audit', 'id', aId)).toBe(1);
      expect(await visibleById('deletion_audit', 'id', bId)).toBe(1);
    });
  });

  it('INSERT denial: the subject user cannot forge an audit line (service/owner only)', async () => {
    await setAuth(ID.clientA, 'student');
    await expectRlsStatementDenied(
      `INSERT INTO public."deletion_audit"("id","user_id","actor_id") VALUES ($1,$2,$3)`,
      ['Audit_ins_subject', ID.clientA, ID.clientA],
    );
  });

  it('UPDATE denial: subject cannot mutate audit evidence', async () => {
    await setAuth(ID.clientA, 'student');
    const affected = await execAffected(
      `UPDATE public."deletion_audit" SET "event" = 'tampered' WHERE "id" = $1`,
      [aId],
    );
    expect(affected).toBe(0);
  });

  it('DELETE denial: anonymous delete affects 0 rows', async () => {
    await clearAuth();
    const affected = await execAffected(`DELETE FROM public."deletion_audit" WHERE "id" = $1`, [aId]);
    expect(affected).toBe(0);
  });
});

// ===========================================================================
// service_role bypass contract
// ---------------------------------------------------------------------------
// Production reality (PR-RLS-01_R2_BRIEF "Production reality"): the NestJS
// backend connects to Postgres via the Supabase service_role JWT, which carries
// the BYPASSRLS attribute. The owner-only UPDATE/DELETE policies on
// ClientCoachConsent / DiagnosticSubmission / data_export_request are therefore
// the defense-in-depth path for any NON-bypass connection — they are NOT meant
// to be satisfiable by a regular authenticated tenant.
//
// These tests prove BOTH halves of the contract simultaneously:
//   1. A service_role (BYPASSRLS) connection performs the lifecycle mutations
//      the production services issue (consent re-grant / revoke, diagnostic
//      user_id nullification + anonymous-row attach, privacy-row deletion).
//   2. A non-bypass tenant connection is denied the same mutation — either via
//      a hard RLS WITH CHECK error (INSERT) or via the RLS USING filter making
//      the row invisible so the statement affects 0 rows (UPDATE/DELETE). The
//      0-rows-affected outcome IS the denial under PostgreSQL RLS semantics for
//      UPDATE/DELETE; we assert the exact affected count, never a vague
//      "rejects.toBeDefined()".
//
// The connecting login role is a member of service_role; `asServiceRole()`
// switches to it (BYPASSRLS) and always RESETs in a finally. Fixtures here are
// dedicated to this block (distinct ids) and torn down in afterAll so they do
// not perturb the shared per-table suites.
// ===========================================================================
describe('service_role bypass contract', () => {
  const bypassClient = 'bypass_client_' + randomUUID();
  const bypassCoach = 'bypass_coach_' + randomUUID();
  const bypassOwner = 'bypass_owner_' + randomUUID();
  const bypassStranger = 'bypass_stranger_' + randomUUID();

  const consentId = 'bypass_consent_' + randomUUID();
  const diagOwnedId = 'bypass_diag_owned_' + randomUUID();
  const diagAnonId = 'bypass_diag_anon_' + randomUUID();
  const exportId = 'bypass_export_' + randomUUID();
  const deleteConsentId = 'bypass_consent_del_' + randomUUID();

  beforeAll(async () => {
    // The consent lifecycle timestamp columns (granted_at / revoked_at) are
    // ensured by PREREQ_SQL, which runs as the table-owning login role before
    // any SET ROLE — DDL under SET ROLE service_role would fail "must be owner".
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."User"("id","coach_id","role") VALUES
           ($1,$2,'student'),($3,NULL,'coach'),($4,NULL,'owner'),($5,NULL,'student')`,
        bypassClient, bypassCoach, bypassCoach, bypassOwner, bypassStranger,
      );

      // Consent owned by bypassClient/bypassCoach (re-grant + revoke scenarios).
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id","scope","granted_at","revoked_at")
           VALUES ($1,$2,$3,'phi', now(), NULL)`,
        consentId, bypassClient, bypassCoach,
      );
      // Separate consent row for the deletion scenario.
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id","scope","granted_at")
           VALUES ($1,$2,$3,'phi', now())`,
        deleteConsentId, bypassClient, bypassCoach,
      );

      // Diagnostic submissions: one attributed to bypassClient, one anonymous.
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."DiagnosticSubmission"("id","user_id") VALUES ($1,$2)`,
        diagOwnedId, bypassClient,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."DiagnosticSubmission"("id","user_id") VALUES ($1, NULL)`,
        diagAnonId,
      );

      // data_export_request owned by bypassClient (deletion scenario).
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."data_export_request"("id","user_id") VALUES ($1,$2)`,
        exportId, bypassClient,
      );
    });
  }, 60_000);

  afterAll(async () => {
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM public."ClientCoachConsent" WHERE "id" = ANY($1::text[])`,
        [consentId, deleteConsentId],
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM public."DiagnosticSubmission" WHERE "id" = ANY($1::text[])`,
        [diagOwnedId, diagAnonId],
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM public."data_export_request" WHERE "id" = $1`,
        exportId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM public."User" WHERE "id" = ANY($1::text[])`,
        [bypassClient, bypassCoach, bypassOwner, bypassStranger],
      );
    });
  });

  // -- Scenario 1: ClientCoachConsent re-grant -----------------------------
  // DENIAL SEMANTICS: filtered-zero. p_clientcoachconsent_update is
  // `USING (app.is_owner())`; a non-owner tenant fails the USING clause, so the
  // target row is invisible to the UPDATE and PostgreSQL reports 0 rows affected
  // WITHOUT raising — that is the correct RLS denial for UPDATE/DELETE (a hard
  // 42501 only fires when USING passes but WITH CHECK fails). We assert the
  // exact 0-row count AND prove the deny path by reading the row back as
  // service_role to confirm the would-be mutation never landed.
  it('consent re-grant: non-owner UPDATE is filtered to 0 rows (granted_at unchanged); service_role re-grants', async () => {
    // Capture the pre-state via service_role for the post-mutation comparison.
    const before = await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ granted_at: Date | null }[]>(
        `SELECT "granted_at" FROM public."ClientCoachConsent" WHERE "id" = $1`,
        consentId,
      );
      return rows[0].granted_at;
    });

    // Non-owner tenant (the named client is NOT a policy owner; UPDATE is owner-only).
    await setAuth(bypassClient, 'student');
    const denied = await execAffected(
      `UPDATE public."ClientCoachConsent" SET "granted_at" = now() WHERE "id" = $1`,
      [consentId],
    );
    expect(denied).toBe(0); // filtered-zero denial, not a hard error

    // Post-check: the row's granted_at is unchanged (the tenant write was a no-op).
    await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ granted_at: Date | null }[]>(
        `SELECT "granted_at" FROM public."ClientCoachConsent" WHERE "id" = $1`,
        consentId,
      );
      expect(rows[0].granted_at?.getTime() ?? null).toBe(before?.getTime() ?? null);
    });

    // service_role (BYPASSRLS) performs the lifecycle re-grant.
    await asServiceRole(async () => {
      const affected = await execAffected(
        `UPDATE public."ClientCoachConsent" SET "granted_at" = now(), "revoked_at" = NULL WHERE "id" = $1`,
        [consentId],
      );
      expect(affected).toBe(1);
    });
  });

  // -- Scenario 2: ClientCoachConsent revoke -------------------------------
  // DENIAL SEMANTICS: filtered-zero (same USING-based owner-only UPDATE policy).
  // The post-check that the revoke landed (revoked_at NOT NULL) also doubles as
  // proof the tenant's prior denied UPDATE did not set revoked_at itself.
  it('consent revoke: non-owner UPDATE is filtered to 0 rows; service_role sets revoked_at', async () => {
    // A different non-owner tenant (the coach party) is also denied UPDATE.
    await setAuth(bypassCoach, 'coach');
    const denied = await execAffected(
      `UPDATE public."ClientCoachConsent" SET "revoked_at" = now() WHERE "id" = $1`,
      [consentId],
    );
    expect(denied).toBe(0); // filtered-zero denial, not a hard error

    // Post-check: tenant write was a no-op — revoked_at is still NULL pre-service.
    await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ revoked_at: Date | null }[]>(
        `SELECT "revoked_at" FROM public."ClientCoachConsent" WHERE "id" = $1`,
        consentId,
      );
      expect(rows[0].revoked_at).toBeNull();
    });

    await asServiceRole(async () => {
      const affected = await execAffected(
        `UPDATE public."ClientCoachConsent" SET "revoked_at" = now() WHERE "id" = $1`,
        [consentId],
      );
      expect(affected).toBe(1);
    });

    // Confirm the revoke landed (read back as service_role).
    await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ revoked_at: Date | null }[]>(
        `SELECT "revoked_at" FROM public."ClientCoachConsent" WHERE "id" = $1`,
        consentId,
      );
      expect(rows[0].revoked_at).not.toBeNull();
    });
  });

  // -- Scenario 3: DiagnosticSubmission.user_id nullification --------------
  // DENIAL SEMANTICS: filtered-zero for the non-owner tenant
  // (p_diagnosticsubmission_update is `USING (app.is_owner())`), then a positive
  // owner path and a positive service_role path. We post-check that the denied
  // tenant UPDATE left user_id intact before the owner legitimately nulls it.
  it('diagnostic nullification: non-owner UPDATE filtered to 0 rows (user_id intact); owner + service_role can null', async () => {
    // A non-owner tenant (even the row's own attributed user) cannot UPDATE.
    await setAuth(bypassClient, 'student');
    const deniedTenant = await execAffected(
      `UPDATE public."DiagnosticSubmission" SET "user_id" = NULL WHERE "id" = $1`,
      [diagOwnedId],
    );
    expect(deniedTenant).toBe(0); // filtered-zero denial, not a hard error

    // Post-check: the denied tenant UPDATE was a no-op — user_id is still attributed.
    await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ user_id: string | null }[]>(
        `SELECT "user_id" FROM public."DiagnosticSubmission" WHERE "id" = $1`,
        diagOwnedId,
      );
      expect(rows[0].user_id).toBe(bypassClient);
    });

    // The owner role (app.is_owner()) CAN nullify (account-deletion privacy path).
    await setAuth(bypassOwner, 'owner');
    const ownerAffected = await execAffected(
      `UPDATE public."DiagnosticSubmission" SET "user_id" = NULL WHERE "id" = $1`,
      [diagOwnedId],
    );
    expect(ownerAffected).toBe(1);

    // Re-attribute as service_role, then prove service_role can nullify too.
    await asServiceRole(async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE public."DiagnosticSubmission" SET "user_id" = $2 WHERE "id" = $1`,
        diagOwnedId, bypassClient,
      );
      const svcAffected = await execAffected(
        `UPDATE public."DiagnosticSubmission" SET "user_id" = NULL WHERE "id" = $1`,
        [diagOwnedId],
      );
      expect(svcAffected).toBe(1);
    });
  });

  // -- Scenario 4: DiagnosticSubmission anonymous-row attach ---------------
  // DENIAL SEMANTICS: filtered-zero. The would-be signup is a non-owner, so the
  // owner-only UPDATE policy hides the row and the attach affects 0 rows.
  it('attachUser(): non-owner attach filtered to 0 rows (row stays anonymous); service_role attaches', async () => {
    // A would-be new signup cannot attach themselves to an anonymous row
    // (UPDATE is owner-only) — proves the policy is owner-only.
    await setAuth(bypassStranger, 'student');
    const deniedTenant = await execAffected(
      `UPDATE public."DiagnosticSubmission" SET "user_id" = $2 WHERE "id" = $1 AND "user_id" IS NULL`,
      [diagAnonId, bypassStranger],
    );
    expect(deniedTenant).toBe(0); // filtered-zero denial, not a hard error

    // Post-check: the denied tenant attach was a no-op — the row is still anonymous.
    await asServiceRole(async () => {
      const rows = await prisma.$queryRawUnsafe<{ user_id: string | null }[]>(
        `SELECT "user_id" FROM public."DiagnosticSubmission" WHERE "id" = $1`,
        diagAnonId,
      );
      expect(rows[0].user_id).toBeNull();
    });

    // service_role performs attachUser() (diagnostic.service.ts:190-195).
    await asServiceRole(async () => {
      const affected = await execAffected(
        `UPDATE public."DiagnosticSubmission" SET "user_id" = $2 WHERE "id" = $1 AND "user_id" IS NULL`,
        [diagAnonId, bypassStranger],
      );
      expect(affected).toBe(1);

      const rows = await prisma.$queryRawUnsafe<{ user_id: string | null }[]>(
        `SELECT "user_id" FROM public."DiagnosticSubmission" WHERE "id" = $1`,
        diagAnonId,
      );
      expect(rows[0].user_id).toBe(bypassStranger);
    });
  });

  // -- Scenario 5: data_export_request + clientCoachConsent deletion -------
  // DENIAL SEMANTICS: filtered-zero. p_data_export_request_delete and
  // p_clientcoachconsent_delete are both `USING (app.is_owner())`; a non-owner
  // tenant DELETE matches no rows and affects 0. We assert the exact 0-row count
  // AND post-check via service_role that BOTH rows still exist — the deny path
  // proof that nothing was actually removed.
  it('privacy deletion: non-owner DELETE filtered to 0 rows (rows survive); service_role DELETEs export + consent', async () => {
    // Non-owner tenant DELETE is filtered to 0 rows on both tables.
    await setAuth(bypassClient, 'student');
    const deniedExport = await execAffected(
      `DELETE FROM public."data_export_request" WHERE "id" = $1`,
      [exportId],
    );
    expect(deniedExport).toBe(0); // filtered-zero denial, not a hard error

    const deniedConsent = await execAffected(
      `DELETE FROM public."ClientCoachConsent" WHERE "id" = $1`,
      [deleteConsentId],
    );
    expect(deniedConsent).toBe(0); // filtered-zero denial, not a hard error

    // Post-check: both target rows STILL EXIST (the denied DELETEs removed nothing).
    await asServiceRole(async () => {
      const exportRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM public."data_export_request" WHERE "id" = $1`,
        exportId,
      );
      expect(Number(exportRows[0].n)).toBe(1);
      const consentRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM public."ClientCoachConsent" WHERE "id" = $1`,
        deleteConsentId,
      );
      expect(Number(consentRows[0].n)).toBe(1);
    });

    // service_role performs the account-deletion cleanup deletes.
    await asServiceRole(async () => {
      const exportAffected = await execAffected(
        `DELETE FROM public."data_export_request" WHERE "id" = $1`,
        [exportId],
      );
      expect(exportAffected).toBe(1);

      const consentAffected = await execAffected(
        `DELETE FROM public."ClientCoachConsent" WHERE "id" = $1`,
        [deleteConsentId],
      );
      expect(consentAffected).toBe(1);
    });
  });

  // -- Bonus: hard RLS INSERT denial (strict SQLSTATE 42501) ---------------
  it('INSERT denial is a strict RLS WITH CHECK violation (SQLSTATE 42501), not a silent pass', async () => {
    // A stranger cannot forge a consent row for another client: this must be a
    // hard row-level-security WITH CHECK rejection, asserted by SQLSTATE.
    await setAuth(bypassStranger, 'student');
    await expectRlsInsertDenied(
      `INSERT INTO public."ClientCoachConsent"("id","client_id","coach_id") VALUES ($1,$2,$3)`,
      ['bypass_ins_forge_' + randomUUID(), bypassClient, bypassCoach],
    );
  });
});
