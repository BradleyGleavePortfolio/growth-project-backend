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

  // Tier-2 (Fix #9): the feed is now a real CommunityWin stream scoped to the
  // current user's coach roster. Before this change the feed returned recent
  // Lessons, which both (a) leaked guideline-Lessons that the coach had filed
  // for individual clients and (b) had nothing to do with what users actually
  // posted via postWin (which itself was a no-op — see below).
  async getFeed(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;
    if (!coachId) return [];

    return this.prisma.communityWin.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: { user: { select: { id: true, name: true } } },
    });
  }

  // Tier-2 (Fix #9): real persistence for community wins. `coach_id` is
  // denormalized at write time from the author's current coach so the win
  // stays attached to the right roster feed even if the client later
  // switches coaches. Unassigned clients can still post — their wins simply
  // don't appear in any coach's feed (coach_id NULL).
  async postWin(userId: string, data: { title: string; description: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach_id: true, role: true, id: true },
    });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id ?? null;

    return this.prisma.communityWin.create({
      data: {
        user_id: userId,
        coach_id: coachId,
        title: data.title,
        description: data.description,
      },
    });
  }
}
