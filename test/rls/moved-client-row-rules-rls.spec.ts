/**
 * Row security after a move (owner 4, MOVE-RLS) on the replayed migration
 * chain: WorkoutPlan, WorkoutProgram, DailyMealPlanAssignment, CoachBrief and
 * the sub-coach branch of app.caller_coaches_client. Head coach A had both
 * clients; `moved` now has coach Z, `stays` is still A's and `teamed` is
 * coached by A's seated sub-coach S. S's delegation of `moved` from A is still
 * open, as a move leaves it. A reaches nothing of `moved`, S's open delegation
 * gives no access, Z reads their own rows, every client keeps their own rows,
 * and an unrelated coach or client reads none.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-row-rules-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: a moved client leaves the former coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [A, S, Z, other, moved, stays, teamed, otherClient] = Array.from({ length: 8 }, () => randomUUID());
  const role: Record<string, string> = {
    [A]: 'coach', [S]: 'coach', [Z]: 'coach', [other]: 'coach',
    [moved]: 'student', [stays]: 'student', [teamed]: 'student', [otherClient]: 'student',
  };
  const coachOf: Record<string, string> = { [S]: A, [moved]: Z, [stays]: A, [teamed]: S, [otherClient]: other };
  const run = randomUUID().slice(0, 8);
  const id = (tag: string) => `${tag}-${run}`;
  const tag = (rows: { id: string }[]) => rows.map((r) => r.id.slice(0, -run.length - 1)).sort();
  // programs: [tenant coach, owner, client, is_template]
  const programs: Record<string, [string, string, string | null, boolean]> = {
    master: [A, A, null, true],
    pMoved: [A, A, moved, false],
    pStays: [A, A, stays, false],
    pTeamed: [A, A, teamed, false],
    pLegacy: [A, A, null, false],
    pSubMoved: [A, S, moved, false],
    pSubStays: [A, S, stays, false],
    pZ: [Z, Z, moved, false],
  };
  // plan days: [coach, program]
  const plans: Record<string, [string, string | null]> = {
    dStandalone: [A, null], dMaster: [A, 'master'], dMoved: [A, 'pMoved'], dStays: [A, 'pStays'],
    dTeamed: [A, 'pTeamed'], dLegacy: [A, 'pLegacy'], dZ: [Z, 'pZ'],
  };
  // workout assignments: [plan, client, assigning coach]
  const assignments: Record<string, [string, string, string]> = {
    cMoved: ['dMoved', moved, A], cLegacy: ['dLegacy', moved, A], cZ: ['dZ', moved, Z],
    cStays: ['dStays', stays, A], cSubMoved: ['dMoved', moved, S], cSubStays: ['dStays', stays, S],
  };
  // meal-plan assignments: [plan coach, client, assigning coach]
  const meals: Record<string, [string, string, string]> = {
    mMoved: [A, moved, A], mStays: [A, stays, A], mZ: [Z, moved, Z],
  };
  // stored briefs: [coach, mode, scope_client_ids (null = none stored), day]
  const briefs: Record<string, [string, string, string[] | null, number]> = {
    bMoved: [A, 'solo_coach', [stays, moved], 1], bStays: [A, 'solo_coach', [stays], 2],
    bLegacy: [A, 'solo_coach', null, 3], bSubMoved: [S, 'sub_coach', [moved], 1],
    bSubStays: [S, 'sub_coach', [stays], 2], bZ: [Z, 'solo_coach', [moved], 1],
  };

  beforeAll(async () => {
    for (const user of [A, S, Z, other, moved, stays, teamed, otherClient]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${user}, ${user}, ${`mrr-${user}`}, 'RLS user', ${role[user]}::"Role", ${coachOf[user] ?? null})`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${A}, ${S})`;
    for (const client of [moved, stays]) {
      await prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
        VALUES (${randomUUID()}, ${A}, ${S}, ${client})`;
    }
    for (const [t, [tenant, owner, client, template]] of Object.entries(programs)) {
      await prisma.$executeRaw`INSERT INTO "WorkoutProgram"
          ("id", "coach_id", "owner_user_id", "name", "weeks", "days_per_week", "is_template", "client_id", "updated_at")
        VALUES (${id(t)}, ${tenant}, ${owner}, ${`mrr-${run}`}, 4, 3, ${template}, ${client}, now())`;
    }
    for (const [t, [coach, program]] of Object.entries(plans)) {
      await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "program_id", "updated_at")
        VALUES (${id(t)}, ${coach}, ${`mrr-${run}`}, 'strength', ${program && id(program)}, now())`;
    }
    for (const [t, [plan, client, coach]] of Object.entries(assignments)) {
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignment"
          ("id", "workout_plan_id", "client_id", "assigned_by_coach_id", "scheduled_for")
        VALUES (${id(t)}, ${id(plan)}, ${client}, ${coach}, now())`;
    }
    for (const [t, [planCoach, client, coach]] of Object.entries(meals)) {
      await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name") VALUES (${id(`plan-${t}`)}, ${planCoach}, 'Plan')`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanAssignment"
          ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
        VALUES (${id(t)}, ${id(`plan-${t}`)}, ${client}, ${coach}, CURRENT_DATE)`;
    }
    for (const [t, [coach, mode, scope, day]] of Object.entries(briefs)) {
      const context = JSON.stringify(scope ? { scope_client_ids: scope } : {});
      await prisma.$executeRaw`INSERT INTO "CoachBrief" ("id", "coach_id", "brief_date", "status", "brief_mode", "brief_context")
        VALUES (${id(t)}, ${coach}, ${`2027-04-0${day}`}, 'generated', ${mode}, ${context}::jsonb)`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Runs `query` as the signed-in API role, with both identity forms the
  // policies read (app.current_user_id and the Supabase JWT subject).
  const asUser = <T>(reader: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[reader]);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: reader }));
      return query(tx);
    });
  const seen = (reader: string) =>
    asUser(reader, async (tx) => ({
      plans: tag(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WorkoutPlan" WHERE "name" = ${`mrr-${run}`}`),
      programs: tag(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WorkoutProgram" WHERE "name" = ${`mrr-${run}`}`),
      assignments: tag(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ClientWorkoutAssignment" WHERE "id" LIKE ${`%-${run}`}`),
      meals: tag(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DailyMealPlanAssignment" WHERE "id" LIKE ${`%-${run}`}`),
      briefs: tag(await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CoachBrief" WHERE "id" LIKE ${`%-${run}`}`),
    }));

  it('the former head coach reaches only what is still theirs', async () => {
    expect(await seen(A)).toEqual({
      plans: ['dMaster', 'dStandalone', 'dStays', 'dTeamed'],
      programs: ['master', 'pStays', 'pTeamed'],
      // As the client's current coach A also reads the sub-coach's assignment for them (20270502000900).
      assignments: ['cStays', 'cSubStays'],
      meals: ['mStays'],
      briefs: ['bStays'],
    });
  });

  it("the sub-coach's open delegation of the moved client gives nothing; the staying client's still works", async () => {
    expect(await seen(S)).toEqual({
      plans: [], programs: ['pSubStays'], assignments: ['cSubStays'], meals: [], briefs: ['bSubStays'],
    });
    expect(await asUser(S, (tx) => tx.$queryRaw<{ moved: boolean; stays: boolean }[]>`
      SELECT app.caller_coaches_client(${moved}) AS "moved", app.caller_coaches_client(${stays}) AS "stays"`))
      .toEqual([{ moved: false, stays: true }]);
  });

  it('the new coach reads their own rows for the client, never the former coach\'s, and every workout assignment of the client', async () => {
    // History follows the client (20270502000900): the current coach reads the
    // client's assignments from every coach's time; plans and programs stay the writer's.
    expect(await seen(Z)).toEqual({
      plans: ['dZ'], programs: ['pZ'], assignments: ['cLegacy', 'cMoved', 'cSubMoved', 'cZ'], meals: ['mZ'], briefs: ['bZ'],
    });
  });

  it('each client keeps their own rows from every coach', async () => {
    const m = await seen(moved);
    expect([m.plans, m.assignments, m.meals]).toEqual([
      ['dLegacy', 'dMoved', 'dZ'], ['cLegacy', 'cMoved', 'cSubMoved', 'cZ'], ['mMoved', 'mZ'],
    ]);
    const s = await seen(stays);
    expect([s.plans, s.assignments, s.meals]).toEqual([['dStays'], ['cStays', 'cSubStays'], ['mStays']]);
    // A client reads their own program copies from every coach (20270502000900), and no briefs.
    expect([m.programs, m.briefs, s.programs, s.briefs]).toEqual([['pMoved', 'pSubMoved', 'pZ'], [], ['pStays', 'pSubStays'], []]);
  });

  it('an unrelated coach and client read none of it', async () => {
    const none = { plans: [], programs: [], assignments: [], meals: [], briefs: [] };
    expect(await seen(other)).toEqual(none);
    expect(await seen(otherClient)).toEqual(none);
  });

  it('the former coach can no longer change, delete or add rows about the moved client', async () => {
    expect(await asUser(A, (tx) => tx.$executeRaw`
      UPDATE "WorkoutPlan" SET "name" = 'changed' WHERE "id" = ${id('dMoved')}`)).toBe(0);
    expect(await asUser(A, (tx) => tx.$executeRaw`
      UPDATE "WorkoutProgram" SET "name" = 'changed' WHERE "id" = ${id('pMoved')}`)).toBe(0);
    expect(await asUser(A, (tx) => tx.$executeRaw`
      DELETE FROM "DailyMealPlanAssignment" WHERE "id" = ${id('mMoved')}`)).toBe(0);
    await expect(asUser(A, (tx) => tx.$executeRaw`
      INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "program_id", "updated_at")
      VALUES (${id('dAdded')}, ${A}, 'added', 'strength', ${id('pMoved')}, now())`)).rejects.toThrow(/row-level security/);
    await expect(asUser(A, (tx) => tx.$executeRaw`
      INSERT INTO "WorkoutProgram" ("id", "coach_id", "owner_user_id", "name", "weeks", "days_per_week", "is_template", "client_id", "updated_at")
      VALUES (${id('pAdded')}, ${A}, ${A}, 'added', 4, 3, false, ${moved}, now())`)).rejects.toThrow(/row-level security/);
    await expect(asUser(A, (tx) => tx.$executeRaw`
      INSERT INTO "DailyMealPlanAssignment" ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
      VALUES (${id('mAdded')}, ${id('plan-mStays')}, ${moved}, ${A}, CURRENT_DATE)`)).rejects.toThrow(/row-level security/);
    // The same writes for the client who stays still pass.
    expect(await asUser(A, (tx) => tx.$executeRaw`
      UPDATE "WorkoutPlan" SET "updated_at" = now() WHERE "id" = ${id('dStays')}`)).toBe(1);
    expect(await asUser(A, (tx) => tx.$executeRaw`
      UPDATE "DailyMealPlanAssignment" SET "ends_on" = CURRENT_DATE WHERE "id" = ${id('mStays')}`)).toBe(1);
  });

  it("the head coach keeps a sub-coach's client's copy only while the sub-coach's team seat is live", async () => {
    await prisma.$executeRaw`UPDATE "TeamSubCoachAssignment" SET "archived_at" = now()
      WHERE "head_coach_id" = ${A} AND "sub_coach_id" = ${S}`;
    const a = await seen(A);
    expect([a.plans, a.programs]).toEqual([['dMaster', 'dStandalone', 'dStays'], ['master', 'pStays']]);
  });
});
