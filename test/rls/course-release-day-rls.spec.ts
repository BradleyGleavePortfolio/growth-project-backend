/**
 * LEARN-BE2 fix round 2 (b#1114): one release day for course weeks, live on the replayed chain.
 * app.client_today (20270502007400) is the client's own day; app.course_module_open (the row
 * rule) and the server's course routes both use it, so they always agree. Coach K (CoachProfile
 * zone America/New_York) has a published course C: week W1 opens on day 0, W2 on day 7, W3 on
 * day 8. Client T lives in Asia/Tokyo (ahead of UTC), client P in America/Los_Angeles (behind);
 * each started C seven of their own days ago, so W2 opens on their today and W3 on their
 * tomorrow. Client A (K's, not enrolled) is refused everything. Reads run as the non-bypass
 * `authenticated` role, and every 0 follows a read that returned 1. Round 3 (Sol B2): TE (Tokyo)
 * and PE (Los Angeles) started the same day but their enrolment ended on a day whose UTC date
 * differs from their own date: the end day is theirs, never the UTC date. Gate: TEST_DATABASE_URL;
 * no URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CoachMediaService } from '../../src/coach-media/coach-media.service';
import { ClientCoursesService } from '../../src/courses/client-courses.service';
import { LessonsService } from '../../src/lessons/lessons.service';
import { PrismaService } from '../../src/prisma.service';
import { localDate } from '../../src/roman-adjust/roman-adjust.rules';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('course-release-day-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)('LEARN-BE2: one release day for course weeks', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const id = (tag: string) => `${tag}-${run}`;
  const [K, T, P, A, U, Z, N, V, C, W1, W2, W3, X1, X2, X3, TE, PE] =
    ['K', 'T', 'P', 'A', 'U', 'Z', 'N', 'V', 'C', 'W1', 'W2', 'W3', 'X1', 'X2', 'X3', 'TE', 'PE'].map(id);
  const zoneOf: Record<string, string> = { [T]: 'Asia/Tokyo', [P]: 'America/Los_Angeles', [TE]: 'Asia/Tokyo', [PE]: 'America/Los_Angeles' };
  const daysAgo = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) - n * 86_400_000);
  // @ts-expect-error partial CoachMediaService double: these lessons hold a link, not an upload
  const media: CoachMediaService = { signLessonVideo: async () => null };
  const courses = new ClientCoursesService(prisma, media);
  const lessons = new LessonsService(prisma);

  beforeAll(async () => {
    const people = [[K, null], [T, K], [P, K], [A, K], [U, K], [Z, K], [N, null], [V, null], [TE, K], [PE, K]] as const;
    for (const [uid, coach_id] of people) {
      await prisma.user.create({ data: { id: uid, supabase_id: uid, email: `day-${uid}`, name: 'Live person', role: uid === K ? 'coach' : 'student', coach_id } });
    }
    await prisma.coachProfile.create({ data: { user_id: K, invite_code: id('code'), timezone: 'America/New_York' } });
    const zones = [[T, 'Asia/Tokyo', true], [P, 'America/Los_Angeles', true], [U, 'UTC', true], [Z, 'Not/AZone', true], [V, 'Asia/Tokyo', false], [TE, 'Asia/Tokyo', true], [PE, 'America/Los_Angeles', true]] as const;
    for (const [user_id, timezone, supplied] of zones) {
      await prisma.notificationPreferences.create({ data: { user_id, timezone, timezone_updated_at: supplied ? new Date() : null } });
    }
    await prisma.course.create({ data: { id: C, coach_id: K, title: 'Course', status: 'published' } });
    for (const [mid, position, opens_after_days] of [[W1, 1, 0], [W2, 2, 7], [W3, 3, 8]] as const) {
      await prisma.courseModule.create({ data: { id: mid, course_id: C, coach_id: K, position, title: 'Week', opens_after_days } });
    }
    for (const [lid, module_id] of [[X1, W1], [X2, W2], [X3, W3]] as const) {
      await prisma.lesson.create({ data: { id: lid, coach_id: K, module_id, title: 'Lesson', kind: 'both', video_url: `https://cdn.example/${lid}.mp4`, tags: [], goal_tags: [] } });
    }
    for (const user_id of [T, P]) {
      const starts_on = daysAgo(localDate(new Date(), zoneOf[user_id]), 7);
      await prisma.courseEnrolment.create({ data: { id: id(`E${user_id}`), course_id: C, user_id, starts_on, source: 'direct' } });
    }
    // TE's plan ended at 01:00 on their own today (the UTC date is yesterday); PE's at 22:00 PST /
    // 23:00 PDT on their own yesterday (the UTC date is today). W2 opens on their today.
    const tokyoToday = localDate(new Date(), 'Asia/Tokyo');
    const laYesterday = daysAgo(localDate(new Date(), 'America/Los_Angeles'), 1).toISOString().slice(0, 10);
    for (const [user_id, ended_at] of [[TE, new Date(`${tokyoToday}T01:00:00+09:00`)], [PE, new Date(`${laYesterday}T22:00:00-08:00`)]] as const) {
      const starts_on = daysAgo(localDate(new Date(), zoneOf[user_id]), 7);
      await prisma.courseEnrolment.create({ data: { id: id(`E${user_id}`), course_id: C, user_id, starts_on, ended_at, source: 'direct' } });
    }
  });
  afterAll(() => prisma.$disconnect());

  const todayOf = async (who: string, at: string) =>
    (await prisma.$queryRaw<{ d: string }[]>`SELECT to_char(app.client_today(${who}, ${at}::timestamptz), 'YYYY-MM-DD') AS d`)[0].d;
  /** The run's lessons `who` reads as the signed-in API role. */
  const lessonsAs = (who: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'student', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return (await tx.lesson.findMany({ where: { id: { endsWith: run } }, select: { id: true } })).map((l) => l.id).sort();
    });

  it('the client\'s day rolls over at their own midnight: Tokyo ahead of UTC, Los Angeles behind', async () => {
    // 15:30 UTC on Oct 11 is already Oct 12 in Tokyo; 03:00 UTC on Oct 12 is still Oct 11 in Los Angeles.
    expect(await todayOf(T, '2026-10-11T15:30:00Z')).toBe('2026-10-12');
    expect(await todayOf(P, '2026-10-11T15:30:00Z')).toBe('2026-10-11');
    expect(await todayOf(P, '2026-10-12T03:00:00Z')).toBe('2026-10-11');
    expect(await todayOf(T, '2026-10-12T03:00:00Z')).toBe('2026-10-12');
  });

  it('a UTC alias or an unknown zone falls to the coach\'s zone; an unsupplied zone or none at all is UTC', async () => {
    // 03:00 UTC on Oct 12 is 23:00 on Oct 11 in New York (the coach's CoachProfile zone).
    expect(await todayOf(U, '2026-10-12T03:00:00Z')).toBe('2026-10-11');
    expect(await todayOf(Z, '2026-10-12T03:00:00Z')).toBe('2026-10-11');
    expect(await todayOf(V, '2026-10-11T15:30:00Z')).toBe('2026-10-11');
    expect(await todayOf(N, '2026-10-12T03:00:00Z')).toBe('2026-10-12');
  });

  it.each([['Tokyo', T], ['Los Angeles', P]])('%s: the row rule and the course routes open the same weeks on the client\'s day', async (_city, who) => {
    expect(await lessonsAs(who)).toEqual([X1, X2].sort());
    const detail = await courses.detail(who, C);
    expect(detail.modules.map((m) => [m.id, m.open])).toEqual([[W1, true], [W2, true], [W3, false]]);
    expect(detail.modules[1].opens_on).toBe(localDate(new Date(), zoneOf[who]));
  });

  it('POST /lessons/:id/complete: the client completes an open course lesson; another client and a locked week are refused', async () => {
    expect(await lessonsAs(T)).toContain(X2);
    await expect(lessons.completeLesson(T, X2)).resolves.toMatchObject({ user_id: T, lesson_id: X2 });
    await expect(lessons.completeLesson(T, X3)).rejects.toBeInstanceOf(NotFoundException);
    expect(await lessonsAs(A)).toEqual([]);
    await expect(lessons.completeLesson(A, X2)).rejects.toBeInstanceOf(NotFoundException);
    const marks = await prisma.lessonCompletion.findMany({ where: { lesson_id: { endsWith: run } }, select: { user_id: true, lesson_id: true } });
    expect(marks).toEqual([{ user_id: T, lesson_id: X2 }]);
  });

  it('video and saved place: the client\'s own open lesson only; another client\'s lesson and a locked week answer 404', async () => {
    await expect(courses.video(T, X2)).resolves.toEqual({ url: `https://cdn.example/${X2}.mp4`, expires_at: null });
    await expect(courses.video(A, X2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(courses.video(T, X3)).rejects.toBeInstanceOf(NotFoundException);
    await courses.savePosition(T, X2, 42);
    await expect(courses.savePosition(A, X2, 42)).rejects.toBeInstanceOf(NotFoundException);
    await expect(courses.savePosition(T, X3, 42)).rejects.toBeInstanceOf(NotFoundException);
    const saved = await prisma.lessonProgress.findMany({ where: { lesson_id: { endsWith: run } }, select: { user_id: true, lesson_id: true, position_seconds: true } });
    expect(saved).toEqual([{ user_id: T, lesson_id: X2, position_seconds: 42 }]);
  });

  it('an ended enrolment ends on the client\'s own day, in the row rule and the routes alike (round 3, Sol B2)', async () => {
    // Tokyo: ended on their today (UTC yesterday), so W2, opened today, stays open.
    expect(await lessonsAs(TE)).toEqual([X1, X2].sort());
    expect((await courses.detail(TE, C)).modules.map((m) => m.open)).toEqual([true, true, false]);
    await expect(courses.video(TE, X2)).resolves.toEqual({ url: `https://cdn.example/${X2}.mp4`, expires_at: null });
    await expect(lessons.completeLesson(TE, X2)).resolves.toMatchObject({ user_id: TE, lesson_id: X2 });
    // Los Angeles: ended on their yesterday (UTC today), so W2 never opens.
    expect(await lessonsAs(PE)).toEqual([X1]);
    expect((await courses.detail(PE, C)).modules.map((m) => m.open)).toEqual([true, false, false]);
    await expect(courses.video(PE, X2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(courses.savePosition(PE, X2, 42)).rejects.toBeInstanceOf(NotFoundException);
    await expect(lessons.completeLesson(PE, X2)).rejects.toBeInstanceOf(NotFoundException);
    const marks = await prisma.lessonCompletion.findMany({ where: { user_id: PE }, select: { lesson_id: true } });
    expect(marks).toEqual([]);
  });
});
