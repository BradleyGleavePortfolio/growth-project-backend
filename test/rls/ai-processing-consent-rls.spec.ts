/**
 * R2 — AiProcessingConsent RLS, LIVE behaviour (Sol audit of #601, finding C1).
 *
 * The unit spec asserts the migration's SQL text; this suite proves the
 * policies against a REAL PostgreSQL (no mocks), with the same principal model
 * as test/rls/roman-rls.spec.ts:
 *   - RLS ENABLED and FORCED on "AiProcessingConsent";
 *   - service_role bypass (Primitive A);
 *   - self reads/inserts/updates own row; another student, and the client's
 *     COACH, see zero rows (a coach never reads a client's consent here);
 *   - platform owner reads all; anon (no GUCs) reads zero;
 *   - forged user_id on INSERT and on UPDATE (re-owning) is rejected;
 *   - no non-service DELETE (revocation is an UPDATE that sets revoked_at);
 *   - ON DELETE CASCADE from "User" removes the row; down.sql drops the table
 *     cleanly and the migration re-applies (forward/reverse/forward).
 *
 * Connection: RLS_ROMAN_TEST_DATABASE_URL > RLS_FN_TEST_DATABASE_URL >
 * DATABASE_URL, defaulting to the local throwaway `rls_fn_test` DB. Runs only
 * under jest.rls.config.js (the default suite ignores test/rls/).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_DIR = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20270201000000_ai_processing_consent',
);
const MIGRATION_SQL_PATH = path.join(MIGRATION_DIR, 'migration.sql');
const DOWN_SQL_PATH = path.join(MIGRATION_DIR, 'down.sql');

const TEST_DB_URL =
  process.env.RLS_ROMAN_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test';

const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

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

const TABLE = 'AiProcessingConsent';

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
      `TRUNCATE public."AiProcessingConsent", public."User" RESTART IDENTITY CASCADE`,
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
const COACH = { id: 'u_coach', userRole: 'coach' };
const USER_A = { id: 'u_a', userRole: 'student' }; // client of u_coach
const USER_B = { id: 'u_b', userRole: 'student' };
const ANON = {};

const ROW = (id: string, user: string) =>
  `INSERT INTO public."${TABLE}"("id","user_id","processor","purpose","consent_version","granted_at")
     VALUES ('${id}','${user}','anthropic','client_ai_processing','client-ai-v2', CURRENT_TIMESTAMP)`;

beforeAll(async () => {
  await prisma.$connect();
  try {
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA app TO anon, ${AUTHED_ROLE}, ${SERVICE_ROLE}`,
    );
  } catch {
    /* grant may already exist or role naming differs; harness handles it */
  }
  await applyScript(`DROP TABLE IF EXISTS public."${TABLE}" CASCADE;`);
  await applyScript(PREREQ_SQL);
  await applyScript(fs.readFileSync(MIGRATION_SQL_PATH, 'utf8'));
  const rel = await getRelSecurity(TABLE);
  if (!rel || !rel.relrowsecurity || !rel.relforcerowsecurity) {
    throw new Error(`bootstrap incomplete: ${TABLE} is not RLS enabled+forced`);
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  await seed([
    `INSERT INTO public."User"("id","coach_id","role") VALUES
       ('u_owner', NULL, 'owner'),
       ('u_coach', NULL, 'coach'),
       ('u_a', 'u_coach', 'student'),
       ('u_b', NULL, 'student')`,
    ROW('c_a', 'u_a'),
    ROW('c_b', 'u_b'),
  ]);
});

describe('AiProcessingConsent — live RLS', () => {
  it('is RLS enabled and forced, with the expected policies', async () => {
    const rel = await getRelSecurity(TABLE);
    expect(rel?.relrowsecurity).toBe(true);
    expect(rel?.relforcerowsecurity).toBe(true);
    expect(await policyNames(TABLE)).toEqual(
      expect.arrayContaining([
        'p_aiprocessingconsent_service_role_all',
        'p_aiprocessingconsent_select',
        'p_aiprocessingconsent_insert',
        'p_aiprocessingconsent_update',
        'deny_all_anon_aiprocessingconsent',
      ]),
    );
    // No DELETE policy for non-service principals.
    const polcmds = (await prisma.$queryRawUnsafe(
      `SELECT pol.polcmd::text AS cmd, pol.polroles::text AS roles
         FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
        WHERE c.relname = $1`,
      TABLE,
    )) as { cmd: string; roles: string }[];
    expect(polcmds.filter((p) => p.cmd === 'd')).toHaveLength(0);
  });

  it('self reads own row; another student and the client\u2019s COACH read zero', async () => {
    expect(await visibleCount(AUTHED_ROLE, USER_A, TABLE, 'c_a')).toBe(1);
    expect(await visibleCount(AUTHED_ROLE, USER_B, TABLE, 'c_a')).toBe(0);
    expect(await visibleCount(AUTHED_ROLE, COACH, TABLE)).toBe(0);
  });

  it('platform owner reads all; anon reads zero; service_role reads all', async () => {
    expect(await visibleCount(AUTHED_ROLE, OWNER, TABLE)).toBe(2);
    expect(await visibleCount(AUTHED_ROLE, ANON, TABLE)).toBe(0);
    expect(await visibleCount(SERVICE_ROLE, {}, TABLE)).toBe(2);
  });

  it('self can INSERT own row; forged user_id INSERT is rejected (student, coach, anon)', async () => {
    await asPrincipal(SERVICE_ROLE, {}, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM public."${TABLE}" WHERE "id" = 'c_a'`),
    );
    expect(await writeSucceeds(AUTHED_ROLE, USER_A, ROW('c_a2', 'u_a'))).toBe(true);
    expect(await writeSucceeds(AUTHED_ROLE, USER_B, ROW('c_forged', 'u_a'))).toBe(false);
    expect(await writeSucceeds(AUTHED_ROLE, COACH, ROW('c_forged2', 'u_a'))).toBe(false);
    expect(await writeSucceeds(AUTHED_ROLE, ANON, ROW('c_forged3', 'u_a'))).toBe(false);
  });

  it('self can revoke (UPDATE revoked_at) own row; another user\u2019s UPDATE touches zero rows; re-owning is rejected', async () => {
    expect(
      await writeSucceeds(
        AUTHED_ROLE,
        USER_A,
        `UPDATE public."${TABLE}" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "id" = 'c_a'`,
      ),
    ).toBe(true);
    const revoked = (await asPrincipal(SERVICE_ROLE, {}, (tx) =>
      tx.$queryRawUnsafe(`SELECT "revoked_at" FROM public."${TABLE}" WHERE "id" = 'c_a'`),
    )) as { revoked_at: Date | null }[];
    expect(revoked[0].revoked_at).not.toBeNull();
    // B tries to revoke A's row: invisible → 0 rows affected, A's row unchanged.
    const affected = await asPrincipal(AUTHED_ROLE, USER_B, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE public."${TABLE}" SET "revoked_at" = NULL WHERE "id" = 'c_a'`,
      ),
    );
    expect(affected).toBe(0);
    // A tries to re-own their row to B: WITH CHECK rejects.
    expect(
      await writeSucceeds(
        AUTHED_ROLE,
        USER_A,
        `UPDATE public."${TABLE}" SET "user_id" = 'u_b' WHERE "id" = 'c_a'`,
      ),
    ).toBe(false);
  });

  it('no non-service DELETE: self, other, coach, owner and anon delete zero rows; service_role can', async () => {
    for (const who of [USER_A, USER_B, COACH, OWNER, ANON]) {
      let affected = 0;
      try {
        affected = await asPrincipal(AUTHED_ROLE, who, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM public."${TABLE}" WHERE "id" = 'c_a'`),
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (!/row-level security|42501|permission denied/.test(m)) throw err;
      }
      expect(affected).toBe(0);
    }
    expect(await visibleCount(SERVICE_ROLE, {}, TABLE, 'c_a')).toBe(1);
    expect(
      await asPrincipal(SERVICE_ROLE, {}, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM public."${TABLE}" WHERE "id" = 'c_a'`),
      ),
    ).toBe(1);
  });

  it('deleting the User cascades the consent row', async () => {
    await asPrincipal(SERVICE_ROLE, {}, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" = 'u_b'`),
    );
    expect(await visibleCount(SERVICE_ROLE, {}, TABLE, 'c_b')).toBe(0);
  });

  it('down.sql drops the table and the migration re-applies cleanly (forward/reverse/forward)', async () => {
    await applyScript(fs.readFileSync(DOWN_SQL_PATH, 'utf8'));
    const gone = (await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public."${TABLE}"') IS NULL AS gone`,
    )) as { gone: boolean }[];
    expect(gone[0].gone).toBe(true);
    await applyScript(fs.readFileSync(MIGRATION_SQL_PATH, 'utf8'));
    const rel = await getRelSecurity(TABLE);
    expect(rel?.relforcerowsecurity).toBe(true);
  });
});
