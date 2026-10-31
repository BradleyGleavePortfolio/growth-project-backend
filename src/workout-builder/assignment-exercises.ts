/**
 * The exercise list a client actually sees on an assignment (MWB-1 §3.3):
 * the frozen snapshot when there is one, else the live (non-archived)
 * workout_plan.exercises join of a pre-MWB-1 assignment. Shared by the
 * assignment presenter and the exercise-video mint check (WK-1-BE), so a
 * signed link follows exactly what the client is shown.
 */
export function visibleAssignmentExercises(assignment: {
  snapshot?: { exercises_json: unknown } | null;
  workout_plan?: { exercises?: unknown[] } | null;
}): unknown[] {
  if (assignment.snapshot) {
    const frozen = assignment.snapshot.exercises_json;
    return Array.isArray(frozen) ? (frozen as unknown[]) : [];
  }
  return assignment.workout_plan?.exercises ?? [];
}
