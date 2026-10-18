/**
 * LEARN-BE1: course, week, enrolment and progress rows, live on the replayed migration chain.
 * Coach K: published course C with weeks W1 (day 0), W2 (day 7) and W3 (day 14) holding lessons
 * X1-X3, draft course D (week DW, lesson DX), single lesson F and video KM. Coach L: course LC
 * (week LW, lesson LX) and video LM. K's client B started C and D eight days ago; K's client A is
 * not enrolled. Reads run as the non-bypass `authenticated` role, and every 0 follows a read of
 * the same row that returned 1. The tests run in order: progress and completions written early
 * are read again after B moves to coach L. Gate: TEST_DATABASE_URL; no URL -> skip, except
 * under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Prisma } from '@prisma/client';
import { LessonsService } from '../../src/lessons/lessons.service';
import { PrismaService } from '../../src/prisma.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('learn-courses-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

class Rollback extends Error {
  constructor(readonly rows: string[]) {
    super('rollback');
  }
}

(DB_URL ? describe : describe.skip)('LEARN-BE1: courses, weeks, enrolments and progress', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const id = (tag: string) => `${tag}-${run}`;
  const [K, L, A, B, C, D, LC, W1, W2, W3, DW, LW] =
    ['K', 'L', 'A', 'B', 'C', 'D', 'LC', 'W1', 'W2', 'W3', 'DW', 'LW'].map(id);
  const [F, X1, X2, X3, DX, LX, KM, LM, EC, ED] =
    ['F', 'X1', 'X2', 'X3', 'DX', 'LX', 'KM', 'LM', 'EC', 'ED'].map(id);
  const coaches = new Set([K, L]);
  const day = 86_400_000;
  const set = (...xs: string[]) => xs.sort();
  const pair = (user: string, lesson: string) => `${user}:${lesson}`;

  beforeAll(async () => {
    for (const [uid, coach_id] of [[K, null], [L, null], [A, K], [B, K]] as const) {
      const role = coaches.has(uid) ? 'coach' : 'student';
      await prisma.user.create({ data: { id: uid, supabase_id: uid, email: `learn-${uid}`, name: 'Live person', role, coach_id } });
    }
    for (const [mid, coach_id] of [[KM, K], [LM, L]] as const) {
      await prisma.coachMediaAsset.create({ data: { id: mid, coach_id, kind: 'video', title: 'Video', storage_key: mid, provider: 'mux' } });
    }
    for (const [cid, coach_id, status] of [[C, K, 'published'], [D, K, 'draft'], [LC, L, 'published']] as const) {
      await prisma.course.create({ data: { id: cid, coach_id, title: 'Course', status } });
    }
    const weeks = [[W1, C, K, 0], [W2, C, K, 7], [W3, C, K, 14], [DW, D, K, 0], [LW, LC, L, 0]] as const;
    for (const [mid, course_id, coach_id, opens_after_days] of weeks) {
      await prisma.courseModule.create({ data: { id: mid, course_id, coach_id, position: opens_after_days, title: 'Week', opens_after_days } });
    }
    const lessons = [[F, K, null], [X1, K, W1], [X2, K, W2], [X3, K, W3], [DX, K, DW], [LX, L, LW]] as const;
    for (const [lid, coach_id, module_id] of lessons) {
      await prisma.lesson.create({ data: { id: lid, coach_id, module_id, title: 'Lesson', tags: [], goal_tags: [] } });
    }
    const starts_on = new Date(Date.now() - 8 * day);
    for (const [eid, course_id] of [[EC, C], [ED, D]] as const) {
      await prisma.courseEnrolment.create({ data: { id: eid, course_id, user_id: B, starts_on, source: 'direct' } });
    }
  });
  afterAll(() => prisma.$disconnect());

  /** `query` as the signed-in API role (app.current_user_id = who). */
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, coaches.has(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return query(tx);
    });
  /** Every row of this run that `who` reads, per table. */
  const view = (who: string) =>
    as(who, async (tx) => {
      const mine = { id: { endsWith: run } };
      const ofRun = { user_id: { endsWith: run } };
      const ids = (rows: Array<{ id: string }>) => set(...rows.map((r) => r.id));
      const pairs = (rows: Array<{ user_id: string; lesson_id: string }>) => set(...rows.map((r) => pair(r.user_id, r.lesson_id)));
      return {
        courses: ids(await tx.course.findMany({ where: mine, select: { id: true } })),
        weeks: ids(await tx.courseModule.findMany({ where: mine, select: { id: true } })),
        lessons: ids(await tx.lesson.findMany({ where: mine, select: { id: true } })),
        enrolments: ids(await tx.courseEnrolment.findMany({ where: mine, select: { id: true } })),
        progress: pairs(await tx.lessonProgress.findMany({ where: ofRun })),
        completions: pairs(await tx.lessonCompletion.findMany({ where: ofRun })),
      };
    });

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(K, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('the coach reads all of their own; an enrolled client the published course, its weeks and the open weeks\' lessons', async () => {
    const none = { enrolments: [], progress: [], completions: [] };
    expect(await view(K)).toEqual({
      courses: set(C, D), weeks: set(W1, W2, W3, DW), lessons: set(F, X1, X2, X3, DX),
      enrolments: set(EC, ED), progress: [], completions: [],
    });
    expect(await view(B)).toEqual({
      courses: [C], weeks: set(W1, W2, W3), lessons: set(F, X1, X2), enrolments: set(EC, ED), progress: [], completions: [],
    });
    expect(await view(A)).toEqual({ courses: [], weeks: [], lessons: [F], ...none });
    expect(await view(L)).toEqual({ courses: [LC], weeks: [LW], lessons: [LX], ...none });
  });

  it('a week opens on its day, at once for an all-at-once course or after open-all; an ended enrolment keeps what had opened', async () => {
    const lessonsOf = async (who: string) => (await view(who)).lessons;
    expect(await lessonsOf(B)).toEqual(set(F, X1, X2));
    await prisma.course.update({ where: { id: C }, data: { week_rule: 'all_at_once' } });
    expect(await lessonsOf(B)).toEqual(set(F, X1, X2, X3));
    await prisma.course.update({ where: { id: C }, data: { week_rule: 'one_at_a_time' } });
    await prisma.courseEnrolment.update({ where: { id: EC }, data: { opened_all_at: new Date() } });
    expect(await lessonsOf(B)).toEqual(set(F, X1, X2, X3));
    await prisma.courseEnrolment.update({ where: { id: EC }, data: { opened_all_at: null, ended_at: new Date(Date.now() - 4 * day) } });
    expect(await view(B)).toMatchObject({ courses: [C], weeks: set(W1, W2, W3), lessons: set(F, X1) });
    await prisma.courseEnrolment.update({ where: { id: EC }, data: { ended_at: null } });
    expect(await lessonsOf(B)).toEqual(set(F, X1, X2));
  });

  it('progress: the client writes their own on a lesson they can open; the current coach only reads it', async () => {
    const write = (who: string, user_id: string, lesson_id: string) =>
      as(who, (tx) => tx.lessonProgress.create({ data: { user_id, lesson_id, position_seconds: 30, watched_seconds: 30 } }));
    await expect(write(B, B, X1)).resolves.toMatchObject({ user_id: B, lesson_id: X1 });
    await expect(write(B, B, X3)).rejects.toThrow();
    await expect(write(B, A, F)).rejects.toThrow();
    await expect(write(A, A, X1)).rejects.toThrow();
    const move = (who: string) =>
      as(who, (tx) => tx.lessonProgress.updateMany({ where: { lesson_id: X1 }, data: { position_seconds: 90 } }));
    expect(await move(B)).toEqual({ count: 1 });
    expect(await move(K)).toEqual({ count: 0 });
    expect((await view(B)).progress).toEqual([pair(B, X1)]);
    expect((await view(K)).progress).toEqual([pair(B, X1)]);
    expect((await view(L)).progress).toEqual([]);
    expect((await view(A)).progress).toEqual([]);
  });

  it('writes stay inside the coach\'s own courses, for every writer', async () => {
    const week = (coach_id: string) => ({ data: { course_id: C, coach_id, position: 9, title: 'Week' } });
    await expect(as(L, (tx) => tx.courseModule.create(week(L)))).rejects.toThrow();
    await expect(as(L, (tx) => tx.courseModule.create(week(K)))).rejects.toThrow();
    await expect(as(L, (tx) => tx.course.create({ data: { coach_id: K, title: 'Course' } }))).rejects.toThrow();
    expect(await as(K, (tx) => tx.course.updateMany({ where: { id: C }, data: { title: 'Course' } }))).toEqual({ count: 1 });
    expect(await as(L, (tx) => tx.course.updateMany({ where: { id: C }, data: { title: 'Taken' } }))).toEqual({ count: 0 });
    expect(await as(L, (tx) => tx.courseModule.updateMany({ where: { id: W1 }, data: { title: 'Taken' } }))).toEqual({ count: 0 });
    await expect(prisma.lesson.update({ where: { id: LX }, data: { module_id: W1 } })).rejects.toThrow();
    await expect(prisma.lesson.update({ where: { id: LX }, data: { media_asset_id: KM } })).rejects.toThrow();
    await expect(prisma.lesson.update({ where: { id: LX }, data: { media_asset_id: LM } })).resolves.toMatchObject({ media_asset_id: LM });
    await expect(prisma.lesson.update({ where: { id: LX }, data: { coach_id: K } })).rejects.toThrow();
    const enrol = (course_id: string, user_id: string) =>
      ({ data: { course_id, user_id, starts_on: new Date(), source: 'direct' as const } });
    await expect(as(B, (tx) => tx.courseEnrolment.create(enrol(LC, B)))).rejects.toThrow();
    await expect(as(K, (tx) => tx.courseEnrolment.create(enrol(C, A)))).rejects.toThrow();
    expect((await view(K)).enrolments).toEqual(set(EC, ED));
  });

  it('a completion is written once per client and lesson, and only by that client', async () => {
    const service = new LessonsService(prisma);
    const first = await service.completeLesson(A, F);
    await expect(service.completeLesson(A, F)).resolves.toMatchObject({ id: first.id });
    await expect(prisma.lessonCompletion.create({ data: { lesson_id: F, user_id: A } })).rejects.toThrow();
    const complete = (who: string, user_id: string, lesson_id: string) =>
      as(who, (tx) => tx.lessonCompletion.create({ data: { lesson_id, user_id } }));
    await expect(complete(B, B, X1)).resolves.toMatchObject({ user_id: B, lesson_id: X1 });
    await expect(complete(K, B, F)).rejects.toThrow();
    await expect(complete(A, B, F)).rejects.toThrow();
    await expect(complete(A, A, X1)).rejects.toThrow();
    expect((await view(K)).completions).toEqual(set(pair(A, F), pair(B, X1)));
  });

  it('after B moves to coach L, B keeps the course; K reads none of B\'s course rows and L reads them', async () => {
    expect(await view(K)).toMatchObject({ enrolments: set(EC, ED), progress: [pair(B, X1)] });
    await prisma.user.update({ where: { id: B }, data: { coach_id: L } });
    expect(await view(B)).toEqual({
      courses: [C], weeks: set(W1, W2, W3), lessons: set(X1, X2), enrolments: set(EC, ED),
      progress: [pair(B, X1)], completions: [pair(B, X1)],
    });
    expect(await view(K)).toMatchObject({ enrolments: [], progress: [], completions: [pair(A, F)] });
    expect(await view(L)).toEqual({
      courses: [LC], weeks: [LW], lessons: [LX], enrolments: set(EC, ED),
      progress: [pair(B, X1)], completions: [pair(B, X1)],
    });
  });

  it('20270502006100 keeps each client\'s first completion of a lesson and removes the repeats', async () => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20270502006100_lesson_completion_once/migration.sql'), 'utf8');
    const dedupe = /DELETE FROM "LessonCompletion"[\s\S]*?;/.exec(sql)?.[0] ?? '';
    expect(dedupe).toContain('USING "LessonCompletion"');
    const kept = await prisma
      .$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('DROP INDEX "LessonCompletion_lesson_id_user_id_key"');
        for (const [tag, date] of [['R3', 3], ['R1', 1], ['R2', 2]] as const) {
          await tx.lessonCompletion.create({
            data: { id: id(tag), lesson_id: F, user_id: B, completed_at: new Date(Date.UTC(2026, 9, date)) },
          });
        }
        await tx.$executeRawUnsafe(dedupe);
        const rows = await tx.lessonCompletion.findMany({ where: { user_id: { in: [A, B] } } });
        throw new Rollback(rows.map((r) => (r.lesson_id === F && r.user_id === B ? r.id : pair(r.user_id, r.lesson_id))));
      })
      .catch((e: unknown) => {
        if (e instanceof Rollback) return set(...e.rows);
        throw e;
      });
    expect(kept).toEqual(set(id('R1'), pair(A, F), pair(B, X1)));
    expect(await prisma.lessonCompletion.count({ where: { lesson_id: F, user_id: B } })).toBe(0);
  });
});
