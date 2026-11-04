/**
 * C1V2-C1: the coach's swaps (WorkoutPlanExercise.alternative_external_ids)
 * as a planned-exercise row has them, for every copy of that row: a save and
 * its revision, a fork, clone, program delivery, copied or duplicated day, an
 * assignment snapshot (coach or AI assign), an Ask AI create or edit, an
 * autosave, an undo and a Roman adjustment. A fresh list of strings, or
 * undefined for a row frozen before swaps existed (read as none).
 */
export function alternativesOf(row: unknown): string[] | undefined {
  const v = (row as { alternative_external_ids?: unknown } | null)?.alternative_external_ids;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

export const PLAN_EXERCISE_UNITS = ['reps', 'seconds'] as const;
export type PlanExerciseUnitValue = (typeof PLAN_EXERCISE_UNITS)[number];

/**
 * TIMED-SETS-BE: whether a planned-exercise row's reps_or_duration_seconds is
 * reps or seconds (WorkoutPlanExercise.unit), for the same copies as the swaps
 * above and every read that sends the row to the phone. A row that says its
 * unit keeps it. A row without one (a snapshot frozen before units, or a
 * request without the field) reads as the migration read the stored rows:
 * seconds only when its program note starts "SECONDS." (the consultation
 * programs' own marker), otherwise reps. The number is never used to guess.
 */
export function unitOf(row: unknown): PlanExerciseUnitValue {
  const r = row as { unit?: unknown; notes?: unknown } | null;
  const unit = r?.unit;
  if (unit === 'seconds' || unit === 'reps') return unit;
  const notes = r?.notes;
  return typeof notes === 'string' && notes.startsWith('SECONDS.') ? 'seconds' : 'reps';
}
