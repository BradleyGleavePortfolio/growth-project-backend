/**
 * TRAIN-BE2 (20270502005700, 20270502005800): the catalog id on a logged set
 * (ExerciseSet.exercise_external_id) and a coach's comment on a workout
 * (WorkoutComment) follow the client. Row access runs as the API role
 * `authenticated` (no RLS bypass) on the replayed chain; every 0 comes right
 * after a 1 for the same caller on a row of the same kind. Coach F coaches A and
 * D, coach K coaches B, coach L coaches C; A then moves from F to K. The service
 * cases call the real WorkoutService and CoachService on the superuser
 * connection, as the API does.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../src/prisma.service';
import { WorkoutService } from '../../src/workout/workout.service';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentService } from '../../src/consent/consent.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { DataExportService } from '../../src/data-export/data-export.service';
import { ERASURE_MANIFEST, executeErasureManifest } from '../../src/account-deletion/account-deletion.manifest';
import { CreateExerciseSetDto, ExerciseHistoryQueryDto, WorkoutCommentDto } from '../../src/workout/workout.dto';
import type { AuditService } from '../../src/audit/audit.service';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('workout-comments-history-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

function stub<T>(value: unknown): T {
  return value as T;
}

const errors = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property);

describe('TRAIN-BE2 request shapes', () => {
  it('exercise history needs the catalog id or the name; a comment is 1 to 1000 characters after trimming', async () => {
    expect(await errors(ExerciseHistoryQueryDto, {})).toEqual(['exercise_id', 'name']);
    expect(await errors(ExerciseHistoryQueryDto, { exercise_id: 'ex-bench' })).toEqual([]);
    expect(await errors(ExerciseHistoryQueryDto, { name: 'Bench press' })).toEqual([]);
    expect(await errors(ExerciseHistoryQueryDto, { exercise_id: ' ', name: 'Bench press' })).toEqual(['exercise_id']);
    expect(await errors(WorkoutCommentDto, { body: '   ' })).toEqual(['body']);
    expect(await errors(WorkoutCommentDto, { body: 'x'.repeat(1001) })).toEqual(['body']);
    expect(plainToInstance(WorkoutCommentDto, { body: '  Strong day.  ' }).body).toBe('Strong day.');
  });
});

(DB_URL ? describe : describe.skip)('TRAIN-BE2: exercise ids and workout comments follow the client', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const workouts = new WorkoutService(prisma, stub<PtmService>({ emit: jest.fn() }),
    stub<ClientAIContextService>({ invalidateForUser: jest.fn() }));
  const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
  const coach = new CoachService(prisma, audit, new ConsentService(prisma, audit), new SubCoachScopeService(prisma));
  const u: Record<string, string> = Object.fromEntries([...'FKLABCD'].map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', D: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const w: Record<string, string> = {};
  const set = (exercise_name: string, exercise_external_id: string | undefined, lbs: number, reps: number): CreateExerciseSetDto =>
    ({ exercise_name, exercise_external_id, muscle_group: 'chest', sets_completed: 2, reps_per_set: [reps, reps], weight_per_set: [lbs, lbs - 5] });
  const log = async (key: string, who: string, date: string, exercises: CreateExerciseSetDto[]) => {
    w[key] = (await workouts.createWorkout(u[who], { date, workout_name: 'Push', workout_type: 'strength', exercises })).id;
  };

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: supa[who], role: 'authenticated' }));
      return query(tx);
    });
  const count = async (who: string, sql: string, ...params: string[]) =>
    (await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(sql, ...params)))[0].n;
  /** Sets of workout `wk` carrying the catalog id that `who` reads. */
  const setsSeen = (who: string, wk: string) => count(who,
    `SELECT count(*)::int AS n FROM "ExerciseSet" WHERE "workout_id" = $1 AND "exercise_external_id" = 'ex-bench'`, w[wk]);
  /** `by`'s comments on workout `wk` that `who` reads. */
  const commentSeen = (who: string, wk: string, by: string) => count(who,
    `SELECT count(*)::int AS n FROM "WorkoutComment" WHERE "workout_id" = $1 AND "coach_id" = $2`, w[wk], u[by]);
  /** An API-role write: the row count, or the SQLSTATE it was refused with. */
  const api = (who: string, sql: string, ...params: string[]) => as(who, (tx) => tx.$executeRawUnsafe(sql, ...params))
    .then((n) => n, (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused');
  const SET_WRITE = `UPDATE "ExerciseSet" SET "exercise_external_id" = 'ex-bench' WHERE "workout_id" = $1 AND "exercise_external_id" = 'ex-bench'`;
  const COMMENT_WRITES = [
    `INSERT INTO "WorkoutComment" ("id", "workout_id", "coach_id", "body", "updated_at") VALUES ($1, $2, $3, 'Mine now', now())`,
    `UPDATE "WorkoutComment" SET "body" = 'Changed' WHERE "id" <> $1 AND "workout_id" = $2 AND "coach_id" = $3`,
    `DELETE FROM "WorkoutComment" WHERE "id" <> $1 AND "workout_id" = $2 AND "coach_id" = $3`,
  ];
  const notFound = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundException);

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`tb2-${u[k]}@example.test`}, ${`Coach ${k}`}, ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    await log('A0', 'A', '2026-08-01', [set('Bench Press', undefined, 125, 8)]);
    await log('A1', 'A', '2026-09-01', [set('Bench press', 'ex-bench', 135, 5), set('Incline bench press', 'ex-incline', 95, 8)]);
    await log('A2', 'A', '2026-10-01', [set('Bench press', 'ex-bench', 100, 5)]);
    // The second writer (PUT /workouts/:id) keeps the id too.
    await workouts.updateWorkout(u.A, w.A2, { exercises: [set('Bench press', 'ex-bench', 155, 6), set('Bench press', 'ex-other', 160, 6)] });
    for (const [key, who] of [['B', 'B'], ['C', 'C'], ['D', 'D']]) await log(key, who, '2026-10-02', [set('Bench press', 'ex-bench', 300, 1)]);
    for (const [by, client, wk] of [['F', 'A', 'A1'], ['F', 'D', 'D'], ['K', 'B', 'B'], ['L', 'C', 'C']]) {
      await coach.setWorkoutComment(u[by], u[client], w[wk], 'Bar speed looked good.', 'coach');
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on tables with RLS forced', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw`SELECT relname::text AS t, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('ExerciseSet', 'WorkoutComment') ORDER BY relname`)
      .toEqual([{ t: 'ExerciseSet', forced: true }, { t: 'WorkoutComment', forced: true }]);
  });

  it("before the move: A and coach F read A's set ids and F's comment; coaches K, L and clients B, C read neither", async () => {
    expect([await setsSeen('A', 'A1'), await setsSeen('F', 'A1')]).toEqual([1, 1]);
    expect([await commentSeen('A', 'A1', 'F'), await commentSeen('F', 'A1', 'F')]).toEqual([1, 1]);
    for (const [who, own] of [['K', 'B'], ['L', 'C'], ['B', 'B'], ['C', 'C']]) {
      expect([await setsSeen(who, own), await setsSeen(who, 'A1')]).toEqual([1, 0]);
      expect([await commentSeen(who, own, coachOf[own]), await commentSeen(who, 'A1', 'F')]).toEqual([1, 0]);
    }
  });

  it('only the client writes their set ids; no API role writes a comment, its author included (the server writes it)', async () => {
    for (const [who, own] of [['A', 'A1'], ['B', 'B'], ['C', 'C']]) expect(await api(who, SET_WRITE, w[own])).toBe(1);
    for (const who of [...'FKLBC']) expect(await api(who, SET_WRITE, w.A1)).toBe(0);
    for (const sql of COMMENT_WRITES) {
      for (const who of [...'FAKLBC']) expect(await api(who, sql, randomUUID(), w.A1, u[who === 'A' ? 'F' : who])).not.toBe(1);
    }
    expect(await prisma.workoutComment.findMany({ where: { workout_id: w.A1 }, select: { coach_id: true, body: true } }))
      .toEqual([{ coach_id: u.F, body: 'Bar speed looked good.' }]);
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.user.update({ where: { id: u.A }, data: { coach_id: u.K } });
    });

    it("A keeps F's comment; F reads it no more; the new coach K reads A's set ids but never F's comment", async () => {
      expect(await commentSeen('A', 'A1', 'F')).toBe(1);
      expect([await setsSeen('F', 'D'), await setsSeen('F', 'A1')]).toEqual([1, 0]);
      expect([await commentSeen('F', 'D', 'F'), await commentSeen('F', 'A1', 'F')]).toEqual([1, 0]);
      expect([await setsSeen('K', 'A1'), await commentSeen('K', 'B', 'K'), await commentSeen('K', 'A1', 'F')]).toEqual([1, 1, 0]);
      expect([await setsSeen('L', 'C'), await setsSeen('L', 'A1')]).toEqual([1, 0]);
    });

    it('the coach routes: K comments on A now; the former coach F and coach L get 404 and change nothing', async () => {
      expect(await coach.setWorkoutComment(u.K, u.A, w.A2, 'Heaviest yet.', 'coach'))
        .toEqual({ workout_id: w.A2, body: 'Heaviest yet.', updated_at: expect.any(Date) });
      expect([await commentSeen('K', 'A2', 'K'), await commentSeen('A', 'A2', 'K')]).toEqual([1, 1]);
      await notFound(coach.setWorkoutComment(u.F, u.A, w.A1, 'Changed', 'coach'));
      await notFound(coach.setWorkoutComment(u.F, u.A, w.A1, null, 'coach'));
      await notFound(coach.setWorkoutComment(u.L, u.A, w.A2, 'Changed', 'coach'));
      // K names the wrong client for A's workout: 404.
      await notFound(coach.setWorkoutComment(u.K, u.B, w.A2, 'Changed', 'coach'));
      expect(await prisma.workoutComment.count({ where: { workout_id: { in: [w.A1, w.A2] } } })).toBe(2);
      // K's client file carries K's own comment on each workout, never F's.
      const summary = stub<{ recent_workouts: Array<{ id: string; comments: Array<{ body: string }> }> }>(
        await coach.getClientSummary(u.K, u.A, undefined, 'coach'));
      const commentsOn = (wk: string) => summary.recent_workouts.find((r) => r.id === w[wk])?.comments.map((c) => c.body);
      expect([commentsOn('A1'), commentsOn('A2')]).toEqual([[], ['Heaviest yet.']]);
    });

    it("A's exercise history: by id and legacy name, all of A's workouts and only A's, every coach's comment", async () => {
      const h = await workouts.getExerciseHistory(u.A, { exercise_id: 'ex-bench', name: 'bench press' });
      expect(h.sessions.map((s) => [s.date, s.top_set, s.coach_comments])).toEqual([
        ['2026-10-01', { weight_lbs: 155, reps: 6 }, [{ coach_name: 'Coach K', body: 'Heaviest yet.' }]],
        ['2026-09-01', { weight_lbs: 135, reps: 5 }, [{ coach_name: 'Coach F', body: 'Bar speed looked good.' }]],
        ['2026-08-01', { weight_lbs: 125, reps: 8 }, []],
      ]);
      expect(h.sessions[0]).toMatchObject({ workout_id: w.A2, sets: 2, reps_per_set: [6, 6], weight_per_set_lbs: [155, 150] });
      expect([h.best, h.first]).toEqual([
        { date: '2026-10-01', top_set: { weight_lbs: 155, reps: 6 } }, { date: '2026-08-01', top_set: { weight_lbs: 125, reps: 8 } }]);
      expect((await workouts.getExerciseHistory(u.A, { exercise_id: 'ex-bench' })).sessions.map((s) => s.date))
        .toEqual(['2026-10-01', '2026-09-01']);
      // By name alone: every Bench press A logged, whatever id it carries; never the incline.
      const byName = (await workouts.getExerciseHistory(u.A, { name: 'BENCH PRESS' })).sessions;
      expect(byName.map((s) => s.top_set?.weight_lbs ?? 0).sort((x, y) => x - y)).toEqual([125, 135, 155, 160]);
      const b = await workouts.getExerciseHistory(u.B, { exercise_id: 'ex-bench', name: 'Bench press' });
      expect(b.sessions.map((s) => [s.workout_id, s.coach_comments.map((c) => c.coach_name)])).toEqual([[w.B, ['Coach K']]]);
    });

    it("A's data download holds every comment on A's workouts and no one else's; erasing coach F takes only F's", async () => {
      const exporter = new DataExportService(prisma);
      const build = Reflect.get(exporter, '_buildArchive') as (who: string, e: string) => Promise<{ buffer: Buffer }>;
      const comments = async (who: string) => stub<{ workout_comments: Array<{ workout_id: string; body: string }> }>(
        JSON.parse((await build.call(exporter, u[who], randomUUID())).buffer.toString('utf8')))
        .workout_comments.map((c) => [c.workout_id, c.body]);
      expect(await comments('A')).toEqual([[w.A1, 'Bar speed looked good.'], [w.A2, 'Heaviest yet.']]);
      expect([await comments('B'), await comments('K')]).toEqual([[[w.B, 'Bar speed looked good.']], []]);
      const steps = ERASURE_MANIFEST.filter((e) => e.model === 'WorkoutComment');
      expect(steps.map((e) => [e.field, e.action.op])).toEqual([['coach_id', 'delete']]);
      await prisma.$transaction((tx: Prisma.TransactionClient) => executeErasureManifest(tx,
        { userId: u.F, email: `tb2-${u.F}@example.test`, tombstoneEmail: `${randomUUID()}@example.test`, now: new Date() }, steps));
      expect(await comments('A')).toEqual([[w.A2, 'Heaviest yet.']]);
    });
  });
});
