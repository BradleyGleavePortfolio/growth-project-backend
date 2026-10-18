/**
 * FOODLINK — live row security for the food log plan link (20270502005200, 20270502005300, 20270502005400).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay (the whole migration chain
 * from empty). Principals are API shaped: SET LOCAL ROLE authenticated with the
 * app.current_user_id / app.current_user_role GUCs the policies read.
 *
 * Proves: LoggedFoodEntry keeps ENABLE + FORCE and only its owner policy and the current coach's
 * SELECT policy (20270502000700), which cover the new columns; client B's context reads, edits
 * and deletes none of client A's entries on the same date, link included (the read GET
 * /log/daily makes, decision 141-4 test 13); a coach deleting a plan meal under row security
 * clears the link on a client's entry the coach cannot read and deletes no food log; a client
 * who moved coach keeps every meal they logged done on the frozen copy of their plan after the
 * former coach edits the plan or a meal, while the staying client's links stay on the live plan;
 * the columns, FK and index have the names Prisma generates.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-entry-plan-link-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('LoggedFoodEntry plan link: row security (FOODLINK)', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
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

  it('LoggedFoodEntry keeps ENABLE + FORCE and only its owner and current-coach policies, which cover the new columns', async () => {
    const [flags] = await prisma.$queryRaw<{ on: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS "on", relforcerowsecurity AS forced FROM pg_class WHERE oid = '"LoggedFoodEntry"'::regclass`;
    expect(flags).toEqual({ on: true, forced: true });
    const policies = await prisma.$queryRaw<{ policyname: string; cmd: string; qual: string; with_check: string | null }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'LoggedFoodEntry'
      ORDER BY policyname`;
    expect(policies.map((p) => [p.policyname, p.cmd])).toEqual([
      ['food_entry_current_coach_select', 'SELECT'],
      ['food_entry_owner_access', 'ALL'],
    ]);
    expect(policies[0].qual).toMatch(/is_current_coach_of\(user_id\)/);
    expect(policies[1].qual).toMatch(/user_id = app\.current_user_id\(\)/);
    expect(policies[1].with_check).toMatch(/user_id = app\.current_user_id\(\)/);
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

  describe("a moved client's logged meals follow the frozen copy of their plan (freezeForMovedClients)", () => {
    // The production service on the server's connection; X moves from coach A to coach B, Y stays.
    const meals = new RealMealPlansService(prisma);
    const [coachA, coachB, x, y] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const DAY = '2026-10-12';
    const ids: Record<string, string> = {};
    // What a client's day read shows (GET /me/meal-plan/today): each plan meal, its time, and done if a food is linked to it.
    const day = async (client: string) => {
      const linked = new Set((await prisma.loggedFoodEntry.findMany({ where: { user_id: client } })).map((e) => e.plan_slot_id));
      const { assignments } = await meals.getTodayForClient(client, DAY);
      return assignments.flatMap(({ daily_meal_plan: p }) =>
        p.slots.map((s) => `${p.name} ${s.slot_label} ${s.time_of_day ?? '-'} ${linked.has(s.id) ? 'done' : 'open'}`)).sort();
    };
    const count = (who: string, role: string, sql: string, arg: string) =>
      as(who, async (tx) => (await tx.$queryRawUnsafe<{ n: number }[]>(sql, arg))[0].n, role);
    const ENTRIES = `SELECT count(*)::int AS "n" FROM "LoggedFoodEntry" WHERE "user_id" = $1`;
    const LINKED_SLOTS = `SELECT count(*)::int AS "n" FROM "DailyMealPlanSlot" s JOIN "LoggedFoodEntry" e ON e."plan_slot_id" = s."id" WHERE e."user_id" = $1`;

    beforeAll(async () => {
      for (const [id, role, coachId] of [[coachA, 'coach', null], [coachB, 'coach', null], [x, 'student', coachA], [y, 'student', coachA]]) {
        await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
          VALUES (${id}, ${id}, ${`${id}@example.test`}, 'RLS user', ${role}::"Role", ${coachId})`;
      }
      for (const name of ['Oats', 'Rice', 'Eggs']) {
        ids[name] = (await meals.createTemplate(coachA, { name, calories_kcal: 400, protein_g: 20, carbs_g: 50, fats_g: 10 })).id;
      }
      const dayPlan = await meals.createPlan(coachA, { name: 'Day', slots: [
        { meal_template_id: ids.Oats, slot_label: 'breakfast', time_of_day: '07:30' }, { meal_template_id: ids.Rice, slot_label: 'lunch' },
      ] });
      const otherPlan = await meals.createPlan(coachA, { name: 'Other', slots: [{ meal_template_id: ids.Eggs, slot_label: 'dinner' }] });
      [ids.Day, ids.Other] = [dayPlan!.id, otherPlan!.id];
      for (const client_id of [x, y]) {
        for (const plan of [dayPlan!, otherPlan!]) {
          await meals.assignPlan(coachA, plan.id, { client_id, starts_on: '2026-10-01' });
          for (const slot of plan.slots) {
            await prisma.loggedFoodEntry.create({ data: { user_id: client_id, date: new Date(DAY), meal_type: 'breakfast', food_item_id: food, plan_slot_id: slot.id } });
          }
        }
      }
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${coachB} WHERE "id" = ${x}`;
    }, 60_000);

    const asLogged = ['Day breakfast 07:30 done', 'Day lunch - done', 'Other dinner - done'];

    it('before any edit, both clients see every meal they logged done', async () => {
      expect(await day(x)).toEqual(asLogged);
      expect(await day(y)).toEqual(asLogged);
    });

    it("coach A retimes a meal and removes one: X's day is as it was, all done; Y's kept meal stays done; no food log is deleted", async () => {
      await meals.updatePlan(coachA, ids.Day, { slots: [{ meal_template_id: ids.Oats, slot_label: 'breakfast', time_of_day: '08:00' }] });
      expect(await day(x)).toEqual(asLogged);
      expect(await day(y)).toEqual(['Day breakfast 08:00 done', 'Other dinner - done']);
      expect(await prisma.loggedFoodEntry.count({ where: { user_id: { in: [x, y] } } })).toBe(6);
    });

    it("coach A edits a meal another plan uses: X's copy of that plan keeps the meal done; Y's stays on the live plan", async () => {
      await meals.updateTemplate(coachA, ids.Eggs, { name: 'Eggs, edited' });
      expect(await day(x)).toEqual(asLogged);
      expect(await day(y)).toEqual(['Day breakfast 08:00 done', 'Other dinner - done']);
      const held = (client: string) => meals.getTodayForClient(client, DAY).then((d) => d.assignments.map((a) => a.daily_meal_plan_id).sort());
      expect(await held(y)).toEqual([ids.Day, ids.Other].sort());
      expect((await held(x)).some((id) => id === ids.Day || id === ids.Other)).toBe(false);
    });

    it('under row security, X opens every plan meal its foods name; coach A reads none of X\'s foods after reading Y\'s; coach B reads X\'s', async () => {
      expect(await count(x, 'student', LINKED_SLOTS, x)).toBe(3);
      expect(await count(y, 'student', LINKED_SLOTS, y)).toBe(2);
      expect(await count(y, 'student', ENTRIES, y)).toBe(3);
      expect(await count(y, 'student', ENTRIES, x)).toBe(0);
      expect(await count(coachA, 'coach', ENTRIES, y)).toBe(3);
      expect(await count(coachA, 'coach', ENTRIES, x)).toBe(0);
      expect(await count(coachB, 'coach', ENTRIES, x)).toBe(3);
    });
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
