import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BadgeSlug } from '@prisma/client';

export interface BadgeDto {
  slug: string;
  label: string;
  awardedAt: string | null;
  description: string;
}

const BADGE_META: Record<BadgeSlug, { label: string; description: string }> = {
  first_win: {
    label: 'First Win',
    description: 'Log your first workout or meal',
  },
  encourager: {
    label: 'Encourager',
    description: 'React to 10 community wins',
  },
  inner_circle_builder: {
    label: 'Inner Circle Builder',
    description: 'Invite a friend or post 5 community wins',
  },
  consistency_hero: {
    label: 'Consistency Hero',
    description: 'Maintain a 14-day activity streak',
  },
};

@Injectable()
export class BadgesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Returns all badges (earned + locked) for a user.
   */
  async getBadgesForUser(userId: string): Promise<BadgeDto[]> {
    const earned = await this.prisma.userBadge.findMany({
      where: { user_id: userId },
    });
    const earnedMap = new Map(earned.map((b) => [b.slug, b.awarded_at]));

    return Object.entries(BADGE_META).map(([slug, meta]) => ({
      slug,
      label: meta.label,
      description: meta.description,
      awardedAt: earnedMap.has(slug as BadgeSlug)
        ? earnedMap.get(slug as BadgeSlug)!.toISOString()
        : null,
    }));
  }

  private async awardIfNotExists(userId: string, slug: BadgeSlug): Promise<void> {
    await this.prisma.userBadge.upsert({
      where: { user_id_slug: { user_id: userId, slug } },
      create: { user_id: userId, slug },
      update: {}, // already awarded — no-op
    });
  }

  /**
   * First Win: awarded when the user has at least one workout OR meal log.
   */
  async checkAndAwardFirstWin(userId: string): Promise<void> {
    const [workoutCount, mealCount] = await Promise.all([
      this.prisma.workoutSession.count({ where: { user_id: userId } }),
      this.prisma.loggedFoodEntry.count({ where: { user_id: userId } }),
    ]);
    if (workoutCount + mealCount >= 1) {
      await this.awardIfNotExists(userId, BadgeSlug.first_win);
    }
  }

  /**
   * Encourager: awarded when the user has reacted to 10+ distinct community wins.
   */
  async checkAndAwardEncourager(userId: string): Promise<void> {
    const distinctWins = await this.prisma.winReaction.findMany({
      where: { user_id: userId },
      distinct: ['win_id'],
      select: { win_id: true },
    });
    if (distinctWins.length >= 10) {
      await this.awardIfNotExists(userId, BadgeSlug.encourager);
    }
  }

  /**
   * Inner Circle Builder: awarded when invited a friend (has invite code used)
   * OR posted 5 community wins.
   */
  async checkAndAwardInnerCircleBuilder(userId: string): Promise<void> {
    const [winsCount, inviteUsed] = await Promise.all([
      this.prisma.communityWin.count({ where: { user_id: userId } }),
      this.prisma.inviteCode.findFirst({
        where: { coach_id: userId, used_count: { gte: 1 } },
      }),
    ]);
    if (winsCount >= 5 || inviteUsed) {
      await this.awardIfNotExists(userId, BadgeSlug.inner_circle_builder);
    }
  }

  /**
   * Consistency Hero: 14-day streak check.
   * A "day active" = has a workout or food log entry on that date.
   * Checks the last 14 calendar days.
   */
  async checkAndAwardConsistencyHero(userId: string): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const days: Set<string> = new Set();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.add(d.toISOString().slice(0, 10));
    }

    const [workouts, meals] = await Promise.all([
      this.prisma.workoutSession.findMany({
        where: { user_id: userId, date: { gte: new Date(today.getTime() - 13 * 86400000) } },
        select: { date: true },
      }),
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: userId, date: { gte: new Date(today.getTime() - 13 * 86400000) } },
        select: { date: true },
      }),
    ]);

    const activeDays = new Set<string>();
    for (const w of workouts) activeDays.add(w.date.toISOString().slice(0, 10));
    for (const m of meals) activeDays.add(m.date.toISOString().slice(0, 10));

    if (activeDays.size >= 14) {
      await this.awardIfNotExists(userId, BadgeSlug.consistency_hero);
    }
  }
}
