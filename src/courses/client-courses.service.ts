import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CoachMediaService } from '../coach-media/coach-media.service';
import { ReleaseMode, WeekOpen, courseOpen } from './course-open.feature';

// What the open rule needs, and nothing a locked week must not show: each week's
// note, and a lesson's title, kind and video length. Lesson descriptions, pages
// and links come in a second read, for open weeks only (Opus N1).
const ENROLMENT = {
  starts_on: true,
  ended_at: true,
  opened_all_at: true,
  course: {
    select: {
      id: true,
      title: true,
      week_rule: true,
      coach: { select: { name: true } },
      modules: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          title: true,
          note: true,
          opens_after_days: true,
          lessons: {
            orderBy: [{ order_index: 'asc' }, { created_at: 'asc' }],
            select: { id: true, title: true, kind: true, media_asset: { select: { duration_sec: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.CourseEnrolmentSelect;

type Enrolment = Prisma.CourseEnrolmentGetPayload<{ select: typeof ENROLMENT }>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const notFound = () => new NotFoundException('Lesson not found');

// Course routes read a client's own enrolment in a published course, never a
// draft. C (for the coach course-editing PR): archiving a course hides weeks a
// client already opened, here and in the row rule; decide there whether
// archive keeps them (#LEARN-LOCK op 1).
const mine = (userId: string): Prisma.CourseEnrolmentWhereInput => ({ user_id: userId, course: { status: 'published' } });

/**
 * The client's own calendar day, from the database: app.client_today
 * (20270502007400) is the same day app.course_module_open opens weeks on, so
 * these routes and the row rule always agree (Sol B1). With `at`, the client's
 * day at that instant: the day an enrolment ended, in the same calendar as
 * today, never the UTC date (round 3, Sol B2).
 */
async function clientDay(prisma: PrismaService, userId: string, at: Date | null = null): Promise<string> {
  const [row] = await prisma.$queryRaw<{ today: string }[]>`SELECT to_char(app.client_today(${userId}, COALESCE(${at?.toISOString() ?? null}::timestamptz, now())), 'YYYY-MM-DD') AS today`;
  return row.today;
}

async function weeksOf(prisma: PrismaService, userId: string, row: Enrolment, today: string): Promise<WeekOpen[]> {
  const releaseMode: ReleaseMode = row.opened_all_at ? 'open_all' : row.course.week_rule === 'all_at_once' ? 'all_at_once' : 'dates';
  return courseOpen({
    startsOn: day(row.starts_on),
    endedOn: row.ended_at ? await clientDay(prisma, userId, row.ended_at) : null,
    today,
    releaseMode,
    weeks: row.course.modules.map((m) => ({ id: m.id, position: m.position, opensAfterDays: m.opens_after_days })),
  });
}

/**
 * True when the lesson is in an open week of a published course the caller is
 * enrolled in. The one check behind completing (POST /lessons/:id/complete),
 * the saved place and the video address of a course lesson.
 */
export async function openCourseLesson(prisma: PrismaService, userId: string, lessonId: string): Promise<boolean> {
  const row = await prisma.courseEnrolment.findFirst({
    where: { user_id: userId, course: { status: 'published', modules: { some: { lessons: { some: { id: lessonId } } } } } },
    select: ENROLMENT,
  });
  const week = row?.course.modules.find((m) => m.lessons.some((l) => l.id === lessonId));
  if (!row || !week) return false;
  return (await weeksOf(prisma, userId, row, await clientDay(prisma, userId))).some((w) => w.id === week.id && w.open);
}

/**
 * LEARN-BE2: the signed-in client's courses. The server connects past row
 * security, so every read starts from the caller's own enrolment in a published
 * course (the same rule as Course_enrolled_select); a course of another
 * client, a draft and a missing id all answer 404. A coach who deleted their
 * account changes nothing here: the deletion keeps the course, its weeks and
 * the enrolment (account-deletion.manifest.ts), so the client keeps reading.
 * Row shape = mobile courseData.ts (m#816). Locked weeks keep their lesson
 * titles and kinds on purpose (the course plan draws them); their notes,
 * bodies and links are never read.
 */
@Injectable()
export class ClientCoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: CoachMediaService,
  ) {}

  async list(userId: string) {
    const rows = await this.prisma.courseEnrolment.findMany({ where: mine(userId), orderBy: { created_at: 'asc' }, select: ENROLMENT });
    return this.shape(userId, rows, false);
  }

  async detail(userId: string, courseId: string) {
    const row = await this.prisma.courseEnrolment.findFirst({ where: { ...mine(userId), course_id: courseId }, select: ENROLMENT });
    if (!row) throw new NotFoundException('Course not found');
    const [course] = await this.shape(userId, [row], true);
    return course;
  }

  /** Remember where the client is in a lesson of an open week of a course they are in. */
  async savePosition(userId: string, lessonId: string, positionSeconds: number): Promise<void> {
    if (!(await openCourseLesson(this.prisma, userId, lessonId))) throw notFound();
    // The key is (user, lesson): only the seconds change, never the lesson (b#1112).
    await this.prisma.lessonProgress.upsert({
      where: { user_id_lesson_id: { user_id: userId, lesson_id: lessonId } },
      create: { user_id: userId, lesson_id: lessonId, position_seconds: positionSeconds },
      update: { position_seconds: positionSeconds },
    });
  }

  /**
   * A short-lived address for a course lesson's video: an uploaded video is
   * signed like the client media route (same signer and lifetime); a coach's
   * own https video link is returned as it is, with no expiry. 404 for anything
   * else, with no reason given.
   */
  async video(userId: string, lessonId: string): Promise<{ url: string; expires_at: string | null }> {
    if (!(await openCourseLesson(this.prisma, userId, lessonId))) throw notFound();
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId }, select: { coach_id: true, media_asset_id: true, video_url: true } });
    if (lesson?.media_asset_id) {
      const signed = await this.media.signLessonVideo(lesson.media_asset_id, lesson.coach_id);
      if (signed) return { url: signed.url, expires_at: new Date(Date.now() + signed.expires_in_seconds * 1000).toISOString() };
    } else if (lesson?.video_url?.startsWith('https://')) {
      return { url: lesson.video_url, expires_at: null };
    }
    throw notFound();
  }

  private async shape(userId: string, rows: Enrolment[], withBody: boolean) {
    const today = await clientDay(this.prisma, userId);
    const weeks = await Promise.all(rows.map((row) => weeksOf(this.prisma, userId, row, today)));
    const all = rows.flatMap((r) => r.course.modules.flatMap((m) => m.lessons.map((l) => l.id)));
    const openIds = rows.flatMap((r, i) => r.course.modules.filter((m) => weeks[i].find((w) => w.id === m.id)?.open).flatMap((m) => m.lessons.map((l) => l.id)));
    const [marks, content, progress] = await Promise.all([
      this.prisma.lessonCompletion.findMany({ where: { user_id: userId, lesson_id: { in: all } }, select: { lesson_id: true } }),
      this.prisma.lesson.findMany({
        where: { id: { in: openIds } },
        // The list leaves the page and links out: they are not read at all.
        select: { id: true, description: true, body_markdown: withBody, video_url: withBody, article_url: withBody, media_asset_id: withBody },
      }),
      withBody
        ? this.prisma.lessonProgress.findMany({ where: { user_id: userId, lesson_id: { in: openIds } }, select: { lesson_id: true, position_seconds: true } })
        : [],
    ]);
    const done = new Set(marks.map((c) => c.lesson_id));
    const body = new Map(content.map(({ id, description, ...page }) => [id, { description, page }]));
    const seconds = new Map(progress.map((p) => [p.lesson_id, p.position_seconds]));

    return rows.map((row, i) => ({
      id: row.course.id,
      title: row.course.title,
      coach_name: row.course.coach.name,
      starts_on: day(row.starts_on),
      modules: row.course.modules.map((m) => {
        const week = weeks[i].find((w) => w.id === m.id);
        return {
          id: m.id,
          position: m.position,
          title: m.title,
          note: m.note,
          open: week?.open === true,
          opens_on: week?.opensOn,
          finish_by: week?.finishBy,
          lessons: m.lessons.map((l) => ({
            id: l.id,
            title: l.title,
            kind: l.kind,
            duration_sec: l.media_asset?.duration_sec ?? null,
            description: week?.open ? (body.get(l.id)?.description ?? null) : null,
            done: done.has(l.id),
            // Open weeks in the detail: the page, links and saved place.
            ...(week?.open && withBody ? { ...body.get(l.id)?.page, position_seconds: seconds.get(l.id) ?? 0 } : {}),
          })),
        };
      }),
    }));
  }
}
