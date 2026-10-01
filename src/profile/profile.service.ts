import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { UpdateProfileDto } from './profile.dto';
import { computeMacros, LBS_PER_KG, resolveMacroInputs } from '../macros/macro-calculator';

@Injectable()
export class ProfileService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      // Return empty profile shell
      return { user_id: userId };
    }

    return profile;
  }

  async updateProfile(userId: string, data: UpdateProfileDto) {
    // CRITICAL: height_cm stored ONLY in UserProfile — single source of truth
    // SECURITY: explicit allow-list mapping (audit C4). The controller DTO already
    // strips unknown fields via ValidationPipe, but we defend-in-depth by mapping
    // only the permitted fields into Prisma rather than spreading. This prevents
    // any future regression (e.g. DTO drift) from letting a client overwrite
    // `user_id`, `id`, `updated_at`, or any of the `macro_target_*` fields that
    // should be computed server-side by `computeAndSaveMacros`.
    const legacy = mapLegacyProfileFields(data);
    const allowed: Record<string, unknown> = {
      ...legacy,
      height_cm: data.height_cm,
      current_weight_lbs: data.current_weight_lbs ?? legacy.current_weight_lbs,
      target_weight_lbs: data.target_weight_lbs ?? legacy.target_weight_lbs,
      date_of_birth: data.date_of_birth ? new Date(data.date_of_birth) : legacy.date_of_birth,
      sex: data.sex,
      activity_level: data.activity_level,
      goal_type: data.goal_type ?? legacy.goal_type,
      workout_experience: data.workout_experience ?? legacy.workout_experience,
      has_gym_membership: data.has_gym_membership ?? legacy.has_gym_membership,
      preferred_snacks: data.preferred_snacks,
      dietary_pattern: data.dietary_pattern ?? legacy.dietary_pattern,
      dietary_restrictions: data.dietary_restrictions ?? legacy.dietary_restrictions,
      workout_days_per_week: data.workout_days_per_week,
      equipment_access: data.equipment_access,
      avatar_url: data.avatar_url,
      bio: data.bio,
      weight_unit: data.weight_unit,
      meals_per_day: data.meals_per_day,
      water_goal_oz: data.water_goal_oz,
      calorie_display: data.calorie_display,
      onboardingCompleted: data.onboardingCompleted ?? legacy.onboardingCompleted,
      injuries: data.injuries,
      preferred_training_time: data.preferred_training_time,
      food_preferences: data.food_preferences,
    };
    // Drop undefined AND null so a "not answered" never overwrites a stored
    // value (the legacy results screen sends `null` for every unanswered
    // field, and several columns are non-null enums).
    const payload: Prisma.UserProfileUncheckedUpdateInput & Prisma.UserProfileUncheckedCreateInput =
      { user_id: userId };
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined && v !== null) (payload as Record<string, unknown>)[k] = v;
    }

    const existing = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });

    if (existing) {
      return this.prisma.userProfile.update({
        where: { user_id: userId },
        data: payload,
      });
    } else {
      return this.prisma.userProfile.create({
        data: payload,
      });
    }
  }

  /**
   * Recompute the profile's targets with the single calculator
   * (src/macros/macro-calculator.ts). When any required input is missing the
   * stored targets are left untouched and nothing is invented: there are no
   * 180 lb / 175 cm / age-30 defaults any more.
   */
  async computeAndSaveMacros(userId: string, now: Date = new Date()) {
    const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
    if (!profile) return null;

    const resolved = resolveMacroInputs(
      {
        current_weight_lbs: profile.current_weight_lbs,
        target_weight_lbs: profile.target_weight_lbs,
        height_cm: profile.height_cm,
        date_of_birth: profile.date_of_birth,
        sex: profile.sex,
        activity_level: profile.activity_level,
        goal_type: profile.goal_type,
      },
      now,
    );
    if (!resolved.ok) return profile;

    const m = computeMacros(resolved.inputs);
    return this.prisma.userProfile.update({
      where: { user_id: userId },
      data: {
        macro_target_calories: m.calories,
        macro_target_protein_g: m.protein_g,
        macro_target_carbs_g: m.carbs_g,
        macro_target_fat_g: m.fat_g,
      },
    });
  }
}

const GOAL_FROM_LEGACY: Record<string, 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance'> =
  {
    lose_fast: 'fat_loss',
    lose_moderate: 'fat_loss',
    lose_weight: 'fat_loss',
    fat_loss: 'fat_loss',
    maintain: 'maintenance',
    maintenance: 'maintenance',
    mobility: 'maintenance',
    gain: 'muscle_gain',
    gain_fast: 'muscle_gain',
    build_muscle: 'muscle_gain',
    muscle_gain: 'muscle_gain',
    performance: 'performance',
  };

const EXPERIENCE_FROM_LEGACY: Record<string, 'beginner' | 'intermediate' | 'advanced'> = {
  beginner: 'beginner',
  new: 'beginner',
  intermediate: 'intermediate',
  some: 'intermediate',
  advanced: 'advanced',
  experienced: 'advanced',
};

/**
 * Legacy weight unit rule (docs/profile-contract.md):
 *   1. `weight_unit` in the same body wins ('kg' or 'lbs').
 *   2. Otherwise a payload carrying a lean-onboarding-only key
 *      (`fitness_level` or `lean_intent`) is kg: the lean writer
 *      (mobile lib/finalizeLeanOnboarding) stores weight in kg.
 *   3. Otherwise lbs (legacy results screen and EditProfile both send lbs).
 */
export function legacyWeightUnit(data: UpdateProfileDto): 'kg' | 'lbs' {
  if (data.weight_unit === 'kg' || data.weight_unit === 'lbs') return data.weight_unit;
  const hasLeanKey =
    (data.fitness_level !== undefined && data.fitness_level !== null) ||
    (data.lean_intent !== undefined && data.lean_intent !== null);
  return hasLeanKey ? 'kg' : 'lbs';
}

function toLbs(v: number | null | undefined, unit: 'kg' | 'lbs'): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  const lbs = unit === 'kg' ? v * LBS_PER_KG : v;
  return Math.round(lbs * 10) / 10;
}

/**
 * Map the legacy mobile field names onto canonical UserProfile columns.
 * Pure; returns only the keys it could map (undefined otherwise). Canonical
 * names in the same body win over these (see updateProfile).
 */
export function mapLegacyProfileFields(data: UpdateProfileDto): {
  date_of_birth?: Date;
  current_weight_lbs?: number;
  target_weight_lbs?: number;
  goal_type?: 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance';
  workout_experience?: 'beginner' | 'intermediate' | 'advanced';
  dietary_pattern?: string;
  dietary_restrictions?: string[];
  has_gym_membership?: boolean;
  onboardingCompleted?: boolean;
} {
  const unit = legacyWeightUnit(data);
  const out: ReturnType<typeof mapLegacyProfileFields> = {};
  if (data.dob) out.date_of_birth = new Date(data.dob);
  const cw = toLbs(data.current_weight, unit);
  if (cw !== undefined) out.current_weight_lbs = cw;
  const tw = toLbs(data.target_weight, unit);
  if (tw !== undefined) out.target_weight_lbs = tw;
  if (data.primary_goal) out.goal_type = GOAL_FROM_LEGACY[data.primary_goal];
  if (data.fitness_level) out.workout_experience = EXPERIENCE_FROM_LEGACY[data.fitness_level];
  if (data.diet_type) {
    // 'omnivore' and 'mediterranean' are not on the canonical list: omnivore
    // is "no particular pattern"; mediterranean is stored as 'other'.
    out.dietary_pattern =
      data.diet_type === 'omnivore'
        ? 'none'
        : data.diet_type === 'mediterranean'
          ? 'other'
          : data.diet_type;
  }
  if (Array.isArray(data.diet_restrictions)) out.dietary_restrictions = data.diet_restrictions;
  // gym_membership maps onto the boolean only; it never overwrites a granular
  // equipment_access list.
  if (data.gym_membership) {
    out.has_gym_membership =
      data.gym_membership === 'yes_regular' || data.gym_membership === 'yes_occasional';
  }
  if (typeof data.onboarding_completed === 'boolean')
    out.onboardingCompleted = data.onboarding_completed;
  return out;
}
