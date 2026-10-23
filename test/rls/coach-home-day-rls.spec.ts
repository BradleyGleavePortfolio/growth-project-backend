/**
 * HOME-BE (#161-9, #161-10): the coach Home's day, GET
 * /coach/command-center/overview?include=home, on the replayed migration
 * chain. The real CommandCenterService on the superuser connection (as the API
 * runs), so the service rule decides; the win rows are also read as the
 * signed-in API role `authenticated` (no row-security bypass), a control of 1
 * before each 0.
 * Fictional people, fresh ids per run: coaches K (Los Angeles) and L (New
 * York); S, K's sub-coach with a seat and a delegation for A; clients A and B
 * of K, and C of L. A moves from K to L. The clock: Wednesday 2026-10-14
 * 13:00 in Los Angeles (20:00 UTC). REACHED-TODAY adds coach N (New York) and
 * the Needs-you clients N reached on N's own date.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import type { AdminPtmService } from '../../src/admin/ptm/admin-ptm.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import { CommandCenterService } from '../../src/coach/command-center/command-center.service';
import { ConsentService } from '../../src/consent/consent.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-home-day-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("HOME-BE: the coach Home's day reaches the client's coach now and no one else", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(v: object): T => v as T;
  const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
  const scope = new SubCoachScopeService(prisma);
  const service = new CommandCenterService(
    prisma,
    stub<AdminPtmService>({}),
    stub<CoachAlertsService>({}),
    scope,
    new ConsentService(prisma, audit, scope),
  );
  const NOW = new Date('2026-10-14T20:00:00Z');
  const [K, L, S, A, B, C] = Array.from({ length: 6 }, () => randomUUID());
  const row: Record<string, string> = {};
  const t = (iso: string) => new Date(iso);
  const day = (d: string) => new Date(`${d}T00:00:00Z`);

  const home = async (coach: string) => {
    const out = await service.getOverview(coach, { home: true, now: NOW });
    if (!out.home) throw new Error('no home block');
    return out.home;
  };
  const winIds = async (coach: string) => (await home(coach)).wins.items.map((w) => w.id);
  /** `read` as the signed-in API role for coach `who`. */
  const asCoach = <T>(who: string, read: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, 'coach');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      return read(tx);
    });
  /** Rows of A's wins `who` reads as the signed-in API role: 1 each, or 0 each. */
  const seen = (who: string) =>
    asCoach(who, async (tx) => [
      await tx.clientSignal.count({ where: { id: row.streak } }),
      await tx.workoutSession.count({ where: { id: row.session } }),
      await tx.exerciseSet.count({ where: { id: row.bench } }),
      await tx.weightLog.count({ where: { id: row.weighIn } }),
      await tx.userProfile.count({ where: { user_id: A } }),
    ]);
  const moveA = (to: string) => prisma.user.update({ where: { id: A }, data: { coach_id: to } });

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [K, 'coach', null], [L, 'coach', null], [S, 'coach', K],
      [A, 'student', K], [B, 'student', K], [C, 'student', L],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `homeday-${id}`, name: `Live ${id.slice(0, 4)}`, role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S, client_id: A } });
    await prisma.coachProfile.create({ data: { user_id: K, invite_code: `hd-${K}`, timezone: 'America/Los_Angeles' } });
    await prisma.coachProfile.create({ data: { user_id: L, invite_code: `hd-${L}`, timezone: 'America/New_York' } });

    // Streak signals: a 7-day milestone twice (one win), a non-milestone, last week's 14 (Sunday 23:59 in LA), C's 14.
    for (const [key, user_id, value, at] of [
      ['streak', A, 7, '2026-10-13T15:00:00Z'], ['streakAgain', A, 7, '2026-10-13T16:00:00Z'],
      ['streak5', A, 5, '2026-10-13T17:00:00Z'], ['streakLastWeek', A, 14, '2026-10-12T06:59:00Z'],
      ['streakC', C, 14, '2026-10-13T12:00:00Z'],
    ] as const) {
      row[key] = (await prisma.clientSignal.create({ data: { user_id, signal_type: 'checkin_streak', value, recorded_at: t(at) } })).id;
    }
    // Lifts: Bench beats its earlier top set; Deadlift only ties; Squat has no earlier set.
    const session = (date: string, created: string, sets: Array<[string, number[], number[]]>) =>
      prisma.workoutSession.create({
        data: {
          user_id: A, date: day(date), workout_name: 'Live lift', workout_type: 'strength', created_at: t(created),
          exercises: {
            create: sets.map(([exercise_name, weight_per_set, reps_per_set]) => ({
              exercise_name, muscle_group: 'chest' as const, sets_completed: reps_per_set.length, weight_per_set, reps_per_set,
            })),
          },
        },
        include: { exercises: true },
      });
    await session('2026-09-30', '2026-09-30T18:00:00Z', [['Bench Press', [185, 200], [5, 3]], ['Deadlift', [300], [5]]]);
    const week = await session('2026-10-13', '2026-10-13T18:00:00Z', [
      ['Bench Press', [205], [3]], ['Deadlift', [300], [5]], ['Squat', [225], [5]],
    ]);
    row.session = week.id;
    row.bench = week.exercises.find((e) => e.exercise_name === 'Bench Press')?.id ?? '';
    // Goal weight 180: 182 last week, 179.6 on Tuesday (reached), 179 today (already there).
    await prisma.userProfile.create({ data: { user_id: A, target_weight_lbs: 180 } });
    for (const [key, date, weight_lbs, at] of [
      ['weighInBefore', '2026-10-10', 182, '2026-10-10T14:00:00Z'], ['weighIn', '2026-10-13', 179.6, '2026-10-13T14:00:00Z'],
      ['weighInToday', '2026-10-14', 179, '2026-10-14T14:00:00Z'],
    ] as const) {
      row[key] = (await prisma.weightLog.create({ data: { user_id: A, date: day(date), weight_lbs, logged_at: t(at) } })).id;
    }
    // Check-ins today: A's reviewed, B's not; B's yesterday.
    for (const [user_id, date, at, reviewed] of [
      [A, '2026-10-14', '2026-10-14T14:00:00Z', true], [B, '2026-10-14', '2026-10-14T15:00:00Z', false],
      [B, '2026-10-13', '2026-10-13T15:00:00Z', false],
    ] as const) {
      await prisma.checkIn.create({ data: { user_id, coach_id: K, date: day(date), soreness: 2, logged_at: t(at), reviewed_by_coach: reviewed } });
    }
    // A's thread with K: last night's message (LA yesterday), one answered by an approved Roman draft, one
    // followed only by a broadcast copy. C's 01:00 New York message is L's today.
    const message = (coach_id: string, client_id: string, sender_id: string, at: string, extra = {}) =>
      prisma.coachMessage.create({ data: { coach_id, client_id, sender_id, body: 'Live message', created_at: t(at), ...extra } });
    await message(K, A, A, '2026-10-14T06:30:00Z');
    await message(K, A, A, '2026-10-14T15:00:00Z');
    await message(K, A, K, '2026-10-14T16:00:00Z', { ai_draft_id: randomUUID() });
    await message(K, A, A, '2026-10-14T17:00:00Z');
    const copy = await message(K, A, K, '2026-10-14T18:00:00Z');
    const [bc, run] = [randomUUID(), randomUUID()];
    await prisma.coachBroadcast.create({ data: { id: bc, coach_id: K, author_user_id: K, status: 'sending',
      body: 'Live broadcast', segment: {}, timezone: 'UTC' } });
    await prisma.coachBroadcastRun.create({ data: { id: run, broadcast_id: bc, run_key: NOW.toISOString(),
      scheduled_for: NOW, status: 'delivering', body: 'Live broadcast', segment: {} } });
    await prisma.coachBroadcastDelivery.create({ data: { run_id: run, broadcast_id: bc, recipient_id: A,
      message_id: copy.id } });
    await message(L, C, C, '2026-10-14T05:00:00Z');
    // Needs you: A, B (K) and C (L) are at risk; K nudged B last night (LA yesterday).
    for (const [user_id, risk_score] of [[A, 0.8], [B, 0.7], [C, 0.9]] as const) {
      await prisma.ptmPrediction.create({ data: { user_id, risk_score, success_score: 0.2, prediction_basis: 'heuristic_v1',
        computed_at: t('2026-10-14T12:00:00Z') } });
    }
    await prisma.coachNudge.create({ data: { coach_id: K, client_id: B, title: 'Live nudge', body: 'Live nudge',
      created_at: t('2026-10-14T06:00:00Z') } });
  });
  afterAll(() => prisma.$disconnect());

  it('the API role used below does not bypass row security; the new index is valid', async () => {
    const [{ b }] = await prisma.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(b).toBe(false);
    const [idx] = await prisma.$queryRaw<{ valid: boolean; def: string }[]>`
      SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
      WHERE i.indexrelid = '"ExerciseSet_workout_id_idx"'::regclass`;
    expect(idx.valid).toBe(true);
    expect(idx.def).toMatch(/ON public\."ExerciseSet" USING btree \(workout_id\)/);
  });

  it("K reads this week's wins and today's rings on K's own date", async () => {
    const out = await home(K);
    expect([out.date, out.week_start, out.time_zone]).toEqual(['2026-10-14', '2026-10-12', 'America/Los_Angeles']);
    expect(out.wins.count).toBe(3);
    expect(out.wins.items.map((w) => w.id)).toEqual([`lifting_best:${row.bench}`, `checkin_streak:${row.streak}`, `goal_weight:${row.weighIn}`]);
    expect(out.wins.items[0]).toEqual(expect.objectContaining({
      kind: 'lifting_best', client_id: A, client_name: `Live ${A.slice(0, 4)}`, at: '2026-10-13T18:00:00.000Z',
      exercise: 'Bench Press', weight_lbs: 205, reps: 3,
      draft: expect.objectContaining({ capability: 'draft.coach_message', subject_user_id: A }),
    }));
    expect(out.wins.items[2]).toEqual(expect.objectContaining({ weight_lbs: 179.6, goal_weight_lbs: 180 }));
    expect(out.rings).toEqual({
      check_ins: { reviewed: 1, submitted: 2 },
      replies: { answered: 1, received: 2 },
      reach_outs: { contacted: 1, goal: 2, contacted_ids: [A] },
    });
    expect((await service.getOverview(K, { now: NOW })).home).toBeUndefined();
  });

  it("K's sub-coach reads only A; L reads only C, on L's New York date", async () => {
    const sub = await home(S);
    expect(sub.wins.count).toBe(3);
    expect(sub.rings).toEqual({
      check_ins: { reviewed: 1, submitted: 1 },
      replies: { answered: 1, received: 2 },
      reach_outs: { contacted: 1, goal: 1, contacted_ids: [A] },
    });
    const l = await home(L);
    expect([l.date, l.time_zone]).toEqual(['2026-10-14', 'America/New_York']);
    expect(l.wins.items.map((w) => w.id)).toEqual([`checkin_streak:${row.streakC}`]);
    expect(l.rings).toEqual({
      check_ins: { reviewed: 0, submitted: 0 },
      replies: { answered: 0, received: 1 },
      reach_outs: { contacted: 0, goal: 1, contacted_ids: [] },
    });
    expect(await seen(K)).toEqual([1, 1, 1, 1, 1]);
    expect(await seen(L)).toEqual([0, 0, 0, 0, 0]);
  });

  it('A moves to L: K and the sub-coach read nothing of A; L reads A\'s wins on L\'s week but not K\'s thread', async () => {
    await moveA(L);
    const k = await home(K);
    expect(k.wins).toEqual({ count: 0, items: [] });
    expect(k.rings).toEqual({
      check_ins: { reviewed: 0, submitted: 1 },
      replies: { answered: 0, received: 0 },
      reach_outs: { contacted: 0, goal: 1, contacted_ids: [] },
    });
    const sub = await home(S);
    expect([sub.wins.count, sub.rings.replies.received, sub.rings.reach_outs.goal]).toEqual([0, 0, 0]);
    // A's 14-day milestone at Monday 02:59 in New York is in L's week (it was last week for K).
    const l = await home(L);
    expect(l.wins.count).toBe(5);
    expect(await winIds(L)).toEqual([
      `lifting_best:${row.bench}`, `checkin_streak:${row.streak}`, `goal_weight:${row.weighIn}`,
      `checkin_streak:${row.streakC}`, `checkin_streak:${row.streakLastWeek}`,
    ]);
    expect(l.rings.replies).toEqual({ answered: 0, received: 1 });
    expect(l.rings.reach_outs).toEqual({ contacted: 0, goal: 2, contacted_ids: [] });
    expect(await seen(K)).toEqual([0, 0, 0, 0, 0]);
    expect(await seen(L)).toEqual([1, 1, 1, 1, 1]);
  });

  describe('fix round 1: unattended messages, goal weight once, lift identity (coach M, client D)', () => {
    const [M, D] = [randomUUID(), randomUUID()];
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      await prisma.user.create({ data: { id: M, supabase_id: M, email: `homeday-${M}`, name: 'Live M', role: 'coach' } });
      await prisma.user.create({ data: { id: D, supabase_id: D, email: `homeday-${D}`, name: 'Live D', role: 'student', coach_id: M } });
      await prisma.coachProfile.create({ data: { user_id: M, invite_code: `hd-${M}`, timezone: 'America/Los_Angeles' } });
      await prisma.ptmPrediction.create({ data: { user_id: D, risk_score: 0.8, success_score: 0.2, prediction_basis: 'heuristic_v1',
        computed_at: t('2026-10-14T12:00:00Z') } });
      // D writes twice today; only the coach welcome and a package auto message follow.
      for (const [sender_id, at, extra] of [
        [D, '2026-10-14T15:00:00Z', {}], [M, '2026-10-14T15:13:00Z', { automated_by: 'coach_welcome', welcome_job_id: randomUUID() }],
        [D, '2026-10-14T16:00:00Z', {}], [M, '2026-10-14T17:00:00Z', { automated_by: 'package_message' }],
      ] as const) {
        await prisma.coachMessage.create({ data: { coach_id: M, client_id: D, sender_id, body: 'Live message', created_at: t(at), ...extra } });
      }
      // Goal 180: reached last Tuesday (179.5), back above, crosses again this week (179.8), back above.
      await prisma.userProfile.create({ data: { user_id: D, target_weight_lbs: 180 } });
      for (const [date, weight_lbs] of [['2026-10-01', 182], ['2026-10-06', 179.5], ['2026-10-09', 181], ['2026-10-13', 179.8], ['2026-10-14', 180.6]] as const) {
        const w = await prisma.weightLog.create({ data: { user_id: D, date: day(date), weight_lbs, logged_at: t(`${date}T14:00:00Z`) } });
        ids[date] = w.id;
      }
      // Lifts. Bench, catalog id ex-bench: 225 x 5 logged with no id as "Bench Press", 185 x 5 under the id as
      // "Bench press", 205 x 5 this week under the id: not a best. Row: the same label under two ids; id B's
      // 100 x 5 this week beats id B's 90 x 5, never id A's 300 x 5.
      const lift = (date: string, sets: Array<[string, string | null, number]>) =>
        prisma.workoutSession.create({
          data: {
            user_id: D, date: day(date), workout_name: 'Live lift', workout_type: 'strength', created_at: t(`${date}T18:00:00Z`),
            exercises: { create: sets.map(([exercise_name, exercise_external_id, w]) => ({ exercise_name, exercise_external_id,
              muscle_group: 'chest' as const, sets_completed: 1, weight_per_set: [w], reps_per_set: [5] })) },
          },
          include: { exercises: true },
        });
      await lift('2026-09-30', [['Bench Press', null, 225], ['Row', 'ex-row-a', 300]]);
      await lift('2026-10-05', [['Bench press', 'ex-bench', 185], ['Row', 'ex-row-b', 90]]);
      const week = await lift('2026-10-13', [['Bench press', 'ex-bench', 205], ['Row', 'ex-row-b', 100]]);
      ids.row = week.exercises.find((e) => e.exercise_external_id === 'ex-row-b')?.id ?? '';
    });

    it('a welcome or a package message answers no one and reaches no one; a message the coach sends does', async () => {
      expect((await home(M)).rings).toEqual(expect.objectContaining({
        replies: { answered: 0, received: 2 }, reach_outs: { contacted: 0, goal: 1, contacted_ids: [] },
      }));
      await prisma.coachMessage.create({ data: { coach_id: M, client_id: D, sender_id: M, body: 'Live message',
        created_at: t('2026-10-14T18:00:00Z') } });
      expect((await home(M)).rings).toEqual(expect.objectContaining({
        replies: { answered: 2, received: 2 }, reach_outs: { contacted: 1, goal: 1, contacted_ids: [D] },
      }));
    });

    it('goal weight is a win once: last week, not again this week; a lift is the same lift as workout history', async () => {
      const lastWeek = await service.getOverview(M, { home: true, now: t('2026-10-07T20:00:00Z') });
      expect(lastWeek.home?.wins.items.filter((w) => w.kind === 'goal_weight').map((w) => w.id))
        .toEqual([`goal_weight:${ids['2026-10-06']}`]);
      const now = await home(M);
      expect(now.wins.items.map((w) => w.id)).toEqual([`lifting_best:${ids.row}`]);
      expect(now.wins.items[0]).toEqual(expect.objectContaining({ exercise: 'Row', weight_lbs: 100, reps: 5 }));
    });
  });

  describe("REACHED-TODAY: who coach N (New York) reached on N's own today; P is another coach", () => {
    // 20:00 UTC is 16:00 in New York, whose 2026-10-14 began at 04:00 UTC.
    const [N, P, E, F, G, H, Q] = Array.from({ length: 7 }, () => randomUUID());
    const ids: Record<string, string> = {};
    const reached = async (coach: string) => {
      const r = (await home(coach)).rings.reach_outs;
      return { ...r, contacted_ids: [...r.contacted_ids].sort() };
    };
    const sorted = (...xs: string[]) => [...xs].sort();
    /** N's voice note to F, N's nudge to G and N's message to H, as the signed-in API role. */
    const rows = (who: string) =>
      asCoach(who, async (tx) => [
        await tx.coachMessage.count({ where: { id: ids.voice } }),
        await tx.coachNudge.count({ where: { id: ids.nudge } }),
        await tx.coachMessage.count({ where: { id: ids.draft } }),
      ]);
    beforeAll(async () => {
      for (const [id, role, coach_id] of [
        [N, 'coach', null], [P, 'coach', null],
        [E, 'student', N], [F, 'student', N], [G, 'student', N], [H, 'student', N], [Q, 'student', P],
      ] as const) {
        await prisma.user.create({ data: { id, supabase_id: id, email: `homeday-${id}`, name: `Live ${id.slice(0, 4)}`, role, coach_id } });
      }
      await prisma.coachProfile.create({ data: { user_id: N, invite_code: `hd-${N}`, timezone: 'America/New_York' } });
      await prisma.coachProfile.create({ data: { user_id: P, invite_code: `hd-${P}`, timezone: 'America/Los_Angeles' } });
      for (const user_id of [E, F, G, H, Q]) {
        await prisma.ptmPrediction.create({ data: { user_id, risk_score: 0.8, success_score: 0.2, prediction_basis: 'heuristic_v1',
          computed_at: t('2026-10-14T12:00:00Z') } });
      }
      const send = (coach_id: string, client_id: string, at: string, extra = {}) =>
        prisma.coachMessage.create({ data: { coach_id, client_id, sender_id: coach_id, created_at: t(at), ...extra } });
      // E: 23:59 last night in New York (already the 14th in UTC), then only a package auto message today.
      await send(N, E, '2026-10-14T03:59:00Z', { body: 'Live message' });
      await send(N, E, '2026-10-14T15:00:00Z', { body: 'Live package', automated_by: 'package_message' });
      // F: a voice note at 00:01 in New York. G: a nudge. H: an approved Roman draft. Q: P's text.
      ids.voice = (await send(N, F, '2026-10-14T04:01:00Z', {
        voice_url: 'live/voice.m4a', voice_duration_sec: 4, voice_size_bytes: 4000, voice_content_type: 'audio/mp4',
      })).id;
      ids.nudge = (await prisma.coachNudge.create({ data: { coach_id: N, client_id: G, title: 'Live nudge', body: 'Live nudge',
        created_at: t('2026-10-14T13:00:00Z') } })).id;
      ids.draft = (await send(N, H, '2026-10-14T14:00:00Z', { body: 'Live draft', ai_draft_id: randomUUID() })).id;
      await send(P, Q, '2026-10-14T16:00:00Z', { body: 'Live message' });
    });

    it("N's today starts at New York midnight: a voice note, a nudge and a Roman draft count; last night and automated do not", async () => {
      expect(await reached(N)).toEqual({ contacted: 3, goal: 4, contacted_ids: sorted(F, G, H) });
      expect(await reached(P)).toEqual({ contacted: 1, goal: 1, contacted_ids: [Q] });
      // The rows behind it: N reads them, P reads none (a control of 1 before each 0).
      expect(await rows(N)).toEqual([1, 1, 1]);
      expect(await rows(P)).toEqual([0, 0, 0]);
    });

    it('H moves to P: N no longer lists H, and P never lists what N sent', async () => {
      await prisma.user.update({ where: { id: H }, data: { coach_id: P } });
      expect(await reached(N)).toEqual({ contacted: 2, goal: 3, contacted_ids: sorted(F, G) });
      expect(await reached(P)).toEqual({ contacted: 1, goal: 2, contacted_ids: [Q] });
      expect(await rows(N)).toEqual([1, 1, 0]);
      expect(await rows(P)).toEqual([0, 0, 0]);
    });
  });
});
