import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { resolveRecipientTimeZoneWithSource } from '../notifications/recipient-timezone';
import { localDate } from '../roman-adjust/roman-adjust.rules';
import { CourseOpen, ReleaseMode, courseOpen } from './course-open.feature';

// What the open rule needs, and nothing a locked week must not show: a lesson's
// title and kind only. Bodies, links and media come in a second read, for open weeks.
const ENROLMENT = {
  starts_on: true,
  ended_at: true,
  opened_all_at: true,
  course: {
    select: {
      id: true,
      title: true,
      summary: true,
      week_rule: true,
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
            select: { id: true, title: true, kind: true },
          },
        },
      },
    },
  },
} satisfies Prisma.CourseEnrolmentSelect;

type Enrolment = Prisma.CourseEnrolmentGetPayload<{ select: typeof ENROLMENT }>;
interface Opened {
  row: Enrolment;
  state: CourseOpen;
  done: Set<string>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * LEARN-BE2: the signed-in client's courses. The server connects past row
 * security, so every read starts from the caller's own enrolment in a published
 * course (the same rule as Course_enrolled_select); a course of another
 * client, a draft and a missing id all answer 404. A coach who deleted their
 * account changes nothing here: the deletion keeps the course, its weeks and
 * the enrolment (account-deletion.manifest.ts), so the client keeps reading.
 */
@Injectable()
export class ClientCoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.courseEnrolment.findMany({
      where: { user_id: userId, course: { status: 'published' } },
      orderBy: { created_at: 'asc' },
      select: ENROLMENT,
    });
    const opened = await this.openAll(userId, rows);
    return opened.map(({ row, state }) => ({
      id: row.course.id,
      title: row.course.title,
      summary: row.course.summary,
      starts_on: day(row.starts_on),
      ...this.summary(state),
    }));
  }

  async detail(userId: string, courseId: string) {
    const row = await this.prisma.courseEnrolment.findFirst({
      where: { user_id: userId, course_id: courseId, course: { status: 'published' } },
      select: ENROLMENT,
    });
    if (!row) throw new NotFoundException('Course not found');
    const [{ state, done }] = await this.openAll(userId, [row]);

    // Bodies, links and media are read only for lessons of open weeks.
    const openIds = row.course.modules
      .filter((m) => state.weeks.find((w) => w.id === m.id)?.open)
      .flatMap((m) => m.lessons.map((l) => l.id));
    const [content, progress] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { id: { in: openIds } },
        select: { id: true, description: true, body_markdown: true, video_url: true, article_url: true, media_asset_id: true },
      }),
      this.prisma.lessonProgress.findMany({
        where: { user_id: userId, lesson_id: { in: openIds } },
        orderBy: { updated_at: 'desc' },
        select: { lesson_id: true, position_seconds: true },
      }),
    ]);
    const body = new Map(content.map((c) => [c.id, c]));
    const seconds = new Map(progress.map((p) => [p.lesson_id, p.position_seconds]));
    const resume = progress.find((p) => p.position_seconds > 0 && !done.has(p.lesson_id));

    return {
      id: row.course.id,
      title: row.course.title,
      summary: row.course.summary,
      starts_on: day(row.starts_on),
      ...this.summary(state),
      resume: resume ? { lesson_id: resume.lesson_id, position_seconds: resume.position_seconds } : null,
      weeks: row.course.modules.map((m) => {
        const week = state.weeks.find((w) => w.id === m.id);
        return {
          id: m.id,
          number: week?.number,
          title: m.title,
          note: m.note,
          open: week?.open === true,
          opens_on: week?.opensOn,
          done: week?.done,
          total: week?.total,
          lessons: m.lessons.map((l) => ({
            ...l,
            done: done.has(l.id),
            ...(week?.open ? { ...body.get(l.id), position_seconds: seconds.get(l.id) ?? 0 } : {}),
          })),
        };
      }),
    };
  }

  /** Remember where the client is in a lesson of an open week of a course they are in. */
  async savePosition(userId: string, lessonId: string, positionSec: number): Promise<void> {
    const row = await this.prisma.courseEnrolment.findFirst({
      where: {
        user_id: userId,
        course: { status: 'published', modules: { some: { lessons: { some: { id: lessonId } } } } },
      },
      select: ENROLMENT,
    });
    const week = row?.course.modules.find((m) => m.lessons.some((l) => l.id === lessonId));
    if (!row || !week) throw new NotFoundException('Lesson not found');
    const [{ state }] = await this.openAll(userId, [row]);
    if (!state.weeks.find((w) => w.id === week.id)?.open) throw new NotFoundException('Lesson not found');
    // The key is (user, lesson): only the seconds change, never the lesson (b#1112).
    await this.prisma.lessonProgress.upsert({
      where: { user_id_lesson_id: { user_id: userId, lesson_id: lessonId } },
      create: { user_id: userId, lesson_id: lessonId, position_seconds: positionSec },
      update: { position_seconds: positionSec },
    });
  }

  private summary(state: CourseOpen) {
    const current = state.weeks.find((w) => w.id === state.currentWeekId);
    return {
      done: state.done,
      total: state.total,
      weeks_open: state.weeks.filter((w) => w.open).length,
      weeks_total: state.weeks.length,
      current_week: current?.number ?? null,
      next_unlock_on: state.nextUnlockOn,
    };
  }

  // The client's own calendar day: their zone, else their coach's, else UTC.
  private async openAll(userId: string, rows: Enrolment[]): Promise<Opened[]> {
    const zone = await resolveRecipientTimeZoneWithSource(this.prisma, userId);
    const today = localDate(new Date(), zone?.timeZone ?? 'UTC');
    const ids = rows.flatMap((r) => r.course.modules.flatMap((m) => m.lessons.map((l) => l.id)));
    const marks = await this.prisma.lessonCompletion.findMany({
      where: { user_id: userId, lesson_id: { in: ids } },
      select: { lesson_id: true },
    });
    const done = new Set(marks.map((c) => c.lesson_id));
    return rows.map((row) => {
      const releaseMode: ReleaseMode = row.opened_all_at ? 'open_all' : row.course.week_rule === 'all_at_once' ? 'all_at_once' : 'dates';
      const state = courseOpen({
        startsOn: day(row.starts_on),
        endedOn: row.ended_at ? day(row.ended_at) : null,
        today,
        releaseMode,
        weeks: row.course.modules.map((m) => ({
          id: m.id,
          position: m.position,
          opensAfterDays: m.opens_after_days,
          lessons: m.lessons.map((l) => ({ id: l.id, done: done.has(l.id) })),
        })),
      });
      return { row, state, done };
    });
  }
}
