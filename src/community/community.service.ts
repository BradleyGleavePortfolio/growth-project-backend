import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CommunityService {
  constructor(private prisma: PrismaService) {}

  async getLeaderboard(userId: string, period: 'week' | 'month' = 'week') {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
    if (!coachId) return [];

    // Get all students in this coach's team (multi-tenant scoped)
    const students = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
    });

    const start = new Date();
    if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const leaderboard = await Promise.all(
      students.map(async (s) => {
        const workouts = await this.prisma.workoutSession.count({
          where: { user_id: s.id, date: { gte: start } },
        });
        return { user_id: s.id, name: s.name, workouts_completed: workouts };
      }),
    );

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
