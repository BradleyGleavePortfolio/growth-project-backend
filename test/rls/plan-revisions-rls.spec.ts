/**
 * PLAN-SWAPS-BE (20270502011100): the row rules of DailyMealPlanRevision (today's plan changes), and the
 * new columns on the tables whose rules already cover them, on the replayed migration chain as the
 * non-bypass `authenticated` role. Coach K coaches B, coach L coaches C, client A starts with coach K and
 * then moves to L. plan.K is held by A and B; plan.L by C. Every 0 below follows a 1 for the same caller
 * on a row of the same kind (its control read).
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('plan-revisions-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)("Row rules: a plan's changes follow the plan", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'KLABCX'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'K', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'KL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const REV = `SELECT count(*)::int AS "n" FROM "DailyMealPlanRevision" WHERE "id" = $1`;

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`pr-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    for (const [plan, coach, clients] of [['K', 'K', ['A', 'B']], ['L', 'L', ['C']]] as const) {
      await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name") VALUES (${id(`plan.${plan}`)}, ${u[coach]}, 'Plan')`;
      await prisma.$executeRaw`INSERT INTO "MealTemplate" ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g", "swap_template_ids")
        VALUES (${id(`tpl.${plan}`)}, ${u[coach]}, 'Meal', 500, 30, 50, 20, ARRAY[]::TEXT[])`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label")
        VALUES (${id(`slot.${plan}`)}, ${id(`plan.${plan}`)}, ${id(`tpl.${plan}`)}, 'breakfast')`;
      for (const c of clients) {
        await prisma.$executeRaw`INSERT INTO "DailyMealPlanAssignment" ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
          VALUES (${id(`hold.${plan}.${c}`)}, ${id(`plan.${plan}`)}, ${u[c]}, ${u[coach]}, CURRENT_DATE)`;
      }
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanRevision" ("id", "plan_id", "slot_id", "slot_label", "from_template_id", "to_template_id")
        VALUES (${id(`rev.${plan}`)}, ${id(`plan.${plan}`)}, ${id(`slot.${plan}`)}, 'breakfast', NULL, ${id(`tpl.${plan}`)})`;
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
  const reads = async (who: string, r: string) => {
    const [{ n }] = await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(REV, id(r)));
    return n;
  };
  const sqlstate = (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused';
  const write = (who: string, sql: string, ...args: string[]) =>
    as(who, (tx) => tx.$executeRawUnsafe(sql, ...args)).then((n) => n, sqlstate);

  it('runs as a role that does not bypass row security, on a table that forces it, with no anon access', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT "relrowsecurity" AS "enabled", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "relnamespace" = 'public'::regnamespace AND "relname" = 'DailyMealPlanRevision'`).toEqual([{ enabled: true, forced: true }]);
    const anon = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM information_schema.role_table_grants
      WHERE "grantee" = 'anon' AND "table_schema" = 'public' AND "table_name" = 'DailyMealPlanRevision'`;
    expect(anon).toEqual([{ n: 0 }]);
  });

  it("a client reads the changes of a plan they hold, and another client's are refused", async () => {
    expect(await reads('A', 'rev.K')).toBe(1);
    expect(await reads('B', 'rev.K')).toBe(1);
    expect(await reads('C', 'rev.L')).toBe(1);
    expect(await reads('C', 'rev.K')).toBe(0);
    expect(await reads('A', 'rev.L')).toBe(0);
    expect(await reads('X', 'rev.K')).toBe(0);
  });

  it("the plan's coach reads its changes; another coach reads none", async () => {
    expect(await reads('K', 'rev.K')).toBe(1);
    expect(await reads('L', 'rev.L')).toBe(1);
    expect(await reads('L', 'rev.K')).toBe(0);
    expect(await reads('K', 'rev.L')).toBe(0);
  });

  it('no API role writes, changes or deletes a change (the server writes it as service_role)', async () => {
    const INSERT = `INSERT INTO "DailyMealPlanRevision" ("id", "plan_id", "slot_id", "slot_label") VALUES ($1, $2, 'x', 'lunch')`;
    for (const who of 'KLAB') {
      expect(await write(who, INSERT, randomUUID(), id('plan.K'))).not.toBe(1);
      expect(await write(who, `UPDATE "DailyMealPlanRevision" SET "slot_label" = 'x' WHERE "id" = $1`, id('rev.K'))).not.toBe(1);
      expect(await write(who, `DELETE FROM "DailyMealPlanRevision" WHERE "id" = $1`, id('rev.K'))).not.toBe(1);
    }
    expect(await reads('A', 'rev.K')).toBe(1);
    const server = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return tx.$executeRawUnsafe(INSERT, id('rev.K-server'), id('plan.K'));
    });
    expect(server).toBe(1);
  });

  it("the new columns stay under their tables' rules: grocery items are server-only, template columns read as before", async () => {
    await prisma.$executeRaw`INSERT INTO "ListItem" ("id", "user_id", "list_type", "name", "source_plan_slot_id")
      VALUES (${id('item.A')}, ${u.A}, 'grocery'::"ListType", 'Oats', ${id('slot.K')})`;
    // ListItem keeps its server-only posture (20270125000000): no API role reads it, its owner included
    // (no table grant: 42501), while the server role reads the new link.
    const item = `SELECT count(*)::int AS "n" FROM "ListItem" WHERE "id" = $1`;
    for (const who of 'AB') {
      expect(await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(item, id('item.A'))).then((r) => r, sqlstate)).toBe('42501');
    }
    expect(await prisma.$queryRawUnsafe<{ n: number }[]>(`${item} AND "source_plan_slot_id" = $2`, id('item.A'), id('slot.K'))).toEqual([{ n: 1 }]);
    const tpl = `SELECT count(*)::int AS "n" FROM "MealTemplate" WHERE "id" = $1 AND "swap_template_ids" = ARRAY[]::TEXT[] AND "recipe_id" IS NULL`;
    expect(await as('K', (tx) => tx.$queryRawUnsafe<{ n: number }[]>(tpl, id('tpl.K')))).toEqual([{ n: 1 }]);
    expect(await as('L', (tx) => tx.$queryRawUnsafe<{ n: number }[]>(tpl, id('tpl.K')))).toEqual([{ n: 0 }]);
    // A removed meal leaves the grocery item; only the link goes (ON DELETE SET NULL).
    await prisma.$executeRaw`DELETE FROM "DailyMealPlanSlot" WHERE "id" = ${id('slot.K')}`;
    expect(await prisma.$queryRaw<{ link: string | null }[]>`SELECT "source_plan_slot_id" AS "link" FROM "ListItem" WHERE "id" = ${id('item.A')}`).toEqual([{ link: null }]);
    // The revision outlives its slot (history); it goes only with its plan (ON DELETE CASCADE).
    expect(await reads('A', 'rev.K')).toBe(1);
  });

  describe('after A moves from coach K to coach L', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.L} WHERE "id" = ${u.A}`;
    });

    it("A still reads the changes of the plan they hold; coach L, now A's coach, reads none of plan K's", async () => {
      expect(await reads('A', 'rev.K')).toBe(1);
      expect(await reads('L', 'rev.L')).toBe(1);
      expect(await reads('L', 'rev.K')).toBe(0);
    });

    it("coach K, who no longer keeps every client of plan K, reads its changes no more (app.caller_keeps_meal_plan)", async () => {
      expect(await reads('B', 'rev.K')).toBe(1);
      expect(await reads('K', 'rev.K')).toBe(0);
    });
  });
});
