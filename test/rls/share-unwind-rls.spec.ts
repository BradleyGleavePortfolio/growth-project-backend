/**
 * SHARE-UNWIND (#SHARE-SIMPLE, #SHARE-JOIN op 1) on the replayed migration chain: workouts, food logs,
 * weigh-ins, check-ins and habits reach the client's coach now, whatever the old switches say, and no one
 * else. Client A moved from F to K and had turned all four switches off for K before the change; F still
 * holds old grants.
 * S is K's seated sub-coach (delegated A; his own client G moved from K, whose grants stay); E's delegation for A ended, R was removed, U coaches B.
 * The real Coach, Command Center, v1 coach and Consent services run as the API does; the row layer is read as the non-bypass
 * `authenticated` role, and each 0 there follows the current coach's read of the same rows returning them.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { GoneException } from '@nestjs/common';
import type { AuditService } from '../../src/audit/audit.service';
import { AdminPtmService } from '../../src/admin/ptm/admin-ptm.service';
import { CoachService } from '../../src/coach/coach.service';
import { CommandCenterService } from '../../src/coach/command-center/command-center.service';
import { COACH_LINK_SCOPES, ConsentService } from '../../src/consent/consent.service';
import { coachSharingCheck, seesWeight } from '../../src/consent/coach-sharing-gate';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { V1CoachService } from '../../src/v1/v1-coach.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('share-unwind-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('SHARE-UNWIND: workouts, food, weigh-ins, check-ins and habits reach the coach now only', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
  const consent = new ConsentService(prisma, audit, new SubCoachScopeService(prisma));
  const service = new CoachService(prisma, audit, consent, new SubCoachScopeService(prisma));
  type Deps<C extends abstract new (...args: never[]) => unknown> = ConstructorParameters<C>;
  const ptm = new AdminPtmService(prisma, audit, stub<Deps<typeof AdminPtmService>[2]>({}), stub<Deps<typeof AdminPtmService>[3]>({}));
  const center = new CommandCenterService(prisma, ptm, stub<Deps<typeof CommandCenterService>[2]>({}), new SubCoachScopeService(prisma), consent);
  const v1 = new V1CoachService(prisma, stub<Deps<typeof V1CoachService>[1]>({}), audit, new SubCoachScopeService(prisma), consent);
  const [F, K, U, S, E, A, B, G, R] = Array.from({ length: 9 }, () => randomUUID());
  const LINKED = [...COACH_LINK_SCOPES];
  const SEES = [1, 1, 1, 1, true, true, true, true];

  const timeline = async (caller: string) => {
    const out = await service.getClientTimeline(caller, A, 90, 'coach');
    if ('error' in out) return out.error;
    const { workouts, food_macros, body_metrics, habits_progress } = out.consent;
    return [out.workouts.length, out.meals.length, out.weights.length, out.checkIns.length, workouts, food_macros, body_metrics, habits_progress];
  };
  /** The client's workout, food, weight, check-in, habit and habit-log rows as the signed-in API role (app.current_user_id = who). */
  const rows = (who: string, user_id = A) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      const where = { user_id };
      return [await tx.workoutSession.count({ where }), await tx.loggedFoodEntry.count({ where }), await tx.weightLog.count({ where }),
        await tx.checkIn.count({ where }), await tx.habit.count({ where }), await tx.habitLog.count({ where: { habit: where } })];
    });
  const history = () =>
    prisma.clientCoachConsent.findMany({ where: { client_id: A }, orderBy: [{ coach_id: 'asc' }, { scope: 'asc' }] });

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [F, 'coach', null], [K, 'coach', null], [U, 'coach', null], [S, 'coach', K], [E, 'coach', K],
      [A, 'student', F], [B, 'student', U], [G, 'student', K], [R, 'coach', K],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `unwind-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const sub of [S, E]) await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: sub } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S, client_id: A } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: E, client_id: A, unassigned_at: new Date() } });
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: R, archived_at: new Date() } });
    const granted_at = new Date('2026-09-01T00:00:00Z');
    for (const scope of LINKED) {
      await prisma.clientCoachConsent.create({ data: { client_id: A, coach_id: F, scope, granted_at } });
      await prisma.clientCoachConsent.create({ data: { client_id: G, coach_id: K, scope, granted_at } });
      await prisma.clientCoachConsent.create({
        data: { client_id: A, coach_id: K, scope, granted_at, revoked_at: new Date('2026-09-02T00:00:00Z') },
      });
    }
    const date = new Date(new Date().toISOString().slice(0, 10));
    const food = await prisma.foodItem.create({
      data: { name: 'Oats', serving_description: '1 bowl', serving_size_grams: 80, calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 },
    });
    await prisma.workoutSession.create({ data: { user_id: A, date, workout_name: 'Lower A', workout_type: 'strength' } });
    await prisma.loggedFoodEntry.create({ data: { user_id: A, date, meal_type: 'breakfast', food_item_id: food.id } });
    await prisma.weightLog.create({ data: { user_id: A, date, weight_lbs: 180 } });
    await prisma.checkIn.create({ data: { user_id: A, date, soreness: 2 } });
    await prisma.habitLog.create({ data: { date, completed: true, habit: { create: { user_id: A, name: 'Walk' } } } });
    await prisma.workoutSession.create({ data: { user_id: G, date, workout_name: 'Lower A', workout_type: 'strength' } });
    await prisma.checkIn.create({ data: { user_id: G, date: new Date(date.getTime() - 30 * 86_400_000), soreness: 2 } });
    await prisma.ptmPrediction.create({ data: { user_id: G, risk_score: 0.9, success_score: 0.1, prediction_basis: 'heuristic_v1',
      factors: [{ key: 'checkin_miss_3plus', label: 'Missed check-ins', contribution: 1 }] } });
    await prisma.coachMessage.create({ data: { coach_id: K, client_id: G, sender_id: G, body: 'Hello' } });
    await prisma.user.update({ where: { id: A }, data: { coach_id: K } });
    await prisma.user.update({ where: { id: G }, data: { coach_id: S } });
  });
  afterAll(() => prisma.$disconnect());

  it('the API role used below does not bypass row security', async () => {
    const [{ b }] = await prisma.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(b).toBe(false);
  });

  it.each<[string, string, boolean]>([
    ['K, the current coach, despite the old switch-off', K, true],
    ['S, a sub-coach with an open delegation', S, true],
    ['F, the former coach, despite the old grants', F, false],
    ['E, whose delegation ended', E, false],
    ['U, an unrelated coach', U, false],
  ])('%s', async (_who, caller, sees) => {
    expect(await timeline(caller)).toEqual(sees ? SEES : 'Client not found');
    for (const scope of LINKED) expect(await consent.coachCanAccess(caller, A, scope, 'coach')).toBe(sees);
    const sharing = await coachSharingCheck(consent, prisma, caller);
    for (const scope of LINKED) expect((await sharing(scope, [A, B])).includes(A)).toBe(sees);
    expect(await seesWeight(consent, caller, A, 'coach')).toBe(sees);
  });

  it("K's roster shows A's last workout, food log, weigh-in and check-in", async () => {
    const [row] = await service.withRosterActivity(K, 'coach', await service.getClients(K, 'all', 'coach'));
    const day = expect.any(String);
    expect(row.activity).toMatchObject({ last_workout_on: day, last_food_on: day, last_weigh_in_on: day, last_check_in_on: day });
  });

  it("row layer: K reads A's rows, F, U, E and R none; S reads his own client G's, K, R and F none", async () => {
    expect(await rows(K)).toEqual([1, 1, 1, 1, 1, 1]);
    for (const caller of [F, U, E, R]) expect(await rows(caller)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await rows(S, G)).toEqual([1, 0, 0, 1, 0, 0]);
    for (const caller of [K, R, F]) expect(await rows(caller, G)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  // LS-1061 B1: Command Center (sharedWith, loadTopFactors) and v1 (listClients, listThreads) ask about the signed-in
  // coach, never the head coach whose id names a sub-coach's alerts and threads. G's thread is under K's id.
  it.each<[string, string, object]>([
    ['K, the head coach: A', K, { overview: [1, 1, 1, 0], atRisk: {}, clients: { [A]: [true, true] }, threads: {} }],
    ['S, seated: his own G and delegated A', S, { overview: [2, 2, 2, 1], atRisk: { [G]: 'Missed check-ins' },
      clients: { [A]: [true, true], [G]: [true, true] }, threads: { [G]: 'at_risk' } }],
    ['R, the removed sub-coach: none', R, { overview: [0, 0, 0, 0], atRisk: {}, clients: {}, threads: {} }],
    ['F, the former coach: none', F, { overview: [0, 0, 0, 0], atRisk: {}, clients: {}, threads: {} }],
  ])('Overview, at-risk, v1 clients and threads: %s', async (_who, who, expected) => {
    const [o, r, c, t] = await Promise.all([center.getOverview(who), center.getAtRisk(who, {}),
      v1.listClients({ id: who, role: 'coach' }), v1.listThreads({ id: who, role: 'coach' })]);
    expect({ overview: [o.roster_size, o.active_today, o.pending_actions, o.at_risk_count],
      atRisk: Object.fromEntries(r.items.map((i) => [i.user_id, i.top_factor])),
      clients: Object.fromEntries(c.map((x) => [x.id, [!!x.lastCheckInAt, !!x.lastWorkoutAt]])),
      threads: Object.fromEntries(t.map((x) => [x.clientId, x.risk])) }).toEqual(expected);
  });

  it('an older app turning one off for K gets 410; the stored history stays and K still sees the logs', async () => {
    const before = await history();
    for (const scope of LINKED) await expect(consent.revoke(A, K, scope)).rejects.toBeInstanceOf(GoneException);
    expect(await history()).toEqual(before);
    expect(await timeline(K)).toEqual(SEES);
    const view = await consent.myConsentView(A, K);
    expect(view.consents.filter((c) => COACH_LINK_SCOPES.has(c.scope)).map((c) => c.granted)).toEqual([true, true, true, true]);
  });
});
