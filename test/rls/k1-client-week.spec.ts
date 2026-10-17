/**
 * K1WEEK: GET /coach/clients/:id/week (the client file's This week ring) on
 * the replayed migration chain. The real CoachService on the superuser
 * connection (as the API runs), so the service rule decides; the same rows are
 * also read as the signed-in API role `authenticated` (no row-security bypass),
 * a control of 4 before each 0.
 * Fictional people, fresh ids per run: coaches F, K and L; S, K's sub-coach
 * with a seat and a delegation for A; client A, whose phone set New York,
 * starts with F, moves to K, then to L; client B of K has no zone of their own
 * (an unstamped Tokyo row), so K's Los Angeles profile zone applies; client C
 * of L. The clock: Wednesday 2026-10-14 13:41 UTC.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import type { AuditService, AuditWriteInput } from '../../src/audit/audit.service';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentScope, ConsentService } from '../../src/consent/consent.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('k1-client-week: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("K1WEEK: a client's week reaches their coach now and no one else", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const audit = { write: jest.fn(async (_entry: AuditWriteInput) => undefined) };
  const service = new CoachService(
    prisma,
    stub<AuditService>(audit),
    new ConsentService(prisma, stub<AuditService>(audit)),
    new SubCoachScopeService(prisma),
  );
  const NOW = new Date('2026-10-14T13:41:00Z');
  const [F, K, L, S, A, B, C] = Array.from({ length: 7 }, () => randomUUID());
  const row: Record<string, string> = {};

  const week = (caller: string, client: string) => service.getClientWeek(caller, client, 'coach', {}, NOW);
  const refused = (caller: string, client: string) =>
    expect(week(caller, client)).rejects.toBeInstanceOf(NotFoundException);
  const listed = async (caller: string, client: string) =>
    (await week(caller, client)).assignments.map((r) => [r.id, r.day, r.completed_at !== null]);
  /** A's in-week rows as the signed-in API role, with app.current_user_id = who. */
  const seen = (who: string, role = 'coach') =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      const ids = ['aMon0', 'aMon1', 'aTue', 'aSun'].map((k) => row[k]);
      return tx.clientWorkoutAssignment.count({ where: { id: { in: ids } } });
    });
  const moveA = (to: string) => prisma.user.update({ where: { id: A }, data: { coach_id: to } });
  // A's week in New York: Monday 2026-10-12 04:00 UTC to Monday 2026-10-19 04:00 UTC.
  const aWeek = () => [
    [row.aMon0, '2026-10-12', false],
    [row.aMon1, '2026-10-12', false],
    [row.aTue, '2026-10-13', true],
    [row.aSun, '2026-10-18', false],
  ];

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [F, 'coach', null], [K, 'coach', null], [L, 'coach', null], [S, 'coach', K],
      [A, 'student', F], [B, 'student', K], [C, 'student', L],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `k1week-${id}`, name: 'Live person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S, client_id: A } });
    await prisma.notificationPreferences.create({ data: { user_id: A, timezone: 'America/New_York', timezone_updated_at: NOW } });
    await prisma.notificationPreferences.create({ data: { user_id: B, timezone: 'Asia/Tokyo' } });
    await prisma.coachProfile.create({ data: { user_id: K, invite_code: `k1w-${K}`, timezone: 'America/Los_Angeles' } });
    for (const [client_id, coach_id] of [[A, F], [A, K], [A, S], [B, K], [C, L]]) {
      await prisma.clientCoachConsent.create({
        data: { client_id, coach_id, scope: ConsentScope.FITNESS_WORKOUTS, granted_at: new Date('2026-10-01T00:00:00Z') },
      });
    }
    const plan = async (coach_id: string) =>
      (await prisma.workoutPlan.create({ data: { coach_id, name: 'Live plan', type: 'strength' } })).id;
    const plans = { [F]: await plan(F), [K]: await plan(K), [L]: await plan(L) };
    const seed: Array<[string, string, string, string, string?]> = [
      ['aBefore', A, F, '2026-10-12T03:59:00Z'], // Sunday 23:59 in New York: last week
      ['aMon0', A, F, '2026-10-12T04:00:00Z'], // Monday 00:00 in New York
      ['aMon1', A, F, '2026-10-12T05:00:00Z'], // Monday 01:00 in New York, still Sunday in Los Angeles
      ['aTue', A, F, '2026-10-13T12:00:00Z', '2026-10-13T23:00:00Z'], // a program day, done
      ['aSun', A, F, '2026-10-19T03:59:00Z'], // Sunday 23:59 in New York
      ['aAfter', A, F, '2026-10-19T04:00:00Z'], // next Monday 00:00 in New York
      ['bSun', B, K, '2026-10-12T05:00:00Z'], // Sunday 22:00 in Los Angeles (Monday in Tokyo)
      ['bMon', B, K, '2026-10-12T07:00:00Z'], // Monday 00:00 in Los Angeles
      ['cWed', C, L, '2026-10-14T18:00:00Z'],
    ];
    for (const [key, client_id, coach, at, done] of seed) {
      row[key] = (await prisma.clientWorkoutAssignment.create({
        data: {
          workout_plan_id: plans[coach], client_id, assigned_by_coach_id: coach,
          scheduled_for: new Date(at), completed_at: done ? new Date(done) : null,
        },
      })).id;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('the API role used below does not bypass row security', async () => {
    const [{ b }] = await prisma.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(b).toBe(false);
  });

  it("A is F's client: F reads A's New York week; K, K's sub-coach and L get 404", async () => {
    const out = await week(F, A);
    expect([out.week_start, out.today, out.shared]).toEqual(['2026-10-12', '2026-10-14', true]);
    expect(await listed(F, A)).toEqual(aWeek());
    for (const caller of [K, S, L]) await refused(caller, A);
    expect(await seen(F)).toBe(4);
    expect(await seen(K)).toBe(0);
  });

  it("A moves to K: K and K's sub-coach read the week, F's rows too; F, L, A and C get 404", async () => {
    await moveA(K);
    expect(await listed(K, A)).toEqual(aWeek());
    expect(await listed(S, A)).toEqual(aWeek());
    for (const caller of [F, L, A, C]) await refused(caller, A);
    expect(await seen(K)).toBe(4);
    expect(await seen(F)).toBe(0);
    expect(await seen(L)).toBe(0);
    expect(await seen(A, 'student')).toBe(4);
  });

  it("B has no zone of their own: K's Los Angeles week; C's row only ever reaches L", async () => {
    const out = await week(K, B);
    expect([out.week_start, out.today]).toEqual(['2026-10-12', '2026-10-14']);
    expect(await listed(K, B)).toEqual([[row.bMon, '2026-10-12', false]]);
    expect(await listed(L, C)).toEqual([[row.cWed, '2026-10-14', false]]);
    await refused(K, C);
  });

  it("A's old Workouts sharing-off for K no longer hides the week from K (#SHARE-SIMPLE)", async () => {
    await prisma.clientCoachConsent.updateMany({
      where: { client_id: A, coach_id: K, scope: ConsentScope.FITNESS_WORKOUTS },
      data: { revoked_at: new Date('2026-10-14T13:00:00Z') },
    });
    const out = await week(K, A);
    expect(out.shared).toBe(true);
    expect(out.assignments.map((r) => [r.id, r.day, r.completed_at !== null])).toEqual(aWeek());
  });

  it('A moves on to L: K and the sub-coach get 404; at the row layer L reads the week, K none of it', async () => {
    await moveA(L);
    for (const caller of [K, S]) await refused(caller, A);
    expect(await seen(L)).toBe(4);
    expect(await seen(K)).toBe(0);
  });

  it('only the allowed reads wrote a view to the audit log', () => {
    const pairs = audit.write.mock.calls.map(([e]) => [e.actorId, e.targetUserId]);
    expect(pairs).toEqual([[F, A], [F, A], [K, A], [S, A], [K, B], [K, B], [L, C], [K, A]]);
  });
});
