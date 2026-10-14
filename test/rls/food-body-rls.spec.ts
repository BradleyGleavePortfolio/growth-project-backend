/**
 * Row security for food, weight, profile and meal-plan rows (RLSLIVE1a,
 * 20270502000700) on the replayed migration chain, as the non-bypass
 * `authenticated` role. Coach K coaches B, coach L coaches C, and client A
 * starts with coach F, then moves to K. Every user's supabase_id differs from
 * their id, so a policy keyed on the JWT subject could not pass by accident.
 * Every 0 or 42501 below follows a read or write of the same row that returned 1.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-body-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: food, weight, profile and meal plans follow the coaching relationship', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLABC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const TABLE: Record<string, string> = {
    food: 'LoggedFoodEntry', weight: 'WeightLog', profile: 'UserProfile',
    plan: 'DailyMealPlan', slot: 'DailyMealPlanSlot', template: 'MealTemplate', assign: 'DailyMealPlanAssignment', meal: 'MealPlan',
  };
  const BODY = ['food.A', 'weight.A', 'profile.A'];

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`fb-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "FoodItem" ("id", "name", "serving_description", "serving_size_grams", "calories", "protein_g", "carbs_g", "fat_g")
      VALUES (${id('oats')}, 'Oats', '1 bowl', 80, 300, 10, 50, 5)`;
    for (const k of 'ABC') {
      await prisma.$executeRaw`INSERT INTO "LoggedFoodEntry" ("id", "user_id", "date", "meal_type", "food_item_id")
        VALUES (${id(`food.${k}`)}, ${u[k]}, CURRENT_DATE, 'breakfast'::"MealType", ${id('oats')})`;
      await prisma.$executeRaw`INSERT INTO "WeightLog" ("id", "user_id", "date", "weight_lbs") VALUES (${id(`weight.${k}`)}, ${u[k]}, CURRENT_DATE, 180)`;
      await prisma.$executeRaw`INSERT INTO "UserProfile" ("id", "user_id", "updated_at") VALUES (${id(`profile.${k}`)}, ${u[k]}, now())`;
    }
    // K's plan held by A (assigned after the move), and the legacy plans F and K wrote for A.
    await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name") VALUES (${id('plan.K')}, ${u.K}, 'Plan')`;
    await prisma.$executeRaw`INSERT INTO "MealTemplate" ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g")
      VALUES (${id('template.K')}, ${u.K}, 'Meal', 500, 30, 50, 20)`;
    await prisma.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label")
      VALUES (${id('slot.K')}, ${id('plan.K')}, ${id('template.K')}, 'Lunch')`;
    for (const k of 'FK') {
      await prisma.$executeRaw`INSERT INTO "MealPlan" ("id", "coach_id", "client_id", "title", "items", "updated_at")
        VALUES (${id(`meal.${k}`)}, ${u[k]}, ${u.A}, 'Plan', '[]'::jsonb, now())`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Backend model: the API role with app.current_user_id (and the JWT subject).
  // Data API model (jwtOnly): the JWT subject alone, no GUC.
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>, jwtOnly = false) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (!jwtOnly) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      }
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const table = (row: string) => TABLE[row.split('.')[0]];
  const reads = async (who: string, rows: string[], jwtOnly = false) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [{ n }] = await as(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table(r)}" WHERE "id" = $1`, id(r)), jwtOnly);
      out[r] = n;
    }
    return out;
  };
  // Harmless writes (a column set to itself).
  const COL: Record<string, string> = { assign: 'starts_on', meal: 'title' };
  const write = (who: string, verb: 'UPDATE' | 'DELETE', r: string) => {
    const col = COL[r.split('.')[0]];
    const sql = verb === 'UPDATE' ? `UPDATE "${table(r)}" SET "${col}" = "${col}" WHERE "id" = $1` : `DELETE FROM "${table(r)}" WHERE "id" = $1`;
    return as(who, (tx) => tx.$executeRawUnsafe(sql, id(r)));
  };
  const all = (rows: string[], n: number) => Object.fromEntries(rows.map((r) => [r, n]));
  const sqlState = (p: Promise<unknown>) =>
    p.then(() => 'ok', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (/Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501)\b/.exec(msg))?.[1] ?? `unparsed: ${msg.slice(0, 200)}`;
    });
  const assign = (who: string, tag: string, plan: string, client: string, coach: string) =>
    as(who, (tx) => tx.$executeRaw`INSERT INTO "DailyMealPlanAssignment" ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
      VALUES (${id(tag)}, ${id(plan)}, ${u[client]}, ${u[coach]}, CURRENT_DATE)`);
  const addMeal = (who: string, tag: string, coach: string, client: string) =>
    as(who, (tx) => tx.$executeRaw`INSERT INTO "MealPlan" ("id", "coach_id", "client_id", "title", "items", "updated_at")
      VALUES (${id(tag)}, ${u[coach]}, ${u[client]}, 'Plan', '[]'::jsonb, now())`);

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the move, the coach of record reads the client\'s food, weight and profile, and writes their plan', async () => {
    expect(await reads('F', BODY)).toEqual(all(BODY, 1));
    expect(await reads('K', ['food.B', 'weight.B', 'profile.B'])).toEqual(all(['food.B', 'weight.B', 'profile.B'], 1));
    expect(await reads('K', BODY)).toEqual(all(BODY, 0));
    expect(await reads('F', ['meal.F'])).toEqual({ 'meal.F': 1 });
    expect(await write('F', 'UPDATE', 'meal.F')).toBe(1);
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it('the current coach reads A\'s food, weight and profile; the former coach and another coach read none', async () => {
      expect(await reads('A', BODY)).toEqual(all(BODY, 1));
      expect(await reads('K', BODY)).toEqual(all(BODY, 1));
      expect(await reads('F', BODY)).toEqual(all(BODY, 0));
      expect(await reads('L', BODY)).toEqual(all(BODY, 0));
      expect(await reads('B', BODY)).toEqual(all(BODY, 0));
      expect(await reads('L', ['food.C', 'weight.C', 'profile.C'])).toEqual(all(['food.C', 'weight.C', 'profile.C'], 1));
      expect(await reads('K', ['food.C', 'weight.C', 'profile.C'])).toEqual(all(['food.C', 'weight.C', 'profile.C'], 0));
    });

    it('only the client\'s coach writes plan assignments; the client no longer can', async () => {
      expect(await assign('K', 'assign.A', 'plan.K', 'A', 'K')).toBe(1);
      expect(await sqlState(assign('A', 'assign.A2', 'plan.K', 'A', 'K'))).toBe('42501');
      expect(await sqlState(assign('C', 'assign.C', 'plan.K', 'C', 'K'))).toBe('42501');
      expect(await sqlState(assign('F', 'assign.F', 'plan.K', 'A', 'F'))).toBe('42501');
      expect(await reads('A', ['assign.A'])).toEqual({ 'assign.A': 1 });
      expect(await write('A', 'UPDATE', 'assign.A')).toBe(0);
      expect(await write('A', 'DELETE', 'assign.A')).toBe(0);
      expect(await write('K', 'UPDATE', 'assign.A')).toBe(1);
    });

    it('the client reads the plan they hold, its slot and its template; another client reads none', async () => {
      const PLAN = ['plan.K', 'slot.K', 'template.K'];
      expect(await reads('K', PLAN)).toEqual(all(PLAN, 1));
      expect(await reads('A', PLAN)).toEqual(all(PLAN, 1));
      expect(await reads('B', PLAN)).toEqual(all(PLAN, 0));
      expect(await reads('C', PLAN)).toEqual(all(PLAN, 0));
      expect(await reads('L', PLAN)).toEqual(all(PLAN, 0));
    });

    it('MealPlan: the client and current coach read it, only the current coach writes it, the former coach loses it', async () => {
      expect(await reads('A', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.K': 1 });
      expect(await reads('K', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.K': 1 });
      expect(await reads('F', ['meal.F'])).toEqual({ 'meal.F': 0 });
      expect(await write('F', 'UPDATE', 'meal.F')).toBe(0);
      expect(await write('K', 'UPDATE', 'meal.K')).toBe(1);
      expect(await write('A', 'UPDATE', 'meal.K')).toBe(0);
      expect(await write('A', 'DELETE', 'meal.K')).toBe(0);
      expect(await write('K', 'UPDATE', 'meal.F')).toBe(0);
      expect(await addMeal('K', 'meal.K2', 'K', 'A')).toBe(1);
      expect(await sqlState(addMeal('A', 'meal.A', 'K', 'A'))).toBe('42501');
      expect(await sqlState(addMeal('L', 'meal.L', 'L', 'A'))).toBe('42501');
      expect(await sqlState(addMeal('K', 'meal.KC', 'K', 'C'))).toBe('42501');
      expect(await reads('L', ['meal.K'])).toEqual({ 'meal.K': 0 });
    });

    it('the Data API model (JWT only, no app.current_user_id) reads and writes none of it', async () => {
      const A_ROWS = [...BODY, 'plan.K', 'slot.K', 'template.K', 'assign.A', 'meal.K'];
      const K_ROWS = [...BODY, 'plan.K', 'slot.K', 'template.K', 'assign.A', 'meal.K', 'food.B'];
      expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
      expect(await reads('A', A_ROWS, true)).toEqual(all(A_ROWS, 0));
      expect(await reads('K', K_ROWS)).toEqual(all(K_ROWS, 1));
      expect(await reads('K', K_ROWS, true)).toEqual(all(K_ROWS, 0));
      expect(await as('K', (tx) => tx.$executeRawUnsafe(`UPDATE "MealPlan" SET "title" = "title" WHERE "id" = $1`, id('meal.K')), true)).toBe(0);
    });
  });

  it('the server\'s service role still reads and writes every row', async () => {
    const rows = [...BODY, 'food.C', 'plan.K', 'slot.K', 'template.K', 'assign.A', 'meal.F', 'meal.K'];
    const seen = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      const out: Record<string, number> = {};
      for (const r of rows) {
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table(r)}" WHERE "id" = $1`, id(r));
        out[r] = n;
      }
      out.write = await tx.$executeRawUnsafe(`UPDATE "MealPlan" SET "title" = "title" WHERE "id" = $1`, id('meal.F'));
      return out;
    });
    expect(seen).toEqual({ ...all(rows, 1), write: 1 });
  });

  it('the two helpers are SECURITY DEFINER with an empty search_path, and only the API and service roles run them', async () => {
    const rows = await prisma.$queryRaw<{ name: string; definer: boolean; config: string[]; anon: boolean; authed: boolean; service: boolean }[]>`
      SELECT p."proname" AS "name", p."prosecdef" AS "definer", p."proconfig" AS "config",
             has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
             has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed",
             has_function_privilege('service_role', p."oid", 'EXECUTE') AS "service"
      FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
      WHERE n."nspname" = 'app' AND p."proname" IN ('caller_holds_meal_plan', 'caller_holds_meal_template') ORDER BY 1`;
    const expected = { definer: true, config: ['search_path=""'], anon: false, authed: true, service: true };
    expect(rows).toEqual([{ name: 'caller_holds_meal_plan', ...expected }, { name: 'caller_holds_meal_template', ...expected }]);
  });
});
