/**
 * RomanClientContext — the exact facts about the signed-in client that Roman
 * is grounded in (PLAN_roman_intelligence §2.3).
 *
 * Owner ruling 2026-09-30 16:31 #6: Roman sees ALL of the client's OWN data —
 * profile, the full consultation including the safety-screen answers, macros,
 * food logs, workouts and history, check-ins, wearable/health/sleep summaries,
 * recent messages with their coach (both directions), and the community posts
 * they authored. Strictly scoped to that ONE client.
 *
 * Still NEVER in this shape: any other user's data, coach-private notes
 * (`coach_notes_md` on CoachingSession), bloodwork, payments, email, phone, last
 * name, raw user id, exact DOB, addresses, wearable tokens/credentials. The
 * exclusion test in test/roman/roman-client-context.spec.ts asserts each.
 *
 * Every field is a number, an enum from the schema, a short sanitized string,
 * or `null` meaning "unknown". Strings are clamped; lists use recency windows.
 */

export const ROMAN_CONTEXT_VERSION = 'ctx-v3';

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

/** One consultation / safety-screen question with the client's own answer. */
export interface RomanCtxQA {
  /** Short question id or label, ≤80 chars. */
  question: string;
  /** The client's answer, ≤200 chars. */
  answer: string;
  /** True when this answer is one that triggered the clearance recommendation. */
  flagged?: boolean;
}

/**
 * Owner ruling 2026-09-30 16:31 #6 (supersedes the earlier two-boolean
 * ruling): Roman sees the client's full consultation INCLUDING the
 * safety-screen answers. `screen_answers` carries the safety-screen Q/A;
 * `clearance_recommended` is still the one derived flag the contract keys on.
 */
export interface RomanCtxSafetyIntake {
  completed: boolean;
  clearance_recommended: boolean;
  /** Safety-screen questions and the client's answers (≤12). */
  screen_answers: RomanCtxQA[];
}

/** The rest of the PT consultation (goals, history, preferences) as Q/A (≤30). */
export interface RomanCtxConsultation {
  completed: boolean;
  completed_at: string | null;
  answers: RomanCtxQA[];
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

/** One logged food entry (ruling #6: Roman sees the food logs themselves). */
export interface RomanCtxFoodEntry {
  meal: string;
  name: string;
  kcal: number;
  protein_g: number;
  logged_at: string;
}

export interface RomanCtxToday extends RomanCtxDayTotals {
  remaining_kcal: number | null;
  remaining_protein_g: number | null;
  remaining_carbs_g: number | null;
  remaining_fat_g: number | null;
  pct_kcal: number | null;
  pct_protein: number | null;
  last_logged_at: string | null;
  /** Today's entries, most recent last (≤16; dropped under the token cap). */
  entries: RomanCtxFoodEntry[];
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

export interface RomanCtxCoachMessage {
  date: string;
  from: 'coach' | 'client';
  excerpt: string;
}

export interface RomanCtxCoach {
  has_coach: boolean;
  coach_first_name: string | null;
  /** CoachGuideline for (coach, client), ≤1,500 chars. */
  guidelines: string | null;
  /** Last 8 messages in the client ↔ coach thread, oldest first, both directions. */
  recent_messages: RomanCtxCoachMessage[];
}

/** The client's OWN community posts (never anyone else's), newest first (≤5). */
export interface RomanCtxCommunityPost {
  date: string;
  scope: string;
  title: string | null;
  excerpt: string | null;
}

/** Per-day wearable summary in the client's local date. */
export interface RomanCtxWearableDay {
  date: string;
  steps: number | null;
  active_kcal: number | null;
  resting_hr_bpm: number | null;
  hrv_ms: number | null;
  sleep_hours: number | null;
  sleep_efficiency_pct: number | null;
  recovery_score: number | null;
  readiness_score: number | null;
}

/** Wearable / health / sleep summary (last 7 local days). Never tokens or raw samples. */
export interface RomanCtxWearables {
  connected: boolean;
  providers: string[];
  last_synced_at: string | null;
  avg_7d: Omit<RomanCtxWearableDay, 'date'>;
  /** Sleep that ended on today's local date; null when none (never an older night). */
  last_night_sleep_hours: number | null;
  /** The most recent night with sleep data, with its own local date. */
  latest_sleep: { date: string; hours: number } | null;
  /** Per-day detail, oldest first (dropped first under the token cap). */
  days: RomanCtxWearableDay[];
}

/** An upcoming coaching session (booking) with the current coach. */
export interface RomanCtxBooking {
  date: string;
  weekday: string;
  local_time: string;
  duration_minutes: number;
  title: string;
  status: 'requested' | 'confirmed';
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
  consultation: RomanCtxConsultation;
  safety_intake: RomanCtxSafetyIntake;
  targets: RomanCtxTargets;
  macro_method: RomanCtxMacroMethod;
  today: RomanCtxToday;
  last_7_days: RomanCtxLast7Days;
  plan: RomanCtxPlan | null;
  logged_workouts: RomanCtxLoggedWorkout[];
  weight_trend: RomanCtxWeightTrend;
  check_ins: RomanCtxCheckIn[];
  wearables: RomanCtxWearables;
  coach: RomanCtxCoach;
  upcoming_sessions: RomanCtxBooking[];
  community_posts: RomanCtxCommunityPost[];
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
  /** Number of Prisma queries the build issued (≤ 16 by contract). */
  query_count: number;
}

/**
 * Source of the consultation + safety-screen facts. C05 (consultation
 * screening) has not landed; until it does the default source reports
 * `completed:false` with no answers, and Roman applies the conservative
 * rules. When C05 lands it registers an implementation under this token.
 * Per ruling #6 the implementation exposes the client's own answers (clamped
 * by the builder); it must never expose another client's rows.
 */
export const ROMAN_SAFETY_INTAKE_SOURCE = 'ROMAN_SAFETY_INTAKE_SOURCE';
export interface RomanConsultationSummary {
  safety_intake: RomanCtxSafetyIntake;
  consultation: RomanCtxConsultation;
}
export interface RomanSafetyIntakeSource {
  summarize(userId: string): Promise<RomanConsultationSummary>;
}
