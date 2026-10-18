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
