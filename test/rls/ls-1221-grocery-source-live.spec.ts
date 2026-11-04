/**
 * LS-1221 B2: a timing-only plan edit must not detach unchanged meals already
 * on a client's grocery list. Uses real FK actions and the actual services.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ListsService } from '../../src/lists/lists.service';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('LS-1221 source-link proof requires TEST_DATABASE_URL under CI.');
}

(url ? describe : describe.skip)('LS-1221 B2: grocery source survives an unchanged plan meal', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const coach = randomUUID();
  const client = randomUUID();
  const template = randomUUID();
  const plan = randomUUID();
  const slot = randomUUID();
  const plans = new RealMealPlansService(prisma as any);
  const lists = new ListsService(prisma as any);

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${coach}, ${randomUUID()}, ${`ls-1221-${coach}`}, 'Source coach', 'coach'::"Role")`;
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
      VALUES (${client}, ${randomUUID()}, ${`ls-1221-${client}`}, 'Source client', 'student'::"Role", ${coach})`;
    await prisma.mealTemplate.create({
      data: { id: template, coach_id: coach, name: 'Breakfast oats', calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 },
    });
    await prisma.dailyMealPlan.create({
      data: {
        id: plan, coach_id: coach, name: 'Daily food',
        slots: { create: { id: slot, meal_template_id: template, slot_label: 'breakfast', planned_time: '08:00' } },
      },
    });
    await prisma.dailyMealPlanAssignment.create({
      data: { daily_meal_plan_id: plan, client_id: client, assigned_by_coach_id: coach, starts_on: new Date('2026-01-01T00:00:00Z') },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('keeps the grocery item linked when only breakfast time changes', async () => {
    await lists.bulkAddItems(client, 'grocery', [{ name: 'Rolled oats', source_plan_slot_id: slot }]);
    const before = await prisma.listItem.findFirstOrThrow({ where: { user_id: client, name: 'Rolled oats' } });
    expect(before.source_plan_slot_id).toBe(slot);

    await plans.updatePlan(coach, plan, {
      slots: [{ meal_template_id: template, slot_label: 'breakfast', planned_time: '09:00' }],
    });
    const after = await prisma.listItem.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.source_plan_slot_id).not.toBeNull();
    const linkedSlot = await prisma.dailyMealPlanSlot.findUnique({
      where: { id: after.source_plan_slot_id! },
    });
    expect(linkedSlot).toMatchObject({
      daily_meal_plan_id: plan, meal_template_id: template, slot_label: 'breakfast', planned_time: '09:00',
    });
  });
});
