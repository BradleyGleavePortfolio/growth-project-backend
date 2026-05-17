import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  ClientAIContext,
  DailyAdherence,
  RecentWorkoutSummary,
  WeightTrendPoint,
  HabitSummary,
  CheckInSummary,
  CoachRelationship,
  MealPlanSummary,
  AIGuardrails,
  AppPrescribedTargets,
  TodaySummary,
  FastingSummary,
  NextSessionSummary,
  CommunityWinSummary,
  LeaderboardSummary,
} from './client-ai-context.types';

// Token-budget knobs. Picked so the assembled context stays well under
// ~3KB of JSON in the typical case (a 7-day, 5-workout user). Exported
// so tests can reason about the trim points.
export const CONTEXT_LIMITS = {
  ADHERENCE_DAYS: 7,
  WORKOUTS: 5,
  WEIGHT_POINTS: 14,
  HABITS: 8,
  CHECK_INS: 5,
  // M15 fix: raised from 800 to 2000 — the previous 800-char cap was
  // aggressively trimming coach guidelines, causing the AI to miss critical
  // nutrition/training rules that appeared later in longer guidelines blobs.
  GUIDELINES_CHARS: 2000,
  COACH_MSG_CHARS: 280,
  BIO_CHARS: 240,
  MEAL_PLAN_ITEMS: 12,
};

// Safety floor on calorie recommendations. The prompt forbids the model
// from suggesting anything below this, on top of the post-response check
// in GuardrailService.
const CALORIE_FLOOR_FALLBACK = 1500;

// Cache TTL: short enough that "I just logged a meal, ask the AI" is fresh,
// long enough to absorb chat-burst usage (rapid follow-up questions reuse
// the same context).
const CONTEXT_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  ctx: ClientAIContext;
  expires_at: number;
}

// Minimal first-name helper that won't throw on weird input. We strip
// surnames so the prompt can address the client without echoing their full
// legal name into AI provider logs.
function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return 'there';
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

function ageFromDob(dob: Date | null | undefined): number | null {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob).getTime();
  if (ms <= 0) return null;
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  return Math.floor(years);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function clampStr(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

@Injectable()
export class ClientAIContextService {
  private readonly logger = new Logger(ClientAIContextService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private prisma: PrismaService) {}

  // Public API. Reads cached context if fresh, else rebuilds from DB.
  // Caching is per-user and short — invalidation by TTL only. We do not
  // try to listen for log inserts; staleness is bounded to TTL.
  async build(userId: string): Promise<ClientAIContext> {
    const cached = this.cache.get(userId);
    if (cached && cached.expires_at > Date.now()) {
      return cached.ctx;
    }
    const ctx = await this.buildFresh(userId);
    this.cache.set(userId, { ctx, expires_at: Date.now() + CONTEXT_CACHE_TTL_MS });
    return ctx;
  }

  // M2 — Explicit cache invalidation for write-path services.
  // Called after food log, workout, weight, fasting, check-in, and coach
  // message events so the next chat sees fresh data without waiting for TTL.
  invalidateForUser(userId: string): void {
    this.cache.delete(userId);
  }

  // Test seam — bypasses cache, used by tests asserting on raw output.
  async buildFresh(userId: string): Promise<ClientAIContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) {
      // Caller should have checked auth already, but degrade gracefully
      // rather than crashing the chat surface.
      this.logger.warn(`buildFresh called for unknown userId=${userId}`);
      return this.emptyContext();
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - CONTEXT_LIMITS.ADHERENCE_DAYS);
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - CONTEXT_LIMITS.WEIGHT_POINTS);
    const sevenDaysAgoFromNow = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      recentEntries,
      todayEntries,
      recentWorkouts,
      recentWeights,
      habits,
      checkIns,
      coachRecord,
      recentCoachMessages,
      activeGuidelines,
      currentMealPlan,
      // M1 additions
      activeFast,
      lastCompletedFast,
      nextSession,
      recentWins,
      requesterProfile,
    ] = await Promise.all([
      this.prisma.loggedFoodEntry.findMany({
        where: {
          user_id: userId,
          date: { gte: sevenDaysAgo, lt: today },
        },
        include: { food_item: true },
      }),
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: userId, date: today },
        include: { food_item: true },
      }),
      this.prisma.workoutSession.findMany({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        take: CONTEXT_LIMITS.WORKOUTS,
        include: { exercises: true },
      }),
      this.prisma.weightLog.findMany({
        where: { user_id: userId, date: { gte: fourteenDaysAgo } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.habit.findMany({
        where: { user_id: userId },
        take: CONTEXT_LIMITS.HABITS,
        include: {
          logs: {
            where: { date: { gte: fourteenDaysAgo } },
            orderBy: { date: 'desc' },
          },
        },
      }),
      this.prisma.checkIn.findMany({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        take: CONTEXT_LIMITS.CHECK_INS,
      }),
      user.coach_id
        ? this.prisma.user.findUnique({ where: { id: user.coach_id } })
        : Promise.resolve(null),
      // M14 fix: fetch last 5 messages instead of just the latest one so
      // the AI has a thread summary rather than a single-message excerpt.
      user.coach_id
        ? this.prisma.coachMessage.findMany({
            where: { coach_id: user.coach_id, client_id: userId },
            orderBy: { created_at: 'desc' },
            take: 5,
          })
        : Promise.resolve([] as Array<{ body: string | null; created_at: Date; sender_id: string | null; coach_id: string | null }>),
      user.coach_id
        ? this.prisma.coachGuideline.findUnique({
            where: {
              CoachGuideline_coach_client_key: {
                coach_id: user.coach_id,
                client_id: userId,
              },
            },
          })
        : Promise.resolve(null),
      user.coach_id
        ? this.prisma.mealPlan.findFirst({
            where: { coach_id: user.coach_id, client_id: userId, archived_at: null },
            orderBy: { updated_at: 'desc' },
          })
        : Promise.resolve(null),
      // M1: active fast (end_time IS NULL)
      this.prisma.fastingWindow.findFirst({
        where: { user_id: userId, end_time: null },
        orderBy: { start_time: 'desc' },
      }),
      // M1: last completed fast
      this.prisma.fastingWindow.findFirst({
        where: { user_id: userId, end_time: { not: null } },
        orderBy: { end_time: 'desc' },
      }),
      // M1: next upcoming coaching session
      user.coach_id
        ? this.prisma.coachingSession.findFirst({
            where: { client_id: userId, start_at: { gte: new Date() } },
            orderBy: { start_at: 'asc' },
            select: { start_at: true, title: true, coach_notes_md: true },
          })
        : Promise.resolve(null),
      // M1: last 3 community wins in the past 7 days (roster-scoped)
      user.coach_id
        ? this.prisma.communityWin.findMany({
            where: {
              coach_id: user.coach_id,
              created_at: { gte: sevenDaysAgoFromNow },
            },
            orderBy: { created_at: 'desc' },
            take: 3,
            select: { title: true, created_at: true },
          })
        : Promise.resolve([] as Array<{ title: string; created_at: Date }>),
      // M1: leaderboard opt-in state for this user
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { show_on_leaderboard: true },
      }),
    ]);

    const profile = user.profile;

    const prescribed: AppPrescribedTargets = {
      calories: profile?.macro_target_calories ?? null,
      protein_g: profile?.macro_target_protein_g ?? null,
      carbs_g: profile?.macro_target_carbs_g ?? null,
      fat_g: profile?.macro_target_fat_g ?? null,
      water_ml: profile?.water_goal_oz ? Math.round(profile.water_goal_oz * 29.5735) : null,
      meals_per_day: profile?.meals_per_day ?? null,
    };

    const todaySum = this.summarizeDay(todayEntries, isoDate(today), prescribed);
    const adherence = this.summarizeAdherenceWindow(recentEntries, sevenDaysAgo, today);

    const ctx: ClientAIContext = {
      identity: {
        first_name: firstNameOf(user.name),
        age_years: ageFromDob(profile?.date_of_birth),
        sex: (profile?.sex as 'male' | 'female' | 'prefer_not_to_say') ?? 'prefer_not_to_say',
      },
      profile: {
        height_cm: profile?.height_cm ?? null,
        current_weight_lbs: profile?.current_weight_lbs ?? null,
        target_weight_lbs: profile?.target_weight_lbs ?? null,
        goal_type: (profile?.goal_type as ClientAIContext['profile']['goal_type']) ?? 'maintenance',
        activity_level:
          (profile?.activity_level as ClientAIContext['profile']['activity_level']) ?? 'moderate',
        workout_experience:
          (profile?.workout_experience as ClientAIContext['profile']['workout_experience']) ??
          'beginner',
        has_gym_membership: profile?.has_gym_membership ?? false,
        preferred_snacks: profile?.preferred_snacks ?? [],
        dietary_pattern: profile?.dietary_pattern ?? null,
        dietary_restrictions: profile?.dietary_restrictions ?? [],
        workout_days_per_week: profile?.workout_days_per_week ?? null,
        equipment_access: profile?.equipment_access ?? [],
        bio: clampStr(profile?.bio ?? null, CONTEXT_LIMITS.BIO_CHARS),
      },
      prescribed,
      today: todaySum,
      recent_adherence_7d: adherence,
      recent_workouts: recentWorkouts.map(this.summarizeWorkout),
      weight_trend_14d: recentWeights.map<WeightTrendPoint>((w) => ({
        date: isoDate(w.date),
        weight_lbs: w.weight_lbs,
      })),
      habits: habits.map<HabitSummary>((h) => ({
        name: h.name,
        category: h.category,
        target_value: h.target_value,
        unit: h.unit,
        completed_last_14d: h.logs.filter((l) => l.completed).length,
      })),
      recent_check_ins: checkIns.map<CheckInSummary>((c) => ({
        date: isoDate(c.date),
        type: c.type as 'morning' | 'evening',
        mood: c.mood,
        energy: c.energy,
        soreness: c.soreness,
        sleep_hours: c.sleep_hours,
        notes: clampStr(c.notes, 200),
      })),
      coach: this.buildCoachRelationship(coachRecord, recentCoachMessages, activeGuidelines),
      current_meal_plan: this.summarizeMealPlan(currentMealPlan),
      // M1 additions
      fasting: this.buildFastingSummary(activeFast, lastCompletedFast),
      next_session: nextSession
        ? {
            date: nextSession.start_at.toISOString(),
            title: nextSession.title,
            coach_note: clampStr(nextSession.coach_notes_md, 200),
          }
        : null,
      recent_wins: (recentWins ?? []).map<CommunityWinSummary>((w) => ({
        title: w.title,
        created_at: w.created_at.toISOString(),
      })),
      leaderboard: {
        opted_in: requesterProfile?.show_on_leaderboard ?? false,
        rank: null, // rank is expensive to compute on every chat; AI uses opted_in signal only
      },
      guardrails: this.buildGuardrails(prescribed, !!user.coach_id),
      generated_at: new Date().toISOString(),
    };
    return ctx;
  }

  // Renders the typed context into a compact human-readable block that the
  // model can reason over. Designed to be stable so any prompt change is a
  // diff against a known shape, not a re-flow of every field.
  renderForPrompt(ctx: ClientAIContext): string {
    const p = ctx.profile;
    const tx = ctx.prescribed;
    const today = ctx.today;
    const id = ctx.identity;

    const lines: string[] = [];
    lines.push('CLIENT_CONTEXT:');
    lines.push(
      `- name: ${id.first_name} | age: ${id.age_years ?? 'unknown'} | sex: ${id.sex}`,
    );
    lines.push(
      `- profile: goal=${p.goal_type}, activity=${p.activity_level}, experience=${p.workout_experience}, gym_member=${p.has_gym_membership}, workout_days_per_week=${p.workout_days_per_week ?? 'unknown'}`,
    );
    lines.push(
      `- body: height_cm=${p.height_cm ?? '?'}, current_lbs=${p.current_weight_lbs ?? '?'}, target_lbs=${p.target_weight_lbs ?? '?'}`,
    );
    lines.push(
      `- diet: pattern=${p.dietary_pattern ?? 'unknown'}, restrictions=${p.dietary_restrictions.length ? p.dietary_restrictions.join('|') : 'none'}`,
    );
    lines.push(
      `- equipment: ${p.equipment_access.length ? p.equipment_access.join('|') : 'unknown'}`,
    );
    lines.push(
      `- APP_PRESCRIBED (DO NOT CONTRADICT): calories=${tx.calories ?? 'unset'}, protein_g=${tx.protein_g ?? 'unset'}, carbs_g=${tx.carbs_g ?? 'unset'}, fat_g=${tx.fat_g ?? 'unset'}, water_ml=${tx.water_ml ?? 'unset'}, meals_per_day=${tx.meals_per_day ?? 'unset'}`,
    );
    lines.push(
      `- today (${today.date}): cal=${today.calories}/${tx.calories ?? '?'}, protein_g=${today.protein_g}/${tx.protein_g ?? '?'}, remaining_cal=${today.remaining_calories ?? '?'}, pct=${today.pct_calories ?? '?'}%`,
    );

    if (ctx.recent_adherence_7d.length) {
      const avg = avgAdherence(ctx.recent_adherence_7d);
      lines.push(
        `- last_${ctx.recent_adherence_7d.length}d_avg: cal=${avg.calories}, protein_g=${avg.protein_g}, days_logged=${ctx.recent_adherence_7d.length}`,
      );
    } else {
      lines.push('- last_7d_avg: no logged days');
    }

    if (ctx.recent_workouts.length) {
      const w = ctx.recent_workouts
        .map(
          (x) => `${x.date} ${x.name} (${x.intensity}, ${x.duration_minutes ?? '?'}min, ${x.exercise_count}ex)`,
        )
        .join('; ');
      lines.push(`- recent_workouts: ${w}`);
    } else {
      lines.push('- recent_workouts: none');
    }

    if (ctx.weight_trend_14d.length >= 2) {
      const first = ctx.weight_trend_14d[0];
      const last = ctx.weight_trend_14d[ctx.weight_trend_14d.length - 1];
      const delta = +(last.weight_lbs - first.weight_lbs).toFixed(1);
      lines.push(
        `- weight_trend_14d: ${first.weight_lbs}lb (${first.date}) -> ${last.weight_lbs}lb (${last.date}), delta=${delta}lb`,
      );
    } else if (ctx.weight_trend_14d.length === 1) {
      lines.push(`- weight_trend_14d: single reading ${ctx.weight_trend_14d[0].weight_lbs}lb`);
    } else {
      lines.push('- weight_trend_14d: none');
    }

    if (ctx.habits.length) {
      const h = ctx.habits
        .map((x) => `${x.name}=${x.completed_last_14d}/14d`)
        .join(', ');
      lines.push(`- habits: ${h}`);
    }

    if (ctx.recent_check_ins.length) {
      const c = ctx.recent_check_ins[0];
      lines.push(
        `- last_check_in: ${c.date} (${c.type}) mood=${c.mood ?? '?'}, energy=${c.energy ?? '?'}, sleep_h=${c.sleep_hours ?? '?'}`,
      );
    }

    lines.push(
      `- coach: ${ctx.coach.has_coach ? `assigned to ${ctx.coach.coach_name ?? 'coach'}` : 'unassigned'}`,
    );
    // M14 fix: surface the full thread summary when available; fall back
    // to the single-message excerpt for backward compat.
    if (ctx.coach.coach_thread_summary) {
      lines.push(
        `- coach_thread (DO NOT CONTRADICT):\n${ctx.coach.coach_thread_summary}`,
      );
    } else if (ctx.coach.last_coach_message_excerpt) {
      lines.push(
        `- last_coach_message (DO NOT CONTRADICT): "${ctx.coach.last_coach_message_excerpt}"`,
      );
    }
    if (ctx.coach.active_guidelines_excerpt) {
      lines.push(`- coach_guidelines: ${ctx.coach.active_guidelines_excerpt}`);
    }

    if (ctx.current_meal_plan) {
      lines.push(
        `- active_meal_plan: "${ctx.current_meal_plan.title}" with ${ctx.current_meal_plan.items_text.length} items`,
      );
    }

    // M1: fasting
    const f = ctx.fasting;
    if (f.active_fast) {
      lines.push(
        `- fasting: ACTIVE since ${f.active_fast.start_at}, elapsed=${f.active_fast.elapsed_hours}h`,
      );
    } else if (f.last_fast) {
      lines.push(
        `- fasting: last_fast=${f.last_fast.duration_hours}h ended ${f.last_fast.ended_at}`,
      );
    } else {
      lines.push('- fasting: no fasting history');
    }

    // M1: next session
    if (ctx.next_session) {
      const ns = ctx.next_session;
      lines.push(
        `- next_session: ${ns.date} "${ns.title}"${ns.coach_note ? ` (note: ${ns.coach_note})` : ''}`,
      );
    }

    // M1: community wins
    if (ctx.recent_wins.length) {
      const winsStr = ctx.recent_wins.map((w) => `"${w.title}"`).join(', ');
      lines.push(`- recent_roster_wins: ${winsStr}`);
    }

    // M1: leaderboard
    lines.push(
      `- leaderboard: opted_in=${ctx.leaderboard.opted_in}${ctx.leaderboard.rank !== null ? `, rank=${ctx.leaderboard.rank}` : ''}`,
    );

    lines.push(
      `- GUARDRAILS: never recommend <${ctx.guardrails.forbid_calorie_recommendations_below}kcal/day; ${ctx.guardrails.forbid_contradicting_macros ? 'never recommend macros different from APP_PRESCRIBED' : 'no prescribed macros to defend'}; refer medical/injury/extreme-restriction questions to ${ctx.coach.has_coach ? 'the coach' : 'a qualified professional'}.`,
    );
    return lines.join('\n');
  }

  // Test/debug seam used by ai.controller.ts to expose context for the
  // current user without leaking it across users.
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  // ---------- Internals ----------

  private summarizeDay(
    entries: Array<{ food_item: { calories: number; protein_g: number; carbs_g: number; fat_g: number }; quantity_multiplier: number }>,
    date: string,
    prescribed: AppPrescribedTargets,
  ): TodaySummary {
    let cal = 0,
      pro = 0,
      carb = 0,
      fat = 0;
    for (const e of entries) {
      cal += e.food_item.calories * e.quantity_multiplier;
      pro += e.food_item.protein_g * e.quantity_multiplier;
      carb += e.food_item.carbs_g * e.quantity_multiplier;
      fat += e.food_item.fat_g * e.quantity_multiplier;
    }
    cal = Math.round(cal);
    pro = Math.round(pro);
    carb = Math.round(carb);
    fat = Math.round(fat);
    return {
      date,
      calories: cal,
      protein_g: pro,
      carbs_g: carb,
      fat_g: fat,
      remaining_calories: prescribed.calories != null ? Math.round(prescribed.calories - cal) : null,
      remaining_protein_g:
        prescribed.protein_g != null ? Math.round(prescribed.protein_g - pro) : null,
      pct_calories:
        prescribed.calories != null && prescribed.calories > 0
          ? Math.round((cal / prescribed.calories) * 100)
          : null,
    };
  }

  private summarizeAdherenceWindow(
    entries: Array<{ date: Date; food_item: { calories: number; protein_g: number; carbs_g: number; fat_g: number }; quantity_multiplier: number }>,
    from: Date,
    to: Date,
  ): DailyAdherence[] {
    // Bucket by date string so we don't depend on the Date object identity.
    const byDay = new Map<string, DailyAdherence>();
    for (const e of entries) {
      const day = isoDate(e.date);
      const cur =
        byDay.get(day) ??
        ({ date: day, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, meal_count: 0 } as DailyAdherence);
      cur.calories += e.food_item.calories * e.quantity_multiplier;
      cur.protein_g += e.food_item.protein_g * e.quantity_multiplier;
      cur.carbs_g += e.food_item.carbs_g * e.quantity_multiplier;
      cur.fat_g += e.food_item.fat_g * e.quantity_multiplier;
      cur.meal_count += 1;
      byDay.set(day, cur);
    }
    // Round and return newest-first; we only show days that had at least one
    // entry so "no log" days don't pollute the average.
    return Array.from(byDay.values())
      .map((d) => ({
        ...d,
        calories: Math.round(d.calories),
        protein_g: Math.round(d.protein_g),
        carbs_g: Math.round(d.carbs_g),
        fat_g: Math.round(d.fat_g),
      }))
      .filter((d) => {
        const t = new Date(d.date).getTime();
        return t >= from.getTime() && t < to.getTime();
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  private summarizeWorkout = (w: {
    date: Date;
    workout_name: string;
    workout_type: string;
    duration_minutes: number | null;
    intensity: string;
    exercises: unknown[];
  }): RecentWorkoutSummary => ({
    date: isoDate(w.date),
    name: w.workout_name,
    type: w.workout_type,
    duration_minutes: w.duration_minutes,
    intensity: w.intensity as RecentWorkoutSummary['intensity'],
    exercise_count: Array.isArray(w.exercises) ? w.exercises.length : 0,
  });

  private buildCoachRelationship(
    coachRecord: { id?: string; name: string } | null,
    // M14 fix: now receives last N messages (desc order) rather than just
    // the most recent one. We reverse to chronological order and build a
    // thread summary so the AI has conversational context.
    // Phase 6C: body is nullable (voice-only messages). Voice messages are
    // excluded from the AI context (no transcription).
    recentMsgs: Array<{ body: string | null; created_at: Date; sender_id: string | null; coach_id: string | null }>,
    guidelines: { content: string } | null,
  ): CoachRelationship {
    const has_coach = !!coachRecord;
    const lastMsg = recentMsgs.length > 0 ? recentMsgs[0] : null;

    // Build thread summary: reverse msgs to chronological order, skip
    // voice-only (null body), label each line Coach/Client.
    const chronological = [...recentMsgs].reverse();
    const threadLines = chronological
      .filter((m) => m.body)
      .map((m) => {
        const role = m.sender_id && m.coach_id && m.sender_id === m.coach_id ? 'Coach' : 'Client';
        return `${role}: ${(m.body ?? '').slice(0, 100)}`;
      });
    const threadSummary = threadLines.length > 0 ? threadLines.join('\n') : null;

    return {
      coach_name: coachRecord ? firstNameOf(coachRecord.name) : null,
      has_coach,
      last_coach_message_excerpt: clampStr(lastMsg?.body ?? null, CONTEXT_LIMITS.COACH_MSG_CHARS),
      last_coach_message_at: lastMsg ? lastMsg.created_at.toISOString() : null,
      active_guidelines_excerpt: clampStr(guidelines?.content ?? null, CONTEXT_LIMITS.GUIDELINES_CHARS),
      coach_thread_summary: threadSummary,
    };
  }

  private summarizeMealPlan(plan: {
    title: string;
    notes: string | null;
    items: unknown;
    updated_at: Date;
  } | null): MealPlanSummary | null {
    if (!plan) return null;
    // `items` is JSON. We accept array-of-strings, array-of-{name},
    // or anything else (rendered as JSON.stringify as a last resort).
    const raw = plan.items;
    let lines: string[] = [];
    if (Array.isArray(raw)) {
      lines = raw
        .map((it) => {
          if (typeof it === 'string') return it;
          if (it && typeof it === 'object') {
            const o = it as Record<string, unknown>;
            if (typeof o.name === 'string') return o.name;
            if (typeof o.text === 'string') return o.text;
            return JSON.stringify(o);
          }
          return String(it);
        })
        .slice(0, CONTEXT_LIMITS.MEAL_PLAN_ITEMS);
    }
    return {
      title: plan.title,
      notes: clampStr(plan.notes, 200),
      items_text: lines,
      updated_at: plan.updated_at.toISOString(),
    };
  }

  private buildGuardrails(prescribed: AppPrescribedTargets, hasCoach: boolean): AIGuardrails {
    const floor =
      prescribed.calories != null
        ? Math.min(CALORIE_FLOOR_FALLBACK, Math.round(prescribed.calories * 0.8))
        : CALORIE_FLOOR_FALLBACK;
    return {
      forbid_calorie_recommendations_below: floor,
      forbid_contradicting_macros: prescribed.calories != null || prescribed.protein_g != null,
      refer_to_coach_for_medical: hasCoach,
      forbid_extreme_dieting_language: true,
      forbid_unsafe_substances: true,
    };
  }

  // M1 — Build fasting summary from the active window and last completed window.
  private buildFastingSummary(
    active: { start_time: Date } | null,
    last: { start_time: Date; end_time: Date | null } | null,
  ): FastingSummary {
    if (active) {
      const elapsedMs = Date.now() - active.start_time.getTime();
      const elapsed_hours = Math.round(elapsedMs / (1000 * 60 * 60) * 10) / 10;
      return {
        active_fast: { start_at: active.start_time.toISOString(), elapsed_hours },
        last_fast: null,
      };
    }
    if (last && last.end_time) {
      const durationMs = last.end_time.getTime() - last.start_time.getTime();
      const duration_hours = Math.round(durationMs / (1000 * 60 * 60) * 10) / 10;
      return {
        active_fast: null,
        last_fast: { duration_hours, ended_at: last.end_time.toISOString() },
      };
    }
    return { active_fast: null, last_fast: null };
  }

  private emptyContext(): ClientAIContext {
    const today = isoDate(new Date());
    return {
      identity: { first_name: 'there', age_years: null, sex: 'prefer_not_to_say' },
      profile: {
        height_cm: null,
        current_weight_lbs: null,
        target_weight_lbs: null,
        goal_type: 'maintenance',
        activity_level: 'moderate',
        workout_experience: 'beginner',
        has_gym_membership: false,
        preferred_snacks: [],
        dietary_pattern: null,
        dietary_restrictions: [],
        workout_days_per_week: null,
        equipment_access: [],
        bio: null,
      },
      prescribed: {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        water_ml: null,
        meals_per_day: null,
      },
      today: {
        date: today,
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        remaining_calories: null,
        remaining_protein_g: null,
        pct_calories: null,
      },
      recent_adherence_7d: [],
      recent_workouts: [],
      weight_trend_14d: [],
      habits: [],
      recent_check_ins: [],
      coach: {
        coach_name: null,
        has_coach: false,
        last_coach_message_excerpt: null,
        last_coach_message_at: null,
        active_guidelines_excerpt: null,
        coach_thread_summary: null,
      },
      current_meal_plan: null,
      // M1 defaults for empty context
      fasting: { active_fast: null, last_fast: null },
      next_session: null,
      recent_wins: [],
      leaderboard: { opted_in: false, rank: null },
      guardrails: {
        forbid_calorie_recommendations_below: CALORIE_FLOOR_FALLBACK,
        forbid_contradicting_macros: false,
        refer_to_coach_for_medical: false,
        forbid_extreme_dieting_language: true,
        forbid_unsafe_substances: true,
      },
      generated_at: new Date().toISOString(),
    };
  }
}

function avgAdherence(rows: DailyAdherence[]): { calories: number; protein_g: number } {
  if (!rows.length) return { calories: 0, protein_g: 0 };
  const sum = rows.reduce(
    (acc, r) => ({ calories: acc.calories + r.calories, protein_g: acc.protein_g + r.protein_g }),
    { calories: 0, protein_g: 0 },
  );
  return {
    calories: Math.round(sum.calories / rows.length),
    protein_g: Math.round(sum.protein_g / rows.length),
  };
}
