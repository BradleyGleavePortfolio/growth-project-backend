import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  TimelineEvent,
  TimelineQuery,
  TimelineResponse,
  DecodedCursor,
  BodyWeightEvent,
  WinStreakEvent,
  WinBuildWeekDay7Event,
  FrictionMissedDayEvent,
} from './timeline.types';
import { KG_PER_LB } from '../macros/macro-calculator';

/**
 * TimelineService — Phase 7B.
 *
 * Composes the 3-lane chronological feed from existing Prisma tables.
 * NO new database tables are created. Every event is derived on the fly.
 *
 * PRIVACY CONTRACT:
 *   - Accepts a `userId` that is ALWAYS taken from the JWT (req.user.id).
 *     It is NEVER derived from a query parameter — callers cannot request
 *     another user's timeline.
 *   - PTM `risk_score` is NEVER included in any event. The score is
 *     advisory and model-internal (see ptm.types.ts doctrine).
 *
 *   - No coach message ever appears (#TIMELINE-COACH op 1): CoachMessage is
 *     never read here, for any coach, current or past. Messages stay in
 *     Messages.
 *
 * LANE SOURCES:
 *   Body  — WeightLog rows (one event per logged entry), in the client's unit,
 *           with the C8 Progress trend (one reading a day, latest wins,
 *           10% smoothing; mobile src/components/progress/weightTrend.ts).
 *   Win   — ClientSignal rows (checkin_streak threshold crossings,
 *           finance_milestone signals) + BuildWeekEnrollment day-7 completions.
 *   Friction — ClientSignal rows of type checkin_miss: a plain "No check-in".
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  // Streak thresholds that produce a Win-lane event.
  private static readonly STREAK_THRESHOLDS: ReadonlyArray<7 | 14 | 30 | 60 | 90> =
    [7, 14, 30, 60, 90];

  // Page size ceiling.
  private static readonly MAX_LIMIT = 50;
  private static readonly DEFAULT_LIMIT = 20;

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  async getTimeline(userId: string, query: TimelineQuery): Promise<TimelineResponse> {
    const limit = Math.min(
      Math.max(query.limit ?? TimelineService.DEFAULT_LIMIT, 1),
      TimelineService.MAX_LIMIT,
    );
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - (query.sinceDays ?? 180));

    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    // Cursor: return events strictly before cursor.at (reverse-chron paging).
    const beforeAt = cursor ? new Date(cursor.at) : new Date();

    const lanesRequested = new Set(query.lanes);

    // Collect events from each requested lane in parallel, then merge.
    const [bodyEvents, winEvents, frictionEvents] = await Promise.all([
      lanesRequested.has('body')
        ? this.buildBodyEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
      lanesRequested.has('win')
        ? this.buildWinEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
      lanesRequested.has('friction')
        ? this.buildFrictionEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
    ]);

    const all: TimelineEvent[] = [
      ...bodyEvents,
      ...winEvents,
      ...frictionEvents,
    ];

    // Sort reverse-chronological.
    all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // If we had a cursor, skip events matching the cursor's id.
    const afterCursor = cursor
      ? all.filter((e) => e.id !== cursor.id)
      : all;

    const page = afterCursor.slice(0, limit);
    const nextCursor =
      afterCursor.length > limit
        ? this.encodeCursor(afterCursor[limit].at, afterCursor[limit].id)
        : null;

    return {
      events: page,
      nextCursor,
      total: afterCursor.length,
    };
  }

  // ─── Body lane ─────────────────────────────────────────────────────────────

  private async buildBodyEvents(
    userId: string,
    since: Date,
    before: Date,
  ): Promise<TimelineEvent[]> {
    const [weights, profile] = await Promise.all([
      this.prisma.weightLog.findMany({
        where: {
          user_id: userId,
          date: { gte: since, lte: before },
        },
        orderBy: [{ date: 'desc' }, { logged_at: 'desc' }],
        take: 200,
      }),
      this.prisma.userProfile.findUnique({ where: { user_id: userId }, select: { weight_unit: true } }),
    ]);
    const kg = profile?.weight_unit === 'kg';
    const show = (lbs: number) => `${(Math.round((kg ? lbs * KG_PER_LB : lbs) * 10) / 10).toFixed(1)} ${kg ? 'kg' : 'lb'}`;

    // C8 trend: one reading a day (the latest wins), smoothed 10% a day; shown from the second day.
    const daily = new Map<number, number>();
    for (const w of [...weights].reverse()) daily.set(w.date.getTime(), w.weight_lbs);
    const trendOn = new Map<number, number>();
    let trend: number | null = null;
    for (const [day, lbs] of daily) {
      if (trend === null) trend = lbs;
      else trendOn.set(day, (trend += 0.1 * (lbs - trend)));
    }

    return weights.map((w): BodyWeightEvent => {
      const trendLbs = trendOn.get(w.date.getTime()) ?? null;
      return {
        id: this.makeId(w.date.toISOString(), w.id),
        lane: 'body',
        eventType: 'weight_logged',
        at: w.date.toISOString(),
        title: `Weighed in at ${show(w.weight_lbs)}`,
        body: [trendLbs === null ? null : `Trend ${show(trendLbs)}`, w.notes].filter(Boolean).join('. ') || undefined,
        metadata: { weightLbs: w.weight_lbs, trendLbs },
      };
    });
  }

  // ─── Win lane ──────────────────────────────────────────────────────────────

  private async buildWinEvents(
    userId: string,
    since: Date,
    before: Date,
  ): Promise<TimelineEvent[]> {
    const events: TimelineEvent[] = [];

    // 1. Checkin streak signals — only fire on threshold crossings.
    const streakSignals = await this.prisma.clientSignal.findMany({
      where: {
        user_id: userId,
        signal_type: 'checkin_streak',
        recorded_at: { gte: since, lte: before },
        // Only signals with a value that crossed a known threshold.
        value: { in: [...TimelineService.STREAK_THRESHOLDS] },
      },
      orderBy: { recorded_at: 'desc' },
      take: 100,
    });

    for (const sig of streakSignals) {
      const threshold = sig.value as 7 | 14 | 30 | 60 | 90;
      const winEvent: WinStreakEvent = {
        id: this.makeId(sig.recorded_at.toISOString(), sig.id),
        lane: 'win',
        eventType: 'checkin_streak_milestone',
        at: sig.recorded_at.toISOString(),
        title: `${threshold} days of check-ins in a row`,
        metadata: {
          streakDays: threshold,
          threshold,
        },
      };
      events.push(winEvent);
    }

    // 2. Finance milestone signals (from federation signals, if present).
    const finSignals = await this.prisma.clientSignal.findMany({
      where: {
        user_id: userId,
        signal_type: 'finance_milestone',
        recorded_at: { gte: since, lte: before },
      },
      orderBy: { recorded_at: 'desc' },
      take: 50,
    });

    for (const sig of finSignals) {
      const meta = sig.metadata as Record<string, unknown> | null;
      // Skip signals that are purely build-week artifacts (those appear below).
      if (meta?.source === 'build_week') continue;

      events.push({
        id: this.makeId(sig.recorded_at.toISOString(), sig.id),
        lane: 'win',
        eventType: 'finance_milestone',
        at: sig.recorded_at.toISOString(),
        title: 'Finance milestone reached',
        body: 'A financial goal was hit.',
        metadata: {
          milestoneRef: String(meta?.milestoneRef ?? sig.id),
        },
      });
    }

    // 3. Build Week Day 7 completions.
    const bwCompletions = await this.prisma.buildWeekEnrollment.findMany({
      where: {
        user_id: userId,
        status: 'completed',
        completed_at: { gte: since, lte: before },
      },
      orderBy: { completed_at: 'desc' },
      take: 10,
    });

    for (const bw of bwCompletions) {
      if (!bw.completed_at) continue;
      const bwEvent: WinBuildWeekDay7Event = {
        id: this.makeId(bw.completed_at.toISOString(), bw.id),
        lane: 'win',
        eventType: 'build_week_complete',
        at: bw.completed_at.toISOString(),
        title: 'Build Week complete, day 7 of 7',
        metadata: {
          enrollmentId: bw.id,
          dayCompleted: 7,
        },
      };
      events.push(bwEvent);
    }

    return events;
  }

  // ─── Friction lane ─────────────────────────────────────────────────────────

  private async buildFrictionEvents(
    userId: string,
    since: Date,
    before: Date,
  ): Promise<TimelineEvent[]> {
    const missSignals = await this.prisma.clientSignal.findMany({
      where: {
        user_id: userId,
        signal_type: 'checkin_miss',
        recorded_at: { gte: since, lte: before },
      },
      orderBy: { recorded_at: 'desc' },
      take: 100,
    });

    return missSignals.map((sig): FrictionMissedDayEvent => ({
      id: this.makeId(sig.recorded_at.toISOString(), sig.id),
      lane: 'friction',
      eventType: 'missed_checkin',
      at: sig.recorded_at.toISOString(),
      title: 'No check-in',
      metadata: {
        consecutiveMisses: Math.round(sig.value ?? 1),
      },
    }));
  }

  // ─── Cursor helpers ────────────────────────────────────────────────────────

  private makeId(at: string, sourceId: string): string {
    return Buffer.from(`${at}_${sourceId}`).toString('base64url');
  }

  private encodeCursor(at: string, id: string): string {
    const payload: DecodedCursor = { at, id };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(cursor: string): DecodedCursor | null {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as DecodedCursor;
      if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      this.logger.warn(`Invalid timeline cursor: ${cursor}`);
      return null;
    }
  }
}
