/**
 * C2-C0 (20270502004500): the coach's planned times follow the row rules they
 * sit on, on the replayed migration chain as the non-bypass `authenticated`
 * role. Coach K coaches B, coach L coaches C, and client A starts with coach F,
 * then moves to K. Columns: DailyMealPlanSlot.time_of_day (a meal's time) and
 * ClientWorkoutAssignment.scheduled_time (the day's training time). plan.Fz is
 * the archived copy of F's plan held only by A (the state freezeForMovedClients
 * leaves). Every 0 below follows a 1 for the same caller on a row of the same
 * kind (its control read or write).
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip,
 * except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('planned-times-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)("Row rules: the coach's planned meal and workout times follow the client", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLABC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  // Each row is counted only when its new column holds what was written.
  const SEEN: Record<string, string> = {
    slot: `SELECT count(*)::int AS "n" FROM "DailyMealPlanSlot" WHERE "id" = $1 AND "time_of_day" = '07:30'`,
    day: `SELECT count(*)::int AS "n" FROM "ClientWorkoutAssignment" WHERE "id" = $1 AND "scheduled_time" = '17:30'`,
  };

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`pt-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    // [plan, coach, client, archived]
    for (const [plan, coach, client, archived] of [['F', 'F', 'A', false], ['Fz', 'F', 'A', true], ['K', 'K', 'B', false], ['L', 'L', 'C', false]] as const) {
      await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name", "archived_at")
        VALUES (${id(`plan.${plan}`)}, ${u[coach]}, 'Plan', ${archived ? new Date() : null})`;
      await prisma.$executeRaw`INSERT INTO "MealTemplate" ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g", "archived_at")
        VALUES (${id(`tpl.${plan}`)}, ${u[coach]}, 'Meal', 500, 30, 50, 20, ${archived ? new Date() : null})`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label", "time_of_day")
        VALUES (${id(`slot.${plan}`)}, ${id(`plan.${plan}`)}, ${id(`tpl.${plan}`)}, 'breakfast', '07:30')`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanAssignment" ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
        VALUES (${id(`hold.${plan}`)}, ${id(`plan.${plan}`)}, ${u[client]}, ${u[coach]}, CURRENT_DATE)`;
      if (archived) continue;
      await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
        VALUES (${id(`wplan.${plan}`)}, ${u[coach]}, 'Day', 'strength', now())`;
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignment" ("id", "workout_plan_id", "client_id", "assigned_by_coach_id", "scheduled_for", "scheduled_time")
        VALUES (${id(`day.${plan}`)}, ${id(`wplan.${plan}`)}, ${u[client]}, ${u[coach]}, now(), '17:30')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const reads = async (who: string, rows: string[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [{ n }] = await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(SEEN[r.split('.')[0]], id(r)));
      out[r] = n;
    }
    return out;
  };
  const all = (rows: string[], n: number) => Object.fromEntries(rows.map((r) => [r, n]));
  const sqlstate = (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused';
  // A write as `who` (an API role) or as the server's service_role: the row count, or the SQLSTATE it was refused with.
  const write = (who: string, sql: string, r: string) => as(who, (tx) => tx.$executeRawUnsafe(sql, id(r))).then((n) => n, sqlstate);
  const asServer = (sql: string, r: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return tx.$executeRawUnsafe(sql, id(r));
    }).then((n) => n, sqlstate);
  // A meal the coach adds to a plan with its time.
  const addSlot = (who: string, tag: string, plan: string) =>
    as(who, (tx) => tx.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label", "order", "time_of_day")
      VALUES (${id(tag)}, ${id(`plan.${plan}`)}, ${id(`tpl.${plan}`)}, 'dinner', 1, '18:45')`).then((n) => n, sqlstate);
  const SLOT_TIME = `UPDATE "DailyMealPlanSlot" SET "time_of_day" = "time_of_day" WHERE "id" = $1`;
  const DAY_TIME = `UPDATE "ClientWorkoutAssignment" SET "scheduled_time" = "scheduled_time" WHERE "id" = $1`;
  const A_ROWS = ['slot.F', 'slot.Fz', 'day.F'];

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw<{ table: string; enabled: boolean; forced: boolean }[]>`
      SELECT "relname" AS "table", "relrowsecurity" AS "enabled", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "relnamespace" = 'public'::regnamespace AND "relname" IN ('ClientWorkoutAssignment', 'DailyMealPlanSlot') ORDER BY "relname"`).toEqual([
      { table: 'ClientWorkoutAssignment', enabled: true, forced: true },
      { table: 'DailyMealPlanSlot', enabled: true, forced: true },
    ]);
  });

  it('before the move: A and coach F read the times; coach K, coach L, client B and client C read none (each after reading 1 of their own)', async () => {
    expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
    expect(await reads('F', A_ROWS)).toEqual(all(A_ROWS, 1));
    for (const [who, own] of [['K', 'K'], ['B', 'K'], ['L', 'L'], ['C', 'L']]) {
      expect(await reads(who, [`slot.${own}`, `day.${own}`])).toEqual(all([`slot.${own}`, `day.${own}`], 1));
      expect(await reads(who, A_ROWS)).toEqual(all(A_ROWS, 0));
    }
  });

  it("before the move: only the plan's coach sets a meal's time; no other coach and no client does", async () => {
    for (const who of 'FKL') expect(await write(who, SLOT_TIME, `slot.${who}`)).toBe(1);
    for (const who of 'AKLBC') expect(await write(who, SLOT_TIME, 'slot.F')).toBe(0);
    expect(await addSlot('F', 'slot.F-added', 'F')).toBe(1);
    for (const who of 'AKB') expect(await addSlot(who, `slot.F-by-${who}`, 'F')).toBe('42501');
  });

  it("no API role writes a workout day's time, the assigning coach F included (the backend writes it as service_role)", async () => {
    for (const who of 'FAKLBC') {
      expect(await write(who, DAY_TIME, 'day.F')).not.toBe(1);
      expect(await write(who, `UPDATE "ClientWorkoutAssignment" SET "scheduled_time" = '05:00' WHERE "id" = $1`, 'day.F')).not.toBe(1);
    }
    expect(await reads('A', ['day.F'])).toEqual({ 'day.F': 1 });
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it("A keeps every time; the current coach reads A's workout time; the former coach reads neither A's day nor A's frozen copy", async () => {
      expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
      expect(await reads('K', ['day.F'])).toEqual({ 'day.F': 1 });
      // The new coach does not read the former coach's plan, nor its copy.
      expect(await reads('K', ['slot.F', 'slot.Fz'])).toEqual({ 'slot.F': 0, 'slot.Fz': 0 });
      expect(await reads('F', ['slot.Fz', 'day.F'])).toEqual({ 'slot.Fz': 0, 'day.F': 0 });
      // slot.F is F's own live plan (the plan, not A's data): F still reads it,
      // and the app moves A to a frozen copy before F's next edit reaches them.
      expect(await reads('F', ['slot.F'])).toEqual({ 'slot.F': 1 });
      for (const who of 'LBC') expect(await reads(who, A_ROWS)).toEqual(all(A_ROWS, 0));
    });

    it('the former coach no longer sets or adds a time on a plan A holds; no API role writes the day', async () => {
      expect(await write('F', SLOT_TIME, 'slot.F')).toBe(0);
      expect(await write('F', SLOT_TIME, 'slot.Fz')).toBe(0);
      expect(await addSlot('F', 'slot.F-late', 'F')).toBe('42501');
      expect(await write('K', SLOT_TIME, 'slot.F')).toBe(0);
      for (const who of 'AKFLBC') expect(await write(who, DAY_TIME, 'day.F')).not.toBe(1);
      expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
    });
  });

  it("the server's service role writes both times, and the database refuses anything but HH:MM", async () => {
    expect(await asServer(SLOT_TIME, 'slot.K')).toBe(1);
    expect(await asServer(DAY_TIME, 'day.K')).toBe(1);
    for (const bad of ['25:00', '7:30', '12:60', 'noon']) {
      expect(await asServer(`UPDATE "DailyMealPlanSlot" SET "time_of_day" = '${bad}' WHERE "id" = $1`, 'slot.K')).toBe('23514');
      expect(await asServer(`UPDATE "ClientWorkoutAssignment" SET "scheduled_time" = '${bad}' WHERE "id" = $1`, 'day.K')).toBe('23514');
    }
    expect(await reads('B', ['slot.K', 'day.K'])).toEqual({ 'slot.K': 1, 'day.K': 1 });
  });
});
