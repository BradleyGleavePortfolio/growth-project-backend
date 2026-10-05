/**
 * RomanClientContextService — builds the RomanClientContext for the signed-in
 * client on every turn (PLAN_roman_intelligence §2.3–§2.6, slice R3).
 *
 * TENANCY (the T4 core)
 * - The subject is ALWAYS the caller id passed in by the controller/service,
 *   which comes from the JWT. Nothing here reads a client id from a body.
 * - Every query carries `user_id = caller` or `client_id = caller`.
 * - Coach-owned rows (MacroTarget, ClientWorkoutAssignment, CoachGuideline,
 *   CoachMessage, DailyMealPlanAssignment) ALSO require the coach id to equal
 *   the client's CURRENT coach (`User.coach_id`), and that coach must not be
 *   soft-deleted. A non-student caller gets no coach-owned facts.
 * - No cross-request persistent cache of client data. The only memo is a 15 s
 *   in-process entry keyed by (user_id, local_date), invalidated by
 *   `invalidateForUser` and by the process-wide hook in
 *   roman-context-invalidation.ts.
 *
 * SCOPE (owner ruling 2026-09-30 16:31 #6)
 * - Roman sees ALL of the client's OWN data: profile, full consultation incl.
 *   safety-screen answers, macros, food logs (today's entries + 7-day
 *   totals), workouts and history, check-ins, wearable/health/sleep
 *   summaries, the recent client ↔ coach thread (both directions), and the
 *   community posts the client authored.
 * - Strings pass `sanitizePromptInput` plus a length clamp; lists use recency
 *   windows so the block stays inside the renderer's token cap.
 * - Excluded by construction: other users' data (every query is scoped to
 *   the caller), coach-private notes (CoachingSession is read ONLY for the
 *   client's own upcoming bookings with the current coach, with a narrow
 *   select of title, start/end time and status; notes, links and coach-private
 *   fields are never selected), email,
 *   phone, last name, raw ids, exact DOB, bloodwork, payments, wearable
 *   credentials/tokens (WearableConnection is read for provider + status only).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { renderClientContext } from './roman-client-context.renderer';
import {
  ROMAN_CONTEXT_VERSION,
  ROMAN_SAFETY_INTAKE_SOURCE,
  RomanClientContext,
  RomanClientContextBundle,
  RomanConsultationSummary,
  RomanCtxCheckIn,
  RomanCtxCoachMessage,
  RomanCtxCommunityPost,
  RomanCtxBooking,
  RomanCtxCompletion,
  RomanCtxDayTotals,
  RomanCtxExercise,
  RomanCtxFoodEntry,
  RomanCtxLoggedWorkout,
  RomanCtxPlan,
  RomanCtxQA,
  RomanCtxSession,
  RomanCtxTargets,
  RomanCtxWearableDay,
  RomanCtxWearables,
  RomanCtxWeightTrend,
  RomanSafetyIntakeSource,
} from './roman-client-context.types';
import { onRomanContextInvalidate } from './roman-context-invalidation';

export const ROMAN_CONTEXT_MEMO_TTL_MS = 15_000;
/** C-651-4: hard bound on memoised bundles held in process memory. */
export const ROMAN_CONTEXT_MEMO_MAX_ENTRIES = 500;
export const ROMAN_CONTEXT_MAX_QUERIES = 17;

/** Recency windows / caps (ruling #6 scope, kept inside the token budget). */
export const ROMAN_CTX_LIMITS = {
  today_food_entries: 16,
  logged_workouts: 8,
  check_ins: 7,
  coach_messages: 8,
  community_posts: 5,
  wearable_days: 7,
  /** B-665-2: read cap+1; more rows means the window is incomplete and is withheld. */
  wearable_samples: 3000,
  /** B-665-4: today and the next 14 local days, ascending (read cap+1). */
  plan_upcoming: 30,
  /** B-665-4: the last 14 local days plus today, newest first (read cap+1). */
  plan_history: 40,
  consultation_answers: 30,
  screen_answers: 12,
  bookings: 3,
} as const;

/** Booking states that are real upcoming sessions (never canceled / declined). */
export const ROMAN_BOOKING_STATUSES = ['requested', 'scheduled', 'pending_provider'] as const;

/** Wearable metrics summarised for Roman (daily aggregates only; never raw HR streams). */
export const ROMAN_WEARABLE_METRICS = [
  'STEPS',
  'ACTIVE_ENERGY_KCAL',
  'RESTING_HEART_RATE_BPM',
  'HRV_MS',
  'SLEEP_TOTAL_MIN',
  'SLEEP_DURATION_MIN',
  'SLEEP_EFFICIENCY_PCT',
  'RECOVERY_SCORE',
  'READINESS_SCORE',
] as const;
const DEFAULT_TZ = 'America/Los_Angeles';

/** Calorie floors per plan §4.4 (owner default: 1,500 for prefer-not-to-say). */
export const ROMAN_CALORIE_FLOOR_KCAL = {
  male: 1500,
  female: 1200,
  prefer_not_to_say: 1500,
} as const;

export const ROMAN_MACRO_METHOD_SUMMARY =
  'BMR (Mifflin-St Jeor) → TDEE via activity level → goal adjustment → calorie floor ' +
  '(1,200 kcal women / 1,500 kcal men or unspecified) → protein ≈ 1 g per lb of target weight, ' +
  'capped at 35% of calories → fat → carbs as the remainder. The coach may override any of it; ' +
  'when targets.source is coach_set, the coach numbers are authoritative.';

// ─── local time helpers ──────────────────────────────────────────────────────

export interface LocalClock {
  timezone: string;
  local_date: string; // YYYY-MM-DD
  local_time: string; // HH:mm
  local_weekday: string;
}

export function localClock(now: Date, timezone: string): LocalClock {
  let tz = timezone;
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    tz = DEFAULT_TZ;
  }
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  return { timezone: tz, local_date: date, local_time: time, local_weekday: weekday };
}

/** `@db.Date` columns compare as UTC-midnight instants in Prisma. */
export function dateOnly(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}
export function addDays(ymd: string, n: number): string {
  const d = dateOnly(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ymdOf = (d: Date): string => d.toISOString().slice(0, 10);

/** B-665-3: local YYYY-MM-DD of an instant, one formatter per call site. */
export function localDateOf(timezone: string): (d: Date) => string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: localClock(new Date(0), timezone).timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (d) => f.format(d);
}

/** B-665-3: the UTC instant at which local date `ymd` begins in `timezone` (DST-safe). */
export function localDayStart(ymd: string, timezone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const c = localClock(new Date(t), timezone);
    const [ly, lm, ld] = c.local_date.split('-').map(Number);
    const [hh, mm] = c.local_time.split(':').map(Number);
    const seen = Date.UTC(ly, lm - 1, ld, hh, mm);
    if (seen === target) break;
    t += target - seen;
  }
  return new Date(t);
}

/** Age as a whole number of years from a DOB, in the client's local date. */
export function ageYears(dob: Date | null | undefined, localDate: string): number | null {
  if (!dob) return null;
  const [y, m, d] = localDate.split('-').map(Number);
  let age = y - dob.getUTCFullYear();
  const beforeBirthday =
    m < dob.getUTCMonth() + 1 || (m === dob.getUTCMonth() + 1 && d < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

const clamp = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  const t = sanitizePromptInput(s, max).trim();
  return t.length ? t : null;
};
const clampList = (xs: string[] | null | undefined, maxItems: number, maxLen: number): string[] =>
  (xs ?? [])
    .map((x) => clamp(x, maxLen))
    .filter((x): x is string => x !== null)
    .slice(0, maxItems);
const firstName = (name: string | null | undefined): string => {
  const t = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return clamp(t, 40) ?? 'there';
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

const clampQA = (xs: RomanCtxQA[] | null | undefined, max: number): RomanCtxQA[] =>
  (xs ?? [])
    .map((qa) => ({
      question: clamp(qa.question, 80) ?? '',
      answer: clamp(qa.answer, 200) ?? '',
      ...(qa.flagged ? { flagged: true } : {}),
    }))
    .filter((qa) => qa.question.length > 0 && qa.answer.length > 0)
    .slice(0, max);

// ─── the service ─────────────────────────────────────────────────────────────

interface MemoEntry {
  local_date: string;
  expires_at: number;
  bundle: RomanClientContextBundle;
}

@Injectable()
export class RomanClientContextService {
  private readonly logger = new Logger(RomanClientContextService.name);
  private readonly memo = new Map<string, MemoEntry>();
  /**
   * Per-user invalidation generation. A build that was in flight when a write
   * path invalidated the user is stale: it still answers its own turn (its
   * reads are this turn's reads) but is never stored for the next one.
   */
  private readonly generation = new Map<string, number>();
  /**
   * C-651-4: builds in flight per user. A generation entry is only needed
   * while a build for that user is in flight; it is pruned when the last one
   * settles, so neither map grows with every client ever served.
   */
  private readonly inFlight = new Map<string, number>();
  private readonly intake: RomanSafetyIntakeSource;

  constructor(
    private readonly prisma: PrismaService,
    // B-R3-1: the consultation source is REQUIRED. RomanModule binds the real
    // client-scoped intake reader (RomanConsultationIntakeSource, #607 data);
    // there is no silent default that reports "no answers" for everyone.
    @Inject(ROMAN_SAFETY_INTAKE_SOURCE) intake: RomanSafetyIntakeSource,
  ) {
    this.intake = intake;
    onRomanContextInvalidate((userId) => this.invalidateForUser(userId));
  }

  /** Drop the memo for one user (write paths call this via the global hook). */
  invalidateForUser(userId: string): void {
    this.memo.delete(userId);
    // Only a build in flight can be stale; with none, nothing needs fencing.
    if (this.inFlight.has(userId)) {
      this.generation.set(userId, (this.generation.get(userId) ?? 0) + 1);
    } else {
      this.generation.delete(userId);
    }
  }

  /** C-651-4: entries held right now (memo, generation fences, builds in flight). */
  retainedEntryCounts(): { memo: number; generation: number; inFlight: number } {
    return { memo: this.memo.size, generation: this.generation.size, inFlight: this.inFlight.size };
  }

  /** C-651-4: drop every expired memo entry so private bundles do not linger. */
  private evictExpired(nowMs: number): void {
    for (const [userId, entry] of this.memo) {
      if (entry.expires_at <= nowMs) this.memo.delete(userId);
    }
    while (this.memo.size > ROMAN_CONTEXT_MEMO_MAX_ENTRIES) {
      const oldest = this.memo.keys().next();
      if (oldest.done) break;
      this.memo.delete(oldest.value);
    }
  }

  /**
   * Build (or reuse within 15 s) the bundle for the caller. `caller.role`
   * gates coach-owned facts; the coach surface never calls this.
   */
  async getBundle(
    caller: { id: string; role: string },
    now: Date = new Date(),
  ): Promise<RomanClientContextBundle> {
    this.evictExpired(now.getTime());
    const hit = this.memo.get(caller.id);
    if (hit && hit.expires_at > now.getTime()) {
      // A day boundary in the client's timezone invalidates "today".
      const clock = localClock(now, hit.bundle.context.identity.timezone);
      if (clock.local_date === hit.local_date) return hit.bundle;
    }
    if (hit) this.memo.delete(caller.id);
    this.inFlight.set(caller.id, (this.inFlight.get(caller.id) ?? 0) + 1);
    const startedAt = this.generation.get(caller.id) ?? 0;
    let stale = true;
    let bundle: RomanClientContextBundle;
    try {
      bundle = await this.buildFresh(caller, now);
    } finally {
      // Invalidated while building: do not memoise data that predates the write.
      stale = (this.generation.get(caller.id) ?? 0) !== startedAt;
      const left = (this.inFlight.get(caller.id) ?? 1) - 1;
      if (left > 0) {
        this.inFlight.set(caller.id, left);
      } else {
        this.inFlight.delete(caller.id);
        this.generation.delete(caller.id);
      }
    }
    if (stale) return bundle;
    this.memo.delete(caller.id);
    this.memo.set(caller.id, {
      local_date: bundle.context.identity.local_date,
      expires_at: now.getTime() + ROMAN_CONTEXT_MEMO_TTL_MS,
      bundle,
    });
    return bundle;
  }

  /** Bypasses the memo. */
  async buildFresh(
    caller: { id: string; role: string },
    now: Date = new Date(),
  ): Promise<RomanClientContextBundle> {
    const { context, query_count } = await this.build(caller, now);
    const rendered = renderClientContext(context);
    if (query_count > ROMAN_CONTEXT_MAX_QUERIES) {
      this.logger.warn(
        `RomanClientContext used ${query_count} queries (> ${ROMAN_CONTEXT_MAX_QUERIES})`,
      );
    }
    return {
      context: rendered.context,
      rendered: rendered.rendered,
      hash: rendered.hash,
      generated_at: now,
      estimated_tokens: rendered.estimated_tokens,
      query_count,
    };
  }

  /** The structured context (pre-render). Exposed for tests and the disclosure endpoint. */
  async build(
    caller: { id: string; role: string },
    now: Date = new Date(),
  ): Promise<{ context: RomanClientContext; query_count: number }> {
    const userId = caller.id;
    let queries = 0;

    // Q1 — the user, profile, prefs and (current) coach in one round trip, with
    // Q2 — the client's open sub-coach delegation (B-665-3), in parallel.
    queries += 2;
    const userRead = this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        role: true,
        coach_id: true,
        profile: true,
        notification_prefs: { select: { timezone: true } },
        coach: { select: { id: true, name: true, role: true, deleted_at: true } },
        // B-665-1: the client's per-metric provider choice (resolveBest policy).
        wearable_metric_preferences: {
          where: { metric: { in: [...ROMAN_WEARABLE_METRICS] } },
          select: { metric: true, preferred_provider: true },
        },
      },
    });
    const [user, overlay] = await Promise.all([
      userRead,
      this.prisma.subCoachAssignment.findFirst({
        where: { client_id: userId, unassigned_at: null },
        orderBy: { assigned_at: 'desc' },
        select: { head_coach_id: true, sub_coach_id: true },
      }),
    ]);

    const clock = localClock(now, user?.notification_prefs?.timezone ?? DEFAULT_TZ);
    const missing: string[] = [];
    if (!user) {
      return { context: this.emptyContext(clock, now, ['user']), query_count: queries };
    }

    // Coach-owned facts only for a student whose current coach is live.
    const coach =
      user.coach && user.coach.role === 'coach' && !user.coach.deleted_at ? user.coach : null;
    // Both the DB role and the JWT role must say "student" (defence in depth:
    // the service already gates on the caller role; a mismatch gets nothing).
    const coachId = user.role === 'student' && caller.role === 'student' && coach ? coach.id : null;
    // B-665-3: a delegated sub-coach assigns plans and meal plans and writes in
    // the head-coach thread as itself (MessagingService pins the thread to the
    // head coach). Only an open delegation from the current head coach counts.
    const subCoachId = coachId && overlay?.head_coach_id === coachId ? overlay.sub_coach_id : null;
    const coachSide: string[] = coachId ? (subCoachId ? [coachId, subCoachId] : [coachId]) : [];

    const today = clock.local_date;
    const d7 = addDays(today, -6);
    const d14 = addDays(today, -14);
    const d30 = addDays(today, -30);
    const plus14 = addDays(today, 14);
    // B-665-3: assignment times are instants; window bounds are local midnights.
    const tz = clock.timezone;
    const truncated: string[] = [];

    const [
      macroTarget,
      foodEntries,
      historyRows,
      upcomingRows,
      workoutSessions,
      weightLogs,
      checkIns,
      guideline,
      coachMessages,
      mealAssignment,
      consult,
      communityPosts,
      wearableConnections,
      wearableSamples,
      bookings,
    ] = await Promise.all([
      coachId
        ? (queries++,
          this.prisma.macroTarget.findFirst({
            where: {
              client_id: userId,
              coach_id: coachId,
              archived_at: null,
              effective_from: { lte: now },
            },
            orderBy: { effective_from: 'desc' },
          }))
        : null,
      (queries++,
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: userId, date: { gte: dateOnly(d7), lte: dateOnly(today) } },
        select: {
          date: true,
          logged_at: true,
          meal_type: true,
          quantity_multiplier: true,
          food_item: {
            select: { name: true, calories: true, protein_g: true, carbs_g: true, fat_g: true },
          },
        },
      })),
      // B-665-4: history (adherence, completions) and upcoming (today, next)
      // are read separately, each with a cap+1 completeness check.
      coachId
        ? (queries++,
          this.prisma.clientWorkoutAssignment.findMany({
            where: {
              client_id: userId,
              assigned_by_coach_id: { in: coachSide },
              scheduled_for: {
                gte: localDayStart(d14, tz),
                lt: localDayStart(addDays(today, 1), tz),
              },
            },
            orderBy: { scheduled_for: 'desc' },
            take: ROMAN_CTX_LIMITS.plan_history + 1,
            select: {
              scheduled_for: true,
              completed_at: true,
              post_rpe: true,
              post_notes: true,
              snapshot: { select: { plan_name: true } },
              workout_plan: { select: { name: true, program: { select: { name: true } } } },
            },
          }))
        : [],
      coachId
        ? (queries++,
          this.prisma.clientWorkoutAssignment.findMany({
            where: {
              client_id: userId,
              assigned_by_coach_id: { in: coachSide },
              scheduled_for: {
                gte: localDayStart(today, tz),
                lt: localDayStart(addDays(plus14, 1), tz),
              },
            },
            orderBy: { scheduled_for: 'asc' },
            take: ROMAN_CTX_LIMITS.plan_upcoming + 1,
            select: {
              scheduled_for: true,
              completed_at: true,
              post_rpe: true,
              post_notes: true,
              snapshot: { select: { plan_name: true, plan_type: true, exercises_json: true } },
              workout_plan: {
                select: {
                  name: true,
                  type: true,
                  program: { select: { name: true } },
                  exercises: {
                    where: { archived_at: null },
                    orderBy: { order: 'asc' },
                    take: 8,
                    select: {
                      exercise_external_id: true,
                      sets: true,
                      reps_or_duration_seconds: true,
                      notes: true,
                    },
                  },
                },
              },
            },
          }))
        : [],
      (queries++,
      this.prisma.workoutSession.findMany({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        take: ROMAN_CTX_LIMITS.logged_workouts,
        select: {
          date: true,
          workout_name: true,
          workout_type: true,
          duration_minutes: true,
          intensity: true,
          _count: { select: { exercises: true } },
        },
      })),
      (queries++,
      this.prisma.weightLog.findMany({
        where: { user_id: userId, date: { gte: dateOnly(d30) } },
        orderBy: { date: 'asc' },
        select: { date: true, weight_lbs: true },
      })),
      (queries++,
      this.prisma.checkIn.findMany({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        take: ROMAN_CTX_LIMITS.check_ins,
        select: {
          date: true,
          type: true,
          mood: true,
          energy: true,
          soreness: true,
          sleep_hours: true,
          notes: true,
        },
      })),
      coachId
        ? (queries++,
          this.prisma.coachGuideline.findFirst({
            where: { coach_id: coachId, client_id: userId },
            select: { content: true },
          }))
        : null,
      // Ruling #6: the recent client ↔ coach thread, BOTH directions. Still
      // scoped to (current coach, this client); senders are the coach side
      // (head coach and an open delegated sub-coach) or the client.
      coachId
        ? (queries++,
          this.prisma.coachMessage.findMany({
            where: {
              coach_id: coachId,
              client_id: userId,
              sender_id: { in: [...coachSide, userId] },
              body: { not: null },
            },
            orderBy: { created_at: 'desc' },
            take: ROMAN_CTX_LIMITS.coach_messages,
            select: { created_at: true, body: true, sender_id: true },
          }))
        : [],
      coachId
        ? (queries++,
          this.prisma.dailyMealPlanAssignment.findFirst({
            where: {
              client_id: userId,
              assigned_by_coach_id: { in: coachSide },
              starts_on: { lte: dateOnly(today) },
              OR: [{ ends_on: null }, { ends_on: { gte: dateOnly(today) } }],
              daily_meal_plan: { archived_at: null },
            },
            orderBy: { starts_on: 'desc' },
            select: {
              daily_meal_plan: {
                select: {
                  name: true,
                  slots: {
                    orderBy: { order: 'asc' },
                    take: 12,
                    select: {
                      slot_label: true,
                      meal_template: {
                        select: { name: true, calories_kcal: true, protein_g: true },
                      },
                    },
                  },
                },
              },
            },
          }))
        : null,
      this.intake.summarize(userId),
      // Ruling #6: the client's OWN community posts (author_id = caller).
      (queries++,
      this.prisma.communityPost.findMany({
        where: { author_id: userId, deleted_at: null, visibility: 'active' },
        orderBy: { created_at: 'desc' },
        take: ROMAN_CTX_LIMITS.community_posts,
        select: { created_at: true, scope: true, title: true, body: true },
      })),
      // Ruling #6: wearables / health / sleep. Connection rows for provider +
      // status + last sync ONLY (never the token columns); samples as daily
      // aggregates for a fixed metric set over the last 7 local days.
      (queries++,
      this.prisma.wearableConnection.findMany({
        where: { user_id: userId, disconnected_at: null },
        select: { provider: true, status: true, last_synced_at: true },
      })),
      (queries++,
      this.prisma.wearableSample.findMany({
        where: {
          user_id: userId,
          metric: { in: [...ROMAN_WEARABLE_METRICS] },
          // C-R3-1: one extra day so the earliest LOCAL day is complete in
          // any timezone; bucketing below is by the client's local date.
          start_at: { gte: new Date(`${addDays(today, -8)}T00:00:00.000Z`) },
        },
        orderBy: { start_at: 'desc' },
        take: ROMAN_CTX_LIMITS.wearable_samples + 1,
        select: {
          metric: true,
          provider: true,
          value: true,
          start_at: true,
          end_at: true,
          recorded_at: true,
          source_tz: true,
        },
      })),
      // Upcoming sessions with the CURRENT coach (bookings). Title, time and
      // status only: never coach_notes_md, recaps, video links or provider ids.
      coachId
        ? (queries++,
          this.prisma.coachingSession.findMany({
            where: {
              client_id: userId,
              coach_id: coachId,
              status: { in: [...ROMAN_BOOKING_STATUSES] },
              start_at: { gte: now },
            },
            orderBy: { start_at: 'asc' },
            take: ROMAN_CTX_LIMITS.bookings,
            select: { title: true, start_at: true, end_at: true, status: true },
          }))
        : [],
    ]);

    // B-665-4: cap+1 rows means the window is incomplete; say so, never guess.
    const history = historyRows.slice(0, ROMAN_CTX_LIMITS.plan_history);
    const historyComplete = historyRows.length <= ROMAN_CTX_LIMITS.plan_history;
    if (!historyComplete) truncated.push('plan.history');
    const upcoming = upcomingRows.slice(0, ROMAN_CTX_LIMITS.plan_upcoming);
    const upcomingComplete = upcomingRows.length <= ROMAN_CTX_LIMITS.plan_upcoming;
    if (!upcomingComplete) truncated.push('plan.upcoming');
    const dayOf = localDateOf(tz);

    // Exercise names for the next/today session (one catalog lookup).
    const sessionsNeedingNames = pickSessions(upcoming, today, dayOf);
    const externalIds = new Set<string>();
    for (const s of [sessionsNeedingNames.today, sessionsNeedingNames.next]) {
      for (const ex of s?.rawExercises ?? []) externalIds.add(ex.exercise_external_id);
    }
    let nameById = new Map<string, string>();
    if (externalIds.size > 0) {
      queries++;
      const ids = [...externalIds];
      const rows = await this.prisma.exerciseCatalogItem.findMany({
        where: { OR: [{ id: { in: ids } }, { slug: { in: ids } }] },
        select: { id: true, slug: true, name: true },
      });
      nameById = new Map<string, string>();
      for (const r of rows) {
        nameById.set(r.id, r.name);
        nameById.set(r.slug, r.name);
      }
    }

    // ── identity / profile ──
    const profile = user.profile;
    const sex = profile?.sex ?? null;
    if (!profile) missing.push('profile');

    // ── targets ──
    const targets: RomanCtxTargets = macroTarget
      ? {
          source: 'coach_set',
          calories: macroTarget.calories_kcal,
          protein_g: macroTarget.protein_g,
          carbs_g: macroTarget.carbs_g,
          fat_g: macroTarget.fats_g,
          fiber_g: macroTarget.fiber_g ?? null,
          water_ml:
            profile?.water_goal_oz != null ? Math.round(profile.water_goal_oz * 29.5735) : null,
          meals_per_day: profile?.meals_per_day ?? null,
          effective_from: ymdOf(macroTarget.effective_from),
          notes: clamp(macroTarget.notes, 200),
        }
      : profile?.macro_target_calories != null
        ? {
            source: 'onboarding_calculated',
            calories: Math.round(profile.macro_target_calories),
            protein_g:
              profile.macro_target_protein_g != null
                ? Math.round(profile.macro_target_protein_g)
                : null,
            carbs_g:
              profile.macro_target_carbs_g != null
                ? Math.round(profile.macro_target_carbs_g)
                : null,
            fat_g:
              profile.macro_target_fat_g != null ? Math.round(profile.macro_target_fat_g) : null,
            fiber_g: null,
            water_ml:
              profile.water_goal_oz != null ? Math.round(profile.water_goal_oz * 29.5735) : null,
            meals_per_day: profile.meals_per_day ?? null,
            effective_from: null,
            notes: null,
          }
        : {
            source: 'none',
            calories: null,
            protein_g: null,
            carbs_g: null,
            fat_g: null,
            fiber_g: null,
            water_ml: null,
            meals_per_day: profile?.meals_per_day ?? null,
            effective_from: null,
            notes: null,
          };
    if (targets.source === 'none') missing.push('targets');

    const floor = ROMAN_CALORIE_FLOOR_KCAL[sex ?? 'prefer_not_to_say'];

    // ── food totals: today + last 7 local days ──
    const byDay = new Map<string, RomanCtxDayTotals>();
    let lastLoggedAt: Date | null = null;
    const todayEntries: RomanCtxFoodEntry[] = [];
    for (const e of foodEntries) {
      const day = ymdOf(e.date);
      if (day === today) {
        todayEntries.push({
          meal: String(e.meal_type ?? 'meal').toLowerCase(),
          name: clamp(e.food_item.name, 60) ?? 'Food',
          kcal: Math.round(e.food_item.calories * e.quantity_multiplier),
          protein_g: Math.round(e.food_item.protein_g * e.quantity_multiplier),
          logged_at: e.logged_at.toISOString(),
        });
      }
      const t = byDay.get(day) ?? {
        date: day,
        kcal: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        meals_logged: 0,
      };
      const q = e.quantity_multiplier;
      t.kcal += e.food_item.calories * q;
      t.protein_g += e.food_item.protein_g * q;
      t.carbs_g += e.food_item.carbs_g * q;
      t.fat_g += e.food_item.fat_g * q;
      t.meals_logged += 1;
      byDay.set(day, t);
      if (day === today && (!lastLoggedAt || e.logged_at > lastLoggedAt))
        lastLoggedAt = e.logged_at;
    }
    for (const t of byDay.values()) {
      t.kcal = Math.round(t.kcal);
      t.protein_g = Math.round(t.protein_g);
      t.carbs_g = Math.round(t.carbs_g);
      t.fat_g = Math.round(t.fat_g);
    }
    const todayTotals = byDay.get(today) ?? {
      date: today,
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      meals_logged: 0,
    };
    if (todayTotals.meals_logged === 0) missing.push('today_logs');
    todayEntries.sort((a, b) => a.logged_at.localeCompare(b.logged_at));
    const entries = todayEntries.slice(-ROMAN_CTX_LIMITS.today_food_entries);
    const rem = (target: number | null, used: number) =>
      target == null ? null : Math.round(target - used);
    const pct = (target: number | null, used: number) =>
      target == null || target <= 0 ? null : Math.round((used / target) * 100);

    const days: RomanCtxDayTotals[] = [];
    for (let i = 6; i >= 1; i--) {
      const day = addDays(today, -i);
      const t = byDay.get(day);
      if (t) days.push(t);
    }
    const logged = days.length + (todayTotals.meals_logged > 0 ? 1 : 0);
    const allLogged = todayTotals.meals_logged > 0 ? [...days, todayTotals] : days;
    const avg = (f: (d: RomanCtxDayTotals) => number) =>
      allLogged.length
        ? Math.round(allLogged.reduce((a, d) => a + f(d), 0) / allLogged.length)
        : null;
    const within10 =
      targets.calories != null
        ? allLogged.filter((d) => Math.abs(d.kcal - targets.calories!) <= targets.calories! * 0.1)
            .length
        : null;

    // ── plan ──
    const plan = buildPlan(
      { history, historyComplete, upcoming, upcomingComplete },
      sessionsNeedingNames,
      nameById,
      today,
      dayOf,
    );
    if (!plan) missing.push('plan');

    // ── logged workouts ──
    const logged_workouts: RomanCtxLoggedWorkout[] = workoutSessions.map((w) => ({
      date: ymdOf(w.date),
      name: clamp(w.workout_name, 80) ?? 'Workout',
      type: clamp(w.workout_type, 40) ?? 'other',
      duration_minutes: w.duration_minutes ?? null,
      intensity: String(w.intensity),
      exercise_count: w._count.exercises,
    }));

    // ── weight trend ──
    const points = weightLogs
      .slice(-14)
      .map((w) => ({ date: ymdOf(w.date), weight_lbs: round1(w.weight_lbs) }));
    const last7 = weightLogs.filter((w) => ymdOf(w.date) >= addDays(today, -6));
    const latest = weightLogs.length ? weightLogs[weightLogs.length - 1] : null;
    const firstOnOrAfter = (ymd: string) => weightLogs.find((w) => ymdOf(w.date) >= ymd) ?? null;
    const w14 = firstOnOrAfter(d14);
    const w30 = firstOnOrAfter(d30);
    const weight_trend: RomanCtxWeightTrend = {
      unit: 'lbs',
      points,
      avg_7d: last7.length
        ? round1(last7.reduce((a, w) => a + w.weight_lbs, 0) / last7.length)
        : null,
      change_14d:
        latest && w14 && w14 !== latest ? round1(latest.weight_lbs - w14.weight_lbs) : null,
      change_30d:
        latest && w30 && w30 !== latest ? round1(latest.weight_lbs - w30.weight_lbs) : null,
    };
    if (weightLogs.length === 0) missing.push('weight');

    // ── check-ins ──
    const check_ins: RomanCtxCheckIn[] = checkIns.map((c) => ({
      date: ymdOf(c.date),
      type: String(c.type),
      mood: c.mood ?? null,
      energy: c.energy ?? null,
      soreness: c.soreness ?? null,
      sleep_hours: c.sleep_hours ?? null,
      notes: clamp(c.notes, 140),
    }));

    // ── coach ──
    const recent_messages: RomanCtxCoachMessage[] = [...coachMessages]
      .reverse() // oldest first for the model
      .filter((m) => m.sender_id === userId || coachSide.includes(m.sender_id ?? ''))
      .map((m) => ({
        date: ymdOf(m.created_at),
        from: (m.sender_id === userId ? 'client' : 'coach') as 'coach' | 'client',
        excerpt: clamp(m.body, 200),
      }))
      .filter((m): m is RomanCtxCoachMessage => m.excerpt !== null);
    const coachBlock = {
      has_coach: coachId !== null,
      coach_first_name: coachId ? firstName(coach?.name) : null,
      guidelines: clamp(guideline?.content, 1500),
      recent_messages,
    };
    if (!coachId) missing.push('coach');

    // ── community posts (own only) ──
    const community_posts: RomanCtxCommunityPost[] = communityPosts.map((p) => ({
      date: ymdOf(p.created_at),
      scope: String(p.scope),
      title: clamp(p.title, 80),
      excerpt: clamp(p.body, 200),
    }));

    // ── wearables ──
    const wearablesComplete = wearableSamples.length <= ROMAN_CTX_LIMITS.wearable_samples;
    if (!wearablesComplete) truncated.push('wearables.samples');
    const wearables = summarizeWearables(
      wearableConnections,
      wearableSamples,
      today,
      clock.timezone,
      { preferences: user.wearable_metric_preferences ?? [], complete: wearablesComplete },
    );

    // ── bookings (upcoming, current coach only) ──
    const upcoming_sessions: RomanCtxBooking[] = bookings.map((b): RomanCtxBooking => {
      const c = localClock(b.start_at, clock.timezone);
      return {
        date: c.local_date,
        weekday: c.local_weekday,
        local_time: c.local_time,
        duration_minutes: Math.max(
          0,
          Math.round((b.end_at.getTime() - b.start_at.getTime()) / 60000),
        ),
        title: clamp(b.title, 80) ?? 'Coaching session',
        status: b.status === 'requested' ? 'requested' : 'confirmed',
      };
    });
    if (!wearables.connected) missing.push('wearables');

    // ── consultation ──
    const safety_intake = {
      completed: consult.safety_intake.completed === true,
      clearance_recommended: consult.safety_intake.clearance_recommended === true,
      screen_answers: clampQA(
        consult.safety_intake.screen_answers,
        ROMAN_CTX_LIMITS.screen_answers,
      ),
    };
    const consultation = {
      completed: consult.consultation.completed === true,
      completed_at: consult.consultation.completed_at ?? null,
      answers: clampQA(consult.consultation.answers, ROMAN_CTX_LIMITS.consultation_answers),
    };

    // ── meal plan ──
    const meal_plan = mealAssignment
      ? {
          title: clamp(mealAssignment.daily_meal_plan.name, 80) ?? 'Meal plan',
          items: mealAssignment.daily_meal_plan.slots
            .map((s) => {
              const label = clamp(s.slot_label, 30) ?? 'Meal';
              const name = clamp(s.meal_template.name, 60) ?? '';
              return `${label}: ${name} (${s.meal_template.calories_kcal} kcal, ${s.meal_template.protein_g} g protein)`;
            })
            .slice(0, 12),
        }
      : null;

    if (!safety_intake.completed) missing.push('intake');
    if (!consultation.completed) missing.push('consultation');

    const context: RomanClientContext = {
      version: ROMAN_CONTEXT_VERSION,
      identity: {
        first_name: firstName(user.name),
        age_years: ageYears(profile?.date_of_birth ?? null, today),
        sex,
        timezone: clock.timezone,
        local_date: clock.local_date,
        local_time: clock.local_time,
        local_weekday: clock.local_weekday,
      },
      profile: {
        goal_type: profile?.goal_type ?? null,
        activity_level: profile?.activity_level ?? null,
        workout_experience: profile?.workout_experience ?? null,
        workout_days_per_week: profile?.workout_days_per_week ?? null,
        equipment_access: clampList(profile?.equipment_access, 12, 40),
        has_gym_membership: profile?.has_gym_membership ?? null,
        dietary_pattern: clamp(profile?.dietary_pattern, 40),
        dietary_restrictions: clampList(profile?.dietary_restrictions, 12, 40),
        food_preferences:
          profile?.food_preferences != null
            ? clamp(JSON.stringify(profile.food_preferences), 400)
            : null,
        preferred_snacks: clampList(profile?.preferred_snacks, 8, 40),
        injuries: clampList(profile?.injuries, 5, 200),
        preferred_training_time: clamp(profile?.preferred_training_time, 30),
        height_cm: profile?.height_cm ?? null,
        current_weight_lbs:
          profile?.current_weight_lbs != null ? round1(profile.current_weight_lbs) : null,
        target_weight_lbs:
          profile?.target_weight_lbs != null ? round1(profile.target_weight_lbs) : null,
        bio: clamp(profile?.bio, 240),
      },
      consultation,
      safety_intake,
      targets,
      macro_method: {
        summary: ROMAN_MACRO_METHOD_SUMMARY,
        floor_kcal: floor,
        floor_applied: targets.calories != null ? targets.calories <= floor : null,
      },
      today: {
        ...todayTotals,
        remaining_kcal: rem(targets.calories, todayTotals.kcal),
        remaining_protein_g: rem(targets.protein_g, todayTotals.protein_g),
        remaining_carbs_g: rem(targets.carbs_g, todayTotals.carbs_g),
        remaining_fat_g: rem(targets.fat_g, todayTotals.fat_g),
        pct_kcal: pct(targets.calories, todayTotals.kcal),
        pct_protein: pct(targets.protein_g, todayTotals.protein_g),
        last_logged_at: lastLoggedAt ? (lastLoggedAt as Date).toISOString() : null,
        entries,
      },
      last_7_days: {
        days_logged: logged,
        avg_kcal_on_logged_days: avg((d) => d.kcal),
        avg_protein_g_on_logged_days: avg((d) => d.protein_g),
        days_within_10pct_kcal: within10,
        days,
      },
      plan,
      logged_workouts,
      weight_trend,
      check_ins,
      wearables,
      coach: coachBlock,
      upcoming_sessions,
      community_posts,
      meal_plan,
      data_quality: { generated_at: now.toISOString(), missing, truncated },
    };
    return { context, query_count: queries };
  }

  private emptyContext(clock: LocalClock, now: Date, missing: string[]): RomanClientContext {
    return {
      version: ROMAN_CONTEXT_VERSION,
      identity: {
        first_name: 'there',
        age_years: null,
        sex: null,
        timezone: clock.timezone,
        local_date: clock.local_date,
        local_time: clock.local_time,
        local_weekday: clock.local_weekday,
      },
      profile: {
        goal_type: null,
        activity_level: null,
        workout_experience: null,
        workout_days_per_week: null,
        equipment_access: [],
        has_gym_membership: null,
        dietary_pattern: null,
        dietary_restrictions: [],
        food_preferences: null,
        preferred_snacks: [],
        injuries: [],
        preferred_training_time: null,
        height_cm: null,
        current_weight_lbs: null,
        target_weight_lbs: null,
        bio: null,
      },
      consultation: { completed: false, completed_at: null, answers: [] },
      safety_intake: { completed: false, clearance_recommended: false, screen_answers: [] },
      targets: {
        source: 'none',
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        water_ml: null,
        meals_per_day: null,
        effective_from: null,
        notes: null,
      },
      macro_method: { summary: ROMAN_MACRO_METHOD_SUMMARY, floor_kcal: null, floor_applied: null },
      today: {
        date: clock.local_date,
        kcal: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        meals_logged: 0,
        remaining_kcal: null,
        remaining_protein_g: null,
        remaining_carbs_g: null,
        remaining_fat_g: null,
        pct_kcal: null,
        pct_protein: null,
        last_logged_at: null,
        entries: [],
      },
      last_7_days: {
        days_logged: 0,
        avg_kcal_on_logged_days: null,
        avg_protein_g_on_logged_days: null,
        days_within_10pct_kcal: null,
        days: [],
      },
      plan: null,
      logged_workouts: [],
      weight_trend: { unit: 'lbs', points: [], avg_7d: null, change_14d: null, change_30d: null },
      check_ins: [],
      wearables: emptyWearables(),
      coach: { has_coach: false, coach_first_name: null, guidelines: null, recent_messages: [] },
      upcoming_sessions: [],
      community_posts: [],
      meal_plan: null,
      data_quality: {
        generated_at: now.toISOString(),
        missing: [...missing, 'profile', 'targets', 'plan', 'today_logs', 'intake'],
        truncated: [],
      },
    };
  }
}

// ─── plan helpers ────────────────────────────────────────────────────────────

type RawExercise = {
  exercise_external_id: string;
  sets: number;
  reps_or_duration_seconds: number;
  notes: string | null;
};
type AssignmentRow = {
  scheduled_for: Date;
  completed_at: Date | null;
  post_rpe: number | null;
  post_notes: string | null;
  snapshot: { plan_name: string; plan_type: string; exercises_json: Prisma.JsonValue } | null;
  workout_plan: {
    name: string;
    type: string;
    program: { name: string } | null;
    exercises: RawExercise[];
  };
};
type PickedSession = { row: AssignmentRow; rawExercises: RawExercise[] };
/** B-665-4: the light history projection (no exercises). */
type HistoryRow = {
  scheduled_for: Date;
  completed_at: Date | null;
  post_rpe: number | null;
  post_notes: string | null;
  snapshot: { plan_name: string } | null;
  workout_plan: { name: string; program: { name: string } | null };
};
type DayOf = (d: Date) => string;

function rawExercisesOf(a: AssignmentRow): RawExercise[] {
  const snap = a.snapshot?.exercises_json;
  if (Array.isArray(snap)) {
    const out: RawExercise[] = [];
    for (const e of snap) {
      if (typeof e !== 'object' || e === null) continue;
      const r = e as Record<string, unknown>;
      if (typeof r.exercise_external_id !== 'string') continue;
      out.push({
        exercise_external_id: r.exercise_external_id,
        sets: typeof r.sets === 'number' ? r.sets : 0,
        reps_or_duration_seconds:
          typeof r.reps_or_duration_seconds === 'number' ? r.reps_or_duration_seconds : 0,
        notes: typeof r.notes === 'string' ? r.notes : null,
      });
    }
    return out.slice(0, 8);
  }
  return a.workout_plan.exercises.slice(0, 8);
}

/**
 * `upcoming` is ascending from local today: the first open row of each kind
 * is exact even when the read hit its cap (every earlier row was read).
 */
function pickSessions(
  upcoming: AssignmentRow[],
  today: string,
  dayOf: DayOf,
): { today: PickedSession | null; next: PickedSession | null } {
  const todayRow =
    upcoming.find((a) => dayOf(a.scheduled_for) === today && !a.completed_at) ?? null;
  const nextRow = upcoming.find((a) => dayOf(a.scheduled_for) > today && !a.completed_at) ?? null;
  return {
    today: todayRow ? { row: todayRow, rawExercises: rawExercisesOf(todayRow) } : null,
    next: nextRow ? { row: nextRow, rawExercises: rawExercisesOf(nextRow) } : null,
  };
}

function toSession(p: PickedSession, nameById: Map<string, string>, dayOf: DayOf): RomanCtxSession {
  const exercises: RomanCtxExercise[] = p.rawExercises.map((e) => ({
    name: clamp(nameById.get(e.exercise_external_id) ?? 'Exercise', 60) ?? 'Exercise',
    sets: e.sets,
    reps_or_duration_seconds: e.reps_or_duration_seconds,
    cue: clamp(e.notes, 80),
  }));
  return {
    date: dayOf(p.row.scheduled_for),
    name: clamp(p.row.snapshot?.plan_name ?? p.row.workout_plan.name, 80) ?? 'Workout',
    type: clamp(p.row.snapshot?.plan_type ?? p.row.workout_plan.type, 30),
    exercises,
  };
}

function buildPlan(
  rows: {
    history: HistoryRow[];
    historyComplete: boolean;
    upcoming: AssignmentRow[];
    upcomingComplete: boolean;
  },
  picked: { today: PickedSession | null; next: PickedSession | null },
  nameById: Map<string, string>,
  today: string,
  dayOf: DayOf,
): RomanCtxPlan | null {
  const { history, upcoming } = rows;
  if (history.length === 0 && upcoming.length === 0) return null;
  // history is newest first; completions are the 10 most recent, oldest first.
  const completions: RomanCtxCompletion[] = history
    .filter((a) => a.completed_at)
    .slice(0, 10)
    .reverse()
    .map((a) => ({
      date: dayOf(a.scheduled_for),
      name: clamp(a.snapshot?.plan_name ?? a.workout_plan.name, 80) ?? 'Workout',
      post_rpe: a.post_rpe ?? null,
      has_notes: !!a.post_notes,
      notes: clamp(a.post_notes, 140),
    }));
  const anchor =
    picked.today?.row ?? picked.next?.row ?? upcoming[upcoming.length - 1] ?? history[0];
  const upcomingDays = new Set(
    upcoming.map((a) => dayOf(a.scheduled_for)).filter((d) => d > today),
  );
  return {
    program_name: clamp(anchor.workout_plan.program?.name ?? null, 80),
    // Unknown (null) when the upcoming read hit its cap.
    days_per_week:
      rows.upcomingComplete && upcomingDays.size
        ? Math.min(7, Math.ceil(upcomingDays.size / 2))
        : null,
    assigned_at: null,
    today_session: picked.today ? toSession(picked.today, nameById, dayOf) : null,
    next_session: picked.next ? toSession(picked.next, nameById, dayOf) : null,
    recent_completions: completions,
    adherence_14d:
      rows.historyComplete && history.length
        ? { completed: history.filter((a) => a.completed_at).length, scheduled: history.length }
        : null,
  };
}

// ─── wearables ───────────────────────────────────────────────────────────────

type WearableConnRow = { provider: string; status: string; last_synced_at: Date | null };
type WearableSampleRow = {
  metric: string;
  /** Absent only in legacy test rows; treated as one unnamed provider. */
  provider?: string;
  value: number;
  start_at: Date;
  end_at: Date;
  recorded_at?: Date;
  source_tz: string | null;
};
type WearablePrefRow = { metric: string; preferred_provider: string };

/**
 * B-665-1: one provider per metric, the same policy as
 * WearablesIngestionService.resolveBest: the client's preferred provider for
 * that metric (even when it has no rows in the window), otherwise the provider
 * that most recently recorded a sample in the window (ties: lowest name).
 * Competing providers are never summed.
 */
export function selectWearableProviders(
  samples: WearableSampleRow[],
  preferences: WearablePrefRow[],
): Map<string, string> {
  const chosen = new Map<string, string>();
  const newest = new Map<string, { provider: string; at: number }>();
  for (const smp of samples) {
    const metric = String(smp.metric);
    const provider = String(smp.provider);
    const at = smp.recorded_at ? new Date(smp.recorded_at).getTime() : Number.NEGATIVE_INFINITY;
    const cur = newest.get(metric);
    if (!cur || at > cur.at || (at === cur.at && provider < cur.provider)) {
      newest.set(metric, { provider, at });
    }
  }
  for (const [metric, n] of newest) chosen.set(metric, n.provider);
  for (const p of preferences) chosen.set(String(p.metric), String(p.preferred_provider));
  return chosen;
}

const EMPTY_WEARABLE_DAY: Omit<RomanCtxWearableDay, 'date'> = {
  steps: null,
  active_kcal: null,
  resting_hr_bpm: null,
  hrv_ms: null,
  sleep_hours: null,
  sleep_efficiency_pct: null,
  recovery_score: null,
  readiness_score: null,
};

export function emptyWearables(): RomanCtxWearables {
  return {
    connected: false,
    providers: [],
    last_synced_at: null,
    avg_7d: { ...EMPTY_WEARABLE_DAY },
    last_night_sleep_hours: null,
    latest_sleep: null,
    days: [],
  };
}

/** Sum metrics accumulate across a day; the rest are averaged. */
const SUM_METRICS = new Set([
  'STEPS',
  'ACTIVE_ENERGY_KCAL',
  'SLEEP_TOTAL_MIN',
  'SLEEP_DURATION_MIN',
]);

/**
 * Daily aggregates for the last 7 local days, oldest first. Sleep is keyed to
 * the day the sample ENDS (the night "before" that morning). Values are
 * rounded; no raw sample, timestamp, device id or token leaves this function.
 */
export function summarizeWearables(
  connections: WearableConnRow[],
  samples: WearableSampleRow[],
  today: string,
  timezone: string = DEFAULT_TZ,
  opts: { preferences?: WearablePrefRow[]; complete?: boolean } = {},
): RomanCtxWearables {
  const active = connections.filter((c) => c.status === 'connected');
  const providers = [...new Set(active.map((c) => String(c.provider).toLowerCase()))].sort();
  // Duck-typed: rows may cross a vm realm in tests, where instanceof Date fails.
  const lastSync = active
    .map((c) => c.last_synced_at)
    .filter((d): d is Date => d != null && typeof (d as Date).getTime === 'function')
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (active.length === 0 && samples.length === 0) return emptyWearables();
  // B-665-2: an incomplete read publishes no totals or averages at all; the
  // caller records `wearables.samples` in data_quality.truncated.
  if (opts.complete === false) {
    return {
      ...emptyWearables(),
      connected: active.length > 0,
      providers,
      last_synced_at: lastSync ? lastSync.toISOString() : null,
    };
  }
  const chosen = selectWearableProviders(samples, opts.preferences ?? []);
  const dayOf = localDateOf(timezone);

  type Acc = Record<string, { sum: number; n: number }>;
  const perDay = new Map<string, Acc>();
  const since = addDays(today, -(ROMAN_CTX_LIMITS.wearable_days - 1));
  for (const smp of samples) {
    const metric = String(smp.metric);
    if (chosen.get(metric) !== String(smp.provider)) continue;
    const isSleep = metric.startsWith('SLEEP_');
    // C-R3-1: bucket by the client's LOCAL date (their authoritative
    // timezone), never the UTC date.
    const day = dayOf(isSleep ? smp.end_at : smp.start_at);
    if (day < since || day > today) continue;
    if (!Number.isFinite(smp.value)) continue;
    const acc = perDay.get(day) ?? {};
    const cell = acc[metric] ?? { sum: 0, n: 0 };
    cell.sum += smp.value;
    cell.n += 1;
    acc[metric] = cell;
    perDay.set(day, acc);
  }
  const value = (acc: Acc, metric: string): number | null => {
    const cell = acc[metric];
    if (!cell || cell.n === 0) return null;
    return SUM_METRICS.has(metric) ? cell.sum : cell.sum / cell.n;
  };
  const sleepMin = (acc: Acc): number | null =>
    value(acc, 'SLEEP_TOTAL_MIN') ?? value(acc, 'SLEEP_DURATION_MIN');

  const days: RomanCtxWearableDay[] = [];
  for (let i = ROMAN_CTX_LIMITS.wearable_days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const acc = perDay.get(day);
    if (!acc) continue;
    const sleep = sleepMin(acc);
    const rhr = value(acc, 'RESTING_HEART_RATE_BPM');
    const hrv = value(acc, 'HRV_MS');
    const eff = value(acc, 'SLEEP_EFFICIENCY_PCT');
    const rec = value(acc, 'RECOVERY_SCORE');
    const rdy = value(acc, 'READINESS_SCORE');
    const steps = value(acc, 'STEPS');
    const kcal = value(acc, 'ACTIVE_ENERGY_KCAL');
    days.push({
      date: day,
      steps: steps === null ? null : Math.round(steps),
      active_kcal: kcal === null ? null : Math.round(kcal),
      resting_hr_bpm: rhr === null ? null : Math.round(rhr),
      hrv_ms: hrv === null ? null : Math.round(hrv),
      sleep_hours: sleep === null ? null : round1(sleep / 60),
      sleep_efficiency_pct: eff === null ? null : Math.round(eff),
      recovery_score: rec === null ? null : Math.round(rec),
      readiness_score: rdy === null ? null : Math.round(rdy),
    });
  }
  const avg = (pick: (d: RomanCtxWearableDay) => number | null, digits: 0 | 1 = 0) => {
    const xs = days.map(pick).filter((x): x is number => x !== null);
    if (xs.length === 0) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return digits === 1 ? round1(m) : Math.round(m);
  };
  // C-R3-1: "last night" is only the sleep that ENDED on today's local
  // date. An older sample is reported with its own date, never as last night.
  const lastNight = days.find((d) => d.date === today && d.sleep_hours !== null);
  const latestSleep = [...days].reverse().find((d) => d.sleep_hours !== null);
  return {
    connected: active.length > 0,
    providers,
    last_synced_at: lastSync ? lastSync.toISOString() : null,
    avg_7d: {
      steps: avg((d) => d.steps),
      active_kcal: avg((d) => d.active_kcal),
      resting_hr_bpm: avg((d) => d.resting_hr_bpm),
      hrv_ms: avg((d) => d.hrv_ms),
      sleep_hours: avg((d) => d.sleep_hours, 1),
      sleep_efficiency_pct: avg((d) => d.sleep_efficiency_pct),
      recovery_score: avg((d) => d.recovery_score),
      readiness_score: avg((d) => d.readiness_score),
    },
    last_night_sleep_hours: lastNight?.sleep_hours ?? null,
    latest_sleep:
      latestSleep && latestSleep.sleep_hours !== null
        ? { date: latestSleep.date, hours: latestSleep.sleep_hours }
        : null,
    days,
  };
}
