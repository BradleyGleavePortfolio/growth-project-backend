/**
 * RomanClientContext — the exact facts about the signed-in client that Roman
 * is grounded in (PLAN_roman_intelligence §2.3).
 *
 * Every field here is either a number, an enum from the schema, a short
 * sanitized string, or `null` meaning "unknown". Nothing in this shape may
 * carry: email, phone, last name, raw user id, exact DOB, addresses,
 * coach-private notes (`CoachingSession.coach_notes_md`), any other user's
 * data, bloodwork, wearables, payments, or the raw food-item list. The
 * exclusion test in test/roman/roman-client-context.spec.ts asserts each.
 */

export const ROMAN_CONTEXT_VERSION = 'ctx-v1';

export interface RomanCtxIdentity {
  first_name: string;
  age_years: number | null;
  sex: 'male' | 'female' | 'prefer_not_to_say' | null;
  timezone: string;
  /** YYYY-MM-DD in the client's timezone. */
  local_date: string;
  /** HH:mm in the client's timezone. */
  local_time: string;
  /** ISO weekday name in the client's timezone. */
  local_weekday: string;
}

export interface RomanCtxProfile {
  goal_type: string | null;
  activity_level: string | null;
  workout_experience: string | null;
  workout_days_per_week: number | null;
  equipment_access: string[];
  has_gym_membership: boolean | null;
  dietary_pattern: string | null;
  dietary_restrictions: string[];
  /** Clamped JSON string of UserProfile.food_preferences, or null. */
  food_preferences: string | null;
  preferred_snacks: string[];
  injuries: string[];
  preferred_training_time: string | null;
  height_cm: number | null;
  current_weight_lbs: number | null;
  target_weight_lbs: number | null;
  bio: string | null;
}

/**
 * Operator ruling (2026-09-30): screening ANSWERS and flag categories are
 * NEVER sent to any AI provider. Only whether the screen was completed and
 * whether it recommended medical clearance (any "yes").
 */
export interface RomanCtxSafetyIntake {
  completed: boolean;
  clearance_recommended: boolean;
}

export interface RomanCtxTargets {
  source: 'coach_set' | 'onboarding_calculated' | 'none';
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  water_ml: number | null;
  meals_per_day: number | null;
  effective_from: string | null;
  /** Coach-written note on the MacroTarget row, ≤200 chars. */
  notes: string | null;
}

export interface RomanCtxMacroMethod {
  summary: string;
  floor_kcal: number | null;
  floor_applied: boolean | null;
}

export interface RomanCtxDayTotals {
  date: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meals_logged: number;
}

export interface RomanCtxToday extends RomanCtxDayTotals {
  remaining_kcal: number | null;
  remaining_protein_g: number | null;
  remaining_carbs_g: number | null;
  remaining_fat_g: number | null;
  pct_kcal: number | null;
  pct_protein: number | null;
  last_logged_at: string | null;
}

export interface RomanCtxLast7Days {
  days_logged: number;
  avg_kcal_on_logged_days: number | null;
  avg_protein_g_on_logged_days: number | null;
  days_within_10pct_kcal: number | null;
  /** Per-day detail, oldest first. Dropped first under the token cap. */
  days: RomanCtxDayTotals[];
}

export interface RomanCtxExercise {
  name: string;
  sets: number;
  reps_or_duration_seconds: number;
  cue: string | null;
}

export interface RomanCtxSession {
  date: string;
  name: string;
  type: string | null;
  exercises: RomanCtxExercise[];
}

export interface RomanCtxCompletion {
  date: string;
  name: string;
  post_rpe: number | null;
  has_notes: boolean;
  notes: string | null;
}

export interface RomanCtxPlan {
  program_name: string | null;
  days_per_week: number | null;
  assigned_at: string | null;
  today_session: RomanCtxSession | null;
  next_session: RomanCtxSession | null;
  recent_completions: RomanCtxCompletion[];
  adherence_14d: { completed: number; scheduled: number } | null;
}

export interface RomanCtxLoggedWorkout {
  date: string;
  name: string;
  type: string;
  duration_minutes: number | null;
  intensity: string;
  exercise_count: number;
}

export interface RomanCtxWeightTrend {
  unit: 'lbs';
  points: Array<{ date: string; weight_lbs: number }>;
  avg_7d: number | null;
  change_14d: number | null;
  change_30d: number | null;
}

export interface RomanCtxCheckIn {
  date: string;
  type: string;
  mood: number | null;
  energy: number | null;
  soreness: number | null;
  sleep_hours: number | null;
  notes: string | null;
}

export interface RomanCtxCoach {
  has_coach: boolean;
  coach_first_name: string | null;
  /** CoachGuideline for (coach, client), ≤1,500 chars. */
  guidelines: string | null;
  /** Last 3 coach → client message excerpts (already visible to the client). */
  recent_messages: Array<{ date: string; excerpt: string }>;
}

export interface RomanCtxMealPlan {
  title: string;
  items: string[];
}

export interface RomanCtxDataQuality {
  generated_at: string;
  missing: string[];
  truncated: string[];
}

export interface RomanClientContext {
  version: typeof ROMAN_CONTEXT_VERSION;
  identity: RomanCtxIdentity;
  profile: RomanCtxProfile;
  safety_intake: RomanCtxSafetyIntake;
  targets: RomanCtxTargets;
  macro_method: RomanCtxMacroMethod;
  today: RomanCtxToday;
  last_7_days: RomanCtxLast7Days;
  plan: RomanCtxPlan | null;
  logged_workouts: RomanCtxLoggedWorkout[];
  weight_trend: RomanCtxWeightTrend;
  check_ins: RomanCtxCheckIn[];
  coach: RomanCtxCoach;
  meal_plan: RomanCtxMealPlan | null;
  data_quality: RomanCtxDataQuality;
}

/** What the prompt path receives: structured + rendered + provenance. */
export interface RomanClientContextBundle {
  context: RomanClientContext;
  /** The `<client_data …>` block injected as the second system block. */
  rendered: string;
  /** sha256 hex of `rendered`. */
  hash: string;
  generated_at: Date;
  /** Rough token estimate of `rendered` (chars / 4). */
  estimated_tokens: number;
  /** Number of Prisma queries the build issued (≤ 12 by contract). */
  query_count: number;
}

/**
 * Source of the safety-intake summary. C05 (consultation screening) has not
 * landed; until it does the default source reports `completed:false` and
 * Roman applies the conservative rules. When C05 lands it registers an
 * implementation under this token. The implementation MUST only expose the
 * two booleans — never categories or answers.
 */
export const ROMAN_SAFETY_INTAKE_SOURCE = 'ROMAN_SAFETY_INTAKE_SOURCE';
export interface RomanSafetyIntakeSource {
  summarize(userId: string): Promise<RomanCtxSafetyIntake>;
}
