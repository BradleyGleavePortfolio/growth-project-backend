/**
 * FIX-1221: the rest of the B1/B2 classes on a live database (replayed migration chain).
 *   B1: a coach saving a meal back with a swap archived since is accepted under RLS; adding an archived
 *       swap or the meal itself is refused (p_mealtemplate_links_insert/_update, 20270502011100).
 *   B2: when a former coach's edit freezes a moved client's plan, a change naming a meal no longer in the
 *       plan keeps its name from a frozen snapshot, the live plan keeps its own history, and a client who
 *       stayed keeps their grocery item on the live slot.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ListsService } from '../../src/lists/lists.service';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('FIX-1221 live proof requires TEST_DATABASE_URL under CI.');
}

const meal = { calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 };

(url ? describe : describe.skip)('FIX-1221 B1: a meal\'s stored swaps save back under RLS', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const k = randomUUID();
  const sub = randomUUID();
  const own = randomUUID();
  const linked = randomUUID();
  const archived = randomUUID();

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${k}, ${sub}, ${`fix-1221-${k}`}, 'Save-back coach', 'coach'::"Role")`;
    await prisma.mealTemplate.create({ data: { id: linked, coach_id: k, name: 'Linked then archived', ...meal } });
    await prisma.mealTemplate.create({ data: { id: archived, coach_id: k, name: 'Never linked', archived_at: new Date(), ...meal } });
    await prisma.mealTemplate.create({ data: { id: own, coach_id: k, name: 'Bowl', swap_template_ids: [linked], ...meal } });
    await prisma.mealTemplate.update({ where: { id: linked }, data: { archived_at: new Date() } });
  });
  afterAll(() => prisma.$disconnect());

  const asCoach = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${k}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_role', 'coach', true)`;
      await tx.$executeRaw`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub, role: 'authenticated' })}, true)`;
      return query(tx);
    });

  it('accepts the stored list back with an edit, refuses a newly added archived swap or the meal itself', async () => {
    expect(await asCoach((tx) => tx.$executeRaw`UPDATE "MealTemplate" SET "name" = 'Bowl two', "swap_template_ids" = ARRAY[${linked}]::TEXT[] WHERE "id" = ${own}`)).toBe(1);
    await expect(asCoach((tx) => tx.$executeRaw`UPDATE "MealTemplate" SET "swap_template_ids" = ARRAY[${linked}, ${archived}]::TEXT[] WHERE "id" = ${own}`)).rejects.toThrow();
    await expect(asCoach((tx) => tx.$executeRaw`UPDATE "MealTemplate" SET "swap_template_ids" = ARRAY[${own}]::TEXT[] WHERE "id" = ${own}`)).rejects.toThrow();
    await expect(asCoach((tx) => tx.mealTemplate.create({ data: { coach_id: k, name: 'New', swap_template_ids: [linked], ...meal } }))).rejects.toThrow();
    expect(await prisma.mealTemplate.findUniqueOrThrow({ where: { id: own } })).toMatchObject({ name: 'Bowl two', swap_template_ids: [linked] });
  });
});

(url ? describe : describe.skip)('FIX-1221 B2: the freeze keeps names, the live history and a staying client\'s grocery link', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const plans = new RealMealPlansService(prisma as any);
  const lists = new ListsService(prisma as any);
  const k = randomUUID();
  const l = randomUUID();
  const moved = randomUUID();
  const stayed = randomUUID();
  const oats = randomUUID();
  const eggs = randomUUID();
  const plan = randomUUID();
  const slot = randomUUID();

  beforeAll(async () => {
    for (const coach of [k, l]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${coach}, ${randomUUID()}, ${`fix-1221-${coach}`}, 'Freeze coach', 'coach'::"Role")`;
    }
    for (const client of [moved, stayed]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${client}, ${randomUUID()}, ${`fix-1221-${client}`}, 'Freeze client', 'student'::"Role", ${k})`;
    }
    await prisma.mealTemplate.create({ data: { id: oats, coach_id: k, name: 'Oats', ...meal } });
    await prisma.mealTemplate.create({ data: { id: eggs, coach_id: k, name: 'Eggs', ...meal } });
    await prisma.dailyMealPlan.create({
      data: {
        id: plan, coach_id: k, name: 'Freeze plan',
        slots: { create: { id: slot, meal_template_id: oats, slot_label: 'breakfast', time_of_day: '08:00' } },
      },
    });
    for (const client of [moved, stayed]) {
      await prisma.dailyMealPlanAssignment.create({
        data: { daily_meal_plan_id: plan, client_id: client, assigned_by_coach_id: k, starts_on: new Date('2026-01-01T00:00:00Z') },
      });
      await lists.bulkAddItems(client, 'grocery', [{ name: `Breakfast ${client}`, source_plan_slot_id: slot }]);
    }
    // Oats -> Eggs while both clients are the coach's: one revision naming a meal that then leaves the plan.
    await plans.updatePlan(k, plan, { slots: [{ meal_template_id: eggs, slot_label: 'breakfast', time_of_day: '08:00' }] });
    await prisma.user.update({ where: { id: moved }, data: { coach_id: l } });
    await plans.updatePlan(k, plan, { slots: [{ meal_template_id: eggs, slot_label: 'breakfast', time_of_day: '09:00' }] });
  });
  afterAll(() => prisma.$disconnect());

  it('the moved client\'s change reads both meal names from frozen snapshots of the former coach', async () => {
    const held = await prisma.dailyMealPlanAssignment.findFirstOrThrow({ where: { client_id: moved } });
    expect(held.daily_meal_plan_id).not.toBe(plan);
    const [change] = (await plans.getTodayForClient(moved)).changes_today;
    expect(change).toMatchObject({ plan_id: held.daily_meal_plan_id, from_name: 'Oats', to_name: 'Eggs' });
    for (const id of [change.from_template_id, change.to_template_id]) {
      expect(id).not.toBe(oats);
      expect(id).not.toBe(eggs);
      expect(await prisma.mealTemplate.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ coach_id: k, archived_at: expect.any(Date) });
    }
  });

  it('the live plan keeps its own history and the staying client keeps the live slot', async () => {
    expect(await prisma.dailyMealPlanRevision.count({ where: { plan_id: plan } })).toBe(1);
    const [change] = (await plans.getTodayForClient(stayed)).changes_today;
    expect(change).toMatchObject({ plan_id: plan, slot_id: slot, from_template_id: oats, to_template_id: eggs });
    const item = await prisma.listItem.findFirstOrThrow({ where: { user_id: stayed } });
    expect(item.source_plan_slot_id).toBe(slot);
  });
});
