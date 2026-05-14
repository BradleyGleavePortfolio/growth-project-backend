// Coach AI v1 — per-client context shape.
//
// This is the SUPERSET context that the coach-AI engine hands the prompt
// builders. It is built once per generation via ClientContextService.build
// and snapshot-stored on every AIDraft.inputContext so a reviewer can see
// exactly what the model saw at draft time.
//
// The shape is a strict additive evolution of `ClientAIContext`
// (src/ai/client-ai-context.types.ts): all the same identity / profile /
// today / prescribed / weight_trend_14d / recent_workouts / coach
// blocks, PLUS the audit-required additions:
//   * profile.injuries / food_preferences / preferred_training_time
//     (new schema columns)
//   * profile.workout_days_per_week / dietary_pattern /
//     dietary_restrictions / meals_per_day (already in UserProfile —
//     just newly threaded through here)
//   * recent_workout_assignments (last 90 days of ClientWorkoutAssignment
//     with post_rpe / completed_at — what the coach prescribed AND
//     what the client actually did)
//   * macro_target (the coach-prescribed MacroTarget row)
//   * food_log_totals_last_7d (rolling 7-day macro adherence)
//   * recent_check_ins (last 3)

export type GoalType = 'fat_loss' | 'muscle_gain' | 'maintenance' | string;
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active' | string;
export type WorkoutExperience = 'beginner' | 'intermediate' | 'advanced' | string;

export interface ClientContextIdentity {
  first_name: string;
  age_years: number | null;
  sex: 'male' | 'female' | 'prefer_not_to_say' | string;
}

export interface ClientContextProfile {
  height_cm: number | null;
  current_weight_lbs: number | null;
  target_weight_lbs: number | null;
  goal_type: GoalType;
  activity_level: ActivityLevel;
  workout_experience: WorkoutExperience;
  has_gym_membership: boolean;
  preferred_snacks: string[];
  dietary_pattern: string | null;
  dietary_restrictions: string[];
  workout_days_per_week: number | null;
  meals_per_day: number | null;
  equipment_access: string[];
  bio: string | null;
  injuries: string[];
  food_preferences: unknown | null;
  preferred_training_time: string | null;
}

export interface ClientContextPrescribed {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  // Convenience pass-through from UserProfile.meals_per_day.
  meals_per_day: number | null;
  water_ml: number | null;
  effective_from: string | null;
}

export interface ClientContextTodaySummary {
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  remaining_calories: number | null;
  remaining_protein_g: number | null;
  pct_calories: number | null;
}

export interface ClientContextWeightPoint {
  date: string;
  weight_lbs: number;
}

export interface ClientContextWorkoutAssignment {
  date: string; // scheduled_for ISO date
  completed_at: string | null;
  post_rpe: number | null;
  post_notes: string | null;
  plan_name: string;
  plan_type: string;
}

export interface ClientContextCheckIn {
  date: string;
  type: string;
  mood: number | null;
  energy: number | null;
  soreness: number | null;
  sleep_hours: number | null;
  notes: string | null;
}

export interface ClientContextFoodLogTotals {
  days_logged: number;
  avg_calories: number;
  avg_protein_g: number;
  avg_carbs_g: number;
  avg_fat_g: number;
}

export interface ClientContextCoach {
  coach_id: string | null;
  coach_name: string | null;
  has_coach: boolean;
  last_coach_message_excerpt: string | null;
}

export interface ClientContext {
  client_id: string;
  identity: ClientContextIdentity;
  profile: ClientContextProfile;
  prescribed: ClientContextPrescribed;
  today: ClientContextTodaySummary;
  weight_trend_90d: ClientContextWeightPoint[];
  recent_workout_assignments: ClientContextWorkoutAssignment[];
  food_log_totals_last_7d: ClientContextFoodLogTotals;
  recent_check_ins: ClientContextCheckIn[];
  coach: ClientContextCoach;
  generated_at: string;
}
