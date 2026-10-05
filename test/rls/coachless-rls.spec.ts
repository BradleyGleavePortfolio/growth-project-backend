/**
 * A1-COACHLESS — live RLS for FeaturedCoachConfig, CoachCodeRedemption and
 * CoachlessPromptState.
 *
 * Runs against a REAL PostgreSQL (no mocks) and applies
 * prisma/migrations/20270301000000_coachless_featured_coach/migration.sql
 * verbatim, then proves for each table:
 *   - RLS ENABLED + FORCED; the policy set is exactly service_role_all, the
 *     one SELECT policy and the anon RESTRICTIVE deny;
 *   - CoachCodeRedemption / CoachlessPromptState: a user reads only their own
 *     rows; another client, the client's own coach, the platform owner role
 *     and an identity-less request read zero (no coach or owner branch);
 *   - FeaturedCoachConfig: only the platform owner reads it through RLS;
 *     clients and coaches read zero (they get a server projection);
 *   - no non-service principal can INSERT (own or forged user_id), UPDATE or
 *     DELETE any of the three tables;
 *   - anon has no table privilege, and even with one the RESTRICTIVE deny
 *     returns zero rows;
 *   - CHECK constraints (singleton id, UUID key, status set) and the unique
 *     (user_id, idempotency_key) index hold;
 *   - deleting a User cascades its redemption and prompt rows and nulls the
 *     featured coach (account erasure);
 *   - down.sql removes the tables and the migration re-applies cleanly.
 *
 * Principals: `SET LOCAL ROLE <role>` + the app.current_user_id /
 * app.current_user_role GUCs (same model as
 * test/rls/ai-processing-consent-ledger-rls.spec.ts).
 *
 * CI: the rls-live-tests job runs this file after the Supabase shim, the
 * RLS-01 bootstrap and the hardened helper migration. The prerequisites below
 * only fill in what is missing, so the file also runs on an empty throwaway DB.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true where a
 * missing URL is a hard failure (no green-by-skip). URL set but unreachable ->
 * hard failure.
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
  '20270301000000_coachless_featured_coach',
);

const RAW_URL = process.env.TEST_DATABASE_URL || '';
if (!RAW_URL && process.env.CI === 'true') {
  throw new Error('[A1] coachless-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const URL_WITH_LIMIT = !RAW_URL
  ? ''
  : RAW_URL.includes('connection_limit=')
    ? RAW_URL
    : RAW_URL + (RAW_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const AUTHED = 'authenticated';
const SERVICE = 'service_role';
const ANON = 'anon';
const TABLES = ['FeaturedCoachConfig', 'CoachCodeRedemption', 'CoachlessPromptState'] as const;

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
  IF to_regprocedure('app.is_owner()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS 'SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = ''owner'''$f$;
  END IF;
END $do$;
CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "role" text NOT NULL DEFAULT 'coach',
  "coach_id" text
);
CREATE TABLE IF NOT EXISTS public."CoachPackage" (
  "id" text PRIMARY KEY,
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
      i = eol === -1 ? sql.length : eol + 1;
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

describeLive('A1-COACHLESS tables RLS (live Postgres)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL_WITH_LIMIT } } });

  type Tx = {
    $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
    $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
  };
  type Identity = { id?: string; userRole?: string };

  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

  async function applyScript(sql: string): Promise<void> {
    for (const stmt of splitSqlStatements(sql)) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
      await prisma.$executeRawUnsafe(stmt);
    }
  }

  async function asPrincipal<T>(
    role: string | null,
    identity: Identity,
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

  function sqlState(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501|55000|23505|23514|23503)\b/.exec(msg);
    return m ? m[1] : `unparsed: ${msg.slice(0, 200)}`;
  }

  async function failsWith(
    role: string | null,
    identity: Identity,
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
    identity: Identity,
    table: string,
    where = '',
  ): Promise<number> {
    const rows = (await asPrincipal(role, identity, (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM public."${table}" ${where}`),
    )) as { n: number }[];
    return Number(rows[0].n);
  }

  async function affected(role: string | null, identity: Identity, stmt: string): Promise<number> {
    return asPrincipal(role, identity, (tx) => tx.$executeRawUnsafe(stmt));
  }

  const CLIENT_A: Identity = { id: 'a1c_client_a', userRole: 'student' };
  const CLIENT_B: Identity = { id: 'a1c_client_b', userRole: 'student' };
  const COACH: Identity = { id: 'a1c_coach', userRole: 'coach' };
  const OWNER: Identity = { id: 'a1c_owner', userRole: 'owner' };
  const NO_IDENTITY: Identity = {};
  const K = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  const HASH = 'a'.repeat(64);

  const insertRedemption = (id: string, user: string, key: string): string =>
    `INSERT INTO public."CoachCodeRedemption"("id","user_id","idempotency_key","request_hash","status","updated_at")
       VALUES (${lit(id)}, ${lit(user)}, ${lit(key)}, ${lit(HASH)}, 'completed', now())`;
  const insertPrompt = (user: string): string =>
    `INSERT INTO public."CoachlessPromptState"("user_id","updated_at") VALUES (${lit(user)}, now())`;
  const insertConfig = (): string =>
    `INSERT INTO public."FeaturedCoachConfig"("id","coach_user_id","code","banner_title","updated_at")
       VALUES ('default', 'a1c_coach', 'GP-A1TEST', 'Enter coach code for coaching and programs', now())`;

  async function installMigration(): Promise<void> {
    await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8'));
    // Supabase grants table privileges to API roles by default; a bare CI
    // Postgres does not. Grant them so the assertions test POLICIES, not the
    // absence of a GRANT. anon stays revoked (the migration revokes it).
    for (const t of TABLES) {
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${t}" TO ${AUTHED}, ${SERVICE}`,
      );
    }
  }

  beforeAll(async () => {
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      throw new Error(`[A1] TEST_DATABASE_URL is set but unreachable: ${sqlState(err)}`);
    }
    await applyScript(PREREQ_SQL);
    await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8'));
    await installMigration();
  }, 120_000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM public."FeaturedCoachConfig"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'a1c\\_%'`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM public."FeaturedCoachConfig"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'a1c\\_%'`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","role","coach_id") VALUES
         ('a1c_coach','coach',NULL),
         ('a1c_owner','owner',NULL),
         ('a1c_client_a','student','a1c_coach'),
         ('a1c_client_b','student',NULL)`,
    );
    await asPrincipal(SERVICE, {}, async (tx) => {
      await tx.$executeRawUnsafe(insertConfig());
      await tx.$executeRawUnsafe(insertRedemption('a1c_r_a1', 'a1c_client_a', K(1)));
      await tx.$executeRawUnsafe(insertRedemption('a1c_r_a2', 'a1c_client_a', K(2)));
      await tx.$executeRawUnsafe(insertRedemption('a1c_r_b1', 'a1c_client_b', K(1)));
      await tx.$executeRawUnsafe(insertPrompt('a1c_client_a'));
      await tx.$executeRawUnsafe(insertPrompt('a1c_client_b'));
      return null;
    });
  });

  describe('catalog', () => {
    it.each(TABLES)('%s: RLS is enabled and forced', async (t) => {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."${t}"'::regclass`,
      )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it.each([
      ['FeaturedCoachConfig', 'featuredcoachconfig', 'select_owner'],
      ['CoachCodeRedemption', 'coachcoderedemption', 'select_self'],
      ['CoachlessPromptState', 'coachlesspromptstate', 'select_self'],
    ])(
      '%s: exactly three policies (service_role_all, %s select, anon deny)',
      async (t, low, sel) => {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT policyname, permissive, roles::text[] AS roles, cmd, coalesce(qual,'') AS qual
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
          t,
        )) as {
          policyname: string;
          permissive: string;
          roles: string[];
          cmd: string;
          qual: string;
        }[];
        expect(rows.map((r) => [r.policyname, r.permissive, r.cmd, r.roles])).toEqual([
          [`p_${low}_anon_deny`, 'RESTRICTIVE', 'ALL', ['anon']],
          [`p_${low}_${sel}`, 'PERMISSIVE', 'SELECT', ['public']],
          [`p_${low}_service_role_all`, 'PERMISSIVE', 'ALL', ['service_role']],
        ]);
        const select = rows.find((r) => r.policyname.endsWith(sel));
        if (sel === 'select_self')
          expect(select?.qual).not.toMatch(/is_owner|coach|team|sub_coach/i);
      },
    );
  });

  describe('reads', () => {
    it('a client reads exactly their own redemption and prompt rows', async () => {
      expect(await count(AUTHED, CLIENT_A, 'CoachCodeRedemption')).toBe(2);
      expect(await count(AUTHED, CLIENT_B, 'CoachCodeRedemption')).toBe(1);
      expect(await count(AUTHED, CLIENT_A, 'CoachlessPromptState')).toBe(1);
      expect(
        await count(AUTHED, CLIENT_A, 'CoachCodeRedemption', `WHERE "user_id" = 'a1c_client_b'`),
      ).toBe(0);
    });

    it('the client’s coach, the platform owner and an identity-less request read no redemption or prompt rows', async () => {
      for (const who of [COACH, OWNER, NO_IDENTITY]) {
        expect(await count(AUTHED, who, 'CoachCodeRedemption')).toBe(0);
        expect(await count(AUTHED, who, 'CoachlessPromptState')).toBe(0);
      }
    });

    it('only the platform owner reads the featured-coach config through RLS', async () => {
      expect(await count(AUTHED, OWNER, 'FeaturedCoachConfig')).toBe(1);
      for (const who of [CLIENT_A, CLIENT_B, COACH, NO_IDENTITY]) {
        expect(await count(AUTHED, who, 'FeaturedCoachConfig')).toBe(0);
      }
      // A forged role GUC without an identity is not the owner.
      expect(await count(AUTHED, { userRole: 'owner' }, 'FeaturedCoachConfig')).toBe(0);
    });

    it('service_role reads everything', async () => {
      expect(await count(SERVICE, {}, 'CoachCodeRedemption')).toBe(3);
      expect(await count(SERVICE, {}, 'CoachlessPromptState')).toBe(2);
      expect(await count(SERVICE, {}, 'FeaturedCoachConfig')).toBe(1);
    });

    it('anon has no privilege; with one granted the RESTRICTIVE deny still returns zero', async () => {
      for (const t of TABLES) {
        expect(await failsWith(ANON, {}, `SELECT 1 FROM public."${t}"`)).toBe('42501');
      }
      for (const t of TABLES)
        await prisma.$executeRawUnsafe(`GRANT SELECT ON public."${t}" TO anon`);
      try {
        // Denied means zero visible rows OR 42501: anon cannot EXECUTE the
        // app.* helpers the permissive policies call (the same rule as
        // clinic-engagement-rls.spec.ts). Either way nothing is readable.
        for (const t of TABLES) {
          let seen: number | string;
          try {
            seen = await count(ANON, CLIENT_A, t);
          } catch (err) {
            seen = sqlState(err);
          }
          expect([t, seen === 0 || seen === '42501' ? 'denied' : seen]).toEqual([t, 'denied']);
        }
      } finally {
        for (const t of TABLES)
          await prisma.$executeRawUnsafe(`REVOKE ALL ON public."${t}" FROM anon`);
      }
    });
  });

  describe('writes', () => {
    it('no client, coach or owner can INSERT a redemption or prompt row (own or forged user)', async () => {
      for (const who of [CLIENT_A, COACH, OWNER]) {
        expect(
          await failsWith(AUTHED, who, insertRedemption(`a1c_x_${who.id}`, 'a1c_client_a', K(9))),
        ).toBe('42501');
        expect(
          await failsWith(AUTHED, who, insertRedemption(`a1c_y_${who.id}`, who.id ?? '', K(8))),
        ).toBe('42501');
      }
      expect(
        await failsWith(
          AUTHED,
          CLIENT_B,
          `DELETE FROM public."CoachlessPromptState" WHERE "user_id" = 'a1c_client_b'`,
        ),
      ).toBeNull();
      expect(await count(SERVICE, {}, 'CoachlessPromptState')).toBe(2); // the DELETE matched no visible-for-delete row
      expect(
        await failsWith(
          AUTHED,
          CLIENT_B,
          `INSERT INTO public."CoachlessPromptState"("user_id","updated_at") VALUES ('a1c_owner', now())`,
        ),
      ).toBe('42501');
    });

    it('UPDATE and DELETE by any non-service principal affect zero rows', async () => {
      for (const who of [CLIENT_A, COACH, OWNER]) {
        expect(
          await affected(
            AUTHED,
            who,
            `UPDATE public."CoachCodeRedemption" SET "status" = 'failed'`,
          ),
        ).toBe(0);
        expect(await affected(AUTHED, who, `DELETE FROM public."CoachCodeRedemption"`)).toBe(0);
        expect(
          await affected(
            AUTHED,
            who,
            `UPDATE public."CoachlessPromptState" SET "roman_not_now_count" = 0`,
          ),
        ).toBe(0);
        expect(
          await affected(
            AUTHED,
            who,
            `UPDATE public."FeaturedCoachConfig" SET "accepting_clients" = true`,
          ),
        ).toBe(0);
        expect(await affected(AUTHED, who, `DELETE FROM public."FeaturedCoachConfig"`)).toBe(0);
      }
      expect(await count(SERVICE, {}, 'CoachCodeRedemption', `WHERE "status" = 'completed'`)).toBe(
        3,
      );
      expect(await count(SERVICE, {}, 'FeaturedCoachConfig')).toBe(1);
    });

    it('nobody but service_role inserts the featured-coach config', async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."FeaturedCoachConfig"`);
      for (const who of [CLIENT_A, COACH, OWNER])
        expect(await failsWith(AUTHED, who, insertConfig())).toBe('42501');
      expect(await failsWith(SERVICE, {}, insertConfig())).toBeNull();
    });
  });

  describe('constraints and erasure', () => {
    it('the config is a singleton', async () => {
      expect(
        await failsWith(
          SERVICE,
          {},
          `INSERT INTO public."FeaturedCoachConfig"("id","banner_title","updated_at") VALUES ('second','x',now())`,
        ),
      ).toBe('23514');
    });

    it('the idempotency key must be a UUID, the status must be known, and (user, key) is unique', async () => {
      expect(
        await failsWith(SERVICE, {}, insertRedemption('a1c_bad_key', 'a1c_client_b', 'not-a-uuid')),
      ).toBe('23514');
      expect(
        await failsWith(
          SERVICE,
          {},
          `UPDATE public."CoachCodeRedemption" SET "status" = 'weird' WHERE "id" = 'a1c_r_b1'`,
        ),
      ).toBe('23514');
      expect(await failsWith(SERVICE, {}, insertRedemption('a1c_dup', 'a1c_client_a', K(1)))).toBe(
        '23505',
      );
    });

    it('deleting a user cascades their redemption and prompt rows and clears the featured coach', async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" = 'a1c_client_a'`);
      expect(
        await count(SERVICE, {}, 'CoachCodeRedemption', `WHERE "user_id" = 'a1c_client_a'`),
      ).toBe(0);
      expect(
        await count(SERVICE, {}, 'CoachlessPromptState', `WHERE "user_id" = 'a1c_client_a'`),
      ).toBe(0);
      await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" = 'a1c_coach'`);
      expect(await count(SERVICE, {}, 'FeaturedCoachConfig', `WHERE "coach_user_id" IS NULL`)).toBe(
        1,
      );
    });

    it('down.sql removes the tables and the migration re-applies cleanly', async () => {
      await applyScript(fs.readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8'));
      const gone = (await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('FeaturedCoachConfig','CoachCodeRedemption','CoachlessPromptState')`,
      )) as { n: number }[];
      expect(Number(gone[0].n)).toBe(0);
      await installMigration();
      const back = (await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('FeaturedCoachConfig','CoachCodeRedemption','CoachlessPromptState')`,
      )) as { n: number }[];
      expect(Number(back[0].n)).toBe(3);
    });
  });
});
