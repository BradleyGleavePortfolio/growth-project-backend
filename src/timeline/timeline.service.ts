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
  CoachTextNoteEvent,
  CoachVoiceNoteEvent,
  FrictionMissedDayEvent,
} from './timeline.types';

/**
 * TimelineService — Phase 7B.
 *
 * Composes the 4-lane chronological feed from existing Prisma tables.
 * NO new database tables are created. Every event is derived on the fly.
 *
 * PRIVACY CONTRACT:
 *   - Accepts a `userId` that is ALWAYS taken from the JWT (req.user.id).
 *     It is NEVER derived from a query parameter — callers cannot request
 *     another user's timeline.
 *   - PTM `risk_score` is NEVER included in any event. The score is
 *     advisory and model-internal (see ptm.types.ts doctrine).
 *
 * LANE SOURCES:
 *   Body  — WeightLog rows (one event per logged entry).
 *   Win   — ClientSignal rows (checkin_streak threshold crossings,
 *           finance_milestone signals) + BuildWeekEnrollment day-7 completions.
 *   Coach — CoachMessage rows directed to this client from their coach
 *           (text + voice, direction: coach_to_client).
 *   Friction — ClientSignal rows of type checkin_miss, aggregated into
 *             missed-day markers.
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
    const [bodyEvents, winEvents, coachEvents, frictionEvents] = await Promise.all([
      lanesRequested.has('body')
        ? this.buildBodyEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
      lanesRequested.has('win')
        ? this.buildWinEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
      lanesRequested.has('coach')
        ? this.buildCoachEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
      lanesRequested.has('friction')
        ? this.buildFrictionEvents(userId, sinceDate, beforeAt)
        : Promise.resolve([] as TimelineEvent[]),
    ]);

    const all: TimelineEvent[] = [
      ...bodyEvents,
      ...winEvents,
      ...coachEvents,
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
    const weights = await this.prisma.weightLog.findMany({
      where: {
        user_id: userId,
        date: { gte: since, lte: before },
      },
      orderBy: { date: 'desc' },
      take: 200,
    });

    let streakDays = 0;
    // Build a quick date-set for streak calculation.
    const dateSortedAsc = [...weights].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );

    const events: TimelineEvent[] = weights.map((w, _idx) => {
      // Compute delta vs previous log (the entry right before this in the ascending list).
      const ascIdx = dateSortedAsc.findIndex((x) => x.id === w.id);
      const prior = ascIdx > 0 ? dateSortedAsc[ascIdx - 1] : null;
      const deltaLbs = prior ? w.weight_lbs - prior.weight_lbs : null;

      // Simple consecutive-day streak count up to each entry.
      if (ascIdx === 0) {
        streakDays = 1;
      } else {
        const prevDate = dateSortedAsc[ascIdx - 1].date;
        const dayGap = Math.round(
          (w.date.getTime() - prevDate.getTime()) / 86400000,
        );
        streakDays = dayGap === 1 ? streakDays + 1 : 1;
      }

      const event: BodyWeightEvent = {
        id: this.makeId(w.date.toISOString(), w.id),
        lane: 'body',
        eventType: 'weight_logged',
        at: w.date.toISOString(),
        title: `Weight logged — ${w.weight_lbs.toFixed(1)} lbs`,
        body: deltaLbs != null
          ? `${deltaLbs > 0 ? '+' : ''}${deltaLbs.toFixed(1)} lbs from previous entry${w.notes ? `. ${w.notes}` : ''}`
          : w.notes ?? undefined,
        metadata: {
          weightLbs: w.weight_lbs,
          deltaLbs,
          streakDays,
        },
      };
      return event;
    });

    return events;
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
        title: `${threshold}-day check-in streak reached`,
        body: `${threshold} consecutive days of check-ins completed.`,
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
        title: 'Build Week complete — Day 7 of 7',
        body: 'All seven days of the guided coaching arc were finished.',
        metadata: {
          enrollmentId: bw.id,
          dayCompleted: 7,
        },
      };
      events.push(bwEvent);
    }

    return events;
  }

  // ─── Coach lane ────────────────────────────────────────────────────────────

  private async buildCoachEvents(
    userId: string,
    since: Date,
    before: Date,
  ): Promise<TimelineEvent[]> {
    // Fetch coach messages sent TO this client FROM their coach.
    // The CoachMessage model uses sender_id to record who sent the message.
    // Coach-to-client: sender_id is NOT the client (i.e. the coach sent it).
    const messages = await this.prisma.coachMessage.findMany({
      where: {
        client_id: userId,
        // Messages where the sender is not the client = coach-to-client direction.
        sender_id: { not: userId },
        created_at: { gte: since, lte: before },
      },
      include: {
        sender: { select: { name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });

    return messages.map((msg) => {
      const coachName = (msg.sender as { name?: string | null })?.name ?? 'Coach';
      const isVoice = Boolean(msg.voice_url);

      if (isVoice) {
        const event: CoachVoiceNoteEvent = {
          id: this.makeId(msg.created_at.toISOString(), msg.id),
          lane: 'coach',
          eventType: 'coach_voice_note',
          at: msg.created_at.toISOString(),
          title: `Voice note from ${coachName}`,
          body: msg.voice_duration_sec
            ? `${Math.round(msg.voice_duration_sec)}s audio message.`
            : 'Audio message.',
          metadata: {
            messageId: msg.id,
            coachName,
            durationSec: msg.voice_duration_sec ?? 0,
          },
        };
        return event;
      }

      const event: CoachTextNoteEvent = {
        id: this.makeId(msg.created_at.toISOString(), msg.id),
        lane: 'coach',
        eventType: 'coach_text_note',
        at: msg.created_at.toISOString(),
        title: `Note from ${coachName}`,
        body: msg.body?.slice(0, 280) ?? undefined,
        metadata: {
          messageId: msg.id,
          coachName,
        },
      };
      return event;
    });
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
      title: `${Math.round(sig.value ?? 1)} missed check-in${(sig.value ?? 1) > 1 ? 's' : ''}`,
      body: 'Check-in not submitted. Logged for honest record.',
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
