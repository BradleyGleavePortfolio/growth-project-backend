/**
 * RLSIDENT (RLSINV I01, I02, Y04): at the row layer a user cannot rewrite their
 * own role, coach link or login id, or delete their own "User" row; a client
 * and their current coach read each other's row; a former coach reads nothing.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moves from coach F to coach K; L is another coach; O is
 * the owner admin. Every id differs from its supabase id (RLSINV Y04); the
 * supabase ids are UUIDs because auth.uid() casts the JWT sub to uuid.
 * The suite runs down.sql (the state before, exactly), records what every
 * caller-keyed "User" read used by other policies and helpers returns, then
 * runs migration.sql and proves the same answers. Every 0 or 42501 follows a
 * control of 1 on the same row.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('user-identity-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000000_user_identity_lock');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

type Key = 'A' | 'K' | 'L' | 'F' | 'O';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', K: 'coach', L: 'coach', F: 'coach', O: 'owner' };
const SAFE_COLUMNS = ['leaderboard_display_name', 'name', 'phone', 'show_on_leaderboard'];
const AUTH_UID_POLICIES = [
  'ClientWorkoutAssignment.assignment_client_read', 'ClientWorkoutAssignment.assignment_coach_manage',
  'WorkoutBuilderIdempotencyKey.WorkoutBuilderIdempotencyKey_owner', 'WorkoutPlan.WorkoutPlan_coach_owner',
  'WorkoutPlan.client_read_assigned_plans', 'WorkoutPlanExercise.WorkoutPlanExercise_through_plan',
  'WorkoutPlanExercise.client_read_assigned_exercises',
];

(DB_URL ? describe : describe.skip)('"User": users cannot rewrite their own role, coach or login id at the row layer', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['A', 'K', 'L', 'F', 'O'];
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const row = { plan: `wp-${run}`, exercise: `wpe-${run}`, assignment: `cwa-${run}`, keyK: `wik-${run}`, keyA: `wia-${run}` };

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
      if (who.guc) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
      }
      return query(tx);
    });
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  // Rows written (or the SQLSTATE of the refusal).
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const reads = (who: Who, target: Key) =>
    as(who, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ${id[target]}`)
      .then((r) => r[0].n);
  const setA = (col: string, value: string) => write(backend('A'), `UPDATE "User" SET "${col}" = $1 WHERE "id" = $2`, value, id.A);
  const moveA = (coach: Key) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id[coach]} WHERE "id" = ${id.A}`;
  const userPolicies = () => prisma.$queryRaw<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null; comment: string | null }[]>`
    SELECT p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual", p."with_check" AS "check",
           obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = '"User"'::regclass
    WHERE p."schemaname" = 'public' AND p."tablename" = 'User' ORDER BY p."policyname"`;
  const updatable = (role: string) => prisma.$queryRaw<{ col: string }[]>`
    SELECT "column_name"::text AS "col" FROM information_schema.columns
    WHERE "table_schema" = 'public' AND "table_name" = 'User'
      AND has_column_privilege(${role}, '"User"', "column_name"::text, 'UPDATE') ORDER BY 1`.then((r) => r.map((c) => c.col));

  // What other tables' policies and the helpers see through "User", per caller.
  const PRINCIPALS: Who[] = [...keys.map(backend), dataApi('A'), dataApi('K')];
  const snapshot = async () => {
    const out: Record<string, unknown> = {};
    for (const who of PRINCIPALS) {
      out[`${who.guc ? 'backend' : 'dataApi'}:${who.key}`] = await as(who, (tx) => tx.$queryRaw<Record<string, unknown>[]>`
        SELECT app.is_owner() AS "isOwner",
               app.is_current_coach_of(${id.A}) AS "isCurrentCoachOfA",
               app.is_user_coached_by(${id.A}, ${id[who.key]}) AS "coachedByCaller",
               app.caller_coaches_client(${id.A}) AS "callerCoachesClientA",
               (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text) AS "selfByAuthUid",
               EXISTS (SELECT 1 FROM "User" u WHERE u."id" = app.current_user_id()) AS "selfByGuc",
               (SELECT count(*)::int FROM "WorkoutPlan" WHERE "id" = ${row.plan}) AS "plans",
               (SELECT count(*)::int FROM "WorkoutPlanExercise" WHERE "id" = ${row.exercise}) AS "exercises",
               (SELECT count(*)::int FROM "ClientWorkoutAssignment" WHERE "id" = ${row.assignment}) AS "assignments",
               (SELECT count(*)::int FROM "WorkoutBuilderIdempotencyKey" WHERE "id" IN (${row.keyK}, ${row.keyA})) AS "keys"`)
        .then((r) => r[0]);
    }
    return out;
  };
  const before: Record<string, Record<string, unknown>> = {};

  beforeAll(async () => {
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`ident-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${k === 'A' ? id.F : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
      VALUES (${row.plan}, ${id.K}, 'Plan', 'strength'::"WorkoutPlanType", now())`;
    await prisma.$executeRaw`INSERT INTO "WorkoutPlanExercise"
        ("id", "workout_plan_id", "exercise_external_id", "order", "sets", "reps_or_duration_seconds")
      VALUES (${row.exercise}, ${row.plan}, 'squat', 0, 3, 10)`;
    await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignment" ("id", "workout_plan_id", "client_id", "assigned_by_coach_id", "scheduled_for")
      VALUES (${row.assignment}, ${row.plan}, ${id.A}, ${id.K}, now())`;
    for (const [rid, k] of [[row.keyK, 'K'], [row.keyA, 'A']] as const) {
      await prisma.$executeRaw`INSERT INTO "WorkoutBuilderIdempotencyKey" ("id", "user_id", "route_key", "idempotency_key", "updated_at")
        VALUES (${rid}, ${id[k]}, 'rls', ${rid}, now())`;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('the replayed chain already carries the new rules', async () => {
    expect((await userPolicies()).map((p) => p.name)).toEqual([
      'user_client_reads_current_coach', 'user_current_coach_reads_client', 'user_self_select', 'user_self_update']);
  });

  describe('under down.sql (the state before, exactly)', () => {
    beforeAll(() => apply('down.sql'));

    it('restores user_self_access, the table-wide UPDATE grant and no helpers', async () => {
      expect(await userPolicies()).toEqual([{
        name: 'user_self_access', cmd: 'ALL', roles: '{public}',
        qual: '(id = app.current_user_id())', check: '(id = app.current_user_id())', comment: null,
      }]);
      const [g] = await prisma.$queryRaw<{ a: boolean; u: boolean; h1: string | null; h2: string | null }[]>`
        SELECT has_table_privilege('anon', '"User"', 'UPDATE') AS "a", has_table_privilege('authenticated', '"User"', 'UPDATE') AS "u",
               to_regprocedure('app.caller_coaches_user(text)')::text AS "h1", to_regprocedure('app.caller_current_coach_id()')::text AS "h2"`;
      expect(g).toEqual({ a: true, u: true, h1: null, h2: null });
    });

    it('the hole: A rewrites their own role; a coach cannot read their own client', async () => {
      expect(await setA('name', 'A before')).toBe(1);
      expect(await write(backend('A'), `UPDATE "User" SET "role" = 'owner'::"Role" WHERE "id" = $1`, id.A)).toBe(1);
      await prisma.$executeRaw`UPDATE "User" SET "role" = 'student'::"Role" WHERE "id" = ${id.A}`;
      expect(await reads(backend('A'), 'A')).toBe(1);
      expect(await reads(backend('F'), 'A')).toBe(0);
    });

    it('records what the helpers and caller-keyed "User" reads return, before and after the move', async () => {
      before.F = await snapshot();
      await moveA('K');
      before.K = await snapshot();
      await moveA('F');
    });
  });

  describe('after the migration', () => {
    beforeAll(() => apply('migration.sql'));

    it('four policies, all keyed on app.current_user_id() only', async () => {
      const policies = await userPolicies();
      expect(policies.map((p) => ({ name: p.name, cmd: p.cmd, roles: p.roles, qual: p.qual, check: p.check }))).toEqual([
        { name: 'user_client_reads_current_coach', cmd: 'SELECT', roles: '{authenticated}', qual: '(id = app.caller_current_coach_id())', check: null },
        { name: 'user_current_coach_reads_client', cmd: 'SELECT', roles: '{authenticated}', qual: 'app.caller_coaches_user(id)', check: null },
        { name: 'user_self_select', cmd: 'SELECT', roles: '{public}', qual: '(id = app.current_user_id())', check: null },
        { name: 'user_self_update', cmd: 'UPDATE', roles: '{public}', qual: '(id = app.current_user_id())', check: '(id = app.current_user_id())' },
      ]);
      for (const p of policies) expect(p.comment).toMatch(/^20270502000000: /);
    });

    it('UPDATE is granted on the profile-safe columns only, to authenticated only', async () => {
      expect(await updatable('authenticated')).toEqual(SAFE_COLUMNS);
      expect(await updatable('anon')).toEqual([]);
    });

    it('both helpers: SECURITY DEFINER, STABLE, fixed search_path, owner bypasses RLS, not executable by anon or PUBLIC', async () => {
      const helpers = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT p.oid::regprocedure::text AS "fn", p."prosecdef" AS "definer", p."provolatile" AS "volatility",
               p."proconfig"::text AS "config", r."rolname" AS "owner", (r."rolsuper" OR r."rolbypassrls") AS "ownerBypasses",
               has_function_privilege('anon', p.oid, 'EXECUTE') AS "anon",
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS "authenticated",
               EXISTS (SELECT 1 FROM aclexplode(p."proacl") x WHERE x."grantee" = 0) AS "public"
        FROM pg_proc p JOIN pg_roles r ON r.oid = p."proowner"
        WHERE p.oid IN ('app.caller_coaches_user(text)'::regprocedure, 'app.caller_current_coach_id()'::regprocedure) ORDER BY 1`;
      const same = { definer: true, volatility: 's', config: '{"search_path=pg_catalog, public"}', owner: 'postgres',
        ownerBypasses: true, anon: false, authenticated: true, public: false };
      expect(helpers).toEqual([
        { fn: 'app.caller_coaches_user(text)', ...same }, { fn: 'app.caller_current_coach_id()', ...same }]);
    });

    it('every function that reads "User" is SECURITY DEFINER under a bypass owner, so no answer depends on "User" rules', async () => {
      const fns = await prisma.$queryRaw<{ fn: string; safe: boolean }[]>`
        SELECT p.oid::regprocedure::text AS "fn", (p."prosecdef" AND (r."rolsuper" OR r."rolbypassrls")) AS "safe"
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p."pronamespace" JOIN pg_roles r ON r.oid = p."proowner"
        WHERE n."nspname" NOT IN ('pg_catalog', 'information_schema') AND p."prosrc" LIKE '%"User"%' ORDER BY 1`;
      expect(fns.filter((f) => !f.safe)).toEqual([]);
      expect(fns.map((f) => f.fn)).toEqual(expect.arrayContaining([
        'app.caller_coaches_client(text)', 'app.caller_coaches_user(text)', 'app.caller_current_coach_id()',
        'app.is_user_coached_by(text,text)']));
    });

    it('every other policy that sub-selects "User" reads only the caller\'s own row', async () => {
      const rows = await prisma.$queryRaw<{ policy: string; expr: string }[]>`
        SELECT "tablename" || '.' || "policyname" AS "policy", coalesce("qual", '') || ' ' || coalesce("with_check", '') AS "expr"
        FROM pg_policies WHERE "schemaname" = 'public' AND "tablename" <> 'User'
          AND coalesce("qual", '') || coalesce("with_check", '') LIKE '%"User"%' ORDER BY 1`;
      const all = /(FROM|JOIN) (public\.)?"User"/g;
      const callerKeyed = /FROM (public\.)?"User"( \w+)? WHERE \(*("User"|\w+)\.(supabase_id = \(auth\.uid\(\)\)::text|id = app\.current_user_id\(\))/g;
      const flat = rows.map((r) => ({ ...r, expr: r.expr.replace(/\s+/g, ' ').replace(/\( /g, '(') }));
      const loose = flat.filter((r) => (r.expr.match(all) ?? []).length !== (r.expr.match(callerKeyed) ?? []).length);
      expect(loose).toEqual([]);
      expect(rows.map((r) => r.policy)).toEqual(expect.arrayContaining(AUTH_UID_POLICIES));
    });

    it('before the move (A coached by F): the helpers and caller-keyed reads answer exactly as before', async () => {
      expect(await snapshot()).toEqual(before.F);
    });

    it('A updates their own display name; role, coach and login id are refused', async () => {
      expect(await setA('name', 'A renamed')).toBe(1);
      expect(await write(backend('A'), `UPDATE "User" SET "role" = 'owner'::"Role" WHERE "id" = $1`, id.A)).toBe('42501');
      expect(await setA('name', 'A renamed again')).toBe(1);
      expect(await setA('coach_id', id.L)).toBe('42501');
      expect(await setA('name', 'A renamed once more')).toBe(1);
      expect(await setA('supabase_id', randomUUID())).toBe('42501');
      const [a] = await prisma.$queryRaw<{ role: string; coach_id: string; supabase_id: string }[]>`
        SELECT "role"::text AS "role", "coach_id", "supabase_id" FROM "User" WHERE "id" = ${id.A}`;
      expect(a).toEqual({ role: 'student', coach_id: id.F, supabase_id: sub.A });
    });

    it('A cannot delete their own row', async () => {
      expect(await reads(backend('A'), 'A')).toBe(1);
      expect(await write(backend('A'), `DELETE FROM "User" WHERE "id" = $1`, id.A)).toBe(0);
      expect(await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ${id.A}`).toEqual([{ n: 1 }]);
    });

    it('the current coach F reads A before the move', async () => {
      expect(await reads(backend('F'), 'A')).toBe(1);
    });

    describe('after A moves from F to K', () => {
      beforeAll(() => moveA('K'));

      it('the helpers and caller-keyed reads answer exactly as before', async () => {
        expect(await snapshot()).toEqual(before.K);
      });

      it('K reads A; L and the former coach F read nothing', async () => {
        expect(await reads(backend('K'), 'A')).toBe(1);
        expect(await reads(backend('L'), 'A')).toBe(0);
        expect(await reads(backend('F'), 'A')).toBe(0);
      });

      it('A reads K; A reads neither L nor the former coach F', async () => {
        expect(await reads(backend('A'), 'K')).toBe(1);
        expect(await reads(backend('A'), 'L')).toBe(0);
        expect(await reads(backend('A'), 'F')).toBe(0);
      });

      it('app.is_owner() is unchanged: true for the owner, false for everyone else', async () => {
        const isOwner = Object.fromEntries(Object.entries(await snapshot()).map(([k, v]) => [k, (v as { isOwner: boolean }).isOwner]));
        expect(isOwner).toEqual({
          'backend:A': false, 'backend:K': false, 'backend:L': false, 'backend:F': false, 'backend:O': true,
          'dataApi:A': false, 'dataApi:K': false,
        });
      });

      it('Data API model (JWT A, no GUC): "User" 0 and "WorkoutPlan" 0', async () => {
        expect(await reads(backend('A'), 'A')).toBe(1);
        expect(await reads(backend('A'), 'K')).toBe(1);
        expect(await as(dataApi('A'), (tx) => tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ANY(${Object.values(id)}::text[])`)).toEqual([{ n: 0 }]);
        const plans = (who: Who) => as(who, (tx) => tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS "n" FROM "WorkoutPlan" WHERE "id" = ${row.plan}`).then((r) => r[0].n);
        expect(await plans(backend('A'))).toBe(1);
        expect(await plans(dataApi('A'))).toBe(0);
      });

      it('the seven auth.uid() workout policies stay closed on the Data API', async () => {
        const s = await snapshot();
        const pick = (k: string) => {
          const { plans, exercises, assignments, keys: idem } = s[k] as Record<string, number>;
          return { plans, exercises, assignments, keys: idem };
        };
        expect(pick('backend:K')).toEqual({ plans: 1, exercises: 1, assignments: 1, keys: 1 });
        expect(pick('backend:A')).toEqual({ plans: 1, exercises: 1, assignments: 1, keys: 1 });
        expect(pick('dataApi:K')).toEqual({ plans: 0, exercises: 0, assignments: 0, keys: 0 });
        expect(pick('dataApi:A')).toEqual({ plans: 0, exercises: 0, assignments: 0, keys: 0 });
        const addPlan = (who: Who) => write(who, `INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
          VALUES ($1, $2, 'Plan', 'strength'::"WorkoutPlanType", now())`, `wp-${randomUUID()}`, id.K);
        expect(await addPlan(backend('K'))).toBe(1);
        expect(await addPlan(dataApi('K'))).toBe('42501');
      });
    });
  });
});
