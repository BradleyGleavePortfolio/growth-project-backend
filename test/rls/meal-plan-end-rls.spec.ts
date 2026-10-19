/**
 * MEALPLAN-END — live row security for ending a client's meal plan assignment. No migration:
 * the DailyMealPlanAssignment update and delete policies (20270502000700) already allow only
 * the assigning coach while the client is theirs.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay (the whole migration chain
 * from empty). Principals are API shaped: SET LOCAL ROLE authenticated with the
 * app.current_user_id / app.current_user_role GUCs the policies read.
 *
 * Proves: the table is ENABLE + FORCE; the two writes the end route makes (set ends_on, delete)
 * change only the assigning coach's row for a client still theirs. Another coach, the client,
 * the former coach after a move and the new coach change 0 rows, each after a control that
 * changes 1. The production service on the server's connection ends, refuses and hides plans
 * with real Postgres relation filters.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('meal-plan-end-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Ending a meal plan assignment: row security (MEALPLAN-END)', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const meals = new RealMealPlansService(prisma);
  // A assigned the plan to `stays` and `moved`; `moved` now has coach Z. B is another coach.
  const [A, B, Z, stays, moved] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const ids: Record<string, string> = {};
  const as = <T>(userId: string, role: string, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, userId);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      return run(tx);
    });
  const end = (who: string, role: string, id: string) =>
    as(who, role, (tx) => tx.$executeRaw`UPDATE "DailyMealPlanAssignment" SET "ends_on" = DATE '2026-10-20' WHERE "id" = ${id}`);
  const remove = (who: string, role: string, id: string) =>
    as(who, role, (tx) => tx.$executeRaw`DELETE FROM "DailyMealPlanAssignment" WHERE "id" = ${id}`);
  const stored = (id: string) => prisma.dailyMealPlanAssignment.findUnique({ where: { id } });
  const onDay = async (client: string, day: string) =>
    (await meals.getTodayForClient(client, day)).assignments.map((a) => a.daily_meal_plan.name);

  beforeAll(async () => {
    for (const [id, role, coachId] of [[A, 'coach', null], [B, 'coach', null], [Z, 'coach', null], [stays, 'student', A], [moved, 'student', A]]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id}, ${id}, ${`${id}@example.test`}, 'RLS user', ${role}::"Role", ${coachId})`;
    }
    const oats = await meals.createTemplate(A, { name: 'Oats', calories_kcal: 400, protein_g: 20, carbs_g: 50, fats_g: 10 });
    const plan = await meals.createPlan(A, { name: 'Day', slots: [{ meal_template_id: oats.id, slot_label: 'breakfast' }] });
    ids.plan = plan!.id;
    for (const [key, client_id, starts_on] of [['stays', stays, '2026-10-01'], ['later', stays, '2026-11-01'], ['moved', moved, '2026-10-01']]) {
      ids[key] = (await meals.assignPlan(A, ids.plan, { client_id, starts_on })).id;
    }
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${Z} WHERE "id" = ${moved}`;
  }, 60_000);

  afterAll(() => prisma.$disconnect());

  it('DailyMealPlanAssignment keeps ENABLE + FORCE', async () => {
    const [flags] = await prisma.$queryRaw<{ on: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS "on", relforcerowsecurity AS forced FROM pg_class WHERE oid = '"DailyMealPlanAssignment"'::regclass`;
    expect(flags).toEqual({ on: true, forced: true });
  });

  it("only the assigning coach, for a client still theirs, sets ends_on or deletes; every other identity changes 0 rows", async () => {
    expect(await end(A, 'coach', ids.stays)).toBe(1);
    expect(await end(B, 'coach', ids.stays)).toBe(0);
    expect(await end(stays, 'student', ids.stays)).toBe(0);
    expect(await remove(B, 'coach', ids.stays)).toBe(0);
    expect(await remove(stays, 'student', ids.stays)).toBe(0);
    // After the move: neither the former coach nor the new coach (who did not assign it) ends it.
    expect(await end(A, 'coach', ids.moved)).toBe(0);
    expect(await end(Z, 'coach', ids.moved)).toBe(0);
    expect(await remove(A, 'coach', ids.moved)).toBe(0);
    expect(await remove(Z, 'coach', ids.moved)).toBe(0);
    expect(await remove(A, 'coach', ids.later)).toBe(1);
    expect(await stored(ids.moved)).toMatchObject({ client_id: moved, ends_on: null });
    expect(await stored(ids.stays)).toMatchObject({ ends_on: new Date('2026-10-20') });
    expect(await stored(ids.later)).toBeNull();
  });

  it('the service ends a plan without extending it, refuses another coach and a former coach, and hides an archived plan from its own client only', async () => {
    await expect(meals.endAssignment(B, ids.plan, ids.stays, { ends_on: '2026-10-15' })).rejects.toThrow('Daily meal plan not found');
    await expect(meals.endAssignment(A, ids.plan, ids.moved, { ends_on: '2026-10-15' })).rejects.toThrow('Assignment not found');
    await meals.endAssignment(A, ids.plan, ids.stays, { ends_on: '2026-10-25' });
    expect(await stored(ids.stays)).toMatchObject({ ends_on: new Date('2026-10-20') });
    await meals.endAssignment(A, ids.plan, ids.stays, { ends_on: '2026-10-15' });
    expect([await onDay(stays, '2026-10-15'), await onDay(stays, '2026-10-16')]).toEqual([['Day'], []]);
    expect(await onDay(moved, '2026-10-16')).toEqual(['Day']);

    await meals.archivePlan(A, ids.plan);
    expect(await onDay(stays, '2026-10-12')).toEqual([]);
    expect(await onDay(moved, '2026-10-16')).toEqual(['Day']);
  });
});
