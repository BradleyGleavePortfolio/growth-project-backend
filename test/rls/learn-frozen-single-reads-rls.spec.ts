/**
 * LEARN-FROZEN-SINGLE-READS: a client keeps reading the single lesson they completed when their
 * coach deletes their account, live on the replayed migration chain (p_lesson_select_kept,
 * 20270502006900). Coach K: single lesson G that client B completed, single lesson F nobody
 * completed, and published course C (week W, lesson X) that B is enrolled in. K's client P did
 * not complete G. Coach L: single lesson LG; L's client Z, and M, who completed LG and then left
 * L (L still has an account). A has no coach. K's deletion runs the finalizer's tombstone fields
 * and the erasure manifest's steps for these tables, on one transaction. Reads run as the
 * non-bypass `authenticated` role, and every 0 follows a read of the same row that returned 1.
 * The service checks run the real LessonsService (the server's read path). The tests run in
 * order. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import { LessonsService } from '../../src/lessons/lessons.service';
import { PrismaService } from '../../src/prisma.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('learn-frozen-single-reads-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('LEARN-FROZEN-SINGLE-READS: kept single lessons stay readable', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const service = new LessonsService(prisma);
  const run = randomUUID().slice(0, 8);
  const [K, L, A, B, P, Z, M, C, W, G, F, X, LG] =
    ['K', 'L', 'A', 'B', 'P', 'Z', 'M', 'C', 'W', 'G', 'F', 'X', 'LG'].map((tag) => `${tag}-${run}`);
  const coaches = new Set([K, L]);
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    const people = [[K, null], [L, null], [A, null], [B, K], [P, K], [Z, L], [M, L]] as const;
    for (const [id, coach_id] of people) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `kept-${id}`, name: 'Live person', role, coach_id } });
    }
    await prisma.course.create({ data: { id: C, coach_id: K, title: 'Course', status: 'published' } });
    await prisma.courseModule.create({ data: { id: W, course_id: C, coach_id: K, position: 0, title: 'Week' } });
    for (const [id, coach_id, module_id] of [[G, K, null], [F, K, null], [X, K, W], [LG, L, null]] as const) {
      await prisma.lesson.create({ data: { id, coach_id, module_id, title: 'Lesson', tags: [], goal_tags: [] } });
    }
    await prisma.courseEnrolment.create({
      data: { course_id: C, user_id: B, starts_on: new Date(Date.now() - 86_400_000), source: 'direct' },
    });
    await prisma.lessonCompletion.createMany({ data: [{ lesson_id: G, user_id: B }, { lesson_id: LG, user_id: M }] });
    // M leaves L; L keeps their account.
    await prisma.user.update({ where: { id: M }, data: { coach_id: null } });
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
  /** How many rows of lesson `lesson` the signed-in `who` reads. */
  const reads = (who: string, lesson: string) => as(who, (tx) => tx.lesson.count({ where: { id: lesson } }));

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(B, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it("before the deletion: K's clients read G, nobody else does; a past coach's lesson stays closed", async () => {
    for (const who of [B, P, K]) expect(await reads(who, G)).toBe(1);
    for (const who of [A, Z, L]) {
      expect(await reads(B, G)).toBe(1);
      expect(await reads(who, G)).toBe(0);
    }
    expect(await reads(Z, LG)).toBe(1);
    expect(await reads(M, LG)).toBe(0);
    expect(await reads(B, X)).toBe(1);
  });

  it("deleting K keeps G (completed) and X (enrolled), removes F, and detaches K's clients", async () => {
    const steps = ERASURE_MANIFEST.filter((e) =>
      ['User', 'LessonCompletion', 'LessonProgress', 'CourseEnrolment', 'Lesson', 'CourseModule', 'Course']
        .includes(e.model));
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const now = new Date();
      const tombstoneEmail = `deleted-${K}`;
      await tx.user.update({
        where: { id: K },
        data: { email: tombstoneEmail, name: 'Deleted user', coach_id: null, archived_at: now, deleted_at: now },
      });
      await executeErasureManifest(tx, { userId: K, email: `kept-${K}`, tombstoneEmail, now }, steps);
    }, { timeout: 30_000 });
    expect(ids(await prisma.lesson.findMany({ where: { coach_id: K }, select: { id: true } }))).toEqual([G, X].sort());
    expect(await prisma.lessonCompletion.count({ where: { lesson_id: G, user_id: B } })).toBe(1);
    expect(await prisma.user.count({ where: { id: { in: [B, P] }, coach_id: null } })).toBe(2);
    expect(await prisma.user.count({ where: { id: K, deleted_at: { not: null } } })).toBe(1);
  });

  it('after the deletion: B still reads G and X; nobody without the lesson does', async () => {
    expect(await reads(B, G)).toBe(1);
    expect(await reads(B, X)).toBe(1);
    for (const who of [P, A, Z, L]) {
      expect(await reads(B, G)).toBe(1);
      expect(await reads(who, G)).toBe(0);
    }
    // Only a deleted coach's lesson is kept: M left L, who still has an account.
    expect(await reads(Z, LG)).toBe(1);
    expect(await reads(M, LG)).toBe(0);
  });

  it('after the deletion: the server lists and completes G for B only', async () => {
    expect(ids(await service.getLessons(B))).toEqual([G]);
    await expect(service.getRecommended(B)).resolves.toEqual([]);
    const completion = await prisma.lessonCompletion.findFirstOrThrow({ where: { lesson_id: G, user_id: B } });
    await expect(service.completeLesson(B, G)).resolves.toMatchObject({ id: completion.id });
    expect(await prisma.lessonCompletion.count({ where: { lesson_id: G } })).toBe(1);
    expect(ids(await service.getLessons(Z))).toEqual([LG]);
    for (const who of [P, A, M]) {
      expect(ids(await service.getLessons(B))).toEqual([G]);
      await expect(service.getLessons(who)).resolves.toEqual([]);
      await expect(service.completeLesson(who, G)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(service.completeLesson(M, LG)).rejects.toBeInstanceOf(NotFoundException);
    for (const who of [Z, L]) await expect(service.completeLesson(who, G)).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.lessonCompletion.count({ where: { lesson_id: G } })).toBe(1);
  });
});
