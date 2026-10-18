/**
 * L5 (LEARN-B): DELETE /lessons/:id, for the coach who wrote the lesson only, live on the replayed
 * migration chain. Coach K wrote lessons X, Y and W; K's client B completed X and Y. Coach L wrote Z;
 * L's client M used to be K's. The row layer is read as the non-bypass `authenticated` role, and every
 * 0 there follows a read of the same row that returned 1. Then the real LessonsService runs as the API
 * does. #LEARN-LOCK op 1: the lesson reads never lock, and a past coach's lessons stay closed.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { LessonsService } from '../../src/lessons/lessons.service';
import { PrismaService } from '../../src/prisma.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('lesson-delete-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('L5: only the coach who wrote a lesson deletes it', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const service = new LessonsService(prisma);
  const [K, L, B, M, X, Y, W, Z] = Array.from({ length: 8 }, () => randomUUID());
  const coaches = new Set([K, L]);

  beforeAll(async () => {
    for (const [id, coach_id] of [[K, null], [L, null], [B, K], [M, L]] as const) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `lesson-del-${id}`, name: 'Live person', role, coach_id } });
    }
    for (const [id, coach_id] of [[X, K], [Y, K], [W, K], [Z, L]] as const) {
      await prisma.lesson.create({ data: { id, coach_id, title: 'Lesson', tags: [], goal_tags: [] } });
    }
    for (const lesson_id of [X, Y]) await prisma.lessonCompletion.create({ data: { lesson_id, user_id: B } });
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
  /** [lesson rows, completion rows] of lesson `id` that `who` reads. */
  const sees = (who: string, id: string) =>
    as(who, async (tx) => [await tx.lesson.count({ where: { id } }), await tx.lessonCompletion.count({ where: { lesson_id: id } })]);
  const del = (who: string, table: 'Lesson' | 'LessonCompletion', id: string) =>
    as(who, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${table === 'Lesson' ? 'id' : 'lesson_id'}" = $1`, id));
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(K, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('row rule: another coach and a client delete 0 rows; the lesson\'s coach deletes it and its completion', async () => {
    expect(await sees(K, X)).toEqual([1, 1]);
    expect(await sees(B, X)).toEqual([1, 1]);
    expect(await del(L, 'Lesson', X)).toBe(0);
    expect(await del(L, 'LessonCompletion', X)).toBe(0);
    expect(await del(B, 'Lesson', X)).toBe(0);
    expect(await sees(K, X)).toEqual([1, 1]);
    expect(await as(K, async (tx) => [
      await tx.$executeRawUnsafe(`DELETE FROM "LessonCompletion" WHERE "lesson_id" = $1`, X),
      await tx.$executeRawUnsafe(`DELETE FROM "Lesson" WHERE "id" = $1`, X),
    ])).toEqual([1, 1]);
    expect(await sees(K, X)).toEqual([0, 0]);
  });

  it('DELETE /lessons/:id: another coach gets 404 and a client 403, both rows stay; the coach deletes both', async () => {
    await expect(service.deleteLesson(L, Y)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteLesson(B, Y)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await sees(K, Y)).toEqual([1, 1]);
    await expect(service.deleteLesson(K, Y)).resolves.toBeUndefined();
    expect([await prisma.lesson.count({ where: { id: Y } }), await prisma.lessonCompletion.count({ where: { lesson_id: Y } })]).toEqual([0, 0]);
    await expect(service.deleteLesson(K, Y)).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.lesson.count({ where: { id: W } })).toBe(1);
  });

  it('a client reads the current coach\'s lessons only; a past coach\'s stay closed', async () => {
    expect(await sees(B, W)).toEqual([1, 0]);
    expect(await sees(M, Z)).toEqual([1, 0]);
    expect(await sees(M, W)).toEqual([0, 0]);
    expect(ids(await service.getLessons(B))).toEqual([W]);
    expect(ids(await service.getLessons(M))).toEqual([Z]);
    expect(ids(await service.getRecommended(M))).toEqual([Z]);
    await expect(service.completeLesson(M, W)).rejects.toBeInstanceOf(NotFoundException);
  });
});
