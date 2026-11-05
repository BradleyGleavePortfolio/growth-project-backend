/**
 * FIX-1221R2 (LS-1221R2B B1, the class): a meal that sits in no slot of a plan can still be named by that
 * plan's changes, as the `from` or the `to` meal. After a client moves, the former coach's later edit of
 * that meal must not rewrite the moved client's held history, through the service or through a direct
 * table write as the API role; the clients who stayed see the edit, and a meal named only in a staying
 * client's history stays the coach's to edit.
 *
 *   dependency | writer  | moved client reads | stayed client reads | table UPDATE rows
 *   from       | service | Oats               | the new name        | -
 *   to         | service | Oats               | the new name        | -
 *   from       | table   | -                  | -                   | 0 (control on a kept plan: 1)
 *   to         | table   | -                  | -                   | 0 (control on a kept plan: 1)
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('FIX-1221R2 history dependency proof requires TEST_DATABASE_URL under CI.');
}

type Side = 'from' | 'to';

(url ? describe : describe.skip)('FIX-1221R2: a meal named only in a plan\'s changes is held for a moved client', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const plans = new RealMealPlansService(prisma as never);
  afterAll(() => prisma.$disconnect());

  const meal = { calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 };

  const fixture = async (side: Side) => {
    const k = randomUUID();
    const l = randomUUID();
    const sub = randomUUID();
    const [moved, stayed] = [randomUUID(), randomUUID()];
    const [oats, eggs, toast] = [randomUUID(), randomUUID(), randomUUID()];
    const [held, kept] = [randomUUID(), randomUUID()];
    for (const [coach, subject] of [[k, sub], [l, randomUUID()]]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${coach}, ${subject}, ${`fix-1221r2-${coach}`}, 'History coach', 'coach'::"Role")`;
    }
    for (const client of [moved, stayed]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${client}, ${randomUUID()}, ${`fix-1221r2-${client}`}, 'History client', 'student'::"Role", ${k})`;
    }
    for (const [id, name] of [[oats, 'Oats'], [eggs, 'Eggs'], [toast, 'Toast']]) {
      await prisma.mealTemplate.create({ data: { id, coach_id: k, name, ...meal } });
    }
    // `held` is held by both clients (one moves); `kept` only by the client who stays. Each plan's slot
    // has Eggs; Oats (held) and Toast (kept) appear only in a change, on the side under test.
    for (const [plan, clients, named] of [[held, [moved, stayed], oats], [kept, [stayed], toast]] as const) {
      await prisma.dailyMealPlan.create({
        data: {
          id: plan, coach_id: k, name: `History ${side}`,
          slots: { create: { id: randomUUID(), meal_template_id: eggs, slot_label: 'breakfast', time_of_day: '08:00' } },
        },
      });
      const slot = await prisma.dailyMealPlanSlot.findFirstOrThrow({ where: { daily_meal_plan_id: plan } });
      await prisma.dailyMealPlanRevision.create({
        data: {
          id: randomUUID(), plan_id: plan, slot_id: slot.id, slot_label: 'breakfast',
          from_template_id: side === 'from' ? named : eggs,
          to_template_id: side === 'to' ? named : eggs,
          changed_at: new Date(),
        },
      });
      for (const client_id of clients) {
        await prisma.dailyMealPlanAssignment.create({
          data: { daily_meal_plan_id: plan, client_id, assigned_by_coach_id: k, starts_on: new Date('2026-01-01T00:00:00Z') },
        });
      }
    }
    expect(await prisma.dailyMealPlanSlot.count({ where: { meal_template_id: { in: [oats, toast] } } })).toBe(0);
    await prisma.user.update({ where: { id: moved }, data: { coach_id: l } });
    const asCoach = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${k}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_role', 'coach', true)`;
        await tx.$executeRaw`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub, role: 'authenticated' })}, true)`;
        return query(tx);
      });
    return { k, moved, stayed, oats, toast, asCoach };
  };

  const nameOn = (side: Side, rows: { from_name: string | null; to_name: string | null }[]) =>
    rows.map((r) => (side === 'from' ? r.from_name : r.to_name));

  it.each<Side>(['from', 'to'])('service: renaming a meal a change names as %s keeps the moved client\'s history', async (side) => {
    const { k, moved, stayed, oats } = await fixture(side);
    await plans.updateTemplate(k, oats, { name: 'Oats for current clients' });
    expect(nameOn(side, (await plans.getTodayForClient(moved)).changes_today)).toEqual(['Oats']);
    expect(nameOn(side, (await plans.getTodayForClient(stayed)).changes_today)).toContain('Oats for current clients');
    expect((await prisma.mealTemplate.findUniqueOrThrow({ where: { id: oats } })).name).toBe('Oats for current clients');
  });

  it.each<Side>(['from', 'to'])('table: the former coach cannot rewrite a meal a departed client\'s change names as %s', async (side) => {
    const { oats, toast, asCoach } = await fixture(side);
    expect(await asCoach((tx) => tx.$executeRaw`
      UPDATE "MealTemplate" SET "name" = 'Oats through the table' WHERE "id" = ${oats}
    `)).toBe(0);
    expect((await prisma.mealTemplate.findUniqueOrThrow({ where: { id: oats } })).name).toBe('Oats');
    // Control: a meal named only in the history of a plan whose clients all stayed is still editable.
    expect(await asCoach((tx) => tx.$executeRaw`
      UPDATE "MealTemplate" SET "name" = 'Toast through the table' WHERE "id" = ${toast}
    `)).toBe(1);
  });
});
