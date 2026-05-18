import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../utils/sanitize-prompt-input';
import {
  ClientContext,
  ClientContextCheckIn,
  ClientContextFoodLogTotals,
  ClientContextProfile,
  ClientContextWorkoutAssignment,
  ClientContextWeightPoint,
} from './client-context.types';

// Coach AI v1 — per-client context builder.
//
// Superset of the data PrivateContextService.loadClientContext exposes to
// the gateway path. The coach-AI engine reads from here exclusively; the
// gateway / chat path still uses its own narrower builder
// (PrivateContextService / ClientAIContextService) to avoid blast-radius.
//
// Refactor note: per the v1 plan, this is the shared seam. Future work
// can route `ClientAIContextService.build` and PrivateContextService's
// loader through a single normalized view onto this builder; we have
// kept that out of v1 to keep the blast radius narrow.

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const ageFromDob = (dob: Date | null | undefined): number | null => {
  if (!dob) return null;
  const ms = Date.now() - new Date(dob).getTime();
  if (ms <= 0) return null;
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
};

const firstNameOf = (name: string | null | undefined): string => {
  if (!name) return 'Client';
  const trimmed = name.trim();
  if (!trimmed) return 'Client';
  return trimmed.split(/\s+/)[0];
};

const clampStr = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

@Injectable()
export class ClientContextService {
  private readonly logger = new Logger(ClientContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Build the per-client context snapshot. Single round trip of parallel
  // queries; everything stays under ~5KB JSON so an AIDraft.inputContext
  // snapshot fits in a single PG row comfortably.
  async build(clientId: string): Promise<ClientContext> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ninetyDaysAgo = new Date(today);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      include: {
        profile: true,
      },
    });
    if (!user) {
      this.logger.warn(`build called for unknown clientId=${clientId}`);
      return this.emptyContext(clientId);
    }

    const [
      macroTarget,
      weightLogs,
      assignments,
      foodEntries7d,
      foodEntriesToday,
      checkIns,
      lastCoachMessage,
      coachUser,
    ] = await Promise.all([
      this.prisma.macroTarget.findFirst({
        where: { client_id: clientId, archived_at: null },
        orderBy: { effective_from: 'desc' },
      }),
      this.prisma.weightLog.findMany({
        where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.clientWorkoutAssignment.findMany({
        where: { client_id: clientId, scheduled_for: { gte: ninetyDaysAgo } },
        orderBy: { scheduled_for: 'desc' },
        take: 20,
        include: { workout_plan: true },
      }),
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: clientId, date: { gte: sevenDaysAgo, lt: today } },
        include: { food_item: true },
      }),
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: clientId, date: today },
        include: { food_item: true },
      }),
      this.prisma.checkIn.findMany({
        where: { user_id: clientId },
        orderBy: { date: 'desc' },
        take: 3,
      }),
      user.coach_id
        ? this.prisma.coachMessage.findFirst({
            where: { coach_id: user.coach_id, client_id: clientId },
            orderBy: { created_at: 'desc' },
          })
        : Promise.resolve(null),
      user.coach_id
        ? this.prisma.user.findUnique({ where: { id: user.coach_id } })
        : Promise.resolve(null),
    ]);

    const profile = user.profile;
    const profileBlock: ClientContextProfile = {
      height_cm: profile?.height_cm ?? null,
      current_weight_lbs: profile?.current_weight_lbs ?? null,
      target_weight_lbs: profile?.target_weight_lbs ?? null,
      goal_type: profile?.goal_type ?? 'maintenance',
      activity_level: profile?.activity_level ?? 'moderate',
      workout_experience: profile?.workout_experience ?? 'beginner',
      has_gym_membership: profile?.has_gym_membership ?? false,
      preferred_snacks: profile?.preferred_snacks ?? [],
      dietary_pattern: profile?.dietary_pattern ?? null,
      dietary_restrictions: profile?.dietary_restrictions ?? [],
      workout_days_per_week: profile?.workout_days_per_week ?? null,
      meals_per_day: profile?.meals_per_day ?? null,
      equipment_access: profile?.equipment_access ?? [],
      bio: profile?.bio ? sanitizePromptInput(clampStr(profile.bio, 240) ?? '') || null : null,
      injuries: (profile?.injuries ?? []).map((inj) =>
        typeof inj === 'string' ? sanitizePromptInput(inj, 200) : inj,
      ),
      food_preferences: (profile?.food_preferences as unknown) ?? null,
      preferred_training_time: profile?.preferred_training_time ?? null,
    };

    const todayTotals = this.totalsOf(foodEntriesToday);
    const calories = todayTotals.calories;
    const remainingCal =
      macroTarget?.calories_kcal != null ? macroTarget.calories_kcal - calories : null;
    const remainingProtein =
      macroTarget?.protein_g != null ? macroTarget.protein_g - todayTotals.protein_g : null;
    const pctCal =
      macroTarget?.calories_kcal != null && macroTarget.calories_kcal > 0
        ? Math.round((calories / macroTarget.calories_kcal) * 100)
        : null;

    const foodLogTotals: ClientContextFoodLogTotals = this.average7d(foodEntries7d, sevenDaysAgo, today);

    return {
      client_id: clientId,
      identity: {
        first_name: firstNameOf(user.name),
        age_years: ageFromDob(profile?.date_of_birth ?? null),
        sex: profile?.sex ?? 'prefer_not_to_say',
      },
      profile: profileBlock,
      prescribed: {
        calories: macroTarget?.calories_kcal ?? profile?.macro_target_calories ?? null,
        protein_g: macroTarget?.protein_g ?? profile?.macro_target_protein_g ?? null,
        carbs_g: macroTarget?.carbs_g ?? profile?.macro_target_carbs_g ?? null,
        fat_g: macroTarget?.fats_g ?? profile?.macro_target_fat_g ?? null,
        fiber_g: macroTarget?.fiber_g ?? null,
        meals_per_day: profile?.meals_per_day ?? null,
        water_ml: profile?.water_goal_oz ? Math.round(profile.water_goal_oz * 29.5735) : null,
        effective_from: macroTarget?.effective_from ? macroTarget.effective_from.toISOString() : null,
      },
      today: {
        date: isoDate(today),
        calories: Math.round(calories),
        protein_g: Math.round(todayTotals.protein_g),
        carbs_g: Math.round(todayTotals.carbs_g),
        fat_g: Math.round(todayTotals.fat_g),
        remaining_calories: remainingCal != null ? Math.round(remainingCal) : null,
        remaining_protein_g: remainingProtein != null ? Math.round(remainingProtein) : null,
        pct_calories: pctCal,
      },
      weight_trend_90d: weightLogs.map<ClientContextWeightPoint>((w) => ({
        date: isoDate(w.date),
        weight_lbs: w.weight_lbs,
      })),
      recent_workout_assignments: assignments.map<ClientContextWorkoutAssignment>((a) => ({
        date: isoDate(a.scheduled_for),
        completed_at: a.completed_at ? a.completed_at.toISOString() : null,
        post_rpe: a.post_rpe,
        post_notes: a.post_notes ? sanitizePromptInput(clampStr(a.post_notes, 200) ?? '') || null : null,
        plan_name: a.workout_plan?.name ?? 'Unknown plan',
        plan_type: a.workout_plan?.type ?? 'strength',
      })),
      food_log_totals_last_7d: foodLogTotals,
      recent_check_ins: checkIns.map<ClientContextCheckIn>((c) => ({
        date: isoDate(c.date),
        type: c.type,
        mood: c.mood,
        energy: c.energy,
        soreness: c.soreness,
        sleep_hours: c.sleep_hours,
        notes: c.notes ? sanitizePromptInput(clampStr(c.notes, 200) ?? '') || null : null,
      })),
      coach: {
        coach_id: user.coach_id ?? null,
        coach_name: coachUser ? firstNameOf(coachUser.name) : null,
        has_coach: !!user.coach_id,
        last_coach_message_excerpt: lastCoachMessage?.body
          ? sanitizePromptInput(clampStr(lastCoachMessage.body, 240) ?? '') || null
          : null,
      },
      generated_at: new Date().toISOString(),
    };
  }

  private totalsOf(
    entries: Array<{
      food_item: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
      quantity_multiplier: number;
    }>,
  ): { calories: number; protein_g: number; carbs_g: number; fat_g: number } {
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
    return { calories: cal, protein_g: pro, carbs_g: carb, fat_g: fat };
  }

  private average7d(
    entries: Array<{
      date: Date;
      food_item: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
      quantity_multiplier: number;
    }>,
    from: Date,
    to: Date,
  ): ClientContextFoodLogTotals {
    const byDay = new Map<string, { cal: number; pro: number; carb: number; fat: number }>();
    for (const e of entries) {
      const t = e.date.getTime();
      if (t < from.getTime() || t >= to.getTime()) continue;
      const k = isoDate(e.date);
      const cur = byDay.get(k) ?? { cal: 0, pro: 0, carb: 0, fat: 0 };
      cur.cal += e.food_item.calories * e.quantity_multiplier;
      cur.pro += e.food_item.protein_g * e.quantity_multiplier;
      cur.carb += e.food_item.carbs_g * e.quantity_multiplier;
      cur.fat += e.food_item.fat_g * e.quantity_multiplier;
      byDay.set(k, cur);
    }
    const days = byDay.size;
    if (days === 0) {
      return { days_logged: 0, avg_calories: 0, avg_protein_g: 0, avg_carbs_g: 0, avg_fat_g: 0 };
    }
    let cal = 0,
      pro = 0,
      carb = 0,
      fat = 0;
    for (const d of byDay.values()) {
      cal += d.cal;
      pro += d.pro;
      carb += d.carb;
      fat += d.fat;
    }
    return {
      days_logged: days,
      avg_calories: Math.round(cal / days),
      avg_protein_g: Math.round(pro / days),
      avg_carbs_g: Math.round(carb / days),
      avg_fat_g: Math.round(fat / days),
    };
  }

  private emptyContext(clientId: string): ClientContext {
    const date = isoDate(new Date());
    return {
      client_id: clientId,
      identity: { first_name: 'Client', age_years: null, sex: 'prefer_not_to_say' },
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
        meals_per_day: null,
        equipment_access: [],
        bio: null,
        injuries: [],
        food_preferences: null,
        preferred_training_time: null,
      },
      prescribed: {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        meals_per_day: null,
        water_ml: null,
        effective_from: null,
      },
      today: {
        date,
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        remaining_calories: null,
        remaining_protein_g: null,
        pct_calories: null,
      },
      weight_trend_90d: [],
      recent_workout_assignments: [],
      food_log_totals_last_7d: {
        days_logged: 0,
        avg_calories: 0,
        avg_protein_g: 0,
        avg_carbs_g: 0,
        avg_fat_g: 0,
      },
      recent_check_ins: [],
      coach: {
        coach_id: null,
        coach_name: null,
        has_coach: false,
        last_coach_message_excerpt: null,
      },
      generated_at: new Date().toISOString(),
    };
  }
}
