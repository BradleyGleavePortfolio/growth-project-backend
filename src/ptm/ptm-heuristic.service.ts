import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  PTM_WINDOWS,
  type PtmFactor,
  type PtmScoreResult,
  type PtmSignalTypeT,
} from './ptm.types';

/**
 * PtmHeuristicService — Phase 1B rule-based scoring engine.
 *
 * Runs from day one without any prior labelled data. Every weight in
 * this file is hand-tuned against the brief in `_brief_phase1b.md`:
 * high-risk factors contribute +0.15..+0.25 each, medium-risk +0.08..+0.12,
 * protective factors -0.10..-0.15. riskScore is clamped to [0.0, 1.0]
 * after summing all contributions.
 *
 * successScore is independent of riskScore. The brief calls this out
 * explicitly: a high-engagement client and a high-burnout-risk client
 * are not mutually exclusive. We compute successScore as a base of
 * (1 - riskScore) lifted by half the absolute sum of protective
 * contributions, so a client with strong protective signals reads as
 * "likely to renew" even if their risk is non-zero.
 *
 * Doctrine:
 *   * No PrismaPromise.$transaction here — reads only. The recompute
 *     orchestrator is the sole writer (PtmPrediction is APPEND-ONLY).
 *   * factors[] only includes factors that fired. An empty array means
 *     no signals matched any rule (typically a brand-new client).
 *   * Window constants live in PTM_WINDOWS so the weighted engine and
 *     the admin teaching surface read from the same source of truth.
 */

const HIGH_RISK_CHECKIN_MISS_3PLUS = 0.2;
const HIGH_RISK_APP_OPEN_GAP_7D = 0.25;
const HIGH_RISK_COACH_NOTE_GAP_10D = 0.15;
const HIGH_RISK_WEIGHT_SKIP_14D = 0.15;
const HIGH_RISK_STREAK_DROPPED_RECENT = 0.2;

const MED_RISK_CONSISTENCY_LOW_RECENT = 0.1;
const MED_RISK_WORKOUT_SKIP_10D = 0.1;
const MED_RISK_MEAL_SKIP_7D = 0.08;
const MED_RISK_FINANCE_EOD_SKIP_5PLUS = 0.12;

const PROTECT_CHECKIN_STREAK_7PLUS = -0.15;
const PROTECT_FINANCE_MILESTONE_RECENT = -0.12;
const PROTECT_COACH_NOTE_RECENT = -0.1;
const PROTECT_WEIGHT_TREND_ALIGNED = -0.12;
const PROTECT_WORKOUT_RECENT = -0.1;

// Window for the "workout_recent" protective factor. The brief calls
// for "logged in last 3 days"; constant lives here rather than in
// PTM_WINDOWS because no other engine consumes the value.
const WORKOUT_RECENT_DAYS = 3;
const CHECKIN_STREAK_RECENT_DAYS = 7;
const FINANCE_MILESTONE_DAYS = 14;
const COACH_NOTE_RECENT_DAYS = 7;
const WEIGHT_TREND_LOOKBACK_DAYS = 14;
const WEIGHT_TREND_MIN_LOGS = 2;
const WEIGHT_TREND_SAMPLE = 3;

// Thresholds.
const CHECKIN_MISS_COUNT_THRESHOLD = 3;
const FINANCE_EOD_RATIO_THRESHOLD = 0.3;
const FINANCE_EOD_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PtmHeuristicService {
  constructor(private readonly prisma: PrismaService) {}

  async score(userId: string): Promise<PtmScoreResult> {
    const now = new Date();
    const factors: PtmFactor[] = [];

    // ---- HIGH RISK ----
    const checkinMissCount = await this.signalCountInWindow(
      userId,
      'checkin_miss',
      PTM_WINDOWS.CHECKIN_MISS_DAYS,
      now,
    );
    if (checkinMissCount >= CHECKIN_MISS_COUNT_THRESHOLD) {
      factors.push({
        key: 'checkin_miss_3plus',
        label: '3+ missed check-ins in last 14 days',
        contribution: HIGH_RISK_CHECKIN_MISS_3PLUS,
        observed: checkinMissCount,
      });
    }

    const appOpenAge = await this.latestSignalAge(userId, 'app_open', now);
    if (appOpenAge >= PTM_WINDOWS.APP_OPEN_GAP_DAYS) {
      factors.push({
        key: 'app_open_gap_7d',
        label: 'No app open in last 7 days',
        contribution: HIGH_RISK_APP_OPEN_GAP_7D,
        observed: Number.isFinite(appOpenAge) ? appOpenAge : undefined,
      });
    }

    const coachNoteAge = await this.latestSignalAge(
      userId,
      'coach_note_received',
      now,
    );
    if (coachNoteAge >= PTM_WINDOWS.COACH_NOTE_GAP_DAYS) {
      factors.push({
        key: 'coach_note_gap_10d',
        label: 'No coach note received in last 10 days',
        contribution: HIGH_RISK_COACH_NOTE_GAP_10D,
        observed: Number.isFinite(coachNoteAge) ? coachNoteAge : undefined,
      });
    }

    const weightAge = await this.latestSignalAge(userId, 'weight_logged', now);
    if (weightAge >= PTM_WINDOWS.WEIGHT_SKIP_DAYS) {
      factors.push({
        key: 'weight_skip_14d',
        label: 'No weight logged in last 14 days',
        contribution: HIGH_RISK_WEIGHT_SKIP_14D,
        observed: Number.isFinite(weightAge) ? weightAge : undefined,
      });
    }

    const streakDroppedRecent = await this.mostRecentSignal(
      userId,
      'streak_dropped',
      PTM_WINDOWS.APP_OPEN_GAP_DAYS,
      now,
    );
    if (streakDroppedRecent != null) {
      factors.push({
        key: 'streak_dropped_recent',
        label: 'Streak dropped in last 7 days',
        contribution: HIGH_RISK_STREAK_DROPPED_RECENT,
        observed: streakDroppedRecent.value,
      });
    }

    // ---- MEDIUM RISK ----
    const consistencyLowRecent = await this.mostRecentSignal(
      userId,
      'consistency_low',
      PTM_WINDOWS.CONSISTENCY_WINDOW_DAYS,
      now,
    );
    if (consistencyLowRecent != null) {
      factors.push({
        key: 'consistency_low_recent',
        label: 'Consistency dropped below 60% in last 30 days',
        contribution: MED_RISK_CONSISTENCY_LOW_RECENT,
        observed: consistencyLowRecent.value,
      });
    }

    const workoutAge = await this.latestSignalAge(
      userId,
      'workout_logged',
      now,
    );
    if (workoutAge >= PTM_WINDOWS.WORKOUT_SKIP_DAYS) {
      factors.push({
        key: 'workout_skip_10d',
        label: 'No workout logged in last 10 days',
        contribution: MED_RISK_WORKOUT_SKIP_10D,
        observed: Number.isFinite(workoutAge) ? workoutAge : undefined,
      });
    }

    const mealAge = await this.latestSignalAge(userId, 'meal_logged', now);
    if (mealAge >= PTM_WINDOWS.MEAL_SKIP_DAYS) {
      factors.push({
        key: 'meal_skip_7d',
        label: 'No meal logged in last 7 days',
        contribution: MED_RISK_MEAL_SKIP_7D,
        observed: Number.isFinite(mealAge) ? mealAge : undefined,
      });
    }

    // Finance EOD: count observed in last 7 days, expected = 7 days.
    // Below 0.3 ratio => 5+ misses => factor fires.
    const financeEodObserved = await this.signalCountInWindow(
      userId,
      'finance_eod',
      FINANCE_EOD_WINDOW_DAYS,
      now,
    );
    const financeEodRatio = financeEodObserved / FINANCE_EOD_WINDOW_DAYS;
    if (financeEodRatio < FINANCE_EOD_RATIO_THRESHOLD) {
      factors.push({
        key: 'finance_eod_skip_5plus',
        label: '5+ finance EOD misses in last 7 days',
        contribution: MED_RISK_FINANCE_EOD_SKIP_5PLUS,
        observed: financeEodObserved,
      });
    }

    // ---- PROTECTIVE ----
    const checkinStreak = await this.mostRecentSignalWithMinValue(
      userId,
      'checkin_streak',
      CHECKIN_STREAK_RECENT_DAYS,
      7,
      now,
    );
    if (checkinStreak != null) {
      factors.push({
        key: 'checkin_streak_7plus',
        label: 'Active check-in streak 7+ days',
        contribution: PROTECT_CHECKIN_STREAK_7PLUS,
        observed: checkinStreak.value,
      });
    }

    const financeMilestone = await this.mostRecentSignal(
      userId,
      'finance_milestone',
      FINANCE_MILESTONE_DAYS,
      now,
    );
    if (financeMilestone != null) {
      factors.push({
        key: 'finance_milestone_recent',
        label: 'Finance milestone hit in last 14 days',
        contribution: PROTECT_FINANCE_MILESTONE_RECENT,
        observed: financeMilestone.value,
      });
    }

    const coachNoteRecent = await this.mostRecentSignal(
      userId,
      'coach_note_received',
      COACH_NOTE_RECENT_DAYS,
      now,
    );
    if (coachNoteRecent != null) {
      factors.push({
        key: 'coach_note_recent',
        label: 'Coach note received in last 7 days',
        contribution: PROTECT_COACH_NOTE_RECENT,
        observed: coachNoteRecent.value,
      });
    }

    const weightTrend = await this.evaluateWeightTrendAligned(userId, now);
    if (weightTrend != null) {
      factors.push({
        key: 'weight_trend_aligned',
        label: 'Weight trending toward goal (3+ logs)',
        contribution: PROTECT_WEIGHT_TREND_ALIGNED,
        observed: weightTrend,
      });
    }

    const workoutRecent = await this.mostRecentSignal(
      userId,
      'workout_logged',
      WORKOUT_RECENT_DAYS,
      now,
    );
    if (workoutRecent != null) {
      factors.push({
        key: 'workout_recent',
        label: 'Workout logged in last 3 days',
        contribution: PROTECT_WORKOUT_RECENT,
        observed: workoutRecent.value,
      });
    }

    // ---- SCORE COMPUTATION ----
    let rawRisk = 0;
    let absProtective = 0;
    for (const f of factors) {
      rawRisk += f.contribution;
      if (f.contribution < 0) absProtective += Math.abs(f.contribution);
    }
    const riskScore = clamp(rawRisk, 0, 1);
    const successScore = clamp(1 - riskScore + 0.5 * absProtective, 0, 1);

    return {
      riskScore,
      successScore,
      basis: 'heuristic_v1',
      factors,
    };
  }

  // -------- private helpers --------

  private async signalCountInWindow(
    userId: string,
    signalType: PtmSignalTypeT,
    sinceDays: number,
    now: Date,
  ): Promise<number> {
    const since = new Date(now.getTime() - sinceDays * DAY_MS);
    return this.prisma.clientSignal.count({
      where: {
        user_id: userId,
        signal_type: signalType,
        recorded_at: { gte: since },
      },
    });
  }

  // Days since the most recent signal of this type, or +Infinity if
  // none. Callers compare against a window threshold (e.g. >= 14 means
  // "no signal in last 14 days").
  private async latestSignalAge(
    userId: string,
    signalType: PtmSignalTypeT,
    now: Date,
  ): Promise<number> {
    const row = await this.prisma.clientSignal.findFirst({
      where: { user_id: userId, signal_type: signalType },
      orderBy: { recorded_at: 'desc' },
      select: { recorded_at: true },
    });
    if (!row) return Number.POSITIVE_INFINITY;
    return (now.getTime() - row.recorded_at.getTime()) / DAY_MS;
  }

  private async mostRecentSignal(
    userId: string,
    signalType: PtmSignalTypeT,
    sinceDays: number,
    now: Date,
  ): Promise<{ value: number } | null> {
    const since = new Date(now.getTime() - sinceDays * DAY_MS);
    const row = await this.prisma.clientSignal.findFirst({
      where: {
        user_id: userId,
        signal_type: signalType,
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: 'desc' },
      select: { value: true },
    });
    return row ? { value: row.value } : null;
  }

  private async mostRecentSignalWithMinValue(
    userId: string,
    signalType: PtmSignalTypeT,
    sinceDays: number,
    minValue: number,
    now: Date,
  ): Promise<{ value: number } | null> {
    const since = new Date(now.getTime() - sinceDays * DAY_MS);
    const row = await this.prisma.clientSignal.findFirst({
      where: {
        user_id: userId,
        signal_type: signalType,
        recorded_at: { gte: since },
        value: { gte: minValue },
      },
      orderBy: { recorded_at: 'desc' },
      select: { value: true },
    });
    return row ? { value: row.value } : null;
  }

  // Pull last 3 weight_logged signals and return the average delta sign
  // if it matches the user's GoalType (fat_loss => negative average).
  // Returns the avg-delta when the factor should fire, else null.
  private async evaluateWeightTrendAligned(
    userId: string,
    now: Date,
  ): Promise<number | null> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { user_id: userId },
      select: { goal_type: true },
    });
    if (!profile?.goal_type) return null;

    const since = new Date(now.getTime() - WEIGHT_TREND_LOOKBACK_DAYS * DAY_MS);
    const rows = await this.prisma.clientSignal.findMany({
      where: {
        user_id: userId,
        signal_type: 'weight_logged',
        recorded_at: { gte: since },
      },
      orderBy: { recorded_at: 'desc' },
      take: WEIGHT_TREND_SAMPLE,
      select: { value: true },
    });
    if (rows.length < WEIGHT_TREND_MIN_LOGS) return null;
    const avg = rows.reduce((s, r) => s + r.value, 0) / rows.length;

    // GoalType -> expected delta sign convention. weight_logged value
    // is the delta vs the prior log (kg): negative = lost, positive =
    // gained, zero = unchanged. fat_loss expects negative; muscle_gain
    // and performance expect positive; maintenance expects ~zero (we
    // accept any sign as "aligned" since the user is holding steady).
    const goal = profile.goal_type;
    let aligned = false;
    if (goal === 'fat_loss') aligned = avg < 0;
    else if (goal === 'muscle_gain' || goal === 'performance') aligned = avg > 0;
    else if (goal === 'maintenance') aligned = Math.abs(avg) < 0.5;

    return aligned ? avg : null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
