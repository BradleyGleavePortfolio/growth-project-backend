/**
 * LS-1221R2B B1: a template removed from a plan can still supply the names in
 * today's revisions. After a client moves, a former coach's later edit must
 * not rewrite that client's held history, through the service or table role.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('LS-1221R2B history proof requires TEST_DATABASE_URL under CI.');
}

(url ? describe : describe.skip)('LS-1221R2B B1: departed-client history includes removed-template dependencies', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const plans = new RealMealPlansService(prisma as never);
  afterAll(() => prisma.$disconnect());

  const fixture = async () => {
    const k = randomUUID();
    const l = randomUUID();
    const sub = randomUUID();
    const moved = randomUUID();
    const stayed = randomUUID();
    const oats = randomUUID();
    const eggs = randomUUID();
    const plan = randomUUID();
    const slot = randomUUID();
    for (const [coach, subject] of [[k, sub], [l, randomUUID()]]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${coach}, ${subject}, ${`ls-1221r2b-${coach}`}, 'History coach', 'coach'::"Role")`;
    }
    for (const client of [moved, stayed]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${client}, ${randomUUID()}, ${`ls-1221r2b-${client}`}, 'History client', 'student'::"Role", ${k})`;
    }
    const meal = { calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 };
    await prisma.mealTemplate.create({ data: { id: oats, coach_id: k, name: 'Oats', ...meal } });
    await prisma.mealTemplate.create({ data: { id: eggs, coach_id: k, name: 'Eggs', ...meal } });
    await prisma.dailyMealPlan.create({
      data: {
        id: plan, coach_id: k, name: 'Held revision history',
        slots: { create: { id: slot, meal_template_id: oats, slot_label: 'breakfast', time_of_day: '08:00' } },
      },
    });
    for (const client_id of [moved, stayed]) {
      await prisma.dailyMealPlanAssignment.create({
        data: { daily_meal_plan_id: plan, client_id, assigned_by_coach_id: k, starts_on: new Date('2026-01-01T00:00:00Z') },
      });
    }
    await plans.updatePlan(k, plan, {
      slots: [{ meal_template_id: eggs, slot_label: 'breakfast', time_of_day: '08:00' }],
    });
    expect(await prisma.dailyMealPlanSlot.count({ where: { meal_template_id: oats } })).toBe(0);
    expect((await plans.getTodayForClient(moved)).changes_today).toEqual([
      expect.objectContaining({ from_name: 'Oats', to_name: 'Eggs' }),
    ]);
    await prisma.user.update({ where: { id: moved }, data: { coach_id: l } });
    const asCoach = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${k}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_role', 'coach', true)`;
        await tx.$executeRaw`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub, role: 'authenticated' })}, true)`;
        return query(tx);
      });
    return { k, moved, stayed, oats, plan, asCoach };
  };

  it('keeps the moved client history name when the former coach edits a removed meal through the service', async () => {
    const { k, moved, stayed, oats } = await fixture();
    expect(await plans.updateTemplate(k, oats, { name: 'Oats revised for current clients' })).toMatchObject({
      name: 'Oats revised for current clients',
    });
    expect((await plans.getTodayForClient(stayed)).changes_today).toEqual([
      expect.objectContaining({ from_name: 'Oats revised for current clients', to_name: 'Eggs' }),
    ]);
    expect((await plans.getTodayForClient(moved)).changes_today).toEqual([
      expect.objectContaining({ from_name: 'Oats', to_name: 'Eggs' }),
    ]);
  });

  it('refuses an authenticated template edit that would mutate history of a client who left', async () => {
    const { oats, plan, asCoach } = await fixture();
    // Control: this coach already cannot read the departed client's held history.
    expect(await asCoach((tx) => tx.dailyMealPlanRevision.count({ where: { plan_id: plan } }))).toBe(0);
    const changed = await asCoach((tx) => tx.$executeRaw`
      UPDATE "MealTemplate" SET "name" = 'Oats revised through table' WHERE "id" = ${oats}
    `);
    expect(changed).toBe(0);
  });
});
