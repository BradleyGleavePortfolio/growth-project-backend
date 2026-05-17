import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getFoundingNumber(userId: string): Promise<{
    rank: number;
    total: number;
    isFoundingMember: boolean;
  }> {
    // Fetch the current user to get their createdAt timestamp
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { created_at: true },
    });

    // rank = count of users created on or before this user (inclusive, 1-indexed)
    const [rankResult, total] = await Promise.all([
      this.prisma.user.count({
        where: { created_at: { lte: user.created_at } },
      }),
      this.prisma.user.count(),
    ]);

    return {
      rank: rankResult,
      total,
      isFoundingMember: rankResult <= 1000,
    };
  }

  async getCircleStats(userId: string): Promise<{
    trainedTodayCount: number;
    totalMembers: number;
  }> {
    // UTC day boundaries for "today"
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    // Check if a coach→client relationship exists (scope to circle if possible)
    const coachUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach_id: true, role: true },
    });

    let userIds: string[] | undefined;

    if (coachUser?.role === 'coach') {
      // For a coach: their own students
      const students = await this.prisma.user.findMany({
        where: { coach_id: userId },
        select: { id: true },
      });
      if (students.length > 0) {
        userIds = students.map((s) => s.id);
      }
    } else if (coachUser?.coach_id) {
      // For a student: all other students of the same coach (the "circle")
      const circlemates = await this.prisma.user.findMany({
        where: { coach_id: coachUser.coach_id },
        select: { id: true },
      });
      if (circlemates.length > 0) {
        userIds = circlemates.map((s) => s.id);
      }
    }
    // If no coach/circle relationship, fall back to global count

    // trainedTodayCount: distinct users with a WorkoutSession or LoggedFoodEntry today
    const [workoutUsers, logUsers, totalMembers] = await Promise.all([
      this.prisma.workoutSession.findMany({
        where: {
          date: { gte: startOfDay, lt: endOfDay },
          ...(userIds ? { user_id: { in: userIds } } : {}),
        },
        select: { user_id: true },
        distinct: ['user_id'],
      }),
      this.prisma.loggedFoodEntry.findMany({
        where: {
          date: { gte: startOfDay, lt: endOfDay },
          ...(userIds ? { user_id: { in: userIds } } : {}),
        },
        select: { user_id: true },
        distinct: ['user_id'],
      }),
      this.prisma.user.count(),
    ]);

    const trainedIds = new Set([
      ...workoutUsers.map((u) => u.user_id),
      ...logUsers.map((u) => u.user_id),
    ]);

    return {
      trainedTodayCount: trainedIds.size,
      totalMembers,
    };
  }

  async updatePushToken(userId: string, token: string | null): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { expo_push_token: token },
    });
  }
}
