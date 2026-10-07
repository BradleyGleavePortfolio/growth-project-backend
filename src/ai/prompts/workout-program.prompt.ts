import { ClientContext } from '../context/client-context.types';
import { CoachAIPrompt } from './prompt.types';
import { sanitizePromptInput } from '../utils/sanitize-prompt-input';
import type { WorkoutContextV2 } from '../context/workout-context.service';
import { InjuryAreaV2, PROGRAM_BOUNDS as PB, substitutionGuide, toInjuryAreas } from '../gateway/workout-builder/training-substitutions';

// Coach AI v1 — workout program generation prompt.
//
// Input: weeks (1-12), daysPerWeek (1-7), optional focus, optional notes.
// Output: a structured multi-week program. Each week has N day-slots
// (one per training day per week) carrying ordered exercise rows that
// can be materialized into WorkoutPlan + WorkoutPlanExercise[].

export interface WorkoutProgramInput {
  weeks: number;
  daysPerWeek: number;
  focus?: string;
  notes?: string;
  /** B-AIB3-126 — client injury areas (enums) and the context v2 block (numbers and enums only). */
  injuryAreas?: readonly InjuryAreaV2[];
  workoutContext?: WorkoutContextV2;
}

export interface WorkoutProgramExerciseRow {
  exercise_external_id: string;
  name: string;
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs?: number | null;
  rest_seconds?: number | null;
  superset_group_id?: string | null;
  notes?: string | null;
}

export interface WorkoutProgramDay {
  week: number;
  day: number;
  name: string;
  type: 'strength' | 'cardio' | 'mobility';
  duration_estimate_minutes?: number;
  exercises: WorkoutProgramExerciseRow[];
}

export interface WorkoutProgramPayload {
  summary: string;
  weeks: number;
  days_per_week: number;
  days: WorkoutProgramDay[];
  coach_notes: string;
}

const SYSTEM = `You are the strength-and-conditioning brain inside The Growth Project.
You are designing a multi-week training block for ONE specific client. Read
the CLIENT_CONTEXT block carefully and obey its constraints:

ABSOLUTE RULES:
1. NEVER prescribe an exercise that loads an area in injury_areas. Use the
   listed substitution for that area and add a one-line note naming the swap.
   The server replaces any exercise that still loads an injury area.
2. ONLY use equipment that appears in profile.equipment_access. If the array is
   empty, design bodyweight programming.
3. Scale volume and intensity to profile.workout_experience.
4. If profile.workout_days_per_week is set, the daysPerWeek input MUST be <= it.
5. If profile.preferred_training_time is set, mention it once in coach_notes so
   the client knows the program was designed with their schedule in mind.
6. Use exercise_external_id as a stable token (e.g. "barbell-back-squat",
   "dumbbell-row"). The downstream system maps these to its ExerciseDB catalog.
7. Tone: confident, direct, zero fluff. No emoji, no exclamation marks.
8. Stay inside hard_limits. Set weight_lbs only for exercises in
   WORKOUT_CONTEXT.client.history_6w, never above the limit; otherwise null.
9. If health_screening is present, keep intensity conservative and tell the
   coach in coach_notes to confirm medical clearance before increasing it.
10. Never make medical claims (cure, treat, heal, rehab, diagnose, therapy).

OUTPUT SCHEMA (return ONLY valid JSON conforming to this shape):
{
  "summary": "<1-2 sentences explaining the block intent>",
  "weeks": <int>,
  "days_per_week": <int>,
  "days": [
    {
      "week": <int 1..weeks>,
      "day": <int 1..days_per_week>,
      "name": "<short day name, e.g. 'Upper A'>",
      "type": "strength" | "cardio" | "mobility",
      "duration_estimate_minutes": <int 20..120>,
      "exercises": [
        {
          "exercise_external_id": "<slug>",
          "name": "<display name>",
          "order": <int 1..>,
          "sets": <int 1..10>,
          "reps_or_duration_seconds": <int>,
          "weight_lbs": <number or null>,
          "rest_seconds": <int or null>,
          "superset_group_id": "<short id or null>",
          "notes": "<short or null>"
        }
      ]
    }
  ],
  "coach_notes": "<3-5 sentences on progression / cues / when to deload>"
}
`;

function validateRow(raw: unknown, weekIdx: number, dayIdx: number): WorkoutProgramExerciseRow {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`week ${weekIdx} day ${dayIdx}: exercise row missing`);
  }
  const o = raw as Record<string, unknown>;
  const exId = String(o.exercise_external_id ?? '').trim();
  if (!exId) throw new Error(`week ${weekIdx} day ${dayIdx}: exercise_external_id required`);
  return {
    exercise_external_id: exId,
    name: String(o.name ?? exId),
    order: numberOf(o.order, 'order'),
    sets: numberOf(o.sets, 'sets'),
    reps_or_duration_seconds: numberOf(o.reps_or_duration_seconds, 'reps_or_duration_seconds'),
    weight_lbs:
      o.weight_lbs == null ? null : numberOf(o.weight_lbs, 'weight_lbs'),
    rest_seconds:
      o.rest_seconds == null ? null : numberOf(o.rest_seconds, 'rest_seconds'),
    superset_group_id:
      o.superset_group_id == null ? null : String(o.superset_group_id),
    notes: o.notes == null ? null : String(o.notes).slice(0, 500),
  };
}

function numberOf(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  throw new Error(`field ${field}: expected number, got ${typeof v}`);
}

export const WorkoutProgramPrompt: CoachAIPrompt<WorkoutProgramInput, WorkoutProgramPayload> = {
  name: 'workout-program',
  version: 'v2',
  system: SYSTEM,
  buildUser(ctx, input) {
    const lines: string[] = [];
    lines.push('GENERATE_WORKOUT_PROGRAM');
    lines.push(`weeks: ${input.weeks}`);
    lines.push(`days_per_week: ${input.daysPerWeek}`);
    if (input.focus) lines.push(`focus: ${sanitizePromptInput(input.focus)}`);
    if (input.notes) lines.push(`coach_notes: ${sanitizePromptInput(input.notes)}`);
    const areas = input.injuryAreas ?? toInjuryAreas(ctx.profile?.injuries);
    if (areas.length > 0) {
      lines.push(`injury_areas: ${areas.join(', ')}`);
      for (const g of substitutionGuide(areas)) lines.push(`substitution: ${g}`);
    }
    lines.push(
      `hard_limits: sets ${PB.setsMin}-${PB.setsMax}; reps 1-30 (timed work 5-${PB.repsOrSecondsMax} seconds); rest 0-${PB.restMax} seconds; ` +
        `at most ${PB.exercisesPerDayMax} exercises per day; weight_lbs at most 5 percent over the last logged weight`,
    );
    if (input.workoutContext?.client?.screening_flag) {
      lines.push('health_screening: the client answered yes to a health screening question');
    }
    if (input.workoutContext) {
      lines.push('WORKOUT_CONTEXT:');
      lines.push(JSON.stringify(input.workoutContext));
    }
    lines.push('---');
    lines.push('CLIENT_CONTEXT:');
    lines.push(JSON.stringify(serializeContextForPrompt(ctx), null, 2));
    return lines.join('\n');
  },
  validate(raw: unknown): WorkoutProgramPayload {
    if (!raw || typeof raw !== 'object') throw new Error('payload must be an object');
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.days)) throw new Error('payload.days must be an array');
    const weeks = numberOf(o.weeks, 'weeks');
    const daysPerWeek = numberOf(o.days_per_week, 'days_per_week');
    const days = o.days.map((d, idx) => {
      if (!d || typeof d !== 'object') throw new Error(`days[${idx}] must be an object`);
      const dd = d as Record<string, unknown>;
      const exercises = Array.isArray(dd.exercises) ? dd.exercises : [];
      return {
        week: numberOf(dd.week, `days[${idx}].week`),
        day: numberOf(dd.day, `days[${idx}].day`),
        name: String(dd.name ?? `Day ${idx + 1}`),
        type:
          dd.type === 'strength' || dd.type === 'cardio' || dd.type === 'mobility'
            ? (dd.type as 'strength' | 'cardio' | 'mobility')
            : 'strength',
        duration_estimate_minutes:
          dd.duration_estimate_minutes == null
            ? undefined
            : numberOf(dd.duration_estimate_minutes, `days[${idx}].duration_estimate_minutes`),
        exercises: exercises.map((row, j) => validateRow(row, idx, j)),
      };
    });
    return {
      summary: String(o.summary ?? ''),
      weeks,
      days_per_week: daysPerWeek,
      days,
      coach_notes: String(o.coach_notes ?? ''),
    };
  },
};

// Light serializer — drops giant arrays so the prompt stays compact.
// B-AIB3-126 (plan section 1): workout generation gets no name, body weight, height, snacks, diet, bio, macros or
// client-written workout notes.
function serializeContextForPrompt(ctx: ClientContext) {
  const p = ctx.profile;
  return {
    profile: {
      goal_type: p.goal_type,
      activity_level: p.activity_level,
      workout_experience: p.workout_experience,
      has_gym_membership: p.has_gym_membership,
      workout_days_per_week: p.workout_days_per_week,
      equipment_access: p.equipment_access,
      preferred_training_time: p.preferred_training_time,
    },
    recent_workouts: ctx.recent_workout_assignments.slice(0, 8).map((a) => ({
      date: a.date,
      completed: a.completed_at !== null,
      post_rpe: a.post_rpe,
      plan_type: a.plan_type,
    })),
    coach: { has_coach: ctx.coach.has_coach },
  };
}
