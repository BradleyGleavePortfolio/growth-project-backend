/**
 * LS-1221 B2: new plan revision history and grocery source links must follow a
 * moved client when the former coach's edit freezes the client's held plan.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ListsService } from '../../src/lists/lists.service';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('LS-1221 moved-plan proof requires TEST_DATABASE_URL under CI.');
}

(url ? describe : describe.skip)('LS-1221 B2: new plan data follows a moved client', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const k = randomUUID();
  const l = randomUUID();
  const client = randomUUID();
  const template = randomUUID();
  const plan = randomUUID();
  const slot = randomUUID();
  const revision = randomUUID();
  const plans = new RealMealPlansService(prisma as any);
  const lists = new ListsService(prisma as any);
  let heldPlan: string;
  let heldSlot: string;
  let item: string;

  beforeAll(async () => {
    for (const coach of [k, l]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${coach}, ${randomUUID()}, ${`ls-1221-${coach}`}, 'History coach', 'coach'::"Role")`;
    }
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
      VALUES (${client}, ${randomUUID()}, ${`ls-1221-${client}`}, 'History client', 'student'::"Role", ${k})`;
    await prisma.mealTemplate.create({
      data: { id: template, coach_id: k, name: 'Breakfast oats', calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 },
    });
    await prisma.dailyMealPlan.create({
      data: {
        id: plan, coach_id: k, name: 'Held food history',
        slots: { create: { id: slot, meal_template_id: template, slot_label: 'breakfast', time_of_day: '08:00' } },
      },
    });
    await prisma.dailyMealPlanAssignment.create({
      data: { daily_meal_plan_id: plan, client_id: client, assigned_by_coach_id: k, starts_on: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.dailyMealPlanRevision.create({
      data: { id: revision, plan_id: plan, slot_id: slot, slot_label: 'breakfast', to_template_id: template },
    });
    await lists.bulkAddItems(client, 'grocery', [{ name: 'History oats', source_plan_slot_id: slot }]);
    item = (await prisma.listItem.findFirstOrThrow({ where: { user_id: client, name: 'History oats' } })).id;
    expect((await plans.getTodayForClient(client)).changes_today).toHaveLength(1);

    await prisma.user.update({ where: { id: client }, data: { coach_id: l } });
    await plans.updatePlan(k, plan, {
      slots: [{ meal_template_id: template, slot_label: 'breakfast', time_of_day: '09:00' }],
    });
    const assignment = await prisma.dailyMealPlanAssignment.findFirstOrThrow({ where: { client_id: client } });
    heldPlan = assignment.daily_meal_plan_id;
    expect(heldPlan).not.toBe(plan);
    const frozen = await prisma.dailyMealPlanSlot.findFirstOrThrow({ where: { daily_meal_plan_id: heldPlan } });
    heldSlot = frozen.id;
    expect(frozen.time_of_day).toBe('08:00');
  });
  afterAll(() => prisma.$disconnect());

  it('keeps earlier revision history on the plan the moved client now holds', async () => {
    const today = await plans.getTodayForClient(client);
    expect(today.assignments.map((a) => a.daily_meal_plan.id)).toContain(heldPlan);
    expect(today.changes_today).toEqual([
      expect.objectContaining({ plan_id: heldPlan, slot_id: heldSlot, slot_label: 'breakfast' }),
    ]);
  });

  it('remaps only the moved client grocery source to the corresponding frozen slot', async () => {
    const grocery = await prisma.listItem.findUniqueOrThrow({ where: { id: item } });
    expect(grocery.source_plan_slot_id).toBe(heldSlot);
    expect(await prisma.dailyMealPlanSlot.count({
      where: { id: grocery.source_plan_slot_id!, daily_meal_plan: { assignments: { some: { client_id: client } } } },
    })).toBe(1);
  });
});
