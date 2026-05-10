import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma.service';
import {
  alignWeekly,
  bucketWeekly,
  DailySample,
  pearson,
  WeeklyBucket,
} from '../common/correlation/pearson';
import { FinanceInsightsClient } from './finance-insights.client';
import {
  HolisticInsight,
  HolisticInsightsEnvelope,
} from './holistic-insights.types';

const DEFAULT_WINDOW_DAYS = 90;
const MIN_WEEKS_FOR_CORRELATION = 4;
const MIN_R_THRESHOLD = 0.3;
// Successful envelopes (status === 'ok' or 'insufficient_data') cache
// for 24 hours: the underlying weekly fitness/finance series only
// updates a few times a week, so a long TTL is fine.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Finance-unavailable envelopes cache for 5 minutes only. A user who
// connects their finance account, fixes a token, or whose finance
// backend recovers from a transient outage should NOT see the paused
// "we could not reach your finance pillar" copy for the rest of the
// day. Five minutes keeps the cache useful (rate-limits hot retries
// from a stuck mobile screen) while letting recovery propagate fast.
const FINANCE_UNAVAILABLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class HolisticInsightsService {
  private readonly logger = new Logger(HolisticInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeClient: FinanceInsightsClient,
  ) {}

  async generateForUser(
    userId: string,
    options: { windowDays?: number; force?: boolean } = {},
  ): Promise<HolisticInsightsEnvelope> {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

    if (!options.force) {
      const cached = await this.readCache(userId, windowDays);
      if (cached) return cached;
    }

    const fitness = await this.collectFitnessSeries(userId, windowDays);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    let financeOutcome:
      | Awaited<ReturnType<FinanceInsightsClient['fetchSummary']>>
      | { kind: 'skipped' } = { kind: 'skipped' };
    if (user?.email && this.financeClient.isConfigured()) {
      financeOutcome = await this.financeClient.fetchSummary(user.email, windowDays);
    }

    const generatedAt = new Date().toISOString();
    const baseEnvelope: HolisticInsightsEnvelope = {
      version: 1,
      status: 'ok',
      generated_at: generatedAt,
      data_window: { window_days: windowDays, weeks_observed: 0 },
      insights: [],
      notes: [],
    };

    if (financeOutcome.kind === 'degraded' || financeOutcome.kind === 'not_found') {
      const reason =
        financeOutcome.kind === 'degraded' ? financeOutcome.reason : 'no_finance_account';
      this.logger.warn(`HolisticInsights finance unavailable user=${userId} reason=${reason}`);
      const env: HolisticInsightsEnvelope = {
        ...baseEnvelope,
        status: 'finance_unavailable',
        notes: [
          'We could not reach your finance pillar right now. Cross-pillar insights pause until both pillars report in. Try again in a few minutes.',
        ],
      };
      await this.writeCache(userId, windowDays, env, FINANCE_UNAVAILABLE_CACHE_TTL_MS);
      return env;
    }
    if (financeOutcome.kind === 'skipped') {
      const env: HolisticInsightsEnvelope = {
        ...baseEnvelope,
        status: 'finance_unavailable',
        notes: [
          'No finance pillar account is connected. Connect your finance account to unlock cross-pillar insights.',
        ],
      };
      await this.writeCache(userId, windowDays, env, FINANCE_UNAVAILABLE_CACHE_TTL_MS);
      return env;
    }

    const financeWeeks = financeOutcome.data.weeks;
    const env = this.computeEnvelope(fitness, financeWeeks, windowDays, generatedAt);
    await this.writeCache(userId, windowDays, env);
    return env;
  }

  // ─── Public surface for tests ────────────────────────────────────────
  computeEnvelope(
    fitness: {
      cardio: WeeklyBucket[];
      strength: WeeklyBucket[];
      weight: WeeklyBucket[];
      sleep: WeeklyBucket[];
    },
    financeWeeks: {
      weekKey: string;
      savings_rate_pct: number;
      spending_kusd: number;
      debt_to_income: number;
    }[],
    windowDays: number,
    generatedAt: string,
  ): HolisticInsightsEnvelope {
    const insights: HolisticInsight[] = [];

    // Build weekly buckets for each finance series.
    const savings: WeeklyBucket[] = financeWeeks.map((w) => ({
      weekKey: w.weekKey,
      value: w.savings_rate_pct,
      sampleCount: 1,
    }));
    const spending: WeeklyBucket[] = financeWeeks.map((w) => ({
      weekKey: w.weekKey,
      value: w.spending_kusd,
      sampleCount: 1,
    }));
    const dti: WeeklyBucket[] = financeWeeks.map((w) => ({
      weekKey: w.weekKey,
      value: w.debt_to_income,
      sampleCount: 1,
    }));

    const fitnessSeries: [string, WeeklyBucket[]][] = [
      ['fitness:cardio_minutes', fitness.cardio],
      ['fitness:strength_sessions', fitness.strength],
      ['fitness:weight_kg', fitness.weight],
      ['fitness:sleep_hours', fitness.sleep],
    ];
    const financeSeries: [string, WeeklyBucket[]][] = [
      ['finance:savings_rate_pct', savings],
      ['finance:spending_kusd', spending],
      ['finance:debt_to_income', dti],
    ];

    let weeksObserved = 0;
    for (const [fName, fSeries] of fitnessSeries) {
      for (const [gName, gSeries] of financeSeries) {
        const aligned = alignWeekly(fSeries, gSeries);
        weeksObserved = Math.max(weeksObserved, aligned.weeks.length);
        if (aligned.weeks.length < MIN_WEEKS_FOR_CORRELATION) continue;
        const r = pearson(aligned.xs, aligned.ys);
        if (!r) continue;
        if (Math.abs(r.r) < MIN_R_THRESHOLD) continue;
        insights.push(
          this.buildInsight(fName, gName, r.r, aligned.weeks),
        );
      }
    }

    if (insights.length === 0) {
      const need = Math.max(0, MIN_WEEKS_FOR_CORRELATION - weeksObserved);
      const note =
        need > 0
          ? `We need more data to find meaningful patterns. Keep logging — at least ${need} more week${need === 1 ? '' : 's'} of overlapping fitness and finance data should unlock insights.`
          : 'No strong correlations stand out yet. We only surface a pattern when |r| >= 0.30 across at least 4 aligned weeks. Patterns will appear here as they emerge.';
      return {
        version: 1,
        status: 'insufficient_data',
        generated_at: generatedAt,
        data_window: { window_days: windowDays, weeks_observed: weeksObserved },
        insights: [],
        notes: [note],
      };
    }

    return {
      version: 1,
      status: 'ok',
      generated_at: generatedAt,
      data_window: { window_days: windowDays, weeks_observed: weeksObserved },
      insights,
      notes: [],
    };
  }

  private buildInsight(
    fName: string,
    gName: string,
    r: number,
    weekKeys: string[],
  ): HolisticInsight {
    // Symmetric template that stays grammatical at either polarity:
    //   r > 0: "Your savings rate rose in weeks when your cardio minutes were higher (...)"
    //   r < 0: "Your spending fell in weeks when your cardio minutes were higher (...)"
    // The dependent clause "in weeks when your <fitness metric> were
    // higher" is the same in both forms; only the verb describing the
    // finance metric flips with the sign of r.
    const verb = r > 0 ? 'rose' : 'fell';
    const friendly = (s: string) =>
      ({
        'fitness:cardio_minutes': 'cardio minutes',
        'fitness:strength_sessions': 'strength sessions',
        'fitness:weight_kg': 'weight (kg)',
        'fitness:sleep_hours': 'sleep hours',
        'finance:savings_rate_pct': 'savings rate',
        'finance:spending_kusd': 'spending',
        'finance:debt_to_income': 'debt-to-income ratio',
      })[s] ?? s;
    const text =
      `Your ${friendly(gName)} ${verb} in weeks when your ${friendly(fName)} were higher ` +
      `(correlation ${r.toFixed(2)}, ${weekKeys.length} weeks).`;
    const id = crypto
      .createHash('sha256')
      .update(`${fName}|${gName}|${weekKeys[0]}|${weekKeys[weekKeys.length - 1]}`)
      .digest('hex')
      .slice(0, 16);
    return {
      id,
      text,
      correlation: r,
      weeks: weekKeys.length,
      weekKeyRange: { from: weekKeys[0], to: weekKeys[weekKeys.length - 1] },
      series: [fName, gName],
    };
  }

  // ─── Data collection ─────────────────────────────────────────────────

  private async collectFitnessSeries(
    userId: string,
    windowDays: number,
  ): Promise<{
    cardio: WeeklyBucket[];
    strength: WeeklyBucket[];
    weight: WeeklyBucket[];
    sleep: WeeklyBucket[];
  }> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    // WorkoutSession granularity is by `date` (date-only). We bucket
    // cardio by minutes-of-cardio per session (workout_type prefix
    // "cardio") and strength by session count for non-cardio entries.
    const workouts = await this.prisma.workoutSession.findMany({
      where: { user_id: userId, date: { gte: since } },
      select: { date: true, workout_type: true, duration_minutes: true, notes: true },
    });
    const cardioSamples: DailySample[] = [];
    const strengthSamples: DailySample[] = [];
    for (const w of workouts) {
      const type = (w.workout_type ?? '').toLowerCase();
      const notes = (w.notes ?? '').toLowerCase();
      const isCardio =
        /(cardio|run|jog|bike|cycle|row|swim|hiit)/.test(type) ||
        /(cardio|run|jog|bike|cycle|row|swim|hiit)/.test(notes);
      if (isCardio) {
        cardioSamples.push({ date: w.date, value: w.duration_minutes ?? 30 });
      } else {
        strengthSamples.push({ date: w.date, value: 1 });
      }
    }

    const weights = await this.prisma.weightLog.findMany({
      where: { user_id: userId, date: { gte: since } },
      select: { date: true, weight_lbs: true },
    });
    // We store lbs but report kg for the human-readable insight. 1 lb
    // = 0.453592 kg.
    const weightSamples: DailySample[] = weights.map((w) => ({
      date: w.date,
      value: w.weight_lbs * 0.453592,
    }));

    const checkIns = await this.prisma.checkIn.findMany({
      where: {
        user_id: userId,
        date: { gte: since },
        sleep_hours: { not: null },
      },
      select: { date: true, sleep_hours: true },
    });
    const sleepSamples: DailySample[] = checkIns
      .filter((c) => typeof c.sleep_hours === 'number')
      .map((c) => ({ date: c.date, value: c.sleep_hours as number }));

    // Aggregation mode by metric:
    //   cardio minutes — sum (a week with five 30-min sessions is 150,
    //     not the 30-min mean per session).
    //   strength sessions — sum (the unit is sessions-per-week; each
    //     sample contributes value 1, so the mean would always be 1
    //     and the series would have zero variance).
    //   weight kg — average (each daily sample is itself a measurement
    //     of weight on that day; the weekly value is a smoothing).
    //   sleep hours — average (per-night rate, weekly value is a mean).
    return {
      cardio: bucketWeekly(cardioSamples, 'sum'),
      strength: bucketWeekly(strengthSamples, 'sum'),
      weight: bucketWeekly(weightSamples, 'average'),
      sleep: bucketWeekly(sleepSamples, 'average'),
    };
  }

  // ─── Cache ───────────────────────────────────────────────────────────
  private async readCache(
    userId: string,
    windowDays: number,
  ): Promise<HolisticInsightsEnvelope | null> {
    const row = await this.prisma.holisticInsightCache.findUnique({
      where: {
        user_id_window_days: { user_id: userId, window_days: windowDays },
      },
    });
    if (!row) return null;
    if (row.expires_at.getTime() < Date.now()) return null;
    return row.payload as unknown as HolisticInsightsEnvelope;
  }

  private async writeCache(
    userId: string,
    windowDays: number,
    payload: HolisticInsightsEnvelope,
    ttlMs: number = CACHE_TTL_MS,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.holisticInsightCache.upsert({
      where: {
        user_id_window_days: { user_id: userId, window_days: windowDays },
      },
      create: {
        user_id: userId,
        window_days: windowDays,
        payload: payload as unknown as object,
        expires_at: expiresAt,
      },
      update: {
        payload: payload as unknown as object,
        expires_at: expiresAt,
        generated_at: new Date(),
      },
    });
  }
}
