// Phase 7C — Leaderboard Service.
//
// Combined score formula (weights sum to 1.0):
//   check-in completion (30%)  : actual_checkins / 30
//   workout logged     (25%)  : workouts_in_30d / target, capped at 1.0
//   meal logged        (20%)  : meals_in_30d / 90, capped at 1.0
//   coach engagement   (15%)  : messages_to_coach_in_30d / 10, capped at 1.0
//   streak bonus       (10%)  : current_checkin_streak / 30, capped at 1.0
//
// Final score = round(sum * 100). Range [0, 100].
//
// Privacy:
//   * NEVER surfaces raw weight, body-fat, or finance numbers.
//   * Display name is either the user-configured value or the derived
//     "{firstName} {lastInitial}." — never the full name.
//     Derivation parses the single `name` column: first token = first name,
//     last token = last name (initial only). "Sarah Connor" → "Sarah C."
//   * Only opted-in users appear; opt-out hides the row for all peers.
//   * Scope is the requesting user's coach roster only — never platform-wide.
//
// Caching:
//   * Per-user combined scores are cached in memory for SCORE_TTL_MS (1 hour).
//   * The nightly scheduler (LeaderboardScheduler) warm-recomputes all
//     opted-in users at 06:00 UTC so daytime reads nearly always hit cache.
//   * Cache key: user ID.  Cache value: { score, computedAt }.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const SCORE_TTL_MS = 60 * 60 * 1_000; // 1 hour

// Component weights must sum to 1.0.
const W_CHECKIN   = 0.30;
const W_WORKOUT   = 0.25;
const W_MEAL      = 0.20;
const W_COACH_MSG = 0.15;
const W_STREAK    = 0.10;

// Denominators / targets (all are "ideal" values for a 30-day window).
const CHECKIN_DENOM   = 30;   // 1 check-in per day
const WORKOUT_TARGET  = 12;   // ~3 workouts/week × 4 weeks
const MEAL_DENOM      = 90;   // 3 meals/day × 30 days
const COACH_MSG_DENOM = 10;   // 10 messages to coach in 30 days
const STREAK_DENOM    = 30;   // 30-day streak = perfect

interface ScoreCacheEntry {
  score: number;
  computedAt: Date;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  combinedScore: number;
  /** Change in combined score since the previous cached computation.
   *  Null on first computation or after a cache miss. */
  weekDelta: number | null;
  isRequester: boolean;
}

export interface LeaderboardViewer {
  /** Explicit opt-in state read directly from the DB field (show_on_leaderboard).
   *  Never inferred from list membership. */
  is_opted_in: boolean;
  /** The requester's current rank. Null when not opted in. */
  rank: number | null;
  /** The requester's current combined score (0–100). Null when not opted in. */
  score: number | null;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  selfRank: number | null;
  /** Explicit viewer state — always present, never inferred from entries. */
  viewer: LeaderboardViewer;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  // In-process score cache. Keys are user IDs. Cleared on opt-out.
  private readonly scoreCache = new Map<string, ScoreCacheEntry>();
  // Previous score cache for delta computation. Keys are user IDs.
  private readonly prevCache = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the leaderboard for the requesting user's coach roster.
   * Only opted-in users appear in the ranked list.
   * The requesting user's row is always present, including their rank
   * (rank is shown even if they are not opted in — their row is simply
   * flagged `isRequester: true` but not counted toward the public ranking).
   */
  async getLeaderboard(requesterId: string): Promise<LeaderboardResponse> {
    if ((process.env.LEADERBOARD_ENABLED ?? 'on').toLowerCase() === 'off') {
      return {
        entries: [],
        selfRank: null,
        viewer: { is_opted_in: false, rank: null, score: null },
      };
    }

    // Resolve the requester's coach so we can scope the roster.
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: {
        id: true,
        name: true,
        coach_id: true,
        show_on_leaderboard: true,
        leaderboard_display_name: true,
      },
    });
    if (!requester || !requester.coach_id) {
      // No coach assigned — empty board (not an error).
      return {
        entries: [],
        selfRank: null,
        viewer: { is_opted_in: false, rank: null, score: null },
      };
    }

    // Explicit opt-in state from the DB field — never inferred from list membership.
    const requesterIsOptedIn = requester.show_on_leaderboard;

    // All clients under the same coach.
    const rosterMembers = await this.prisma.user.findMany({
      where: {
        coach_id: requester.coach_id,
        deleted_at: null,
      },
      select: {
        id: true,
        name: true,
        show_on_leaderboard: true,
        leaderboard_display_name: true,
      },
    });

    // Score every opted-in member.
    // The requester is included for rank computation only when opted in.
    const scored: Array<{ userId: string; displayName: string; score: number }> = [];
    for (const member of rosterMembers) {
      if (!member.show_on_leaderboard) continue;
      const score = await this.getCachedScore(member.id);
      scored.push({
        userId:      member.id,
        displayName: this.resolveDisplayName(member),
        score,
      });
    }

    // If the requester is not opted in, compute their score for the viewer
    // block but do NOT include them in the ranked entries list.
    let requesterScoreForViewer: number | null = null;
    if (!requesterIsOptedIn) {
      requesterScoreForViewer = await this.getCachedScore(requesterId);
    }

    // Sort descending by score.
    scored.sort((a, b) => b.score - a.score);

    // Build ranked entries. Ties share the same rank.
    const entries: LeaderboardEntry[] = [];
    let rank = 0;
    let prevScore = -1;
    let tieCount = 0;

    for (const item of scored) {
      if (item.score !== prevScore) {
        rank += 1 + tieCount;
        tieCount = 0;
      } else {
        tieCount += 1;
      }
      prevScore = item.score;

      const prev = this.prevCache.get(item.userId);
      entries.push({
        rank,
        userId:       item.userId,
        displayName:  item.displayName,
        combinedScore: item.score,
        weekDelta:    prev !== undefined ? item.score - prev : null,
        isRequester:  item.userId === requesterId,
      });
    }

    const selfEntry = entries.find((e) => e.isRequester);

    // Build the explicit viewer object from the DB field.
    const viewer: LeaderboardViewer = {
      is_opted_in: requesterIsOptedIn,
      rank:  requesterIsOptedIn ? (selfEntry?.rank ?? null) : null,
      score: requesterIsOptedIn
        ? (selfEntry?.combinedScore ?? null)
        : requesterScoreForViewer,
    };

    return {
      entries,
      selfRank: selfEntry?.rank ?? null,
      viewer,
    };
  }

  /**
   * Opt a user in or out of the leaderboard.
   * Clears the cache on opt-out so a stale score is never served.
   */
  async setOptIn(
    userId: string,
    enabled: boolean,
    displayName?: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        show_on_leaderboard:      enabled,
        leaderboard_display_name: enabled
          ? (displayName?.trim() ?? null)
          : null,
      },
    });

    if (!enabled) {
      this.scoreCache.delete(userId);
      this.prevCache.delete(userId);
    }
  }

  /**
   * Recomputes and caches scores for all opted-in users.
   * Called by LeaderboardScheduler at 06:00 UTC.
   */
  async recomputeAll(): Promise<{ computed: number; errors: number }> {
    const opted = await this.prisma.user.findMany({
      where: { show_on_leaderboard: true, deleted_at: null },
      select: { id: true },
    });

    let computed = 0;
    let errors = 0;
    for (const { id } of opted) {
      try {
        const prev = this.scoreCache.get(id);
        if (prev) this.prevCache.set(id, prev.score);
        const score = await this.computeScore(id);
        this.scoreCache.set(id, { score, computedAt: new Date() });
        computed += 1;
      } catch (err: unknown) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Leaderboard recompute failed (user=${id}): ${msg}`);
      }
    }
    return { computed, errors };
  }

  // ─── Score computation ─────────────────────────────────────────────────────

  /**
   * Returns a cached score if fresh, otherwise recomputes and caches.
   */
  async getCachedScore(userId: string): Promise<number> {
    const cached = this.scoreCache.get(userId);
    if (cached && Date.now() - cached.computedAt.getTime() < SCORE_TTL_MS) {
      return cached.score;
    }
    const score = await this.computeScore(userId);
    this.scoreCache.set(userId, { score, computedAt: new Date() });
    return score;
  }

  /**
   * Computes the combined score from raw Prisma data for a single user.
   * Always hits the database — call getCachedScore for the hot path.
   */
  async computeScore(userId: string): Promise<number> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);

    // Resolve current streak from check-in signals.
    const streakSignal = await this.prisma.clientSignal.findFirst({
      where: {
        user_id: userId,
        signal_type: 'checkin_streak',
      },
      orderBy: { recorded_at: 'desc' },
      select: { value: true },
    });
    const currentStreak = streakSignal?.value ?? 0;

    // Count distinct check-in signals in last 30 days.
    const checkinCount = await this.prisma.clientSignal.count({
      where: {
        user_id:     userId,
        signal_type: 'checkin_streak',
        recorded_at: { gte: since },
      },
    });

    // Count workout_logged signals.
    const workoutCount = await this.prisma.clientSignal.count({
      where: {
        user_id:     userId,
        signal_type: 'workout_logged',
        recorded_at: { gte: since },
      },
    });

    // Count meal_logged signals.
    const mealCount = await this.prisma.clientSignal.count({
      where: {
        user_id:     userId,
        signal_type: 'meal_logged',
        recorded_at: { gte: since },
      },
    });

    // Count message_sent signals (client → coach).
    const msgCount = await this.prisma.clientSignal.count({
      where: {
        user_id:     userId,
        signal_type: 'message_sent',
        recorded_at: { gte: since },
      },
    });

    const checkinRate  = Math.min(checkinCount / CHECKIN_DENOM,   1.0);
    const workoutRate  = Math.min(workoutCount / WORKOUT_TARGET,  1.0);
    const mealRate     = Math.min(mealCount    / MEAL_DENOM,      1.0);
    const coachMsgRate = Math.min(msgCount     / COACH_MSG_DENOM, 1.0);
    const streakRate   = Math.min((currentStreak ?? 0) / STREAK_DENOM, 1.0);

    const raw =
      checkinRate  * W_CHECKIN   +
      workoutRate  * W_WORKOUT   +
      mealRate     * W_MEAL      +
      coachMsgRate * W_COACH_MSG +
      streakRate   * W_STREAK;

    return Math.round(raw * 100);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Derives a safe display name from the user record.
   * Priority:
   *   1. leaderboard_display_name (explicitly set by user)
   *   2. "{first token} {last-token initial}." derived from `name`
   *   3. "Member" (fallback when name is blank)
   *
   * The derivation never exposes the full name — only "Sarah C." style.
   * This matches the Phase 7C privacy doctrine: no full name without consent.
   */
  private resolveDisplayName(member: {
    name: string;
    leaderboard_display_name: string | null;
  }): string {
    if (member.leaderboard_display_name?.trim()) {
      return member.leaderboard_display_name.trim();
    }
    const parts = (member.name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'Member';
    const first = parts[0];
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return lastInitial ? `${first} ${lastInitial}.` : first;
  }
}
