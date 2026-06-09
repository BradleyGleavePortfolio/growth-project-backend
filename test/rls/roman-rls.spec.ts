/**
 * Roman Phase 1 — RLS policies (HECTACORN security gate).
 *
 * Verifies migration 20261216000000_add_roman_chat against a REAL PostgreSQL
 * instance (NO mocks). For the two Roman tables it proves:
 *   - RLS is ENABLED *and* FORCED (relrowsecurity / relforcerowsecurity).
 *   - The expected per-command policies exist.
 *   - service_role bypasses (Primitive A).
 *   - Owner-self read/write of own sessions + messages.
 *   - Cross-user denial (IDOR): user A cannot read user B's sessions/messages.
 *   - Platform `owner` role reads everything (app.is_owner()).
 *   - anon zero-access (no GUCs -> helpers NULL).
 *   - INSERT with a mismatched user_id is rejected by the WITH CHECK.
 *   - RomanMessage defence-in-depth: a forged user_id OR a foreign session_id is
 *     rejected on both SELECT (invisible) and INSERT (denied).
 *
 * Principals are modeled with Postgres roles + the `app.current_user_id` /
 * `app.current_user_role` GUCs the helper functions read:
 *   - `service_role`        -> Primitive A bypass path.
 *   - `app_authenticated`   -> the `TO public` policy bucket (a normal request).
 *   - anon                  -> `app_authenticated` with empty GUCs (helpers NULL).
 *
 * The suite is self-bootstrapping and idempotent: it (re)creates the minimal
 * prerequisite schema (app.* helpers, public."User", the two Roman tables) and
 * applies the migration SQL exactly as Prisma would, then asserts. Re-running
 * is clean.
 *
 * Connection: RLS_ROMAN_TEST_DATABASE_URL > RLS_FN_TEST_DATABASE_URL >
 * DATABASE_URL, defaulting to the local throwaway `rls_fn_test` DB. The
 * PrismaClient is constructed against that URL via `datasources` so it never
 * touches the app's default database or production Supabase.
 *
 * Pattern cloned from test/rls-b5-contracts-policies.spec.ts (verified working).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261216000000_add_roman_chat',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_ROMAN_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

// Minimal prerequisite schema: the app helper functions (mirrors PR-RLS-FN) and
// public."User" with only the columns the policies + FKs read. The Roman tables
// themselves are created by the migration SQL under test.
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
`;

const ALL_TABLES = ['RomanSession', 'RomanMessage'];

/**
 * Split a SQL file into top-level statements honoring dollar-quoted blocks and
 * single-quoted literals. Mirrors the PR-RLS-FN / B5 spec splitter.
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

type Tx = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
};

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

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

async function seed(stmts: string[]): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
    return null;
  });
}

async function truncateAll(): Promise<void> {
  await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
    await tx.$executeRawUnsafe(
      `TRUNCATE public."RomanMessage", public."RomanSession",
              public."User" RESTART IDENTITY CASCADE`,
    );
    return null;
  });
}

type RelSecRow = {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};

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

// Canonical identities.
const OWNER = { id: 'u_owner', userRole: 'owner' };
const USER_A = { id: 'u_a', userRole: 'student' };
const USER_B = { id: 'u_b', userRole: 'student' };
const ANON = {}; // no GUCs -> helpers return NULL

beforeAll(async () => {
  await prisma.$connect();
  try {
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA app TO anon, ${AUTHED_ROLE}, ${SERVICE_ROLE}`,
    );
  } catch {
    /* grant may already exist or role naming differs; harness handles it */
  }
  // Idempotent bootstrap: drop any Roman objects left behind by a prior run so
  // the migration's CREATE TYPE / CREATE TABLE statements apply cleanly. The
  // migration SQL itself is non-idempotent (as Prisma emits it); the test
  // harness owns the throwaway DB and resets it here.
  await applyScript(`
    DROP TABLE IF EXISTS public."RomanMessage" CASCADE;
    DROP TABLE IF EXISTS public."RomanSession" CASCADE;
    DROP TYPE  IF EXISTS "RomanMessageRole" CASCADE;
    DROP TYPE  IF EXISTS "RomanSurface" CASCADE;
  `);
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  for (const t of ALL_TABLES) {
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
  // Two ordinary users (students) plus a platform owner. user A and user B are
  // strangers — neither should ever see the other's sessions or messages.
  await seed([
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('u_owner', NULL, 'owner'),
       ('u_a', NULL, 'student'),
       ('u_b', NULL, 'student')`,
    // A session owned by A and a session owned by B, each with one message.
    `INSERT INTO public."RomanSession"("id","user_id","surface","day_key","updated_at")
       VALUES ('sess_a','u_a','client','2026-06-09', CURRENT_TIMESTAMP)`,
    `INSERT INTO public."RomanSession"("id","user_id","surface","day_key","updated_at")
       VALUES ('sess_b','u_b','client','2026-06-09', CURRENT_TIMESTAMP)`,
    `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
       VALUES ('msg_a','sess_a','u_a','user','hello from A')`,
    `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
       VALUES ('msg_b','sess_b','u_b','user','hello from B')`,
  ]);
});

// ---------------------------------------------------------------------------
// 1) RomanSession — owner-self scope
// ---------------------------------------------------------------------------
describe('RomanSession (owner-self scope)', () => {
  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('RomanSession');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected policies', async () => {
    const names = await policyNames('RomanSession');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_romansession_service_role_all',
        'p_romansession_select',
        'p_romansession_insert',
        'p_romansession_update',
      ]),
    );
  });

  it('owner-of-row reads their own session', async () => {
    expect(await visibleCount(AUTHED_ROLE, USER_A, 'RomanSession', 'sess_a')).toBe(1);
  });

  it('user A CANNOT read user B\u2019s session (IDOR denied)', async () => {
    expect(await visibleCount(AUTHED_ROLE, USER_A, 'RomanSession', 'sess_b')).toBe(0);
    // And the reverse, for symmetry.
    expect(await visibleCount(AUTHED_ROLE, USER_B, 'RomanSession', 'sess_a')).toBe(0);
  });

  it('platform owner reads ALL sessions (app.is_owner())', async () => {
    expect(await visibleCount(AUTHED_ROLE, OWNER, 'RomanSession')).toBe(2);
  });

  it('anon (no GUCs) reads zero sessions', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'RomanSession')).toBe(0);
  });

  it('a user can INSERT a session they own', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanSession"("id","user_id","surface","day_key","updated_at")
           VALUES ('sess_a2','u_a','coach','2026-06-10', CURRENT_TIMESTAMP)`),
    ).toBe(true);
  });

  it('a user CANNOT INSERT a session with a mismatched user_id (forged owner rejected)', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanSession"("id","user_id","surface","day_key","updated_at")
           VALUES ('sess_hax','u_b','client','2026-06-11', CURRENT_TIMESTAMP)`),
    ).toBe(false);
  });

  it('a user can soft-delete (UPDATE deleted_at) their OWN session', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `UPDATE public."RomanSession" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "id" = 'sess_a'`),
    ).toBe(true);
  });

  it('a user\u2019s UPDATE on another user\u2019s session affects zero rows (invisible target)', async () => {
    const affected = await asPrincipal(AUTHED_ROLE, USER_A, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE public."RomanSession" SET "message_count" = 99 WHERE "id" = 'sess_b'`,
      ),
    );
    expect(Number(affected)).toBe(0);
  });

  it('service_role bypasses RLS for session reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'RomanSession', 'sess_b')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2) RomanMessage — owner-self scope with defence-in-depth (session join)
// ---------------------------------------------------------------------------
describe('RomanMessage (owner-self + defence-in-depth)', () => {
  it('is RLS enabled and forced', async () => {
    const rel = await getRelSecurity('RomanMessage');
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
  });

  it('declares the expected policies', async () => {
    const names = await policyNames('RomanMessage');
    expect(names).toEqual(
      expect.arrayContaining([
        'p_romanmessage_service_role_all',
        'p_romanmessage_select',
        'p_romanmessage_insert',
      ]),
    );
  });

  it('owner-of-row reads their own message', async () => {
    expect(await visibleCount(AUTHED_ROLE, USER_A, 'RomanMessage', 'msg_a')).toBe(1);
  });

  it('user A CANNOT read user B\u2019s message (IDOR denied)', async () => {
    expect(await visibleCount(AUTHED_ROLE, USER_A, 'RomanMessage', 'msg_b')).toBe(0);
    expect(await visibleCount(AUTHED_ROLE, USER_B, 'RomanMessage', 'msg_a')).toBe(0);
  });

  it('platform owner reads ALL messages (app.is_owner())', async () => {
    expect(await visibleCount(AUTHED_ROLE, OWNER, 'RomanMessage')).toBe(2);
  });

  it('anon (no GUCs) reads zero messages', async () => {
    expect(await visibleCount(AUTHED_ROLE, ANON, 'RomanMessage')).toBe(0);
  });

  it('a user can INSERT a message into their OWN session with their OWN user_id', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
           VALUES ('msg_a2','sess_a','u_a','roman','reply to A')`),
    ).toBe(true);
  });

  it('defence-in-depth: a forged user_id (own session) is rejected on INSERT', async () => {
    // Correct session ownership, but user_id column forged to another user.
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
           VALUES ('msg_hax1','sess_a','u_b','user','forged user_id')`),
    ).toBe(false);
  });

  it('defence-in-depth: appending to a FOREIGN session is rejected on INSERT (even with own user_id)', async () => {
    // user_id = self, but the parent session belongs to user B.
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
           VALUES ('msg_hax2','sess_b','u_a','user','foreign session')`),
    ).toBe(false);
  });

  it('defence-in-depth: BOTH forged user_id AND foreign session is rejected on INSERT', async () => {
    expect(
      await writeSucceeds(AUTHED_ROLE, USER_A,
        `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
           VALUES ('msg_hax3','sess_b','u_b','user','fully forged')`),
    ).toBe(false);
  });

  it('defence-in-depth on SELECT: a message whose session belongs to another user stays invisible', async () => {
    // service_role plants a message that points at sess_b but carries u_a's
    // user_id (a forged/legacy row). The SELECT policy still hides it from A
    // because the parent session.user_id is u_b, not u_a.
    await seed([
      `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content")
         VALUES ('msg_mismatch','sess_b','u_a','user','mismatched row')`,
    ]);
    expect(
      await visibleCount(AUTHED_ROLE, USER_A, 'RomanMessage', 'msg_mismatch'),
    ).toBe(0);
    // service_role still sees it (bypass).
    expect(
      await visibleCount(SERVICE_ROLE, {}, 'RomanMessage', 'msg_mismatch'),
    ).toBe(1);
  });

  it('service_role can INSERT any message (Primitive A bypass — persistence path)', async () => {
    expect(
      await writeSucceeds(SERVICE_ROLE, {},
        `INSERT INTO public."RomanMessage"("id","session_id","user_id","role","content","interrupted")
           VALUES ('msg_svc','sess_a','u_a','roman','server-persisted',false)`),
    ).toBe(true);
  });

  it('service_role bypasses RLS for message reads', async () => {
    expect(await visibleCount(SERVICE_ROLE, {}, 'RomanMessage', 'msg_b')).toBe(1);
  });
});
