/**
 * PR-RLS-FN — RLS helper search_path hardening.
 *
 * Verifies the migration 20261212000000_rls_helper_search_path:
 *   1. Each of the five helper functions EXISTS with its exact signature.
 *   2. Each carries `search_path=` in pg_proc.proconfig (i.e. SET search_path = '').
 *   3. Each still returns the expected values / raises the expected errors for
 *      representative inputs — proving behavior did NOT drift.
 *
 * This spec hits a REAL PostgreSQL instance (NO mocks). It is fully
 * self-bootstrapping: it creates the minimal prerequisite catalog objects
 * (schema `app`, public."User", public."TeamSubCoachAssignment", the
 * out-of-scope app.is_user_coached_by helper, and the prior trigger binding),
 * then applies the migration SQL exactly as Prisma would, then asserts.
 *
 * Connection: RLS_FN_TEST_DATABASE_URL (preferred) or DATABASE_URL. The CI/dev
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
  '20261212000000_rls_helper_search_path',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

// Prerequisite catalog objects that the helpers depend on, mirroring the
// production schema columns the functions actually read. Applied before the
// migration so the migration's CREATE OR REPLACE statements have valid targets.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE TABLE IF NOT EXISTS public."TeamSubCoachAssignment" (
  "id" text PRIMARY KEY,
  "sub_coach_id" text NOT NULL,
  "archived_at" timestamptz
);

-- Out-of-scope helper (already hardened in a prior migration). is_current_coach_of
-- calls it; recreate it verbatim so the dependency resolves.
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT client_user_id IS NOT NULL
     AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" u
       WHERE u."id" = client_user_id
         AND u."coach_id" = coach_user_id
         AND u."role" = 'student'
     )
$fn$;

-- Prior (un-hardened) trigger function + binding, mirroring migration ordering.
-- The PR migration REPLACEs the body; the binding below is left intact.
CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
RETURNS TRIGGER AS $fn$
DECLARE head_count INTEGER;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO head_count FROM "TeamSubCoachAssignment"
   WHERE "sub_coach_id" = NEW."sub_coach_id" AND "archived_at" IS NULL AND "id" <> NEW."id";
  IF head_count >= 2 THEN
    RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_subcoach_head_cap ON "TeamSubCoachAssignment";
CREATE TRIGGER trg_enforce_subcoach_head_cap
BEFORE INSERT OR UPDATE ON "TeamSubCoachAssignment"
FOR EACH ROW EXECUTE FUNCTION enforce_subcoach_head_cap();
`;

/**
 * Split a SQL file into top-level statements on semicolons that are NOT inside a
 * dollar-quoted block ($$...$$ or $tag$...$tag$). Prisma applies migrations as a
 * single script, but $executeRawUnsafe runs one statement at a time, so we honor
 * dollar-quoting to keep function bodies intact. The migration wraps everything
 * in BEGIN/COMMIT; we strip those because each $executeRawUnsafe runs in its own
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
    // Single-quoted string literal — copy verbatim (handles '' escapes and any
    // embedded ';' or '--' which are NOT statement/ comment delimiters here).
    if (inSingleQuote) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          // Escaped quote ('') — consume the second quote, stay in string.
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
    // Line comment — copy through end of line.
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
  // Drop bare transaction-control statements — each exec is its own tx.
  return statements.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim()));
}

// Pin the pool to a single connection so session GUCs (set_config(..., false))
// and any aborted-transaction recovery are deterministic across statements.
const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({
  datasources: { db: { url: SINGLE_CONN_URL } },
});

/**
 * Run a statement expected to RAISE, asserting the message matches `pattern`.
 * The statement runs inside an interactive transaction so the inevitable abort
 * is fully contained (rolled back) and never poisons the shared connection for
 * subsequent assertions.
 */
async function expectRaises(stmt: string, pattern: RegExp): Promise<void> {
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(stmt);
    }),
  ).rejects.toThrow(pattern);
}

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
    if (!stmt) continue; // comment-only chunk — nothing to execute
    // Skip transaction-control verbs: each $executeRawUnsafe autocommits, so a
    // bare BEGIN/COMMIT would open an uncommitted tx that rolls back on
    // disconnect (and silently discard every DDL statement after it). The check
    // runs AFTER comment stripping because the migration prefixes statements
    // with -- comments, which would otherwise hide the BEGIN/COMMIT verb.
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
    // No swallowing: any failure here must fail the suite loudly (R0).
    await prisma.$executeRawUnsafe(stmt);
  }
}

beforeAll(async () => {
  await prisma.$connect();
  // Self-bootstrap: prerequisites, then the migration under test.
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);
  // Clean slate for data-dependent assertions.
  await prisma.$executeRawUnsafe('DELETE FROM public."TeamSubCoachAssignment"');
  await prisma.$executeRawUnsafe('DELETE FROM public."User"');

  // Fail loudly (R0: no silent failures) if the migration did not create every
  // helper. This converts any swallowed/ordering problem into an explicit error.
  const created = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
      WHERE (ns.nspname = 'app' AND p.proname IN ('current_user_id','current_user_role','is_owner','is_current_coach_of'))
         OR (ns.nspname = 'public' AND p.proname = 'enforce_subcoach_head_cap')`,
  );
  if (Number(created[0].n) !== 5) {
    throw new Error(`bootstrap incomplete: expected 5 helper functions, found ${created[0].n}`);
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** Reset GUCs to a known-unset state between tests (set to '' → helpers see NULL). */
async function clearAuthContext(): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id', '', false)`);
  await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role', '', false)`);
}

type ProcRow = { nspname: string; proname: string; proconfig: string[] | null; args: string; rettype: string };

async function getProc(schema: string, name: string): Promise<ProcRow | undefined> {
  const rows = await prisma.$queryRawUnsafe<ProcRow[]>(
    `SELECT n.nspname,
            p.proname,
            p.proconfig,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            pg_catalog.format_type(p.prorettype, NULL) AS rettype
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2`,
    schema,
    name,
  );
  return rows[0];
}

function hasSearchPathPin(proc: ProcRow | undefined): boolean {
  return !!proc?.proconfig?.some((c) => c.startsWith('search_path='));
}

describe('PR-RLS-FN: RLS helper search_path hardening', () => {
  beforeEach(async () => {
    await clearAuthContext();
  });

  describe('public.enforce_subcoach_head_cap()', () => {
    it('exists and pins search_path', async () => {
      const proc = await getProc('public', 'enforce_subcoach_head_cap');
      expect(proc).toBeDefined();
      expect(proc!.rettype).toBe('trigger');
      expect(proc!.args).toBe('');
      expect(hasSearchPathPin(proc)).toBe(true);
    });

    it('allows up to 2 head-coach assignments and rejects the 3rd', async () => {
      await prisma.$executeRawUnsafe('DELETE FROM public."TeamSubCoachAssignment"');
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('a1','subX',NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('a2','subX',NULL)`,
      );
      await expectRaises(
        `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('a3','subX',NULL)`,
        /sub_coach_head_cap_exceeded/,
      );
    });

    it('does not count archived rows toward the cap', async () => {
      await prisma.$executeRawUnsafe('DELETE FROM public."TeamSubCoachAssignment"');
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('b1','subY',NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('b2','subY',NULL)`,
      );
      // An archived 3rd row bypasses the cap (NEW.archived_at IS NOT NULL → RETURN NEW).
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO public."TeamSubCoachAssignment"("id","sub_coach_id","archived_at") VALUES ('b3','subY', now())`,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('app.current_user_id()', () => {
    it('exists and pins search_path', async () => {
      const proc = await getProc('app', 'current_user_id');
      expect(proc).toBeDefined();
      expect(proc!.rettype).toBe('text');
      expect(proc!.args).toBe('');
      expect(hasSearchPathPin(proc)).toBe(true);
    });

    it('returns the GUC value, and NULL when unset/empty', async () => {
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','u_42',false)`);
      const set = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT app.current_user_id() AS v`);
      expect(set[0].v).toBe('u_42');
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','',false)`);
      const empty = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT app.current_user_id() AS v`);
      expect(empty[0].v).toBeNull();
    });
  });

  describe('app.current_user_role()', () => {
    it('exists and pins search_path', async () => {
      const proc = await getProc('app', 'current_user_role');
      expect(proc).toBeDefined();
      expect(proc!.rettype).toBe('text');
      expect(proc!.args).toBe('');
      expect(hasSearchPathPin(proc)).toBe(true);
    });

    it('returns the GUC value, and NULL when unset/empty', async () => {
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role','owner',false)`);
      const set = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT app.current_user_role() AS v`);
      expect(set[0].v).toBe('owner');
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role','',false)`);
      const empty = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT app.current_user_role() AS v`);
      expect(empty[0].v).toBeNull();
    });
  });

  describe('app.is_owner()', () => {
    it('exists and pins search_path', async () => {
      const proc = await getProc('app', 'is_owner');
      expect(proc).toBeDefined();
      expect(proc!.rettype).toBe('boolean');
      expect(proc!.args).toBe('');
      expect(hasSearchPathPin(proc)).toBe(true);
    });

    it('is true only for an authenticated owner', async () => {
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','u_owner',false)`);
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role','owner',false)`);
      const owner = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_owner() AS v`);
      expect(owner[0].v).toBe(true);

      // Wrong role → false.
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role','student',false)`);
      const student = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_owner() AS v`);
      expect(student[0].v).toBe(false);

      // No id → false even if role says owner.
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','',false)`);
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_role','owner',false)`);
      const noId = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_owner() AS v`);
      expect(noId[0].v).toBe(false);
    });
  });

  describe('app.is_current_coach_of(text)', () => {
    it('exists and pins search_path', async () => {
      const proc = await getProc('app', 'is_current_coach_of');
      expect(proc).toBeDefined();
      expect(proc!.rettype).toBe('boolean');
      expect(proc!.args).toBe('client_user_id text');
      expect(hasSearchPathPin(proc)).toBe(true);
    });

    it('is true only when the current user coaches the given client', async () => {
      await prisma.$executeRawUnsafe('DELETE FROM public."User"');
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."User"("id","coach_id","role") VALUES ('clientA','coach1','student'), ('clientB','coach2','student')`,
      );
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','coach1',false)`);
      const own = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_current_coach_of('clientA') AS v`);
      expect(own[0].v).toBe(true);
      const other = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_current_coach_of('clientB') AS v`);
      expect(other[0].v).toBe(false);

      // Unauthenticated → false.
      await prisma.$executeRawUnsafe(`SELECT set_config('app.current_user_id','',false)`);
      const anon = await prisma.$queryRawUnsafe<{ v: boolean }[]>(`SELECT app.is_current_coach_of('clientA') AS v`);
      expect(anon[0].v).toBe(false);
    });
  });

  it('all five helpers carry a pinned search_path in pg_proc.proconfig', async () => {
    const targets: Array<[string, string]> = [
      ['public', 'enforce_subcoach_head_cap'],
      ['app', 'current_user_id'],
      ['app', 'current_user_role'],
      ['app', 'is_owner'],
      ['app', 'is_current_coach_of'],
    ];
    for (const [schema, name] of targets) {
      const proc = await getProc(schema, name);
      expect(proc).toBeDefined();
      expect(hasSearchPathPin(proc)).toBe(true);
    }
  });
});
