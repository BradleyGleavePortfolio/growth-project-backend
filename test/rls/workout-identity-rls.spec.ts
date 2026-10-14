/**
 * RLSLIVE1b (RLSINV I04): the workout plan and assignment row rules use the
 * same user id as every other rule. Migration
 * 20270502000800_workout_identity_current_user_id moves WorkoutPlan_coach_owner,
 * client_read_assigned_plans, WorkoutPlanExercise_through_plan,
 * client_read_assigned_exercises, assignment_client_read,
 * assignment_coach_manage, WorkoutBuilderIdempotencyKey_owner and
 * app.caller_coaches_client from auth.uid() + a sub-select on "User" to
 * app.current_user_id() (and the role check to app.current_user_role()).
 *
 * Two identity models, both as the API role `authenticated` (no RLS bypass):
 *   backend   app.current_user_id / app.current_user_role GUCs, no JWT subject
 *   Data API  a JWT subject (the user's supabase_id), no GUC
 * Every person is seeded with supabase_id <> id, so a rule keyed on the wrong
 * id cannot pass by accident. Every zero comes right after a read of 1 of the
 * same row (by the allowed principal, or on the superuser connection), so a
 * zero means the rule refused the row, not that it is missing. The last case
 * runs down.sql to show the old denial on this data, then re-applies the
 * migration and checks the catalog comes back identical.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('workout-identity-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270502000800_workout_identity_current_user_id';
const RLS = /row-level security/;
const TABLES = ['WorkoutPlan', 'WorkoutPlanExercise', 'ClientWorkoutAssignment', 'WorkoutBuilderIdempotencyKey'];
const SEVEN = [
  'WorkoutPlan_coach_owner', 'client_read_assigned_plans', 'WorkoutPlanExercise_through_plan', 'client_read_assigned_exercises',
  'assignment_client_read', 'assignment_coach_manage', 'WorkoutBuilderIdempotencyKey_owner',
];
type Model = { guc?: boolean; jwt?: boolean; role?: string };
const BACKEND: Model = { guc: true };
const DATA_API: Model = { jwt: true };

(DB_URL ? describe : describe.skip)('RLSLIVE1b: workout row rules key on app.current_user_id()', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Coaches k and l; a is k's client, c is l's.
  const [k, l, a, c] = Array.from({ length: 4 }, () => randomUUID());
  const sub: Record<string, string> = { [k]: randomUUID(), [l]: randomUUID(), [a]: randomUUID(), [c]: randomUUID() };
  const roleOf: Record<string, string> = { [k]: 'coach', [l]: 'coach', [a]: 'student', [c]: 'student' };
  const row: Record<string, string> = {};
  let planL = '';

  /** Runs `fn` in one transaction as `authenticated`, signed in as `who` under `model`. */
  const asUser = <T>(who: string, model: Model, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, model.guc ? who : '');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, model.guc ? model.role ?? roleOf[who] : '');
      // '{}' (not ''): the shim's auth.uid() casts the claims GUC to jsonb.
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        model.jwt ? JSON.stringify({ sub: sub[who], role: 'authenticated' }) : '{}');
      return fn(tx);
    });
  /** Rows with this id in `table` that `who` reads under `model`. */
  const seen = async (table: string, rowId: string, who: string, model: Model = BACKEND): Promise<number> => {
    const [{ n }] = await asUser(who, model, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, rowId));
    return n;
  };
  /** The same count on the superuser connection (the row exists). */
  const exists = async (table: string, rowId: string): Promise<number> => {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, rowId);
    return n;
  };
  const insertKey = (who: string, owner: string, model: Model = BACKEND) => asUser(who, model, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."WorkoutBuilderIdempotencyKey" ("id","user_id","route_key","idempotency_key","updated_at") VALUES ($1, $2, 'rls', $1, now())`,
    randomUUID(), owner));
  const insertExercise = (who: string, plan: string) => asUser(who, BACKEND, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."WorkoutPlanExercise" ("id","workout_plan_id","exercise_external_id","order","sets","reps_or_duration_seconds")
     VALUES ($1, $2, 'rls-ex', 9, 3, 10)`, randomUUID(), plan));
  const insertPlan = (who: string, coach: string) => asUser(who, BACKEND, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."WorkoutPlan" ("id","coach_id","name","type","updated_at") VALUES ($1, $2, 'RLS plan', 'strength', now())`,
    randomUUID(), coach));
  const coaches = (who: string, client: string, model: Model = BACKEND) => asUser(who, model, (tx) =>
    tx.$queryRawUnsafe<{ ok: boolean }[]>('SELECT app.caller_coaches_client($1) AS ok', client)).then(([r]) => r.ok);
  /** The seven policies (plus #992's restrictive pair), their comments and the helper, as the catalog has them. */
  const catalog = async () => ({
    policies: await prisma.$queryRawUnsafe<{ policyname: string; qual: string | null; with_check: string | null }[]>(
      `SELECT p.tablename, p.policyname, p.permissive, p.roles::text AS roles, p.cmd, p.qual, p.with_check,
              obj_description(pol.oid, 'pg_policy') AS comment
         FROM pg_policies p
         JOIN pg_policy pol ON pol.polname = p.policyname AND pol.polrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
        WHERE p.schemaname = 'public' AND p.tablename IN (${TABLES.map((t) => `'${t}'`).join(', ')})
        ORDER BY p.tablename, p.policyname`),
    helper: (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT pg_get_functiondef(p.oid) AS def, p.prosecdef AS definer, p.proconfig AS cfg, obj_description(p.oid, 'pg_proc') AS comment,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_x
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'caller_coaches_client'`))[0],
  });
  /** Applies a migration file in one transaction, statement by statement (each ends a line with `;`). */
  const runSql = (file: 'migration.sql' | 'down.sql') => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, file), 'utf8');
    const statements = sql.split(/;[ \t]*$/m).map((st) => st.trim())
      .filter((st) => !/^(BEGIN|COMMIT|)$/i.test(st.replace(/^\s*--.*$/gm, '').trim()));
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    });
  };

  beforeAll(async () => {
    for (const [id, coach_id] of [[k, null], [l, null], [a, k], [c, l]] as const) {
      await prisma.user.create({
        data: { id, supabase_id: sub[id], email: `${id}@example.test`, name: 'RLS person', role: roleOf[id] as 'coach' | 'student', coach_id },
      });
    }
    const plan = (coach: string) => prisma.workoutPlan.create({ data: { coach_id: coach, name: 'RLS plan', type: 'strength' } }).then((p) => p.id);
    row.WorkoutPlan = await plan(k);
    planL = await plan(l);
    row.WorkoutPlanExercise = (await prisma.workoutPlanExercise.create({
      data: { workout_plan_id: row.WorkoutPlan, exercise_external_id: 'rls-ex', order: 0, sets: 3, reps_or_duration_seconds: 10 },
    })).id;
    row.ClientWorkoutAssignment = (await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: row.WorkoutPlan, client_id: a, assigned_by_coach_id: k, scheduled_for: new Date() },
    })).id;
    row.WorkoutBuilderIdempotencyKey = (await prisma.workoutBuilderIdempotencyKey.create({
      data: { user_id: k, route_key: 'rls', idempotency_key: randomUUID() },
    })).id;
  });
  afterAll(() => prisma.$disconnect());

  it('backend model: the coach reads their own rows on all four tables; the other coach and their client read none', async () => {
    for (const table of TABLES) {
      expect(await seen(table, row[table], k)).toBe(1);
      expect(await seen(table, row[table], l)).toBe(0);
      expect(await seen(table, row[table], c)).toBe(0);
    }
    expect(await seen('WorkoutPlan', planL, l)).toBe(1);
    expect(await seen('WorkoutPlan', planL, k)).toBe(0);
  });

  it("backend model: the client reads the assigned plan, its exercises and their assignment, never the coach's key or another plan", async () => {
    for (const table of TABLES.slice(0, 3)) {
      expect(await seen(table, row[table], a)).toBe(1);
      expect(await seen(table, row[table], c)).toBe(0);
    }
    expect(await seen('WorkoutBuilderIdempotencyKey', row.WorkoutBuilderIdempotencyKey, k)).toBe(1);
    expect(await seen('WorkoutBuilderIdempotencyKey', row.WorkoutBuilderIdempotencyKey, a)).toBe(0);
    expect(await seen('WorkoutPlan', planL, l)).toBe(1);
    expect(await seen('WorkoutPlan', planL, a)).toBe(0);
  });

  it('Data API model (JWT subject, no GUC): 0 on all four tables, for the coach and for the client', async () => {
    for (const table of TABLES) {
      expect(await seen(table, row[table], k)).toBe(1);
      expect(await seen(table, row[table], k, DATA_API)).toBe(0);
    }
    for (const table of TABLES.slice(0, 3)) {
      expect(await seen(table, row[table], a)).toBe(1);
      expect(await seen(table, row[table], a, DATA_API)).toBe(0);
    }
  });

  it('assignment_coach_manage takes the role from app.current_user_role()', async () => {
    expect(await seen('ClientWorkoutAssignment', row.ClientWorkoutAssignment, k, { guc: true, role: 'coach' })).toBe(1);
    expect(await seen('ClientWorkoutAssignment', row.ClientWorkoutAssignment, k, { guc: true, role: 'student' })).toBe(0);
    expect(await seen('ClientWorkoutAssignment', row.ClientWorkoutAssignment, k, { guc: true, role: '' })).toBe(0);
  });

  it('writes: a coach writes plans, exercises and keys only as themselves, and never through a JWT alone', async () => {
    await expect(insertKey(k, k)).resolves.toBe(1);
    await expect(insertKey(k, l)).rejects.toThrow(RLS);
    await expect(insertKey(k, k, DATA_API)).rejects.toThrow(RLS);
    await expect(insertExercise(k, row.WorkoutPlan)).resolves.toBe(1);
    await expect(insertExercise(l, row.WorkoutPlan)).rejects.toThrow(RLS);
    await expect(insertPlan(k, k)).resolves.toBe(1);
    await expect(insertPlan(k, l)).rejects.toThrow(RLS);
    await expect(insertPlan(a, k)).rejects.toThrow(RLS);
  });

  it('app.caller_coaches_client keys on app.current_user_id(): SECURITY DEFINER, empty search_path, EXECUTE for authenticated and service_role only', async () => {
    expect(await coaches(k, a)).toBe(true);
    expect(await coaches(l, a)).toBe(false);
    expect(await coaches(k, c)).toBe(false);
    expect(await coaches(k, a, DATA_API)).toBe(false);
    const { helper } = await catalog();
    expect(helper).toMatchObject({ definer: true, cfg: ['search_path=""'], anon_x: false, auth_x: true, svc_x: true, public_x: false });
    expect(helper.def).toContain('caller."id" = app.current_user_id()');
    expect(helper.def).not.toContain('auth.uid');
  });

  it('down.sql brings back the old denial on this data; the migration closes it again with an identical catalog', async () => {
    const after = await catalog();
    const seven = after.policies.filter((p) => SEVEN.includes(p.policyname));
    expect(seven).toHaveLength(7);
    for (const p of seven) {
      expect(`${p.qual} ${p.with_check}`).not.toContain('auth.uid');
      expect(p.qual).toContain('app.current_user_id() IS NOT NULL');
    }
    expect(after.policies.map((p) => p.policyname)).toEqual(expect.arrayContaining(['WorkoutPlan_links_in_tenant_insert', 'WorkoutPlan_links_in_tenant_update']));

    await runSql('down.sql');
    expect(await exists('WorkoutPlan', row.WorkoutPlan)).toBe(1);
    expect(await seen('WorkoutPlan', row.WorkoutPlan, k)).toBe(0);
    expect(await seen('WorkoutPlan', row.WorkoutPlan, k, { guc: true, jwt: true })).toBe(1);
    const before = await catalog();
    for (const p of before.policies.filter((x) => SEVEN.includes(x.policyname))) {
      expect(`${p.qual} ${p.with_check}`).toContain('auth.uid()');
      expect(`${p.qual} ${p.with_check}`).not.toContain('current_user_id');
    }
    expect(before.policies.find((p) => p.policyname === 'WorkoutPlan_coach_owner')?.qual).toContain('workout_program_stays_in_tenant');
    expect(before.helper).toMatchObject({ definer: true, anon_x: true, auth_x: true, svc_x: true, public_x: false });
    expect(before.helper.def).toContain('auth.uid()');

    await runSql('migration.sql');
    expect(await seen('WorkoutPlan', row.WorkoutPlan, k)).toBe(1);
    expect(await catalog()).toEqual(after);
  });
});
