/**
 * D8 (B-D8-124) — live RLS proof for 20270319000000_cwa_coach_manage_client_tenancy.
 *
 * Runs against a REAL PostgreSQL (no mocks). Builds the production shape of the two tables this
 * policy touches (ClientWorkoutAssignment + WorkoutPlan, RLS enabled and forced, the Supabase
 * default API-role table grants) with their production policies copied verbatim from
 * 20260508000001 / 20260620000000 / 20260621000000, applies
 * prisma/migrations/20260702000000_fix_workout_rls_coach_role/migration.sql verbatim (today's
 * production policy), then this PR's migration.sql / down.sql verbatim. Principals are PostgREST
 * shaped: `SET LOCAL ROLE authenticated|anon` + the `request.jwt.claims` GUC that auth.uid() reads.
 *
 * Proves:
 *   - reads / deletes (USING): a coach no longer sees or deletes an assignment they created for
 *     another coach's client; own-roster and open-sub-coach rows stay visible; client reads unchanged;
 *   - writes (WITH CHECK): with the production WorkoutPlan <-> ClientWorkoutAssignment policy cycle
 *     present, every API-role INSERT / UPDATE fails 42P17 before and after this migration (unchanged,
 *     no widening); with the cycle removed (the shape the write branch has the day that cycle is
 *     broken), a coach inserting for another coach's client is refused 42501 while the same insert
 *     succeeds on the down.sql (pre-D8) policy, a coach's own client succeeds, a sub-coach succeeds
 *     only for a client with an open assignment, a soft-deleted client is refused, a client and anon
 *     are refused;
 *   - down.sql / migration.sql round-trip cleanly.
 *
 * CI: the rls-live-tests job runs this file after the Supabase shim and the scoped bootstraps; the
 * prerequisites below only fill in what is missing, so the file also runs on an empty throwaway DB.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure; no green-by-skip).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATIONS = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const D8_DIR = path.join(MIGRATIONS, '20270319000000_cwa_coach_manage_client_tenancy');
const PRIOR_SQL = path.join(MIGRATIONS, '20260702000000_fix_workout_rls_coach_role', 'migration.sql');

const RAW_URL = process.env.TEST_DATABASE_URL || '';
if (!RAW_URL && process.env.CI === 'true') {
  throw new Error('[D8] cwa-coach-manage-client-tenancy-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const URL_WITH_LIMIT = !RAW_URL
  ? ''
  : RAW_URL.includes('connection_limit=')
    ? RAW_URL
    : RAW_URL + (RAW_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

// Production policy text (verbatim) for the tables this policy graph touches.
const CLIENT_READ_ASSIGNED_PLANS = `CREATE POLICY "client_read_assigned_plans"
    ON "WorkoutPlan" AS PERMISSIVE FOR SELECT TO PUBLIC
    USING ("id" IN (SELECT "workout_plan_id" FROM "ClientWorkoutAssignment"
      WHERE "client_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text)))`;

const PREREQ_SQL = `
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $do$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;
DO $do$ BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULLIF(current_setting(''request.jwt.claims'', true)::jsonb ->> ''sub'', '''')::uuid'$f$;
  END IF;
END $do$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA app TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS public."User" ("id" text PRIMARY KEY, "role" text NOT NULL DEFAULT 'coach', "coach_id" text);
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "supabase_id" text;
ALTER TABLE public."User" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS public."TeamSubCoachAssignment" (
  "id" text PRIMARY KEY, "sub_coach_id" text NOT NULL, "head_coach_id" text NOT NULL, "archived_at" timestamptz);
CREATE TABLE IF NOT EXISTS public."SubCoachAssignment" (
  "id" text PRIMARY KEY, "head_coach_id" text NOT NULL, "sub_coach_id" text NOT NULL, "client_id" text NOT NULL,
  "unassigned_at" TIMESTAMP(3));
CREATE TABLE IF NOT EXISTS public."WorkoutPlan" ("id" text PRIMARY KEY, "coach_id" text NOT NULL);
CREATE TABLE IF NOT EXISTS public."ClientWorkoutAssignment" (
  "id" text PRIMARY KEY, "workout_plan_id" text NOT NULL, "client_id" text NOT NULL, "assigned_by_coach_id" text NOT NULL);
ALTER TABLE public."WorkoutPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkoutPlan" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."ClientWorkoutAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ClientWorkoutAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WorkoutPlan_coach_owner" ON "WorkoutPlan";
CREATE POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan" AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text))
  WITH CHECK ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text));
DROP POLICY IF EXISTS "client_read_assigned_plans" ON "WorkoutPlan";
${CLIENT_READ_ASSIGNED_PLANS};
DROP POLICY IF EXISTS "assignment_client_read" ON "ClientWorkoutAssignment";
CREATE POLICY "assignment_client_read" ON "ClientWorkoutAssignment" AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ("client_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text));
GRANT SELECT ON public."User" TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."WorkoutPlan" TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."ClientWorkoutAssignment" TO anon, authenticated, service_role;
`;

/** Top-level statement splitter honouring dollar quotes, single quotes and line comments. */
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

describeLive('D8 assignment_coach_manage client tenancy (live Postgres, PostgREST principals)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL_WITH_LIMIT } } });
  type Tx = { $executeRawUnsafe: (sql: string) => Promise<number>; $queryRawUnsafe: (sql: string) => Promise<unknown[]> };

  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  // Users: two head coaches, a sub-coach on coach A's team, A's clients, B's client.
  const COACH_A = { id: 'd8_coach_a', sub: uuid(801) };
  const COACH_B = { id: 'd8_coach_b', sub: uuid(802) };
  const SUB_A = { id: 'd8_sub_a', sub: uuid(803) };
  const CLIENT_A = { id: 'd8_client_a', sub: uuid(804) };
  const CLIENT_A2 = { id: 'd8_client_a2', sub: uuid(805) };
  const CLIENT_DEL = { id: 'd8_client_del', sub: uuid(806) };
  const CLIENT_B = { id: 'd8_client_b', sub: uuid(807) };
  type Who = { sub?: string } | null;

  async function applyScript(sql: string): Promise<void> {
    for (const stmt of splitSqlStatements(sql)) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
      if (/^SET LOCAL /i.test(stmt)) continue; // transaction-scoped settings; no transaction here
      await prisma.$executeRawUnsafe(stmt);
    }
  }
  const up = async () => applyScript(fs.readFileSync(path.join(D8_DIR, 'migration.sql'), 'utf8'));
  const down = async () => applyScript(fs.readFileSync(path.join(D8_DIR, 'down.sql'), 'utf8'));

  async function asUser<T>(role: 'authenticated' | 'anon', who: Who, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      // '{}' (not '') when there is no identity: auth.uid() casts the claims GUC to jsonb.
      const claims = JSON.stringify(who?.sub ? { sub: who.sub, role } : { role });
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', ${lit(claims)}, true)`);
      return fn(tx as unknown as Tx);
    });
  }

  function sqlState(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501|42P17|23505|23503)\b/.exec(msg);
    return m ? m[1] : `unparsed: ${msg.slice(0, 200)}`;
  }

  /** null when the statement succeeded; otherwise its SQLSTATE. */
  async function attempt(role: 'authenticated' | 'anon', who: Who, stmt: string): Promise<string | null> {
    try {
      await asUser(role, who, (tx) => tx.$executeRawUnsafe(stmt));
      return null;
    } catch (err) {
      return sqlState(err);
    }
  }

  const insert = (id: string, plan: string, client: string, by: string) =>
    `INSERT INTO public."ClientWorkoutAssignment"("id","workout_plan_id","client_id","assigned_by_coach_id")
       VALUES (${lit(id)}, ${lit(plan)}, ${lit(client)}, ${lit(by)})`;

  async function visibleIds(who: Who): Promise<string[]> {
    const rows = (await asUser('authenticated', who, (tx) =>
      tx.$queryRawUnsafe(`SELECT "id" FROM public."ClientWorkoutAssignment" WHERE "id" LIKE 'd8\\_%' ORDER BY "id"`),
    )) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async function seed(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM public."ClientWorkoutAssignment" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."SubCoachAssignment" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."WorkoutPlan" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","supabase_id","role","coach_id","deleted_at") VALUES
         (${lit(COACH_A.id)}, ${lit(COACH_A.sub)}, 'coach', NULL, NULL),
         (${lit(COACH_B.id)}, ${lit(COACH_B.sub)}, 'coach', NULL, NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","supabase_id","role","coach_id","deleted_at") VALUES
         (${lit(SUB_A.id)}, ${lit(SUB_A.sub)}, 'coach', ${lit(COACH_A.id)}, NULL),
         (${lit(CLIENT_A.id)}, ${lit(CLIENT_A.sub)}, 'student', ${lit(COACH_A.id)}, NULL),
         (${lit(CLIENT_A2.id)}, ${lit(CLIENT_A2.sub)}, 'student', ${lit(COACH_A.id)}, NULL),
         (${lit(CLIENT_DEL.id)}, ${lit(CLIENT_DEL.sub)}, 'student', ${lit(COACH_A.id)}, now()),
         (${lit(CLIENT_B.id)}, ${lit(CLIENT_B.sub)}, 'student', ${lit(COACH_B.id)}, NULL)`,
    );
    // Sub-coach A holds an open assignment to client A only (also its team membership).
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."SubCoachAssignment"("id","head_coach_id","sub_coach_id","client_id","unassigned_at") VALUES
         ('d8_sca_a', ${lit(COACH_A.id)}, ${lit(SUB_A.id)}, ${lit(CLIENT_A.id)}, NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."WorkoutPlan"("id","coach_id") VALUES
         ('d8_plan_a', ${lit(COACH_A.id)}), ('d8_plan_s', ${lit(SUB_A.id)}), ('d8_plan_b', ${lit(COACH_B.id)})`,
    );
    // Superuser seed (RLS bypassed): d8_cwa_foreign is the row the pre-D8 policy let coach A create
    // for coach B's client.
    const rows: Array<[string, string, string, string]> = [
      ['d8_cwa_own', 'd8_plan_a', CLIENT_A.id, COACH_A.id],
      ['d8_cwa_foreign', 'd8_plan_a', CLIENT_B.id, COACH_A.id],
      ['d8_cwa_sub_ok', 'd8_plan_s', CLIENT_A.id, SUB_A.id],
      ['d8_cwa_sub_no', 'd8_plan_s', CLIENT_A2.id, SUB_A.id],
    ];
    for (const [id, plan, client, by] of rows) {
      await prisma.$executeRawUnsafe(insert(id, plan, client, by));
    }
  }

  beforeAll(async () => {
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      throw new Error(`[D8] TEST_DATABASE_URL is set but unreachable: ${sqlState(err)}`);
    }
    await applyScript(PREREQ_SQL);
    await applyScript(fs.readFileSync(PRIOR_SQL, 'utf8')); // today's production policy, verbatim
    await up();
  }, 120_000);

  beforeEach(seed);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM public."ClientWorkoutAssignment" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."SubCoachAssignment" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."WorkoutPlan" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."User" WHERE "id" LIKE 'd8\\_%'`);
    await prisma.$disconnect();
  });

  it('installs the helper as SECURITY DEFINER with EXECUTE for the API roles only', async () => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT p.prosecdef AS definer, p.provolatile::text AS vol, p.proconfig AS cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'caller_coaches_client'`,
    )) as { definer: boolean; vol: string; cfg: string[]; anon_x: boolean; auth_x: boolean; svc_x: boolean; public_x: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ definer: true, vol: 's', anon_x: true, auth_x: true, svc_x: true, public_x: false });
    expect(rows[0].cfg).toEqual(['search_path=""']);
  });

  describe('USING (read / delete) on the production policy graph', () => {
    it('coach A no longer sees the row they created for coach B\'s client; down.sql (pre-D8) still shows it', async () => {
      expect(await visibleIds(COACH_A)).toEqual(['d8_cwa_own']);
      await down();
      try {
        expect(await visibleIds(COACH_A)).toEqual(['d8_cwa_foreign', 'd8_cwa_own']);
      } finally {
        await up();
      }
      expect(await visibleIds(COACH_A)).toEqual(['d8_cwa_own']);
    });

    it('sub-coach sees only rows for the client with an open assignment; clients still read their own rows', async () => {
      expect(await visibleIds(SUB_A)).toEqual(['d8_cwa_sub_ok']);
      expect(await visibleIds(CLIENT_A)).toEqual(['d8_cwa_own', 'd8_cwa_sub_ok']);
      expect(await visibleIds(CLIENT_B)).toEqual(['d8_cwa_foreign']);
      expect(await visibleIds(COACH_B)).toEqual([]);
    });

    it('coach A cannot delete the foreign-client row but can delete their own client\'s row', async () => {
      const del = (id: string) => asUser('authenticated', COACH_A, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM public."ClientWorkoutAssignment" WHERE "id" = ${lit(id)}`));
      expect(await del('d8_cwa_foreign')).toBe(0);
      expect(await del('d8_cwa_own')).toBe(1);
    });
  });

  describe('WITH CHECK on the production policy graph (WorkoutPlan <-> ClientWorkoutAssignment cycle present)', () => {
    it('every API-role INSERT / UPDATE fails 42P17 before planning, before and after this migration (unchanged)', async () => {
      const writes: Array<[Who, string]> = [
        [COACH_A, insert('d8_cwa_new', 'd8_plan_a', CLIENT_B.id, COACH_A.id)],
        [COACH_A, insert('d8_cwa_new', 'd8_plan_a', CLIENT_A.id, COACH_A.id)],
        [COACH_A, `UPDATE public."ClientWorkoutAssignment" SET "client_id" = ${lit(CLIENT_B.id)} WHERE "id" = 'd8_cwa_own'`],
      ];
      for (const [who, stmt] of writes) expect(await attempt('authenticated', who, stmt)).toBe('42P17');
      await down();
      try {
        for (const [who, stmt] of writes) expect(await attempt('authenticated', who, stmt)).toBe('42P17');
      } finally {
        await up();
      }
    });
  });

  describe('WITH CHECK once the plan-read cycle is broken (client_read_assigned_plans removed)', () => {
    beforeAll(async () => {
      await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "client_read_assigned_plans" ON "WorkoutPlan"`);
    });
    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "client_read_assigned_plans" ON "WorkoutPlan"`);
      await prisma.$executeRawUnsafe(CLIENT_READ_ASSIGNED_PLANS);
    });

    it('a coach inserting for another coach\'s client is refused 42501; the pre-D8 policy (down.sql) allowed it', async () => {
      const stranger = insert('d8_cwa_new', 'd8_plan_b', CLIENT_A.id, COACH_B.id);
      expect(await attempt('authenticated', COACH_B, stranger)).toBe('42501');
      expect(await attempt('authenticated', COACH_A, insert('d8_cwa_new', 'd8_plan_a', CLIENT_B.id, COACH_A.id))).toBe('42501');
      await down();
      try {
        expect(await attempt('authenticated', COACH_B, stranger)).toBeNull();
      } finally {
        await up();
      }
    });

    it('a coach inserting for their own client succeeds; a soft-deleted client is refused', async () => {
      expect(await attempt('authenticated', COACH_A, insert('d8_cwa_new', 'd8_plan_a', CLIENT_A2.id, COACH_A.id))).toBeNull();
      expect(await attempt('authenticated', COACH_A, insert('d8_cwa_del', 'd8_plan_a', CLIENT_DEL.id, COACH_A.id))).toBe('42501');
    });

    it('a sub-coach succeeds only for the client with an open assignment', async () => {
      expect(await attempt('authenticated', SUB_A, insert('d8_cwa_new', 'd8_plan_s', CLIENT_A.id, SUB_A.id))).toBeNull();
      expect(await attempt('authenticated', SUB_A, insert('d8_cwa_new2', 'd8_plan_s', CLIENT_A2.id, SUB_A.id))).toBe('42501');
    });

    it('a coach cannot re-point their own row to another coach\'s client', async () => {
      expect(
        await attempt('authenticated', COACH_A,
          `UPDATE public."ClientWorkoutAssignment" SET "client_id" = ${lit(CLIENT_B.id)} WHERE "id" = 'd8_cwa_own'`),
      ).toBe('42501');
    });

    it('a client and anon cannot insert', async () => {
      expect(await attempt('authenticated', CLIENT_A, insert('d8_cwa_new', 'd8_plan_a', CLIENT_A.id, CLIENT_A.id))).toBe('42501');
      expect(await attempt('anon', null, insert('d8_cwa_new', 'd8_plan_a', CLIENT_A.id, COACH_A.id))).toBe('42501');
    });
  });
});
