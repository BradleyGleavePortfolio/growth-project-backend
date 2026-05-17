import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { SubCoachSummaryView } from './sub-coaches.types';

// Phase 8 — engagement analytics for sub-coaches.
//
// Split out of SubCoachesService during the M9 refactor. The numbers
// computed here are exposed both as a stand-alone /sub-coaches/:id/analytics
// route (via `analytics()`) and as inputs to the list/detail summaries
// (via `bulkResolveTiers` / `bulkAssignedCounts`, which the main
// SubCoachesService still calls into).
@Injectable()
export class SubCoachAnalyticsService {
  private readonly logger = new Logger(SubCoachAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // GET /sub-coaches/:id/analytics — same engagement block as detail,
  // exposed as its own route so the mobile screen can refresh just the
  // metric without re-pulling the full client list.
  async analytics(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<SubCoachSummaryView['engagement']> {
    await this.assertCanReadSubCoach(callerId, callerRole, subCoachId);
    return this.computeEngagement(subCoachId);
  }

  // Public — the main SubCoachesService consumes these from list() and
  // detail() so the read paths share one query strategy.
  async bulkResolveTiers(coachIds: string[]): Promise<Map<string, string>> {
    if (coachIds.length === 0) return new Map();
    const subs = await this.prisma.coachSubscription.findMany({
      where: { coach_id: { in: coachIds } },
      select: { coach_id: true, stripe_price_id: true },
    });
    const map = new Map<string, string>();
    for (const s of subs) {
      map.set(s.coach_id, this.priceIdToTier(s.stripe_price_id));
    }
    return map;
  }

  async bulkAssignedCounts(coachIds: string[]): Promise<Map<string, number>> {
    if (coachIds.length === 0) return new Map();
    const rows = await this.prisma.user.groupBy({
      by: ['coach_id'],
      where: {
        role: 'student',
        deleted_at: null,
        coach_id: { in: coachIds },
      },
      _count: { _all: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.coach_id) map.set(r.coach_id, r._count._all);
    }
    return map;
  }

  // ── internals ─────────────────────────────────────────────────────

  // Same auth check the main service uses. Kept here so the analytics
  // route can gate itself without a circular DI to SubCoachesService.
  private async assertCanReadSubCoach(
    callerId: string,
    callerRole: string,
    subCoachId: string,
  ): Promise<void> {
    if (callerRole === 'owner') return;
    if (callerId === subCoachId) return;
    const assigned = await this.prisma.teamSubCoachAssignment.findFirst({
      where: {
        head_coach_id: callerId,
        sub_coach_id: subCoachId,
        archived_at: null,
      },
      select: { id: true },
    });
    if (!assigned) {
      throw new ForbiddenException({
        kind: 'sub_coach_not_on_team',
        message: 'You do not have access to that sub-coach.',
      });
    }
  }

  // Engagement score (v1): four boolean / averaged signals over the last
  // seven days, each weighted equally. Anything we can't compute on a
  // dry database returns 0 rather than fake data.
  private async computeEngagement(
    subCoachId: string,
  ): Promise<SubCoachSummaryView['engagement']> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const fortyEightHours = 48 * 3_600_000;

    const clients = await this.prisma.user.findMany({
      where: { coach_id: subCoachId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    const clientIds = clients.map((c) => c.id);
    const totalClients = clientIds.length;

    // Signal 1 — clients with any LoggedFoodEntry in last 7d.
    // Signal 3 — workout plan touched this week by the sub-coach.
    // Signal 4 — avg WorkoutSession completion ≥ 70%.
    // Signal 2 — sub-coach messaged within 48h of the most recent check-in.
    //
    // Each signal degrades to 0 when there's nothing to measure.
    let loggedIn7d = 0;
    let messagedWithin48hOfCheckin = 0;
    let updatedWorkoutPlanThisWeek = 0;
    let avgWorkoutCompletionGte70 = 0;

    if (totalClients > 0) {
      const loggedClients = await this.prisma.loggedFoodEntry.findMany({
        where: {
          user_id: { in: clientIds },
          logged_at: { gte: sevenDaysAgo },
        },
        select: { user_id: true },
        distinct: ['user_id'],
      });
      loggedIn7d = loggedClients.length;

      // For each client, find the most recent CheckIn timestamp, then
      // check whether the sub-coach sent a CoachMessage within 48h of
      // it. We use logged_at (CheckIn) and created_at (CoachMessage).
      const latestCheckIns = await this.prisma.checkIn.findMany({
        where: { user_id: { in: clientIds } },
        orderBy: { logged_at: 'desc' },
        distinct: ['user_id'],
        select: { user_id: true, logged_at: true },
      });
      if (latestCheckIns.length > 0) {
        const messages = await this.prisma.coachMessage.findMany({
          where: {
            sender_id: subCoachId,
            client_id: { in: latestCheckIns.map((c) => c.user_id) },
          },
          select: { client_id: true, created_at: true },
        });
        const byClient = new Map<string, Date[]>();
        for (const m of messages) {
          if (!m.client_id) continue;
          const list = byClient.get(m.client_id) ?? [];
          list.push(m.created_at);
          byClient.set(m.client_id, list);
        }
        for (const c of latestCheckIns) {
          const list = byClient.get(c.user_id) ?? [];
          if (
            list.some(
              (t) =>
                t.getTime() >= c.logged_at.getTime() &&
                t.getTime() <= c.logged_at.getTime() + fortyEightHours,
            )
          ) {
            messagedWithin48hOfCheckin += 1;
          }
        }
      }

      // Workout plan touched this week by the sub-coach. A new or
      // freshly-completed assignment is the closest proxy for
      // "updated workout plan" on the current schema.
      const recentAssignments =
        await this.prisma.clientWorkoutAssignment.findMany({
          where: {
            assigned_by_coach_id: subCoachId,
            client_id: { in: clientIds },
            OR: [
              { scheduled_for: { gte: sevenDaysAgo } },
              { completed_at: { gte: sevenDaysAgo } },
            ],
          },
          select: { client_id: true },
          distinct: ['client_id'],
        });
      updatedWorkoutPlanThisWeek = recentAssignments.length;

      // Avg workout completion ≥ 70%: in the absence of a per-session
      // completion-percent column, we approximate via assignment
      // completion ratio over the last 7d. A client whose 7-day
      // assignments are at least 70% completed counts.
      const recent7dAssignments =
        await this.prisma.clientWorkoutAssignment.findMany({
          where: {
            client_id: { in: clientIds },
            scheduled_for: { gte: sevenDaysAgo },
          },
          select: { client_id: true, completed_at: true },
        });
      const byClient = new Map<string, { total: number; done: number }>();
      for (const a of recent7dAssignments) {
        const cur = byClient.get(a.client_id) ?? { total: 0, done: 0 };
        cur.total += 1;
        if (a.completed_at) cur.done += 1;
        byClient.set(a.client_id, cur);
      }
      for (const { total, done } of byClient.values()) {
        if (total > 0 && done / total >= 0.7) avgWorkoutCompletionGte70 += 1;
      }
    }

    // Score = mean of four normalized signals (0..1) * 100.
    const norm = (n: number) =>
      totalClients === 0 ? 0 : Math.min(1, n / totalClients);
    const score = Math.round(
      ((norm(loggedIn7d) +
        norm(messagedWithin48hOfCheckin) +
        norm(updatedWorkoutPlanThisWeek) +
        norm(avgWorkoutCompletionGte70)) /
        4) *
        100,
    );

    return {
      subCoachId,
      score,
      breakdown: {
        logged_in_within_7d: loggedIn7d,
        messaged_within_48h_of_checkin: messagedWithin48hOfCheckin,
        updated_workout_plan_this_week: updatedWorkoutPlanThisWeek,
        avg_workout_completion_gte_70: avgWorkoutCompletionGte70,
      },
    };
  }

  private priceIdToTier(priceId: string | null): string {
    if (!priceId) return 'unknown';
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
    return 'unknown';
  }
}
