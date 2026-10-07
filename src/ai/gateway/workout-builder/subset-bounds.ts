// B-815-1 — selective Apply of an AI workout-builder draft. The generator validated the FULL proposal against the per-workout
// and per-week set ceilings and the exercise cap. A subset (e.g. keep an add, untick its matching removal) can land above what
// was validated. Pure re-check of the selected result against the same ceilings: a muscle or the exercise count may exceed a
// ceiling only where the current workout or the validated full proposal already did (the generator's rule).
import { WorkoutDiffApplyError, applyWorkoutDiff } from '../materialisers/__shared/workout-diff.applier';
import { PlanSnapshot, WorkoutDiffOp, WorkoutDiffOpSchema } from '../materialisers/__shared/workout-diff.types';
import { TRAINING_BOUNDS } from './training-safety.constants';
import { setsByMuscle } from './week-limits';

function parseOps(diff: readonly unknown[]): WorkoutDiffOp[] | null {
  const ops: WorkoutDiffOp[] = [];
  for (const raw of diff) {
    const parsed = WorkoutDiffOpSchema.safeParse(raw);
    if (!parsed.success) return null;
    ops.push(parsed.data);
  }
  return ops;
}

function tryApply(baseline: PlanSnapshot, ops: WorkoutDiffOp[]): PlanSnapshot | null {
  try {
    return applyWorkoutDiff(baseline, ops);
  } catch (e) {
    if (e instanceof WorkoutDiffApplyError) return null;
    throw e;
  }
}

export interface WeekLimits { otherSetsByMuscle: ReadonlyMap<string, number>; cap: number }

/**
 * Reason string when applying only `subset` breaks a ceiling the full proposal was held to, else null: hard sets per muscle in
 * this workout (12), per muscle in the program week (24, beginner 16, when `week` is given) and exercises per workout (14).
 * A subset that does not parse or apply is left to the materialiser, which rejects it structurally.
 */
export function subsetLimitBreach(baseline: PlanSnapshot, fullDiff: readonly unknown[], subset: readonly unknown[], week?: WeekLimits | null): string | null {
  const subsetOps = parseOps(subset);
  const after = subsetOps ? tryApply(baseline, subsetOps) : null;
  if (!after) return null;
  const fullOps = parseOps(fullDiff);
  const full = fullOps ? tryApply(baseline, fullOps) : null;
  const [base, proposed, selected] = [setsByMuscle(baseline), full ? setsByMuscle(full) : new Map<string, number>(), setsByMuscle(after)];
  for (const [muscle, sets] of selected) {
    const already = Math.max(base.get(muscle) ?? 0, proposed.get(muscle) ?? 0);
    if (sets <= already) continue;
    if (sets > TRAINING_BOUNDS.hardSetsPerMuscleMax) return `More than ${TRAINING_BOUNDS.hardSetsPerMuscleMax} hard sets for one muscle in a workout.`;
    if (week && sets + (week.otherSetsByMuscle.get(muscle) ?? 0) > week.cap) return `More than ${week.cap} hard sets for one muscle in this program week.`;
  }
  const count = after.exercises.length;
  if (count > TRAINING_BOUNDS.exercisesPerWorkoutMax && count > Math.max(baseline.exercises.length, full?.exercises.length ?? 0)) {
    return `A workout holds at most ${TRAINING_BOUNDS.exercisesPerWorkoutMax} exercises.`;
  }
  return null;
}
