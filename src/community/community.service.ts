import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// Helper: anonymise a display name to "first-name + last initial" e.g. "Alex M."
function anonymiseName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

@Injectable()
export class CommunityService {
  constructor(private prisma: PrismaService) {}

  async getLeaderboard(userId: string, period: 'week' | 'month' = 'week') {
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

  /**
   * GET /community/feed — last 30 anonymised community wins.
   * Returns: [{ id, displayName, action, createdAt }]
   */
  async getFeed(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id;

    // Pull from roster-scoped wins if coach exists, otherwise return public wins
    const whereClause = coachId
      ? { coach_id: coachId }
      : { visibility: 'public' };

    const wins = await this.prisma.communityWin.findMany({
      where: whereClause,
      orderBy: { created_at: 'desc' },
      take: 30,
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    return wins.map((w) => ({
      id: w.id,
      displayName: anonymiseName(w.user.name),
      action: w.title, // "title" is the win action text
      createdAt: w.created_at,
    }));
  }

  /**
   * POST /community/wins — create a community win entry.
   */
  async postWin(userId: string, data: { title: string; description: string; visibility?: 'circle' | 'public' }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach_id: true, role: true, id: true },
    });
    const coachId = user?.role === 'coach' ? user.id : user?.coach_id ?? null;

    const win = await this.prisma.communityWin.create({
      data: {
        user_id: userId,
        coach_id: coachId,
        title: data.title,
        description: data.description,
        visibility: data.visibility ?? 'circle',
      },
    });

    return win;
  }
}
