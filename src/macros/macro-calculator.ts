/**
 * The one macro calculator (C06, single source of truth).
 *
 * Every server path that turns body measurements into daily targets calls
 * `computeMacros` from this file:
 *   - PUT /profile            -> ProfileService.computeAndSaveMacros
 *   - POST /coach/macros/preset -> MacrosService.computePreset
 *   - POST /me/onboarding/complete (C05/C07) -> initial MacroTarget
 *
 * Method: Mifflin-St Jeor BMR x activity factor, then a goal adjustment.
 *   male    BMR = 10*kg + 6.25*cm - 5*age + 5
 *   female  BMR = 10*kg + 6.25*cm - 5*age - 161
 *   prefer_not_to_say uses the MALE equation (approved method, MM-1/2/4, C-D5)
 *
 * Goal adjustment: fat_loss -500 kcal, muscle_gain +300 kcal, maintenance and
 * performance 0.
 *
 * Calorie floor (calorie-floor.ts): 1,200 kcal for female, 1,500 kcal for
 * everyone else. The floor is applied after the goal adjustment and reported
 * as `floor_applied`.
 *
 * Split: protein 1 g per lb of goal weight (current weight when no goal weight
 * was given), capped at 35% of calories; fat 25% of calories; carbs fill the
 * remainder (never negative). Everything is rounded to the nearest whole unit.
 *
 * No silent defaults. Missing or implausible inputs are reported by
 * `resolveMacroInputs` as a list of missing fields; callers decide what to do
 * (PUT /profile skips the write, onboarding complete returns 409
 * `consultation_incomplete`). There is no 180 lb / 175 cm / age 30 fallback.
 *
 * This module is pure: no Prisma, no Nest, no clock except the `now` argument.
 */

import { calorieFloorKcal } from './calorie-floor';

export type MacroSex = 'male' | 'female' | 'prefer_not_to_say';
export type MacroGoal = 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance';
export type MacroActivity = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

export const ACTIVITY_FACTORS: Readonly<Record<MacroActivity, number>> = Object.freeze({
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
});

export const GOAL_ADJUSTMENT_KCAL: Readonly<Record<MacroGoal, number>> = Object.freeze({
  fat_loss: -500,
  muscle_gain: 300,
  maintenance: 0,
  performance: 0,
});

export const FAT_SHARE_OF_KCAL = 0.25;
/** Protein never exceeds this share of calories (approved method). */
export const PROTEIN_MAX_SHARE_OF_KCAL = 0.35;
export const LBS_PER_KG = 2.2046226218;
export const KG_PER_LB = 0.45359237;

/** Plausibility bounds. Outside these the input is treated as missing. */
export const INPUT_BOUNDS = Object.freeze({
  weight_lbs: { min: 60, max: 1000 },
  height_cm: { min: 90, max: 250 },
  age_years: { min: 13, max: 110 },
});

export interface MacroInputs {
  weight_lbs: number;
  height_cm: number;
  age_years: number;
  sex: MacroSex;
  activity_level: MacroActivity;
  goal: MacroGoal;
  /** Optional goal weight; protein is set from it when present. */
  target_weight_lbs?: number | null;
}

export type MacroMethod = 'mifflin_st_jeor';

export interface MacroResult {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  bmr: number;
  tdee: number;
  method: MacroMethod;
  floor_applied: boolean;
  floor_kcal: number;
}

export type MacroInputField =
  'weight' | 'height_cm' | 'date_of_birth' | 'sex' | 'activity_level' | 'goal';

export type ResolveResult =
  { ok: true; inputs: MacroInputs } | { ok: false; missing: MacroInputField[] };

const SEXES: readonly MacroSex[] = ['male', 'female', 'prefer_not_to_say'];
const GOALS: readonly MacroGoal[] = ['fat_loss', 'muscle_gain', 'maintenance', 'performance'];
const ACTIVITIES = Object.keys(ACTIVITY_FACTORS) as MacroActivity[];

function finiteInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** Whole years between `dob` and `now` (UTC calendar arithmetic). */
export function ageInYears(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * Raw, possibly-incomplete inputs as they live on a profile row or in the
 * consultation answers. Everything is optional; `resolveMacroInputs` reports
 * what is missing instead of guessing.
 */
export interface RawMacroInputs {
  current_weight_lbs?: number | null;
  target_weight_lbs?: number | null;
  height_cm?: number | null;
  date_of_birth?: Date | string | null;
  sex?: string | null;
  activity_level?: string | null;
  goal_type?: string | null;
}

export function resolveMacroInputs(raw: RawMacroInputs, now: Date): ResolveResult {
  const missing: MacroInputField[] = [];

  const weightOk = finiteInRange(
    raw.current_weight_lbs,
    INPUT_BOUNDS.weight_lbs.min,
    INPUT_BOUNDS.weight_lbs.max,
  );
  if (!weightOk) missing.push('weight');

  const heightOk = finiteInRange(
    raw.height_cm,
    INPUT_BOUNDS.height_cm.min,
    INPUT_BOUNDS.height_cm.max,
  );
  if (!heightOk) missing.push('height_cm');

  let age: number | null = null;
  if (raw.date_of_birth) {
    const dob = raw.date_of_birth instanceof Date ? raw.date_of_birth : new Date(raw.date_of_birth);
    if (!Number.isNaN(dob.getTime())) {
      const a = ageInYears(dob, now);
      if (a >= INPUT_BOUNDS.age_years.min && a <= INPUT_BOUNDS.age_years.max) age = a;
    }
  }
  if (age === null) missing.push('date_of_birth');

  const sex = SEXES.includes(raw.sex as MacroSex) ? (raw.sex as MacroSex) : null;
  if (!sex) missing.push('sex');

  const activity = ACTIVITIES.includes(raw.activity_level as MacroActivity)
    ? (raw.activity_level as MacroActivity)
    : null;
  if (!activity) missing.push('activity_level');

  const goal = GOALS.includes(raw.goal_type as MacroGoal) ? (raw.goal_type as MacroGoal) : null;
  if (!goal) missing.push('goal');

  if (missing.length > 0 || !sex || !activity || !goal || age === null) {
    return { ok: false, missing };
  }

  const target = finiteInRange(
    raw.target_weight_lbs,
    INPUT_BOUNDS.weight_lbs.min,
    INPUT_BOUNDS.weight_lbs.max,
  )
    ? raw.target_weight_lbs
    : null;

  return {
    ok: true,
    inputs: {
      weight_lbs: raw.current_weight_lbs as number,
      height_cm: raw.height_cm as number,
      age_years: age,
      sex,
      activity_level: activity,
      goal,
      target_weight_lbs: target,
    },
  };
}

export function bmrMifflinStJeor(
  weightKg: number,
  heightCm: number,
  ageYears: number,
  sex: MacroSex,
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  if (sex === 'male') return base + 5;
  if (sex === 'female') return base - 161;
  // prefer_not_to_say: the male equation (approved method), with the
  // 1,500 kcal floor.
  return base + 5;
}

export function computeMacros(inputs: MacroInputs): MacroResult {
  const weightKg = inputs.weight_lbs * KG_PER_LB;
  const bmr = bmrMifflinStJeor(weightKg, inputs.height_cm, inputs.age_years, inputs.sex);
  const tdee = bmr * ACTIVITY_FACTORS[inputs.activity_level];
  const adjusted = tdee + GOAL_ADJUSTMENT_KCAL[inputs.goal];
  const floor = calorieFloorKcal(inputs.sex);
  const floorApplied = Math.round(adjusted) < floor;
  const calories = floorApplied ? floor : Math.round(adjusted);

  const proteinBasisLbs = inputs.target_weight_lbs ?? inputs.weight_lbs;
  const proteinCapG = (calories * PROTEIN_MAX_SHARE_OF_KCAL) / 4;
  const protein_g = Math.round(Math.min(proteinBasisLbs, proteinCapG));
  const fat_g = Math.round((calories * FAT_SHARE_OF_KCAL) / 9);
  const carbs_g = Math.max(0, Math.round((calories - protein_g * 4 - fat_g * 9) / 4));

  return {
    calories,
    protein_g,
    carbs_g,
    fat_g,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    method: 'mifflin_st_jeor',
    floor_applied: floorApplied,
    floor_kcal: floor,
  };
}

/**
 * The one read-side resolver for "what are this client's daily targets".
 * A live coach MacroTarget wins; otherwise the profile's computed targets;
 * otherwise nothing (no invented numbers).
 */
export type TargetsSource = 'coach_target' | 'profile' | 'unset';

export interface DisplayedTargets {
  source: TargetsSource;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

export function resolveDisplayedTargets(
  macroTarget:
    | {
        calories_kcal: number;
        protein_g: number;
        carbs_g: number;
        fats_g: number;
        fiber_g: number | null;
      }
    | null
    | undefined,
  profile:
    | {
        macro_target_calories: number | null;
        macro_target_protein_g: number | null;
        macro_target_carbs_g: number | null;
        macro_target_fat_g: number | null;
      }
    | null
    | undefined,
): DisplayedTargets {
  if (macroTarget) {
    return {
      source: 'coach_target',
      calories: macroTarget.calories_kcal,
      protein_g: macroTarget.protein_g,
      carbs_g: macroTarget.carbs_g,
      fat_g: macroTarget.fats_g,
      fiber_g: macroTarget.fiber_g ?? null,
    };
  }
  if (profile && typeof profile.macro_target_calories === 'number') {
    return {
      source: 'profile',
      calories: Math.round(profile.macro_target_calories),
      protein_g:
        profile.macro_target_protein_g == null ? null : Math.round(profile.macro_target_protein_g),
      carbs_g:
        profile.macro_target_carbs_g == null ? null : Math.round(profile.macro_target_carbs_g),
      fat_g: profile.macro_target_fat_g == null ? null : Math.round(profile.macro_target_fat_g),
      fiber_g: null,
    };
  }
  return {
    source: 'unset',
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
  };
}
