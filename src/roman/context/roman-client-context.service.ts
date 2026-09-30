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
 * MINIMISATION
 * - Strings pass `sanitizePromptInput` plus a length clamp.
 * - Screening: only { completed, clearance_recommended } — never answers or
 *   categories (operator ruling 2026-09-30).
 * - Excluded by construction: email, phone, last name, raw ids, exact DOB,
 *   coach-private notes, other users' data, bloodwork, wearables, payments,
 *   the raw food-item list.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { renderClientContext } from './roman-client-context.renderer';
import {
  ROMAN_CONTEXT_VERSION,
  ROMAN_SAFETY_INTAKE_SOURCE,
  RomanClientContext,
  RomanClientContextBundle,
  RomanCtxCheckIn,
  RomanCtxCompletion,
  RomanCtxDayTotals,
  RomanCtxExercise,
  RomanCtxLoggedWorkout,
  RomanCtxPlan,
  RomanCtxSafetyIntake,
  RomanCtxSession,
  RomanCtxTargets,
  RomanCtxWeightTrend,
  RomanSafetyIntakeSource,
} from './roman-client-context.types';
import { onRomanContextInvalidate } from './roman-context-invalidation';

export const ROMAN_CONTEXT_MEMO_TTL_MS = 15_000;
export const ROMAN_CONTEXT_MAX_QUERIES = 12;
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

class DefaultSafetyIntakeSource implements RomanSafetyIntakeSource {
  async summarize(): Promise<RomanCtxSafetyIntake> {
    return { completed: false, clearance_recommended: false };
  }
}

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
  private readonly intake: RomanSafetyIntakeSource;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ROMAN_SAFETY_INTAKE_SOURCE) intake?: RomanSafetyIntakeSource,
  ) {
    this.intake = intake ?? new DefaultSafetyIntakeSource();
    onRomanContextInvalidate((userId) => this.invalidateForUser(userId));
  }

  /** Drop the memo for one user (write paths call this via the global hook). */
  invalidateForUser(userId: string): void {
    this.memo.delete(userId);
  }

  /**
   * Build (or reuse within 15 s) the bundle for the caller. `caller.role`
   * gates coach-owned facts; the coach surface never calls this.
   */
  async getBundle(
    caller: { id: string; role: string },
    now: Date = new Date(),
  ): Promise<RomanClientContextBundle> {
    const hit = this.memo.get(caller.id);
    if (hit && hit.expires_at > now.getTime()) {
      // A day boundary in the client's timezone invalidates "today".
      const clock = localClock(now, hit.bundle.context.identity.timezone);
      if (clock.local_date === hit.local_date) return hit.bundle;
    }
    const bundle = await this.buildFresh(caller, now);
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

    // Q1 — the user, profile, prefs and (current) coach in one round trip.
    queries++;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        role: true,
        coach_id: true,
        profile: true,
        notification_prefs: { select: { timezone: true } },
        coach: { select: { id: true, name: true, role: true, deleted_at: true } },
      },
    });

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

    const today = clock.local_date;
    const d7 = addDays(today, -6);
    const d14 = addDays(today, -14);
    const d30 = addDays(today, -30);
    const plus14 = addDays(today, 14);

    const [
      macroTarget,
      foodEntries,
      assignments,
      workoutSessions,
      weightLogs,
      checkIns,
      guideline,
      coachMessages,
      mealAssignment,
      intake,
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
          quantity_multiplier: true,
          food_item: { select: { calories: true, protein_g: true, carbs_g: true, fat_g: true } },
        },
      })),
      coachId
        ? (queries++,
          this.prisma.clientWorkoutAssignment.findMany({
            where: {
              client_id: userId,
              assigned_by_coach_id: coachId,
              scheduled_for: { gte: dateOnly(d14), lt: dateOnly(addDays(plus14, 1)) },
            },
            orderBy: { scheduled_for: 'asc' },
            take: 40,
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
        take: 5,
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
        take: 5,
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
      coachId
        ? (queries++,
          this.prisma.coachMessage.findMany({
            where: {
              coach_id: coachId,
              client_id: userId,
              sender_id: coachId,
              body: { not: null },
            },
            orderBy: { created_at: 'desc' },
            take: 3,
            select: { created_at: true, body: true },
          }))
        : [],
      coachId
        ? (queries++,
          this.prisma.dailyMealPlanAssignment.findFirst({
            where: {
              client_id: userId,
              assigned_by_coach_id: coachId,
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
    ]);

    // Exercise names for the next/today session (one catalog lookup).
    const sessionsNeedingNames = pickSessions(assignments, today);
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
    for (const e of foodEntries) {
      const day = ymdOf(e.date);
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
    const plan = buildPlan(assignments, sessionsNeedingNames, nameById, today, d14);
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
    const coachBlock = {
      has_coach: coachId !== null,
      coach_first_name: coachId ? firstName(coach?.name) : null,
      guidelines: clamp(guideline?.content, 1500),
      recent_messages: coachMessages
        .map((m) => ({ date: ymdOf(m.created_at), excerpt: clamp(m.body, 200) }))
        .filter((m): m is { date: string; excerpt: string } => m.excerpt !== null),
    };
    if (!coachId) missing.push('coach');

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

    if (!intake.completed) missing.push('intake');

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
      safety_intake: {
        completed: intake.completed === true,
        clearance_recommended: intake.clearance_recommended === true,
      },
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
      coach: coachBlock,
      meal_plan,
      data_quality: { generated_at: now.toISOString(), missing, truncated: [] },
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
      safety_intake: { completed: false, clearance_recommended: false },
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
      coach: { has_coach: false, coach_first_name: null, guidelines: null, recent_messages: [] },
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

function pickSessions(
  assignments: AssignmentRow[],
  today: string,
): { today: PickedSession | null; next: PickedSession | null } {
  const todayRow =
    assignments.find((a) => ymdOf(a.scheduled_for) === today && !a.completed_at) ?? null;
  const nextRow =
    assignments.find((a) => ymdOf(a.scheduled_for) > today && !a.completed_at) ?? null;
  return {
    today: todayRow ? { row: todayRow, rawExercises: rawExercisesOf(todayRow) } : null,
    next: nextRow ? { row: nextRow, rawExercises: rawExercisesOf(nextRow) } : null,
  };
}

function toSession(p: PickedSession, nameById: Map<string, string>): RomanCtxSession {
  const exercises: RomanCtxExercise[] = p.rawExercises.map((e) => ({
    name: clamp(nameById.get(e.exercise_external_id) ?? 'Exercise', 60) ?? 'Exercise',
    sets: e.sets,
    reps_or_duration_seconds: e.reps_or_duration_seconds,
    cue: clamp(e.notes, 80),
  }));
  return {
    date: ymdOf(p.row.scheduled_for),
    name: clamp(p.row.snapshot?.plan_name ?? p.row.workout_plan.name, 80) ?? 'Workout',
    type: clamp(p.row.snapshot?.plan_type ?? p.row.workout_plan.type, 30),
    exercises,
  };
}

function buildPlan(
  assignments: AssignmentRow[],
  picked: { today: PickedSession | null; next: PickedSession | null },
  nameById: Map<string, string>,
  today: string,
  d14: string,
): RomanCtxPlan | null {
  if (assignments.length === 0) return null;
  const recent = assignments.filter(
    (a) => ymdOf(a.scheduled_for) >= d14 && ymdOf(a.scheduled_for) <= today,
  );
  const completions: RomanCtxCompletion[] = recent
    .filter((a) => a.completed_at)
    .slice(-10)
    .map((a) => ({
      date: ymdOf(a.scheduled_for),
      name: clamp(a.snapshot?.plan_name ?? a.workout_plan.name, 80) ?? 'Workout',
      post_rpe: a.post_rpe ?? null,
      has_notes: !!a.post_notes,
      notes: clamp(a.post_notes, 140),
    }));
  const anchor = picked.today?.row ?? picked.next?.row ?? assignments[assignments.length - 1];
  const upcomingDays = new Set(
    assignments.filter((a) => ymdOf(a.scheduled_for) > today).map((a) => ymdOf(a.scheduled_for)),
  );
  return {
    program_name: clamp(anchor.workout_plan.program?.name ?? null, 80),
    days_per_week: upcomingDays.size ? Math.min(7, Math.ceil(upcomingDays.size / 2)) : null,
    assigned_at: null,
    today_session: picked.today ? toSession(picked.today, nameById) : null,
    next_session: picked.next ? toSession(picked.next, nameById) : null,
    recent_completions: completions,
    adherence_14d: recent.length
      ? { completed: recent.filter((a) => a.completed_at).length, scheduled: recent.length }
      : null,
  };
}
