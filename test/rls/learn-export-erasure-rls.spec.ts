/**
 * PRIVACY-SWEEP: course enrolments and lesson progress in the data download and in account
 * deletion, live on the replayed migration chain. Coach K: course C (week W1 with lessons X1
 * and X2, week W2 with X3) that clients A and B are enrolled in, course D (week DW, lesson DX)
 * that nobody is enrolled in, and single lessons F and G (B completed G). Coach L coaches
 * nobody here. The real DataExportService builds each person's download and the real
 * account-deletion manifest steps run on the same connection, as the deletion job does. Every
 * empty result follows a read of the same rows that found them. The tests run in order: A is
 * erased before K. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { DataExportService } from '../../src/data-export/data-export.service';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('learn-export-erasure-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

type Download = Record<string, Array<Record<string, unknown>>>;

(DB_URL ? describe : describe.skip)('PRIVACY-SWEEP: Learn rows in the data download and in erasure', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, A, B, C, D, W1, W2, DW, X1, X2, X3, DX, F, G, EA, EB] = [
    'K', 'L', 'A', 'B', 'C', 'D', 'W1', 'W2', 'DW', 'X1', 'X2', 'X3', 'DX', 'F', 'G', 'EA', 'EB',
  ].map((tag) => `${tag}-${run}`);
  const set = (...xs: string[]) => xs.sort();
  const pair = (r: Record<string, unknown>) => `${String(r.user_id)}:${String(r.lesson_id)}`;
  const exporter = new DataExportService(prisma);
  const build = Reflect.get(exporter, '_buildArchive') as (u: string, e: string) => Promise<{ buffer: Buffer }>;
  const download = async (who: string): Promise<Download> =>
    JSON.parse((await build.call(exporter, who, randomUUID())).buffer.toString('utf8'));
  /** The Learn rows of a download: enrolment ids, and user:lesson pairs of progress and completions. */
  const learn = (d: Download) => ({
    enrolments: set(...d.course_enrolments.map((r) => String(r.id))),
    progress: set(...d.lesson_progress.map(pair)),
    completions: set(...d.lesson_completions.map(pair)),
  });
  const none = { enrolments: [], progress: [], completions: [] };
  const steps = (...models: string[]) => ERASURE_MANIFEST.filter((e) => models.includes(e.model));
  const erase = (userId: string, entries: typeof ERASURE_MANIFEST) =>
    prisma.$transaction((tx: Prisma.TransactionClient) => executeErasureManifest(tx,
      { userId, email: `learn-${userId}`, tombstoneEmail: `deleted-${userId}`, now: new Date() }, entries));

  beforeAll(async () => {
    const people = [[K, 'coach', null], [L, 'coach', null], [A, 'student', K], [B, 'student', K]] as const;
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `learn-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const id of [C, D]) {
      await prisma.course.create({ data: { id, coach_id: K, title: 'Course', status: 'published' } });
    }
    for (const [id, course_id, position] of [[W1, C, 0], [W2, C, 1], [DW, D, 0]] as const) {
      await prisma.courseModule.create({ data: { id, course_id, coach_id: K, position, title: 'Week' } });
    }
    for (const [id, module_id] of [[X1, W1], [X2, W1], [X3, W2], [DX, DW], [F, null], [G, null]] as const) {
      await prisma.lesson.create({ data: { id, coach_id: K, module_id, title: 'Lesson', tags: [], goal_tags: [] } });
    }
    for (const [id, user_id] of [[EA, A], [EB, B]] as const) {
      await prisma.courseEnrolment.create({
        data: { id, course_id: C, user_id, starts_on: new Date('2026-10-01'), source: 'direct' },
      });
    }
    await prisma.lessonProgress.createMany({ data: [
      { user_id: A, lesson_id: X1, position_seconds: 40, watched_seconds: 40 },
      { user_id: A, lesson_id: X2, position_seconds: 12, watched_seconds: 30 },
      { user_id: B, lesson_id: X2, position_seconds: 5, watched_seconds: 5 },
    ] });
    await prisma.lessonCompletion.createMany({ data: [{ lesson_id: X1, user_id: A }, { lesson_id: G, user_id: B }] });
  });
  afterAll(() => prisma.$disconnect());

  it("each person's download holds their own enrolments and lesson progress, every field; nobody else's", async () => {
    const [a, b, k, l] = [await download(A), await download(B), await download(K), await download(L)];
    expect(learn(a)).toEqual({ enrolments: [EA], progress: [pair({ user_id: A, lesson_id: X1 }),
      pair({ user_id: A, lesson_id: X2 })], completions: [pair({ user_id: A, lesson_id: X1 })] });
    expect(learn(b)).toEqual({ enrolments: [EB], progress: [pair({ user_id: B, lesson_id: X2 })],
      completions: [pair({ user_id: B, lesson_id: G })] });
    // Their coach and another coach: none of either client's rows.
    expect(learn(k)).toEqual(none);
    expect(learn(l)).toEqual(none);
    expect(a.course_enrolments).toEqual([expect.objectContaining({ id: EA, course_id: C, user_id: A,
      starts_on: '2026-10-01T00:00:00.000Z', source: 'direct', source_id: null, opened_all_at: null, ended_at: null })]);
    expect(a.lesson_progress.find((r) => r.lesson_id === X2)).toEqual(expect.objectContaining({
      user_id: A, position_seconds: 12, watched_seconds: 30, updated_at: expect.any(String) }));
  });

  it("erasing a client takes their enrolments, progress and completions; the other client's stay", async () => {
    const clientSteps = steps('LessonCompletion', 'LessonProgress', 'CourseEnrolment');
    expect(clientSteps.map((e) => [e.model, e.field, e.action.op])).toEqual([
      ['LessonCompletion', 'user_id', 'delete'],
      ['LessonProgress', 'user_id', 'delete'],
      ['CourseEnrolment', 'user_id', 'delete'],
    ]);
    const kept = learn(await download(B));
    expect(learn(await download(A)).enrolments).toEqual([EA]);
    await erase(A, clientSteps);
    expect(learn(await download(A))).toEqual(none);
    expect(learn(await download(B))).toEqual(kept);
  });

  it('erasing the coach keeps a course a client is enrolled in whole, with their progress; the rest goes', async () => {
    const ids = (rows: Array<{ id: string }>) => set(...rows.map((r) => r.id));
    const content = async () => ({
      courses: ids(await prisma.course.findMany({ where: { coach_id: K }, select: { id: true } })),
      weeks: ids(await prisma.courseModule.findMany({ where: { coach_id: K }, select: { id: true } })),
      lessons: ids(await prisma.lesson.findMany({ where: { coach_id: K }, select: { id: true } })),
    });
    expect(await content()).toEqual({ courses: set(C, D), weeks: set(W1, W2, DW), lessons: set(X1, X2, X3, DX, F, G) });
    const kept = learn(await download(B));
    expect(kept.progress).toEqual([pair({ user_id: B, lesson_id: X2 })]);
    await erase(K, steps('Lesson', 'CourseModule', 'Course'));
    // C stays with every week and lesson (none completed now that A is gone), and B's progress
    // with it. D, its week and lesson, and the uncompleted single lesson F go; completed G stays.
    expect(await content()).toEqual({ courses: [C], weeks: set(W1, W2), lessons: set(X1, X2, X3, G) });
    expect(learn(await download(B))).toEqual(kept);
  });
});
