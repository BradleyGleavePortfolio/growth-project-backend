import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LessonsService {
  constructor(private prisma: PrismaService) {}

  async getLessons(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;

    const where: any = {};
    if (coachId) where.coach_id = coachId;

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

  async createLesson(userId: string, data: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.role !== 'coach') throw new ForbiddenException('Coach access required');

    return this.prisma.lesson.create({
      data: { ...data, coach_id: userId },
    });
  }

  async updateLesson(userId: string, id: string, data: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.role !== 'coach') throw new ForbiddenException('Coach access required');

    return this.prisma.lesson.update({ where: { id }, data });
  }

  async completeLesson(userId: string, lessonId: string) {
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

    const completedIds = user?.lesson_completions.map(c => c.lesson_id) || [];

    return this.prisma.lesson.findMany({
      where: {
        id: { notIn: completedIds },
        coach_id: user?.coach_id || undefined,
      },
      take: 5,
      orderBy: { order_index: 'asc' },
    });
  }
}
