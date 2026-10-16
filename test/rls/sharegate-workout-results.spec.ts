/**
 * SHAREGATE (SoT A2 items 12-13): a coach reads a client's workout results only
 * while that client shares Workouts with them (Settings > Privacy > Coach
 * sharing), and never after the client moves to another coach. One shared gate,
 * the client summary's: ConsentService.coachCanAccess, through
 * coachSharingCheck. One row per coach route that returns workout results and
 * was open on main, plus the summary as the reference row. Each row walks one
 * fresh client of coach A with a finished workout: sharing on -> results,
 * sharing off -> none, moved to coach B (A's switch still on) -> none for A.
 * A's other client D shares throughout and keeps every result (the control).
 * A failed consent read fails the request with nothing returned.
 *
 * Real services on the superuser connection (service_role, as the API runs), so
 * the service rule decides; no row policy changes here.
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentScope, ConsentService } from '../../src/consent/consent.service';
import type { EmailService } from '../../src/email/email.service';
import { InviteCodesService } from '../../src/invite-codes/invite-codes.service';
import { PrismaService } from '../../src/prisma.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('sharegate-workout-results: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("Coach reads of workout results follow the client's Workouts switch", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  /** Only what these reads reach. */
  const stub = <T>(part: Partial<T>) => part as T;
  const audit = stub<AuditService>({ write: async () => undefined });
  const consent = new ConsentService(prisma, audit);
  const WORKOUTS = ConsentScope.FITNESS_WORKOUTS;
  /** The API's services, wired with `gate` as their ConsentService. */
  const services = (gate: ConsentService) => ({
    plans: new WorkoutBuilderService(prisma, undefined, undefined, undefined, gate),
    invites: new InviteCodesService(
      prisma, stub<AnalyticsService>({}), stub<EmailService>({}), audit, undefined, undefined, gate,
    ),
    coach: new CoachService(prisma, audit, gate),
  });
  const live = services(consent);
  const failing = services(stub<ConsentService>({
    coachCanAccess: async () => {
      throw new Error('consent read failed');
    },
  }));
  // Fictional people, fresh ids per run. Coaches a and b; d: a's client who keeps sharing.
  const [a, b] = [randomUUID(), randomUUID()];
  let plan = '';
  let d = '';
  const inviteOf = new Map<string, string>();

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({
      data: { id, supabase_id: id, email: `sharegate-${id}`, name: 'Live person', role, coach_id },
    });
  /** A client of A who joined on A's invite, finished A's plan once, logged it, and shares Workouts. */
  const client = async () => {
    const id = randomUUID();
    await person(id, 'student', a);
    await prisma.clientWorkoutAssignment.create({
      data: {
        workout_plan_id: plan, client_id: id, assigned_by_coach_id: a, scheduled_for: new Date(),
        started_at: new Date(), completed_at: new Date(), post_rpe: 7, post_notes: 'Felt good',
        completion_payload: { sets_done: 3 },
      },
    });
    await prisma.workoutSession.create({
      data: { user_id: id, date: new Date(), workout_name: 'Push', workout_type: 'strength' },
    });
    const invite = await prisma.inviteCode.create({
      data: { code: `SG-${id}`, coach_id: a, accepted_by_user_id: id, accepted_at: new Date() },
    });
    inviteOf.set(id, invite.id);
    await consent.grant(id, a, WORKOUTS);
    return id;
  };

  type Services = ReturnType<typeof services>;
  // [route, the results `s` returns to coach A about `c` (0 = none), the count while shared]
  const routes: Array<[string, (s: Services, c: string) => Promise<number>, number]> = [
    [
      'GET /workout-plans/:planId/assignments (rows with completion, notes, effort)',
      async (s, c) => {
        const page = await s.plans.listAssignments(a, plan);
        return (page.items as Array<{ client_id: string; completed_at: Date | null }>)
          .filter((r) => r.client_id === c && r.completed_at).length;
      },
      1,
    ],
    [
      'GET /coach/invite-codes/:id/redeemers (last active from a logged workout)',
      async (s, c) => {
        const rows = await s.invites.listRedeemersForCoach(a, inviteOf.get(c) ?? '');
        return rows.filter((r) => r.user_id === c && r.last_active_at).length;
      },
      1,
    ],
    [
      'GET /coach/clients/:id/summary (reference: recent workouts and assignments)',
      async (s, c) => {
        const sum = await s.coach.getClientSummary(a, c, undefined, 'coach');
        return 'error' in sum ? 0 : sum.recent_workouts.length + sum.recent_assignments.length;
      },
      2,
    ],
  ];

  beforeAll(async () => {
    for (const coach of [a, b]) await person(coach, 'coach', null);
    plan = (await prisma.workoutPlan.create({ data: { coach_id: a, name: 'Push day', type: 'strength' } })).id;
    d = await client();
  });
  afterAll(() => prisma.$disconnect());

  it.each(routes)('%s: on -> results, off -> none, moved -> none for the old coach', async (_route, read, on) => {
    const c = await client();
    expect([await read(live, c), await read(live, d)]).toEqual([on, on]);

    await consent.revoke(c, a, WORKOUTS);
    expect([await read(live, c), await read(live, d)]).toEqual([0, on]);

    await consent.grant(c, a, WORKOUTS);
    expect(await read(live, c)).toBe(on);
    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    await consent.grant(c, b, WORKOUTS);
    expect([await read(live, c), await read(live, d)]).toEqual([0, on]);
  });

  it.each(routes)('%s: a failed consent read fails closed', async (_route, read) => {
    await expect(read(failing, d)).rejects.toThrow('consent read failed');
  });
});
