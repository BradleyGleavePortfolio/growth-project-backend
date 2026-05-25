import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface EngagementBreakdown {
  logged_in_within_7d: number;              // +20
  messaged_within_48h_of_checkin: number;   // +30
  updated_workout_plan_this_week: number;   // +25
  avg_workout_completion_gte_70: number;    // +25
}

export interface EngagementScoreResult {
  subCoachId: string;
  score: number;
  breakdown: EngagementBreakdown;
}

/**
 * SubCoachAnalyticsService
 *
 * Computes an engagement score per sub-coach based on four weighted signals.
 * Phase 11: client membership comes from SubCoachAssignment (open rows),
 * not from User.coach_id (which always points at the head coach).
 *
 * Signals:
 *   +20  logged in within 7 days (proxy: sent at least one message in the last 7 days)
 *   +30  sent a message to a client within 48 h of the client's last check-in
 *   +25  created or updated a workout routine this calendar week
 *   +25  >= 70% session-day adherence across the team this month
 */
@Injectable()
export class SubCoachAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getEngagementScore(
    headCoachId: string,
    subCoachId: string,
  ): Promise<EngagementScoreResult> {
    // Verify ownership.
    const subCoach = await this.prisma.user.findFirst({
      where: { id: subCoachId, coach_id: headCoachId, role: 'coach' },
      select: { id: true },
    });
    if (!subCoach) {
      throw new NotFoundException(
        'Sub-coach not found or does not belong to this team',
      );
    }

    const now = new Date();

    // ── Signal 1: active within 7 days (+20) ─────────────────────────────────
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentMessage = await this.prisma.coachMessage.findFirst({
      where: {
        sender_id: subCoachId,
        created_at: { gte: sevenDaysAgo },
      },
      select: { id: true },
    });
    const loggedInWithin7d = recentMessage != null ? 20 : 0;

    // Load assigned clients via the join table.
    const openAssignments = await this.prisma.subCoachAssignment.findMany({
      where: {
        head_coach_id: headCoachId,
        sub_coach_id: subCoachId,
        unassigned_at: null,
      },
      select: { client_id: true },
    });
    const clientIds = openAssignments.map((a) => a.client_id);

    // ── Signal 2: responded within 48 h of client check-in (+30) ─────────────
    let messagedWithin48h = 0;
    if (clientIds.length > 0) {
      const fortyEightH = 48 * 60 * 60 * 1000;
      // Batched: pull each client's latest check-in, then a single
      // grouped message query — no per-client findFirst loop.
      const checkIns = await this.prisma.checkIn.findMany({
        where: { user_id: { in: clientIds } },
        orderBy: { logged_at: 'desc' },
        select: { user_id: true, logged_at: true },
      });
      const lastByClient = new Map<string, Date>();
      for (const ci of checkIns) {
        if (!lastByClient.has(ci.user_id)) {
          lastByClient.set(ci.user_id, ci.logged_at);
        }
      }
      if (lastByClient.size > 0) {
        const earliestDeadline = new Date(
          Math.min(...Array.from(lastByClient.values()).map((d) => d.getTime())),
        );
        const latestDeadline = new Date(
          Math.max(...Array.from(lastByClient.values()).map((d) => d.getTime())) +
            fortyEightH,
        );
        const responses = await this.prisma.coachMessage.findMany({
          where: {
            sender_id: subCoachId,
            client_id: { in: Array.from(lastByClient.keys()) },
            created_at: { gte: earliestDeadline, lte: latestDeadline },
          },
          select: { client_id: true, created_at: true },
        });
        for (const r of responses) {
          if (!r.client_id) continue;
          const ts = lastByClient.get(r.client_id);
          if (
            ts &&
            r.created_at >= ts &&
            r.created_at <= new Date(ts.getTime() + fortyEightH)
          ) {
            messagedWithin48h = 30;
            break;
          }
        }
      }
    }

    // ── Signal 3: assigned/updated a workout routine this week (+25) ──────────
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    const routineThisWeek = await this.prisma.workoutRoutine.findFirst({
      where: {
        creator_id: subCoachId,
        created_at: { gte: weekStart },
      },
      select: { id: true },
    });
    const updatedWorkoutPlanThisWeek = routineThisWeek != null ? 25 : 0;

    // ── Signal 4: avg client workout adherence >= 70 % this month (+25) ──────
    let avgCompletionGte70 = 0;
    if (clientIds.length > 0) {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const sessions = await this.prisma.workoutSession.findMany({
        where: {
          user_id: { in: clientIds },
          created_at: { gte: monthStart },
        },
        select: { user_id: true, date: true },
      });

      const activeDayKeys = new Set(
        sessions.map((s) => `${s.user_id}:${s.date.toISOString().slice(0, 10)}`),
      );
      const daysElapsed = Math.max(
        1,
        Math.ceil((now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const expectedDays = clientIds.length * daysElapsed;
      if (activeDayKeys.size / expectedDays >= 0.7) {
        avgCompletionGte70 = 25;
      }
    }

    const score = Math.min(
      100,
      loggedInWithin7d +
        messagedWithin48h +
        updatedWorkoutPlanThisWeek +
        avgCompletionGte70,
    );

    return {
      subCoachId,
      score,
      breakdown: {
        logged_in_within_7d: loggedInWithin7d,
        messaged_within_48h_of_checkin: messagedWithin48h,
        updated_workout_plan_this_week: updatedWorkoutPlanThisWeek,
        avg_workout_completion_gte_70: avgCompletionGte70,
      },
    };
  }
}
