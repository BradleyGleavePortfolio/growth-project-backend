import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateLessonDto, UpdateLessonDto } from './lessons.dto';

@Injectable()
export class LessonsService {
  constructor(private prisma: PrismaService) {}

  /**
   * The single lessons this user may see: a coach sees their own, a client
   * sees their coach's. A client with no coach (coachless sign-up, or a coach
   * link that was removed) has no lesson scope at all, so every read returns
   * nothing and every completion is refused. Lessons always belong to a coach
   * (Lesson.coach_id is required); there is no platform library. Lessons
   * inside a course week (module_id set) are never in this scope: course
   * routes reach them by enrolment and open week (LEARN-BE1, p_lesson_select).
   */
  private singleLessonsOf(
    user: { id: string; role: string; coach_id: string | null } | null,
  ): Prisma.LessonWhereInput | null {
    const coach_id = user?.role === 'coach' ? user.id : user?.coach_id;
    return coach_id ? { coach_id, module_id: null } : null;
  }

  async getLessons(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    // B2: before this, a missing coach meant no coach filter, so a coachless
    // client's Learn tab listed every coach's lessons.
    const scope = this.singleLessonsOf(user);
    if (!scope) return [];

    const where: Prisma.LessonWhereInput = { ...scope };

    // Filter by user's goal type if available
    if (user?.profile?.goal_type) {
      where.OR = [
        { goal_tags: { has: user.profile.goal_type } },
        { goal_tags: { isEmpty: true } },
      ];
    }

    return this.prisma.lesson.findMany({
      where,
      include: { completions: { where: { user_id: userId } } },
      orderBy: [{ order_index: 'asc' }, { created_at: 'desc' }],
    });
  }

  async createLesson(userId: string, data: CreateLessonDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.role !== 'coach') throw new ForbiddenException('Coach access required');

    // Explicit field mapping — coach_id is ALWAYS the requester, never the client's
    // input. Previously `{ ...data, coach_id: userId }` was safe because userId
    // came last, but an `@Body() body: any` signature meant an attacker could
    // still overwrite primary-key fields like `id` or `created_at`. See audit C4.
    return this.prisma.lesson.create({
      data: {
        coach_id: userId,
        title: data.title,
        description: data.description,
        video_url: data.video_url,
        article_url: data.article_url,
        tags: data.tags ?? [],
        goal_tags: data.goal_tags ?? [],
        order_index: data.order_index ?? 0,
      },
    });
  }

  async updateLesson(userId: string, id: string, data: UpdateLessonDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.role !== 'coach') throw new ForbiddenException('Coach access required');

    // SECURITY: verify the lesson belongs to this coach before letting them update it.
    // Previously any coach could overwrite any other coach's lesson (audit C8). Combined
    // with the old CaboRules backdoor this meant any user could rewrite educational
    // content served to every student.
    const lesson = await this.prisma.lesson.findFirst({
      where: { id, coach_id: userId },
      select: { id: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    return this.prisma.lesson.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        video_url: data.video_url,
        article_url: data.article_url,
        tags: data.tags,
        goal_tags: data.goal_tags,
        order_index: data.order_index,
      },
    });
  }

  /**
   * L5: only the coach who wrote a lesson deletes it. Any other caller's id
   * matches no row: another coach gets 404 (the route never says whose lesson
   * an id is), a client 403. Completion marks point only at their lesson
   * (FK RESTRICT), so they go in the same transaction; nothing else refers to
   * a lesson. The row rule agrees (p_lesson_delete, p_lessoncompletion_delete).
   */
  async deleteLesson(userId: string, id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== 'coach') throw new ForbiddenException('Coach access required');
    const own = { id, coach_id: userId };
    const [, { count }] = await this.prisma.$transaction([
      this.prisma.lessonCompletion.deleteMany({ where: { lesson: own } }),
      this.prisma.lesson.deleteMany({ where: own }),
    ]);
    if (count === 0) throw new NotFoundException('Lesson not found');
  }

  async completeLesson(userId: string, lessonId: string) {
    // Only a lesson this client can see may be marked complete.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const scope = this.singleLessonsOf(user);
    const lesson = scope
      ? await this.prisma.lesson.findFirst({
          where: { id: lessonId, ...scope },
          select: { id: true },
        })
      : null;
    if (!lesson) throw new NotFoundException('Lesson not found');

    const existing = await this.prisma.lessonCompletion.findFirst({
      where: { user_id: userId, lesson_id: lessonId },
    });
    if (existing) return existing;

    return this.prisma.lessonCompletion.create({
      data: { user_id: userId, lesson_id: lessonId },
    });
  }

  async getRecommended(userId: string) {
    // Return first 5 incomplete lessons matching user's goal
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, lesson_completions: true },
    });

    // B2: same coach scope as getLessons; no coach means no lessons.
    const scope = this.singleLessonsOf(user);
    if (!user || !scope) return [];

    const completedIds = user.lesson_completions.map(c => c.lesson_id);

    return this.prisma.lesson.findMany({
      where: {
        id: { notIn: completedIds },
        ...scope,
      },
      take: 5,
      orderBy: { order_index: 'asc' },
    });
  }
}
