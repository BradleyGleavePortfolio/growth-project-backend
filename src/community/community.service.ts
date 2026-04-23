import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CommunityService {
  constructor(private prisma: PrismaService) {}

  async getLeaderboard(userId: string, period: 'week' | 'month' = 'week') {
    // Before: 2 + N queries (user lookup, students.findMany, one count per student).
    //   A team of 40 students → 42 sequential queries.
    // After: 3 queries — user, students, one groupBy on workoutSession. Response
    //   shape unchanged (same keys, same order).
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
    if (!coachId) return [];

    const students = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
    });
    if (students.length === 0) return [];

    const start = new Date();
    if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const grouped = await this.prisma.workoutSession.groupBy({
      by: ['user_id'],
      where: { user_id: { in: students.map((s) => s.id) }, date: { gte: start } },
      _count: { _all: true },
    });

    const countByUser = new Map<string, number>();
    for (const g of grouped) countByUser.set(g.user_id, g._count._all);

    const leaderboard = students.map((s) => ({
      user_id: s.id,
      name: s.name,
      workouts_completed: countByUser.get(s.id) ?? 0,
    }));

    return leaderboard.sort((a, b) => b.workouts_completed - a.workouts_completed);
  }

  async getFeed(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
    if (!coachId) return [];

    // Return recent lessons as "feed" items — scoped to coach's team
    return this.prisma.lesson.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
      take: 20,
    });
  }

  async postWin(userId: string, data: { title: string; description: string }) {
    // Store as a check-in note or a community win (use CheckIn for now)
    return { message: 'Win posted', data };
  }
}
