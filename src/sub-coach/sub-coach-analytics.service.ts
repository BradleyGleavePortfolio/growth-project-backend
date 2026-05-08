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
 * Computes an engagement score per sub-coach based on four weighted signals:
 *   +20  logged in within 7 days (proxy: sent at least one message in the last 7 days)
 *   +30  sent a message to a client within 48 h of the client's last check-in
 *   +25  created or updated a workout routine this calendar week
 *   +25  clients had >= 70% workout-session days with at least one session this month
 * Cap: 100.
 *
 * Score formula is intentionally approximated from existing data:
 *   - There is no dedicated "last login" field, so recent message activity is the proxy.
 *   - WorkoutSession has no completion flag; instead we measure session density
 *     (days-with-sessions / total-days) as a proxy for adherence.
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
    // Proxy: sub-coach sent at least one CoachMessage in the last 7 days.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const recentMessage = await this.prisma.coachMessage.findFirst({
      where: {
        sender_id: subCoachId,
        created_at: { gte: sevenDaysAgo },
      },
      select: { id: true },
    });
    const loggedInWithin7d = recentMessage != null ? 20 : 0;

    // ── Signal 2: responded within 48 h of client check-in (+30) ─────────────
    const clients = await this.prisma.user.findMany({
      where: { coach_id: subCoachId, role: 'student', deleted_at: null },
      select: { id: true },
    });

    let messagedWithin48h = 0;
    const fortyEightH = 48 * 60 * 60 * 1000;
    for (const client of clients) {
      const lastCheckIn = await this.prisma.checkIn.findFirst({
        where: { user_id: client.id },
        orderBy: { logged_at: 'desc' },
        select: { logged_at: true },
      });
      if (!lastCheckIn) continue;
      const deadline = new Date(lastCheckIn.logged_at.getTime() + fortyEightH);
      const responded = await this.prisma.coachMessage.findFirst({
        where: {
          sender_id: subCoachId,
          client_id: client.id,
          created_at: { gte: lastCheckIn.logged_at, lte: deadline },
        },
        select: { id: true },
      });
      if (responded) {
        messagedWithin48h = 30;
        break; // one qualifying response is enough
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
    // Proxy: (unique session-days / total calendar days elapsed this month) >= 0.7
    let avgCompletionGte70 = 0;
    if (clients.length > 0) {
      const clientIds = clients.map((c) => c.id);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const sessions = await this.prisma.workoutSession.findMany({
        where: {
          user_id: { in: clientIds },
          created_at: { gte: monthStart },
        },
        select: { user_id: true, date: true },
      });

      // Count distinct (user_id, date) pairs as "active days".
      const activeDayKeys = new Set(
        sessions.map((s) => `${s.user_id}:${s.date.toISOString().slice(0, 10)}`),
      );
      const daysElapsed = Math.max(
        1,
        Math.ceil((now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const expectedDays = clients.length * daysElapsed;
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
