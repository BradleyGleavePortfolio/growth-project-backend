/**
 * R2a — AI processing consent ledger: live RLS + append-only proof.
 *
 * Runs against a REAL PostgreSQL (no mocks) and applies
 * prisma/migrations/20270203000000_ai_processing_consent_ledger/migration.sql
 * verbatim, then proves for "AiProcessingConsentEvent":
 *   - RLS ENABLED + FORCED; the policy set is exactly service_role_all,
 *     select_self and the anon RESTRICTIVE deny; no policy references
 *     app.is_owner() or any coach helper (Sol A-R2-4 applied to this table);
 *   - a client reads only their own rows; a stranger, the client's own coach,
 *     the application owner role and an identity-less request read zero;
 *   - anon has no table privilege, and even with one the RESTRICTIVE deny
 *     returns zero rows;
 *   - no non-service principal can INSERT (own or forged user_id), UPDATE or
 *     DELETE;
 *   - append-only: UPDATE is rejected by the trigger for service_role AND the
 *     table owner (superuser); DELETE remains possible only for privileged
 *     roles and through the User FK cascade (account erasure);
 *   - CHECK constraints (action, seq, sha256 shape) and the unique
 *     (user_id, processor, purpose, seq) index that serialises writers;
 *   - down.sql removes the table and trigger function, and the migration
 *     re-applies cleanly.
 *
 * Principals: `SET LOCAL ROLE <role>` + the app.current_user_id /
 * app.current_user_role GUCs the helper functions read (same model as
 * test/rls/roman-rls.spec.ts). `authenticated` (Supabase shim role, NOBYPASSRLS)
 * stands for an RLS-bound request; `service_role` (BYPASSRLS) for the server.
 *
 * CI: the rls-live-tests job runs this file after the Supabase shim, the
 * RLS-01 bootstrap and the hardened helper migration (so the policies are
 * evaluated against the real app.current_user_id()). The bootstrap below only
 * fills in what is missing, so the file also runs on an empty throwaway DB.
 *
 * Gate: TEST_DATABASE_URL (set by the rls-live-tests job). No URL -> skip, except
 * under CI=true where a missing URL is a hard failure (no green-by-skip). URL
 * set but unreachable -> hard failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const MIGRATION_DIR = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20270203000000_ai_processing_consent_ledger',
);
const TABLE = 'AiProcessingConsentEvent';
const SHA = 'd8738c900ed2bfbb12b7ca6423132a532fc47e2cd0fe52854cc38e34c427840f';

// Not DATABASE_URL: test/jest.setup.ts always sets a placeholder DATABASE_URL.
const RAW_URL = liveTestDatabaseUrl();
if (!RAW_URL && process.env.CI === 'true') {
  throw new Error(
    '[R2a] ai-processing-consent-ledger-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.',
  );
}
const URL_WITH_LIMIT = !RAW_URL
  ? ''
  : RAW_URL.includes('connection_limit=')
    ? RAW_URL
    : RAW_URL + (RAW_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const AUTHED = 'authenticated';
const SERVICE = 'service_role';

// Fill in only what a fresh DB lacks. In the CI job the shim, the RLS-01
// bootstrap and the hardened helpers already exist and are NOT replaced.
const PREREQ_SQL = `
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $do$;
CREATE SCHEMA IF NOT EXISTS app;
DO $do$ BEGIN
  IF to_regprocedure('app.current_user_id()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT NULLIF(current_setting(''app.current_user_id'', true), '''')'$f$;
  END IF;
  IF to_regprocedure('app.current_user_role()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT NULLIF(current_setting(''app.current_user_role'', true), '''')'$f$;
  END IF;
END $do$;
CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "role" text NOT NULL DEFAULT 'coach',
  "coach_id" text
);
GRANT USAGE ON SCHEMA app TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;

/** Top-level statement splitter honouring dollar quotes and single quotes. */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingle = false;
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
    if (inSingle) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += sql[i];
          i += 1;
        } else inSingle = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      i = end;
      buf += '\n';
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const describeLive = URL_WITH_LIMIT ? describe : describe.skip;

describeLive('AiProcessingConsentEvent RLS + append-only (live Postgres, R2a)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL_WITH_LIMIT } } });

  type Tx = {
    $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
  };

  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

  async function applyScript(sql: string): Promise<void> {
    for (const stmt of splitSqlStatements(sql)) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
      await prisma.$executeRawUnsafe(stmt);
    }
  }

  async function asPrincipal<T>(
    role: string | null,
    identity: { id?: string; userRole?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', ${lit(identity.id ?? '')}, true)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_role', ${lit(identity.userRole ?? '')}, true)`,
      );
      return fn(tx);
    });
  }

  /** SQLSTATE of a failed raw query (Prisma P2010 message carries it). */
  function sqlState(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501|55000|23505|23514|23503)\b/.exec(msg);
    return m ? m[1] : `unparsed: ${msg.slice(0, 200)}`;
  }

  async function failsWith(
    role: string | null,
    identity: { id?: string; userRole?: string },
    stmt: string,
  ): Promise<string | null> {
    try {
      await asPrincipal(role, identity, (tx) => tx.$executeRawUnsafe(stmt));
      return null;
    } catch (err) {
      return sqlState(err);
    }
  }

  async function count(
    role: string | null,
    identity: { id?: string; userRole?: string },
    where = '',
  ): Promise<number> {
    const rows = (await asPrincipal(role, identity, (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM public."${TABLE}" ${where}`),
    )) as { n: number }[];
    return Number(rows[0].n);
  }

  async function affected(
    role: string | null,
    identity: { id?: string; userRole?: string },
    stmt: string,
  ): Promise<number> {
    return asPrincipal(role, identity, (tx) => tx.$executeRawUnsafe(stmt));
  }

  const CLIENT_A = { id: 'r2a_client_a', userRole: 'student' };
  const CLIENT_B = { id: 'r2a_client_b', userRole: 'student' };
  const COACH = { id: 'r2a_coach', userRole: 'coach' };
  const OWNER = { id: 'r2a_owner', userRole: 'owner' };
  const NO_IDENTITY = {};

  const insertEvent = (id: string, user: string, seq: number, action = 'grant'): string =>
    `INSERT INTO public."${TABLE}"("id","user_id","processor","purpose","seq","action","consent_version","copy_sha256")
       VALUES (${lit(id)}, ${lit(user)}, 'anthropic', 'client_ai_processing', ${seq}, ${lit(action)}, 'client-ai-v3', ${lit(SHA)})`;

  async function installMigration(): Promise<void> {
    await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8'));
    // Supabase grants table privileges to API roles by default; a bare CI
    // Postgres does not. Grant them so the assertions test POLICIES, not the
    // absence of a GRANT. anon stays revoked (the migration revokes it).
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${TABLE}" TO ${AUTHED}, ${SERVICE}`,
    );
  }

  beforeAll(async () => {
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      throw new Error(
        `[R2a] TEST_DATABASE_URL is set but unreachable: ${sqlState(err)}`,
      );
    }
    await applyScript(PREREQ_SQL);
    await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8'));
    await installMigration();
  }, 120_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'r2a\\_%'`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Removing our users cascades their ledger rows (FK ON DELETE CASCADE).
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'r2a\\_%'`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","role","coach_id") VALUES
         ('r2a_coach','coach',NULL),
         ('r2a_owner','owner',NULL),
         ('r2a_client_a','student','r2a_coach'),
         ('r2a_client_b','student','r2a_coach')`,
    );
    await asPrincipal(SERVICE, {}, async (tx) => {
      await tx.$executeRawUnsafe(insertEvent('r2a_e_a1', 'r2a_client_a', 1, 'grant'));
      await tx.$executeRawUnsafe(insertEvent('r2a_e_a2', 'r2a_client_a', 2, 'withdraw'));
      await tx.$executeRawUnsafe(insertEvent('r2a_e_b1', 'r2a_client_b', 1, 'grant'));
      return null;
    });
  });

  describe('catalog', () => {
    it('RLS is enabled and forced', async () => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."${TABLE}"'::regclass`,
      )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('declares exactly the three expected policies, none with an owner or coach branch', async () => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT policyname, permissive, roles::text[] AS roles, cmd, coalesce(qual,'') AS qual, coalesce(with_check,'') AS with_check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
        TABLE,
      )) as { policyname: string; permissive: string; roles: string[]; cmd: string; qual: string; with_check: string }[];
      expect(rows.map((r) => [r.policyname, r.permissive, r.cmd, r.roles])).toEqual([
        ['deny_all_anon_aiprocessingconsentevent', 'RESTRICTIVE', 'ALL', ['anon']],
        ['p_aiprocessingconsentevent_select_self', 'PERMISSIVE', 'SELECT', ['public']],
        ['p_aiprocessingconsentevent_service_role_all', 'PERMISSIVE', 'ALL', ['service_role']],
      ]);
      for (const r of rows) {
        expect(`${r.qual} ${r.with_check}`).not.toMatch(/is_owner|coach|team|sub_coach/i);
      }
    });

    it('binds the append-only trigger', async () => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public."${TABLE}"'::regclass AND NOT tgisinternal`,
      )) as { tgname: string }[];
      expect(rows.map((r) => r.tgname)).toEqual(['AiProcessingConsentEvent_append_only']);
    });
  });

  describe('reads', () => {
    it('a client reads exactly their own rows', async () => {
      expect(await count(AUTHED, CLIENT_A)).toBe(2);
      expect(await count(AUTHED, CLIENT_A, `WHERE "user_id" = 'r2a_client_a'`)).toBe(2);
    });

    it("a client reads none of another client's rows", async () => {
      expect(await count(AUTHED, CLIENT_A, `WHERE "user_id" = 'r2a_client_b'`)).toBe(0);
      expect(await count(AUTHED, CLIENT_B)).toBe(1);
    });

    it("the client's own coach reads zero rows", async () => {
      expect(await count(AUTHED, COACH)).toBe(0);
    });

    it('the application owner role reads zero rows (A-R2-4)', async () => {
      expect(await count(AUTHED, OWNER)).toBe(0);
    });

    it('a request with no identity reads zero rows', async () => {
      expect(await count(AUTHED, NO_IDENTITY)).toBe(0);
    });

    it('service_role reads all rows (server path)', async () => {
      expect(await count(SERVICE, {}, `WHERE "user_id" LIKE 'r2a\\_%'`)).toBe(3);
    });

    it('anon has no table privilege', async () => {
      expect(await failsWith('anon', NO_IDENTITY, `SELECT 1 FROM public."${TABLE}"`)).toBe('42501');
    });

    it('anon reads zero rows even if a privilege were granted (RESTRICTIVE deny)', async () => {
      await prisma.$executeRawUnsafe(`GRANT SELECT ON public."${TABLE}" TO anon`);
      try {
        // Either outcome is a denial: zero rows (RESTRICTIVE false) or 42501
        // (anon may not EXECUTE the hardened app.* helpers the permissive
        // policy calls). Rows are never returned.
        let outcome: number | string;
        try {
          outcome = await count('anon', CLIENT_A);
        } catch (err) {
          outcome = sqlState(err);
        }
        expect([0, '42501']).toContain(outcome);
      } finally {
        await prisma.$executeRawUnsafe(`REVOKE ALL ON public."${TABLE}" FROM anon`);
      }
    });
  });

  describe('writes by non-service principals', () => {
    it('a client cannot INSERT their own row (server is the only writer)', async () => {
      expect(await failsWith(AUTHED, CLIENT_A, insertEvent('r2a_x1', 'r2a_client_a', 3))).toBe('42501');
    });

    it("a client cannot INSERT a row for another user", async () => {
      expect(await failsWith(AUTHED, CLIENT_A, insertEvent('r2a_x2', 'r2a_client_b', 2))).toBe('42501');
    });

    it('a coach cannot INSERT a row for their client', async () => {
      expect(await failsWith(AUTHED, COACH, insertEvent('r2a_x3', 'r2a_client_a', 3))).toBe('42501');
    });

    it('a client UPDATE affects zero rows and changes nothing', async () => {
      expect(
        await affected(AUTHED, CLIENT_A, `UPDATE public."${TABLE}" SET "action" = 'grant' WHERE "id" = 'r2a_e_a2'`),
      ).toBe(0);
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT "action" FROM public."${TABLE}" WHERE "id" = 'r2a_e_a2'`,
      )) as { action: string }[];
      expect(rows[0].action).toBe('withdraw');
    });

    it('a client DELETE affects zero rows', async () => {
      expect(await affected(AUTHED, CLIENT_A, `DELETE FROM public."${TABLE}" WHERE "user_id" = 'r2a_client_a'`)).toBe(0);
      expect(await count(SERVICE, {}, `WHERE "user_id" = 'r2a_client_a'`)).toBe(2);
    });
  });

  describe('append-only and integrity', () => {
    it('service_role UPDATE is rejected by the trigger', async () => {
      expect(
        await failsWith(SERVICE, {}, `UPDATE public."${TABLE}" SET "action" = 'grant' WHERE "id" = 'r2a_e_a2'`),
      ).toBe('55000');
    });

    it('the table owner (superuser) UPDATE is rejected by the trigger', async () => {
      expect(
        await failsWith(null, {}, `UPDATE public."${TABLE}" SET "consent_version" = 'x' WHERE "id" = 'r2a_e_a1'`),
      ).toBe('55000');
    });

    it('service_role can append the next seq', async () => {
      expect(await failsWith(SERVICE, {}, insertEvent('r2a_e_a3', 'r2a_client_a', 3, 'grant'))).toBeNull();
    });

    it('a duplicate seq for the same user/processor/purpose is rejected (writer serialisation)', async () => {
      expect(await failsWith(SERVICE, {}, insertEvent('r2a_dup', 'r2a_client_a', 2, 'grant'))).toBe('23505');
    });

    it.each([
      ['an unknown action', `'maybe'`, '9', `'${SHA}'`],
      ['seq 0', `'grant'`, '0', `'${SHA}'`],
      ['a non-hex sha256', `'grant'`, '5', `'${'Z'.repeat(64)}'`],
      ['an uppercase sha256', `'grant'`, '5', `'${SHA.toUpperCase()}'`],
    ])('CHECK rejects %s', async (_l, action, seq, sha) => {
      expect(
        await failsWith(
          SERVICE,
          {},
          `INSERT INTO public."${TABLE}"("id","user_id","processor","purpose","seq","action","consent_version","copy_sha256")
             VALUES ('r2a_chk','r2a_client_a','anthropic','client_ai_processing',${seq},${action},'client-ai-v3',${sha})`,
        ),
      ).toBe('23514');
    });

    it('a row for a non-existent user is rejected (FK)', async () => {
      expect(await failsWith(SERVICE, {}, insertEvent('r2a_fk', 'r2a_ghost', 1))).toBe('23503');
    });

    it("deleting the user (account erasure) cascades their ledger rows", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" = 'r2a_client_a'`);
      expect(await count(SERVICE, {}, `WHERE "user_id" = 'r2a_client_a'`)).toBe(0);
      expect(await count(SERVICE, {}, `WHERE "user_id" = 'r2a_client_b'`)).toBe(1);
    });
  });

  describe('down / up', () => {
    it('down.sql removes the table and trigger function; the migration re-applies', async () => {
      await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8'));
      const gone = (await prisma.$queryRawUnsafe(
        `SELECT to_regclass('public."${TABLE}"') IS NULL AS t,
                to_regprocedure('public.ai_processing_consent_event_reject_update()') IS NULL AS f`,
      )) as { t: boolean; f: boolean }[];
      expect(gone[0]).toEqual({ t: true, f: true });
      await installMigration();
      expect(await count(SERVICE, {})).toBe(0);
      expect(await count(AUTHED, OWNER)).toBe(0);
    });
  });
});
