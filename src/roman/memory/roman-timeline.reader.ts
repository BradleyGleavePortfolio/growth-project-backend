/**
 * RomanTimelineReader — Roman v1.1 client timeline (slice R11-M2).
 *
 * One ordered, client-scoped view of the client's own events across existing
 * tables, so the background day summaries (R11-M3a) can walk back months in
 * 31-day steps. Internal only: no endpoint, no model call, no writes, and no
 * caller yet (R11-M3a wires it behind FEATURE_ROMAN_MEMORY). Not the
 * client-facing /me/timeline (src/timeline), which drops meals, workouts and
 * raw check-ins on purpose.
 *
 * TENANCY (T4)
 * - The subject is the `clientId` argument only. Every query carries
 *   `user_id = clientId` or `client_id = clientId` (HabitLog through its
 *   habit's `user_id`).
 * - Coach-owned rows (ClientWorkoutAssignment, CoachMessage, CoachingSession,
 *   WorkoutAdjustmentProposal, ActivityEvent) also require the client's
 *   CURRENT live coach, or that coach's open sub-coach delegation, through the
 *   same rule as the per-turn context (roman-coach-scope.ts). A former coach's
 *   rows drop out the moment the client is reassigned.
 * - A missing or soft-deleted client reads nothing.
 *
 * NEVER SELECTED: CoachingSession.coach_notes_md, video links and provider ids;
 * WorkoutAdjustmentProposal.dismiss_reason and roman_text; ActivityEvent
 * summary and payload; WearableConnection (credentials); bloodwork, purchases,
 * payments, email, phone, last name. Strings pass sanitizePromptInput and a
 * length clamp.
 *
 * ORDER AND PAGING
 * - Events are ascending by (at, kind, source.table, source.id); the cursor is
 *   the last emitted (at, key), so a page never repeats or skips an event.
 * - Each source reads at most its cap + 1 rows in time order. A source that
 *   returns more marks its kind truncated and the page stops before its first
 *   unread row; the next page continues from there.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import {
  ROMAN_WEARABLE_METRICS,
  addDays,
  dateOnly,
  localClock,
  localDateOf,
  localDayStart,
  summarizeWearables,
} from '../context/roman-client-context.service';
import { resolveRomanCoachScope } from '../context/roman-coach-scope';
import {
  ROMAN_TIMELINE_ACTIVITY_TYPES,
  ROMAN_TIMELINE_ADJUSTMENT_STATUSES,
  ROMAN_TIMELINE_KINDS,
  ROMAN_TIMELINE_LIMITS,
  RomanTimelineError,
  RomanTimelineEvent,
  RomanTimelineFactValue,
  RomanTimelineKind,
  RomanTimelinePage,
  RomanTimelineReadOptions,
  RomanTimelineTable,
} from './roman-timeline.types';

const DEFAULT_TZ = 'America/Los_Angeles';
const DAY_MS = 86_400_000;
const CAP = ROMAN_TIMELINE_LIMITS.rows_per_source;

const clamp = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  const t = sanitizePromptInput(s, max).trim();
  return t.length ? t : null;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;
const ymdOf = (d: Date): string => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ─── cursor ──────────────────────────────────────────────────────────────────

interface CursorPos {
  at: number;
  key: string;
}

const keyOf = (e: RomanTimelineEvent): string => `${e.kind}|${e.source.table}|${e.source.id}`;

function comparePos(a: CursorPos, b: CursorPos): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function encodeTimelineCursor(pos: CursorPos): string {
  return Buffer.from(JSON.stringify({ v: 1, at: pos.at, k: pos.key }), 'utf8').toString(
    'base64url',
  );
}

export function decodeTimelineCursor(cursor: string): CursorPos {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      raw.v === 1 &&
      typeof raw.at === 'number' &&
      Number.isFinite(raw.at) &&
      typeof raw.k === 'string'
    ) {
      return { at: raw.at, key: raw.k };
    }
  } catch {
    // fall through
  }
  throw new RomanTimelineError('bad_cursor');
}

// ─── per-source batches ──────────────────────────────────────────────────────

interface Batch {
  kinds: readonly RomanTimelineKind[];
  events: RomanTimelineEvent[];
  /** Set when the source hit its cap: events at or after this instant may be unread. */
  horizon: number | null;
}

interface ReadPlan {
  clientId: string;
  tz: string;
  dayOf: (d: Date) => string;
  /** Instant window [gte, lt) for instant-keyed sources. */
  instants: { gte: Date; lt: Date };
  /** Local-date window [gte, lte] for date-only sources (@db.Date). */
  dates: { gte: Date; lte: Date };
  firstDay: string;
  lastDay: string;
  coachId: string | null;
  coachSide: string[];
  /** B31: assigners whose plan rows are the client's (coach side, or the coachless client). */
  planSide: string[];
  preferences: { metric: string; preferred_provider: string }[];
  now: Date;
}

@Injectable()
export class RomanTimelineReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(clientId: string, opts: RomanTimelineReadOptions): Promise<RomanTimelinePage> {
    const fromMs = opts.from?.getTime?.() ?? Number.NaN;
    const toMs = opts.to?.getTime?.() ?? Number.NaN;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      throw new RomanTimelineError('bad_range');
    }
    if (toMs - fromMs > ROMAN_TIMELINE_LIMITS.max_range_days * DAY_MS) {
      throw new RomanTimelineError('range_too_large');
    }
    const to = new Date(toMs);
    const requested = opts.kinds && opts.kinds.length > 0 ? opts.kinds : ROMAN_TIMELINE_KINDS;
    for (const k of requested) {
      if (!(ROMAN_TIMELINE_KINDS as readonly string[]).includes(k))
        throw new RomanTimelineError('bad_kind');
    }
    const kinds = new Set<RomanTimelineKind>(requested);
    const limit = Math.min(
      ROMAN_TIMELINE_LIMITS.max_page,
      Math.max(1, Math.floor(opts.limit ?? ROMAN_TIMELINE_LIMITS.default_page)),
    );
    const cursor = opts.cursor ? decodeTimelineCursor(opts.cursor) : null;
    const now = opts.now ?? new Date();

    const [user, overlay] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: clientId },
        select: {
          role: true,
          deleted_at: true,
          coach: { select: { id: true, role: true, deleted_at: true } },
          notification_prefs: { select: { timezone: true } },
          wearable_metric_preferences: {
            where: { metric: { in: [...ROMAN_WEARABLE_METRICS] } },
            select: { metric: true, preferred_provider: true },
          },
        },
      }),
      this.prisma.subCoachAssignment.findFirst({
        where: { client_id: clientId, unassigned_at: null },
        orderBy: { assigned_at: 'desc' },
        select: { head_coach_id: true, sub_coach_id: true },
      }),
    ]);
    const tz = localClock(now, user?.notification_prefs?.timezone ?? DEFAULT_TZ).timezone;
    const empty: RomanTimelinePage = {
      client_id: clientId,
      timezone: tz,
      events: [],
      next_cursor: null,
      truncated: [],
    };
    if (!user || user.deleted_at) return empty;

    // The reader has no JWT: the DB role stands in for the caller role, so
    // only a student gets coach-owned rows (same rule as the per-turn context).
    const scope = resolveRomanCoachScope({
      userRole: user.role,
      callerRole: user.role,
      coach: user.coach,
      overlay,
      userId: clientId,
    });

    const startMs = cursor && cursor.at > fromMs ? cursor.at : fromMs;
    if (startMs >= toMs) return empty;
    const start = new Date(startMs);
    const dayOf = localDateOf(tz);
    const firstDay = dayOf(start);
    const lastDay = dayOf(new Date(toMs - 1));
    const plan: ReadPlan = {
      clientId,
      tz,
      dayOf,
      instants: { gte: start, lt: to },
      dates: { gte: dateOnly(firstDay), lte: dateOnly(lastDay) },
      firstDay,
      lastDay,
      coachId: scope.coachId,
      coachSide: scope.coachSide,
      planSide: scope.planSide,
      preferences: (user.wearable_metric_preferences ?? []).map((p) => ({
        metric: String(p.metric),
        preferred_provider: String(p.preferred_provider),
      })),
      now,
    };

    const want = (...ks: RomanTimelineKind[]) => ks.some((k) => kinds.has(k));
    const coached = scope.coachId !== null;
    const reads: Promise<Batch>[] = [];
    if (want('food_day')) reads.push(this.food(plan));
    if (plan.planSide.length > 0 && want('workout_done', 'workout_missed'))
      reads.push(this.assignments(plan));
    if (want('workout_done')) reads.push(this.loggedWorkouts(plan));
    if (want('weight')) reads.push(this.weights(plan));
    if (want('water')) reads.push(this.water(plan));
    if (want('habit')) reads.push(this.habits(plan));
    if (want('check_in')) reads.push(this.checkIns(plan));
    if (want('wearable_day')) reads.push(this.wearables(plan));
    if (coached && want('message')) reads.push(this.messages(plan));
    if (coached && want('booking')) reads.push(this.bookings(plan));
    if (coached && want('adjustment')) reads.push(this.adjustments(plan));
    if (coached && want('activity')) reads.push(this.activity(plan));
    const batches = await Promise.all(reads);

    let horizon = Number.POSITIVE_INFINITY;
    const truncated = new Set<RomanTimelineKind>();
    for (const b of batches) {
      if (b.horizon === null) continue;
      horizon = Math.min(horizon, b.horizon);
      for (const k of b.kinds) if (kinds.has(k)) truncated.add(k);
    }
    const ranked = batches
      .flatMap((b) => b.events)
      .filter((e) => kinds.has(e.kind))
      .map((e) => ({ e, pos: { at: Date.parse(e.at), key: keyOf(e) } }))
      .filter(({ pos }) => pos.at >= fromMs && pos.at < toMs && pos.at < horizon)
      .filter(({ pos }) => !cursor || comparePos(pos, cursor) > 0)
      .sort((a, b) => comparePos(a.pos, b.pos));
    const page = ranked.slice(0, limit);
    const more = ranked.length > limit || (horizon !== Number.POSITIVE_INFINITY && page.length > 0);
    const last = page[page.length - 1];
    return {
      client_id: clientId,
      timezone: tz,
      events: page.map((r) => r.e),
      next_cursor: more && last ? encodeTimelineCursor(last.pos) : null,
      truncated: ROMAN_TIMELINE_KINDS.filter((k) => truncated.has(k)),
    };
  }

  // ─── event helpers ─────────────────────────────────────────────────────────

  private event(
    p: ReadPlan,
    at: Date,
    kind: RomanTimelineKind,
    table: RomanTimelineTable,
    id: string,
    facts: Record<string, RomanTimelineFactValue>,
    text?: string | null,
  ): RomanTimelineEvent {
    return {
      at: at.toISOString(),
      local_date: p.dayOf(at),
      kind,
      source: { table, id },
      facts,
      ...(text ? { text } : {}),
    };
  }

  /** Date-only rows sit at the start of their local day. */
  private dayEvent(
    p: ReadPlan,
    date: Date,
    kind: RomanTimelineKind,
    table: RomanTimelineTable,
    id: string,
    facts: Record<string, RomanTimelineFactValue>,
    text?: string | null,
  ): RomanTimelineEvent {
    const ymd = ymdOf(date);
    return {
      at: localDayStart(ymd, p.tz).toISOString(),
      local_date: ymd,
      kind,
      source: { table, id },
      facts,
      ...(text ? { text } : {}),
    };
  }

  /** cap+1 rows read in time order: the (cap+1)-th row's instant bounds what is complete. */
  private horizonOf<T>(rows: T[], cap: number, instantOf: (r: T) => Date): number | null {
    return rows.length > cap ? instantOf(rows[cap]).getTime() : null;
  }

  private dayHorizon(p: ReadPlan, rows: { date: Date }[]): number | null {
    return this.horizonOf(rows, CAP, (r) => localDayStart(ymdOf(r.date), p.tz));
  }

  // ─── sources ───────────────────────────────────────────────────────────────

  /** food_day: LoggedFoodEntry totals per local day (numbers only, no food names). */
  private async food(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: p.clientId, date: p.dates },
      orderBy: { date: 'asc' },
      take: CAP + 1,
      select: {
        date: true,
        meal_type: true,
        quantity_multiplier: true,
        food_item: { select: { calories: true, protein_g: true, carbs_g: true, fat_g: true } },
      },
    });
    const byDay = new Map<
      string,
      { date: Date; kcal: number; p: number; c: number; f: number; n: number; meals: Set<string> }
    >();
    for (const r of rows) {
      const day = ymdOf(r.date);
      const t = byDay.get(day) ?? {
        date: r.date,
        kcal: 0,
        p: 0,
        c: 0,
        f: 0,
        n: 0,
        meals: new Set<string>(),
      };
      const q = r.quantity_multiplier;
      t.kcal += r.food_item.calories * q;
      t.p += r.food_item.protein_g * q;
      t.c += r.food_item.carbs_g * q;
      t.f += r.food_item.fat_g * q;
      t.n += 1;
      t.meals.add(String(r.meal_type));
      byDay.set(day, t);
    }
    const events = [...byDay.entries()].map(([day, t]) =>
      this.dayEvent(p, t.date, 'food_day', 'LoggedFoodEntry', day, {
        kcal: Math.round(t.kcal),
        protein_g: Math.round(t.p),
        carbs_g: Math.round(t.c),
        fat_g: Math.round(t.f),
        entries: t.n,
        meals: t.meals.size,
      }),
    );
    return { kinds: ['food_day'], events, horizon: this.dayHorizon(p, rows) };
  }

  /** workout_done / workout_missed: plans from the plan side only (current coach side, or the coachless client's own). */
  private async assignments(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        client_id: p.clientId,
        assigned_by_coach_id: { in: p.planSide },
        OR: [{ scheduled_for: p.instants }, { completed_at: p.instants }],
      },
      orderBy: { scheduled_for: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        scheduled_for: true,
        completed_at: true,
        post_rpe: true,
        post_notes: true,
        snapshot: { select: { plan_name: true } },
        workout_plan: { select: { name: true } },
      },
    });
    const today = p.dayOf(p.now);
    const events: RomanTimelineEvent[] = [];
    for (const r of rows) {
      const plan_name = clamp(r.snapshot?.plan_name ?? r.workout_plan?.name, 80) ?? 'Workout';
      if (r.completed_at) {
        events.push(
          this.event(
            p,
            r.completed_at,
            'workout_done',
            'ClientWorkoutAssignment',
            r.id,
            { plan_name, scheduled_date: p.dayOf(r.scheduled_for), post_rpe: r.post_rpe ?? null },
            clamp(r.post_notes, 300),
          ),
        );
      } else if (p.dayOf(r.scheduled_for) < today) {
        events.push(
          this.event(p, r.scheduled_for, 'workout_missed', 'ClientWorkoutAssignment', r.id, {
            plan_name,
          }),
        );
      }
    }
    return {
      kinds: ['workout_done', 'workout_missed'],
      events,
      horizon: this.horizonOf(rows, CAP, (r) => r.scheduled_for),
    };
  }

  /** workout_done: workouts the client logged themself (WorkoutSession). */
  private async loggedWorkouts(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.workoutSession.findMany({
      where: { user_id: p.clientId, date: p.dates },
      orderBy: { date: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        date: true,
        workout_name: true,
        workout_type: true,
        duration_minutes: true,
        intensity: true,
        notes: true,
        _count: { select: { exercises: true } },
      },
    });
    const events = rows.map((r) =>
      this.dayEvent(
        p,
        r.date,
        'workout_done',
        'WorkoutSession',
        r.id,
        {
          name: clamp(r.workout_name, 80) ?? 'Workout',
          type: clamp(r.workout_type, 40) ?? 'other',
          duration_minutes: r.duration_minutes ?? null,
          intensity: String(r.intensity),
          exercise_count: r._count.exercises,
        },
        clamp(r.notes, 300),
      ),
    );
    return { kinds: ['workout_done'], events, horizon: this.dayHorizon(p, rows) };
  }

  private async weights(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.weightLog.findMany({
      where: { user_id: p.clientId, date: p.dates },
      orderBy: { date: 'asc' },
      take: CAP + 1,
      select: { id: true, date: true, weight_lbs: true },
    });
    const events = rows.map((r) =>
      this.dayEvent(p, r.date, 'weight', 'WeightLog', r.id, { weight_lbs: round1(r.weight_lbs) }),
    );
    return { kinds: ['weight'], events, horizon: this.dayHorizon(p, rows) };
  }

  private async water(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.waterLog.findMany({
      where: { user_id: p.clientId, logged_at: p.instants },
      orderBy: { logged_at: 'asc' },
      take: CAP + 1,
      select: { id: true, logged_at: true, amount_ml: true },
    });
    const events = rows.map((r) =>
      this.event(p, r.logged_at, 'water', 'WaterLog', r.id, { amount_ml: r.amount_ml }),
    );
    return { kinds: ['water'], events, horizon: this.horizonOf(rows, CAP, (r) => r.logged_at) };
  }

  /** habit: HabitLog scoped through the habit's owner. */
  private async habits(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.habitLog.findMany({
      where: { habit: { user_id: p.clientId }, date: p.dates },
      orderBy: { date: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        date: true,
        value: true,
        completed: true,
        habit: { select: { name: true, category: true, unit: true, target_value: true } },
      },
    });
    const events = rows.map((r) =>
      this.dayEvent(p, r.date, 'habit', 'HabitLog', r.id, {
        habit: clamp(r.habit.name, 60) ?? 'Habit',
        category: clamp(r.habit.category, 40),
        value: num(r.value),
        target: num(r.habit.target_value),
        unit: clamp(r.habit.unit, 20),
        completed: r.completed,
      }),
    );
    return { kinds: ['habit'], events, horizon: this.dayHorizon(p, rows) };
  }

  private async checkIns(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.checkIn.findMany({
      where: { user_id: p.clientId, date: p.dates },
      orderBy: { date: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        date: true,
        type: true,
        mood: true,
        energy: true,
        soreness: true,
        sleep_hours: true,
        weight_kg: true,
        notes: true,
      },
    });
    const events = rows.map((r) =>
      this.dayEvent(
        p,
        r.date,
        'check_in',
        'CheckIn',
        r.id,
        {
          type: String(r.type),
          mood: r.mood ?? null,
          energy: r.energy ?? null,
          soreness: r.soreness ?? null,
          sleep_hours: num(r.sleep_hours),
          weight_kg: r.weight_kg == null ? null : round1(r.weight_kg),
        },
        clamp(r.notes, 300),
      ),
    );
    return { kinds: ['check_in'], events, horizon: this.dayHorizon(p, rows) };
  }

  /** wearable_day: daily aggregates through summarizeWearables (same provider policy as the turn). */
  private async wearables(p: ReadPlan): Promise<Batch> {
    const cap = ROMAN_TIMELINE_LIMITS.wearable_samples;
    const rows = await this.prisma.wearableSample.findMany({
      where: {
        user_id: p.clientId,
        metric: { in: [...ROMAN_WEARABLE_METRICS] },
        // One extra day before: sleep is keyed to the day it ENDS.
        start_at: {
          gte: localDayStart(addDays(p.firstDay, -1), p.tz),
          lt: localDayStart(addDays(p.lastDay, 1), p.tz),
        },
      },
      orderBy: { start_at: 'asc' },
      take: cap + 1,
      select: {
        metric: true,
        provider: true,
        value: true,
        start_at: true,
        end_at: true,
        recorded_at: true,
        source_tz: true,
      },
    });
    const samples = rows.map((r) => ({
      ...r,
      metric: String(r.metric),
      provider: String(r.provider),
    }));
    const events: RomanTimelineEvent[] = [];
    // summarizeWearables covers 7 local days ending at `today`; walk the window in 7-day steps.
    for (let end = p.lastDay; end >= p.firstDay; end = addDays(end, -7)) {
      const w = summarizeWearables([], samples, end, p.tz, {
        preferences: p.preferences,
        complete: true,
      });
      for (const d of w.days) {
        if (d.date < p.firstDay) continue;
        const { date: _date, ...facts } = d;
        events.push(
          this.dayEvent(p, dateOnly(d.date), 'wearable_day', 'WearableSample', d.date, facts),
        );
      }
    }
    return {
      kinds: ['wearable_day'],
      events,
      horizon: this.horizonOf(rows, cap, (r) => localDayStart(p.dayOf(r.start_at), p.tz)),
    };
  }

  /** message: the client <-> current coach thread, both directions, text only. */
  private async messages(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.coachMessage.findMany({
      where: {
        coach_id: p.coachId,
        client_id: p.clientId,
        sender_id: { in: [...p.coachSide, p.clientId] },
        body: { not: null },
        deleted_at: null,
        created_at: p.instants,
      },
      orderBy: { created_at: 'asc' },
      take: CAP + 1,
      select: { id: true, created_at: true, sender_id: true, body: true },
    });
    const events: RomanTimelineEvent[] = [];
    for (const r of rows) {
      const text = clamp(r.body, 300);
      if (!text) continue;
      const from = r.sender_id === p.clientId ? 'client' : 'coach';
      events.push(this.event(p, r.created_at, 'message', 'CoachMessage', r.id, { from }, text));
    }
    return { kinds: ['message'], events, horizon: this.horizonOf(rows, CAP, (r) => r.created_at) };
  }

  /** booking: sessions with the current coach side. Never coach_notes_md or links. */
  private async bookings(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.coachingSession.findMany({
      where: { client_id: p.clientId, coach_id: { in: p.coachSide }, start_at: p.instants },
      orderBy: { start_at: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        title: true,
        start_at: true,
        end_at: true,
        status: true,
        client_recap_md: true,
      },
    });
    const events = rows.map((r) =>
      this.event(
        p,
        r.start_at,
        'booking',
        'CoachingSession',
        r.id,
        {
          title: clamp(r.title, 80) ?? 'Coaching session',
          status: String(r.status),
          duration_minutes: Math.max(
            0,
            Math.round((r.end_at.getTime() - r.start_at.getTime()) / 60000),
          ),
        },
        clamp(r.client_recap_md, 600),
      ),
    );
    return { kinds: ['booking'], events, horizon: this.horizonOf(rows, CAP, (r) => r.start_at) };
  }

  /** adjustment: approved, edited or undone workout changes (#655). Never dismiss_reason. */
  private async adjustments(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.workoutAdjustmentProposal.findMany({
      where: {
        client_id: p.clientId,
        coach_id: { in: p.coachSide },
        status: { in: [...ROMAN_TIMELINE_ADJUSTMENT_STATUSES] },
        decided_at: p.instants,
      },
      orderBy: { decided_at: 'asc' },
      take: CAP + 1,
      select: {
        id: true,
        status: true,
        rule_key: true,
        severity: true,
        decided_at: true,
        applied_change: true,
      },
    });
    const events: RomanTimelineEvent[] = [];
    for (const r of rows) {
      if (!r.decided_at) continue;
      const c = (r.applied_change ?? null) as Record<string, unknown> | null;
      events.push(
        this.event(p, r.decided_at, 'adjustment', 'WorkoutAdjustmentProposal', r.id, {
          status: r.status,
          rule_key: r.rule_key,
          severity: r.severity,
          volume_pct: num(c?.volume_pct),
          sets_before: num(c?.sets_before),
          sets_after: num(c?.sets_after),
        }),
      );
    }
    return {
      kinds: ['adjustment'],
      events,
      horizon: this.horizonOf(rows, CAP, (r) => r.decided_at ?? new Date(0)),
    };
  }

  /** activity: allowlisted ActivityEvent types for this client and the current coach side (type only). */
  private async activity(p: ReadPlan): Promise<Batch> {
    const rows = await this.prisma.activityEvent.findMany({
      where: {
        client_id: p.clientId,
        coach_id: { in: p.coachSide },
        type: { in: [...ROMAN_TIMELINE_ACTIVITY_TYPES] },
        created_at: p.instants,
      },
      orderBy: { created_at: 'asc' },
      take: CAP + 1,
      select: { id: true, type: true, created_at: true },
    });
    const events = rows.map((r) =>
      this.event(p, r.created_at, 'activity', 'ActivityEvent', r.id, { type: r.type }),
    );
    return { kinds: ['activity'], events, horizon: this.horizonOf(rows, CAP, (r) => r.created_at) };
  }
}
