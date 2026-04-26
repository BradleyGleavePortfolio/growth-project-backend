import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BadgesService } from './badges.service';

// Helper: anonymise a display name to "first-name + last initial" e.g. "Alex M."
function anonymiseName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// Helper: aggregate reactions array → { fire: n, clap: n }
function sumReactions(reactions: { kind: string }[]): { fire: number; clap: number } {
  return reactions.reduce(
    (acc, r) => {
      if (r.kind === 'fire') acc.fire += 1;
      if (r.kind === 'clap') acc.clap += 1;
      return acc;
    },
    { fire: 0, clap: 0 },
  );
}

@Injectable()
export class CommunityService {
  constructor(
    private prisma: PrismaService,
    private badgesService: BadgesService,
  ) {}

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
   * Returns: [{ id, displayName, action, createdAt, reactions: { fire, clap } }]
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
        reactions: { select: { kind: true } },
      },
    });

    return wins.map((w) => ({
      id: w.id,
      displayName: anonymiseName(w.user.name),
      action: w.title, // "title" is the win action text
      createdAt: w.created_at,
      reactions: sumReactions(w.reactions),
    }));
  }

  /**
   * POST /community/wins/:id/react — add or toggle a fire/clap reaction.
   * Returns updated reaction counts.
   */
  async reactToWin(userId: string, winId: string, kind: 'fire' | 'clap'): Promise<{ fire: number; clap: number }> {
    const win = await this.prisma.communityWin.findUnique({
      where: { id: winId },
    });
    if (!win) throw new NotFoundException('Win not found');

    // Upsert: if the user already reacted with this kind, toggle it off
    const existing = await this.prisma.winReaction.findUnique({
      where: { win_id_user_id_kind: { win_id: winId, user_id: userId, kind } },
    });

    if (existing) {
      await this.prisma.winReaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.winReaction.create({
        data: { win_id: winId, user_id: userId, kind },
      });
      // Award "Encourager" badge check (react to 10 community wins)
      await this.badgesService.checkAndAwardEncourager(userId);
    }

    const reactions = await this.prisma.winReaction.findMany({
      where: { win_id: winId },
      select: { kind: true },
    });
    return sumReactions(reactions);
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

    // Badge checks: first win, inner circle builder (5 wins)
    await this.badgesService.checkAndAwardFirstWin(userId);
    await this.badgesService.checkAndAwardInnerCircleBuilder(userId);

    return win;
  }
}
