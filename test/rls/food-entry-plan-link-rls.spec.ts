/**
 * FOODLINK — live row security for the food log plan link (20270420000000, 20270420000001).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay (the whole migration chain
 * from empty). Principals are API shaped: SET LOCAL ROLE authenticated with the
 * app.current_user_id / app.current_user_role GUCs the policies read.
 *
 * Proves: LoggedFoodEntry keeps ENABLE + FORCE and its one owner-only policy, which covers the
 * new columns; client B's context reads, edits and deletes none of client A's entries on the
 * same date, link included (the read GET /log/daily makes, decision 141-4 test 13); a coach
 * deleting a plan meal under row security clears the link on a client's entry the coach cannot
 * read and deletes no food log; the columns, FK and index have the names Prisma generates.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-entry-plan-link-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('LoggedFoodEntry plan link: row security (FOODLINK)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [a, b, coach] = [randomUUID(), randomUUID(), randomUUID()];
  const [slot, slot2, plan, plan2, food] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [entryA, entryA2, entryB] = [randomUUID(), randomUUID(), randomUUID()];

  type Row = { id: string; user_id: string; plan_slot_id: string | null; fills_usual_meal: boolean };
  const as = <T>(userId: string, run: (tx: Prisma.TransactionClient) => Promise<T>, role = 'student') =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, userId);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      return run(tx);
    });
  const byId = (x: Row, y: Row) => (x.id < y.id ? -1 : 1);
  const rows = async (tx: Prisma.TransactionClient, where = 'true') =>
    (await tx.$queryRawUnsafe<Row[]>(
      `SELECT "id", "user_id", "plan_slot_id", "fills_usual_meal" FROM "LoggedFoodEntry" WHERE ${where}`,
    )).sort(byId);
  const stored = (id: string) => prisma.loggedFoodEntry.findUnique({ where: { id } });

  beforeAll(async () => {
    for (const [id, name] of [[a, 'Client A'], [b, 'Client B'], [coach, 'Coach']]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name") VALUES (${id}, ${id}, ${`${id}@example.test`}, ${name})`;
    }
    await prisma.$executeRaw`INSERT INTO "FoodItem" ("id", "name", "serving_description", "serving_size_grams", "calories", "protein_g", "carbs_g", "fat_g")
      VALUES (${food}, 'Oats', '1 bowl', 80, 300, 10, 50, 5)`;
    const tpl = randomUUID();
    await prisma.$executeRaw`INSERT INTO "MealTemplate" ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g")
      VALUES (${tpl}, ${coach}, 'Oats', 300, 10, 50, 5)`;
    for (const [p, s] of [[plan, slot], [plan2, slot2]]) {
      await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name") VALUES (${p}, ${coach}, 'Plan')`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label")
        VALUES (${s}, ${p}, ${tpl}, 'breakfast')`;
    }
    const entries: [string, string, string | null, boolean][] = [
      [entryA, a, slot, false],
      [entryA2, a, slot2, true],
      [entryB, b, null, true],
    ];
    for (const [id, user, link, usual] of entries) {
      await prisma.$executeRaw`INSERT INTO "LoggedFoodEntry" ("id", "user_id", "date", "meal_type", "food_item_id", "plan_slot_id", "fills_usual_meal")
        VALUES (${id}, ${user}, '2026-10-12'::date, 'breakfast'::"MealType", ${food}, ${link}, ${usual})`;
    }
  }, 60_000);
  afterAll(() => prisma.$disconnect());

  it('LoggedFoodEntry keeps ENABLE + FORCE and only its owner policy, which covers the new columns', async () => {
    const [flags] = await prisma.$queryRaw<{ on: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS "on", relforcerowsecurity AS forced FROM pg_class WHERE oid = '"LoggedFoodEntry"'::regclass`;
    expect(flags).toEqual({ on: true, forced: true });
    const policies = await prisma.$queryRaw<{ policyname: string; cmd: string; qual: string; with_check: string }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'LoggedFoodEntry'`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyname: 'food_entry_owner_access', cmd: 'ALL' });
    expect(policies[0].qual).toMatch(/user_id = app\.current_user_id\(\)/);
    expect(policies[0].with_check).toMatch(/user_id = app\.current_user_id\(\)/);
  });

  it("each client reads only their own entries and links on the same date (GET /log/daily's read)", async () => {
    expect(await as(a, (tx) => rows(tx))).toEqual(
      [
        { id: entryA, user_id: a, plan_slot_id: slot, fills_usual_meal: false },
        { id: entryA2, user_id: a, plan_slot_id: slot2, fills_usual_meal: true },
      ].sort(byId),
    );
    expect(await as(b, (tx) => rows(tx))).toEqual([{ id: entryB, user_id: b, plan_slot_id: null, fills_usual_meal: true }]);
    expect(await as(b, (tx) => rows(tx, `"plan_slot_id" = '${slot}' OR "user_id" = '${a}'`))).toEqual([]);
    expect(await as('', (tx) => rows(tx))).toEqual([]);
  });

  it("client B cannot edit, re-link, delete or forge client A's entries", async () => {
    expect(await as(b, (tx) => tx.$executeRawUnsafe(
      `UPDATE "LoggedFoodEntry" SET "plan_slot_id" = NULL, "fills_usual_meal" = true WHERE "id" = $1`, entryA))).toBe(0);
    expect(await as(b, (tx) => tx.$executeRawUnsafe(`DELETE FROM "LoggedFoodEntry" WHERE "user_id" = $1`, a))).toBe(0);
    await expect(as(b, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "LoggedFoodEntry" ("id", "user_id", "date", "meal_type", "food_item_id", "plan_slot_id")
       VALUES ($1, $2, '2026-10-12'::date, 'breakfast'::"MealType", $3, $4)`, randomUUID(), a, food, slot))).rejects.toThrow(/row-level security/);
    expect(await stored(entryA)).toMatchObject({ user_id: a, plan_slot_id: slot, fills_usual_meal: false });
  });

  it("a coach deleting a plan meal under row security unlinks the client's entry and deletes no food log", async () => {
    expect(await as(coach, (tx) => rows(tx), 'coach')).toEqual([]);
    expect(await as(coach, (tx) => tx.$executeRawUnsafe(`DELETE FROM "DailyMealPlanSlot" WHERE "id" = $1`, slot), 'coach')).toBe(1);
    expect(await stored(entryA)).toMatchObject({ user_id: a, plan_slot_id: null });
    // Coach account deletion: the plan cascades to its slots, and the link goes null the same way.
    await prisma.$executeRaw`DELETE FROM "DailyMealPlan" WHERE "id" = ${plan2}`;
    expect(await stored(entryA2)).toMatchObject({ user_id: a, plan_slot_id: null, fills_usual_meal: true });
    expect(await prisma.loggedFoodEntry.count({ where: { id: { in: [entryA, entryA2, entryB] } } })).toBe(3);
  });

  it('the columns, FK and index exist with the names Prisma generates', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'LoggedFoodEntry' AND column_name IN ('plan_slot_id', 'fills_usual_meal')
      ORDER BY column_name`;
    expect(cols).toEqual([
      { column_name: 'fills_usual_meal', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'plan_slot_id', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    const [fk] = await prisma.$queryRaw<{ del: string; upd: string; valid: boolean; target: string }[]>`
      SELECT confdeltype::text AS del, confupdtype::text AS upd, convalidated AS valid, confrelid::regclass::text AS target
      FROM pg_constraint WHERE conname = 'LoggedFoodEntry_plan_slot_id_fkey'`;
    expect(fk).toEqual({ del: 'n', upd: 'c', valid: true, target: '"DailyMealPlanSlot"' });
    const [idx] = await prisma.$queryRaw<{ valid: boolean; def: string }[]>`
      SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
      WHERE i.indexrelid = '"LoggedFoodEntry_plan_slot_id_idx"'::regclass`;
    expect(idx.valid).toBe(true);
    expect(idx.def).toMatch(/ON public\."LoggedFoodEntry" USING btree \(plan_slot_id\)/);
  });
});
