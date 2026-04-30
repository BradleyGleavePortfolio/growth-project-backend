// Typed contract for the server-side context the AI dietitian/coach receives
// when a client asks a question through /ai/chat. Lives in its own file so
// both the builder and the prompt-assembly code (and tests) share one source
// of truth and the AI never sees a raw Prisma row.
//
// Design rules baked into the shape:
//   1. Server builds it. The mobile client never sends profile/macros/logs.
//   2. PII minimization. We never include email, supabase id, exact DOB, or
//      raw user.id. Names are reduced to first name only. Coach is a name +
//      relationship marker, not the coach's full record.
//   3. App-prescribed values (macros, calorie target, current goal) are
//      clearly labeled so the prompt can forbid contradicting them.
//   4. Optional fields are typed `null` (not `undefined`) so the prompt
//      knows the difference between absent and unknown.
//   5. Token budget is bounded: arrays are pre-trimmed to the small handful
//      that actually informs answers (e.g. last 7 days, 5 workouts).

export interface ClientAIIdentity {
  // First name only — used so the AI can address the client naturally.
  // Last name, email, supabase id, and internal user id are intentionally
  // omitted; nothing in the prompt should encourage the AI to surface them.
  first_name: string;
  // Coarse age band (`'30s'`) is sufficient for nutrition/training advice
  // and avoids passing exact DOB to the model.
  age_years: number | null;
  sex: 'male' | 'female' | 'prefer_not_to_say';
}

export interface ClientAIProfile {
  height_cm: number | null;
  current_weight_lbs: number | null;
  target_weight_lbs: number | null;
  goal_type: 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance';
  activity_level: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  workout_experience: 'beginner' | 'intermediate' | 'advanced';
  has_gym_membership: boolean;
  preferred_snacks: string[];
  // Diet shape ("vegan", "keto", "none", …). Free-form on the schema so
  // future values do not require a migration; null when the client has not
  // answered yet. The AI must treat null as "unknown" and not assume "none".
  dietary_pattern: string | null;
  // Allergens / avoid-list. Empty array is the explicit "no restrictions"
  // answer; the AI must not invent restrictions when absent.
  dietary_restrictions: string[];
  // Self-reported weekly training cadence. Null when the client has not
  // answered; the AI must not assume "0 days" from the absence.
  workout_days_per_week: number | null;
  // Granular equipment availability. `has_gym_membership` already says
  // "gym vs no gym"; this answers "barbell, dumbbells, bands, or
  // bodyweight only" so the workout-builder does not have to ask. The
  // prompt treats an empty array as "unknown" rather than as a confirmed
  // bodyweight-only answer — the explicit bodyweight answer is the
  // single-element token `["bodyweight_only"]`.
  equipment_access: string[];
  // Free-text dietary notes, redactions, allergies. We forward only short,
  // user-supplied bio text — never coach-only fields.
  bio: string | null;
}

// The numbers the app itself is prescribing. The prompt MUST treat these as
// authoritative and never recommend numbers that contradict them. Each field
// is nullable so a partially-onboarded user does not poison the prompt.
export interface AppPrescribedTargets {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  water_ml: number | null;
  meals_per_day: number | null;
}

// One day of food logging compressed to the totals the AI actually needs.
// Raw food entries are NOT included — too much noise, leaks brand names the
// AI doesn't need to repeat back.
export interface DailyAdherence {
  date: string; // YYYY-MM-DD, in UTC
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
}

// Today is reported separately because the prompt logic (status questions,
// "what should I eat next") cares specifically about remaining headroom.
export interface TodaySummary {
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  remaining_calories: number | null;
  remaining_protein_g: number | null;
  // Helps the prompt say "you're at 87% of your target" without doing math.
  pct_calories: number | null;
}

export interface RecentWorkoutSummary {
  date: string;
  name: string;
  type: string;
  duration_minutes: number | null;
  intensity: 'light' | 'moderate' | 'hard' | 'max';
  exercise_count: number;
}

export interface WeightTrendPoint {
  date: string;
  weight_lbs: number;
}

export interface HabitSummary {
  name: string;
  category: string;
  target_value: number | null;
  unit: string | null;
  // Out of the last 14 days, how many were marked complete.
  completed_last_14d: number;
}

export interface CheckInSummary {
  date: string;
  type: 'morning' | 'evening';
  mood: number | null;
  energy: number | null;
  soreness: number;
  sleep_hours: number | null;
  notes: string | null;
}

export interface CoachRelationship {
  // Coach's display name, or null if the client is unassigned. We never
  // include the coach's email, phone, or business details.
  coach_name: string | null;
  has_coach: boolean;
  // Last short coach-message body, if any, so the AI can avoid contradicting
  // recent coach guidance. Trimmed to 280 chars.
  last_coach_message_excerpt: string | null;
  last_coach_message_at: string | null;
  // Short excerpt of the active per-client guidelines (rules the coach typed
  // for THIS client). Trimmed to 800 chars.
  active_guidelines_excerpt: string | null;
}

export interface MealPlanSummary {
  title: string;
  notes: string | null;
  // Plan items kept as opaque strings — coach-authored meal lines copied as
  // text. We don't try to parse the JSON shape; the AI sees what the coach
  // wrote.
  items_text: string[];
  updated_at: string;
}

// Hard guardrail signals derived from prescribed targets and profile. The
// prompt wires these into explicit DO-NOT rules so the model cannot drift.
export interface AIGuardrails {
  forbid_calorie_recommendations_below: number; // safety floor (e.g. 1500)
  forbid_contradicting_macros: boolean; // true when prescribed macros exist
  refer_to_coach_for_medical: boolean; // always true when has_coach
  forbid_extreme_dieting_language: boolean; // always true
  forbid_unsafe_substances: boolean; // always true
}

export interface ClientAIContext {
  identity: ClientAIIdentity;
  profile: ClientAIProfile;
  prescribed: AppPrescribedTargets;
  today: TodaySummary;
  // Last 7 days excluding today. Empty array when nothing logged.
  recent_adherence_7d: DailyAdherence[];
  recent_workouts: RecentWorkoutSummary[];
  weight_trend_14d: WeightTrendPoint[];
  habits: HabitSummary[];
  recent_check_ins: CheckInSummary[];
  coach: CoachRelationship;
  current_meal_plan: MealPlanSummary | null;
  guardrails: AIGuardrails;
  // ISO-8601, used for cache keys and freshness debugging in non-prod.
  generated_at: string;
}
