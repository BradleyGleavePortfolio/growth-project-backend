/**
 * SHARE-UNWIND (#SHARE-SIMPLE, owner op 1) on the replayed migration chain: workouts, food logs and
 * weigh-ins reach the client's coach now, whatever the old switches say, and no one else. Client A moved
 * from F to K and had turned those three switches off for K before the change; F still holds old grants.
 * S is K's sub-coach with an open delegation for A, E's delegation for A ended, U coaches B.
 * The real CoachService and ConsentService run as the API does; the row layer is read as the non-bypass
 * `authenticated` role, and each 0 there follows K's read of the same rows returning them.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { GoneException } from '@nestjs/common';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachService } from '../../src/coach/coach.service';
import { COACH_LINK_SCOPES, ConsentScope, ConsentService } from '../../src/consent/consent.service';
import { coachSharingCheck, seesWeight } from '../../src/consent/coach-sharing-gate';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('share-unwind-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('SHARE-UNWIND: workouts, food logs and weigh-ins reach the coach now and no one else', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const audit = { write: jest.fn(async () => undefined) } as unknown as AuditService;
  const consent = new ConsentService(prisma, audit, new SubCoachScopeService(prisma));
  const service = new CoachService(prisma, audit, consent, new SubCoachScopeService(prisma));
  const [F, K, U, S, E, A, B] = Array.from({ length: 7 }, () => randomUUID());
  const LINKED = [...COACH_LINK_SCOPES];
  const SEES = [1, 1, 1, true, true, true];

  const timeline = async (caller: string) => {
    const out = await service.getClientTimeline(caller, A, 90, 'coach');
    if ('error' in out) return out.error;
    return [out.workouts.length, out.meals.length, out.weights.length, out.consent.workouts, out.consent.food_macros, out.consent.body_metrics];
  };
  /** A's workout, food and weight rows as the signed-in API role, with app.current_user_id = who. */
  const rows = (who: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      const where = { user_id: A };
      return [await tx.workoutSession.count({ where }), await tx.loggedFoodEntry.count({ where }), await tx.weightLog.count({ where })];
    });
  const history = () =>
    prisma.clientCoachConsent.findMany({ where: { client_id: A }, orderBy: [{ coach_id: 'asc' }, { scope: 'asc' }] });

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [F, 'coach', null], [K, 'coach', null], [U, 'coach', null], [S, 'coach', K], [E, 'coach', K],
      [A, 'student', F], [B, 'student', U],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `unwind-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const sub of [S, E]) await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: sub } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S, client_id: A } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: E, client_id: A, unassigned_at: new Date() } });
    const granted_at = new Date('2026-09-01T00:00:00Z');
    for (const scope of LINKED) {
      await prisma.clientCoachConsent.create({ data: { client_id: A, coach_id: F, scope, granted_at } });
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
    await prisma.user.update({ where: { id: A }, data: { coach_id: K } });
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
    expect(await sharing(ConsentScope.FITNESS_WORKOUTS, [A, B])).toEqual(sees ? [A] : []);
    expect(await seesWeight(consent, caller, A, 'coach')).toBe(sees);
  });

  it("K's roster shows A's last workout, food log and weigh-in", async () => {
    const [row] = await service.withRosterActivity(K, 'coach', await service.getClients(K, 'all', 'coach'));
    const day = expect.any(String);
    expect(row.activity).toMatchObject({ last_workout_on: day, last_food_on: day, last_weigh_in_on: day });
  });

  it('row layer: K reads the rows; F, U and E read none', async () => {
    expect(await rows(K)).toEqual([1, 1, 1]);
    for (const caller of [F, U, E]) expect(await rows(caller)).toEqual([0, 0, 0]);
  });

  it('an older app turning one off for K gets 410; the stored history stays and K still sees the logs', async () => {
    const before = await history();
    for (const scope of LINKED) await expect(consent.revoke(A, K, scope)).rejects.toBeInstanceOf(GoneException);
    expect(await history()).toEqual(before);
    expect(await timeline(K)).toEqual(SEES);
    const view = await consent.myConsentView(A, K);
    expect(view.consents.filter((c) => COACH_LINK_SCOPES.has(c.scope)).map((c) => c.granted)).toEqual([true, true, true]);
  });
});
