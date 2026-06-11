/**
 * MWB-5 — pure workout-plan diff applier (NO I/O).
 *
 * This is the integrity boundary of the entire live-create flow (brief R0 /
 * §"Reminder"). Given an in-memory `PlanSnapshot` and a validated
 * `WorkoutDiffOp[]`, it returns a NEW snapshot with the ops applied in order.
 * It performs ZERO I/O — no Prisma, no clock, no randomness — so it is
 * deterministic and exhaustively unit-testable in isolation. Both
 * materialisers (create + edit) route ALL plan mutation through this single
 * function so the two paths can never diverge.
 *
 * Invariants this function guarantees (each covered by the exhaustive matrix in
 * `test/mwb-5-workout-diff.applier.spec.ts`):
 *   I1. INPUT IMMUTABILITY — the supplied baseline is never mutated; a deep
 *       copy is taken first. Callers may reuse the baseline after the call.
 *   I2. ORDER IS DERIVED — the result's exercise `order` values are always
 *       0-based and contiguous in final list position. A diff op can never set
 *       `order` directly, so sparse/duplicate orders are impossible to persist.
 *   I3. STABLE REFS — every op addresses exercises by `client_ref`. Adding a
 *       duplicate ref, or updating/removing a missing ref, throws
 *       `WorkoutDiffApplyError` (never a silent no-op or overwrite — R0).
 *   I4. REORDER TOTALITY — `reorder` must list every current ref exactly once;
 *       a missing/extra/duplicate ref throws. A partial reorder can never drop
 *       or duplicate a row.
 *   I5. EMPTY DIFF IS A NO-OP — an empty op list returns a faithful (deep) copy
 *       of the baseline, unchanged. (Materialiser payload schemas separately
 *       require >= 1 op at the API boundary; the applier itself tolerates an
 *       empty list so the no-op case is well-defined and testable.)
 *
 * The applier re-validates each op against the zod schema (defence-in-depth):
 * a payload that drifted via direct DB write cannot drive a malformed op
 * through materialisation.
 */

import {
  AddExerciseOp,
  PlanExerciseSnapshot,
  PlanMetaOp,
  PlanSnapshot,
  RemoveExerciseOp,
  ReorderOp,
  UpdateExerciseOp,
  WorkoutDiffOp,
  WorkoutDiffOpInput,
  WorkoutDiffOpSchema,
  planMetaOpChangesAField,
  updateExerciseOpChangesAField,
} from './workout-diff.types';

/**
 * Thrown when a diff op is internally consistent (passes zod) but cannot be
 * applied to the given snapshot — e.g. adding a duplicate ref, updating a
 * missing ref, or a reorder whose ref set does not match the snapshot. The
 * materialisers map this to a recoverable 4xx (never a leaked 500), so a
 * bad-but-not-malicious diff produces a clear, retryable error rather than a
 * crash.
 */
export class WorkoutDiffApplyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'DUPLICATE_REF'
      | 'UNKNOWN_REF'
      | 'REORDER_MISMATCH'
      | 'MALFORMED_OP',
    readonly opIndex: number,
  ) {
    super(message);
    this.name = 'WorkoutDiffApplyError';
  }
}

/** Deep-copy a single exercise snapshot (no shared references — I1). */
function cloneExercise(e: PlanExerciseSnapshot): PlanExerciseSnapshot {
  return {
    client_ref: e.client_ref,
    exercise_external_id: e.exercise_external_id,
    order: e.order,
    sets: e.sets,
    reps_or_duration_seconds: e.reps_or_duration_seconds,
    weight_lbs: e.weight_lbs,
    rest_seconds: e.rest_seconds,
    superset_group_id: e.superset_group_id,
    notes: e.notes,
  };
}

/** Deep-copy a whole plan snapshot (I1). */
function cloneSnapshot(snapshot: PlanSnapshot): PlanSnapshot {
  return {
    meta: { ...snapshot.meta },
    exercises: snapshot.exercises.map(cloneExercise),
  };
}

/**
 * Re-number every exercise to its 0-based contiguous list position (I2). Called
 * after EVERY structural mutation (add / remove / reorder) so the result is
 * always canonical, regardless of what the ops requested.
 */
function renumber(exercises: PlanExerciseSnapshot[]): void {
  for (let i = 0; i < exercises.length; i++) {
    exercises[i].order = i;
  }
}

function indexOfRef(
  exercises: PlanExerciseSnapshot[],
  ref: string,
): number {
  return exercises.findIndex((e) => e.client_ref === ref);
}

function applyAdd(
  exercises: PlanExerciseSnapshot[],
  op: AddExerciseOp,
  opIndex: number,
): void {
  if (indexOfRef(exercises, op.client_ref) !== -1) {
    throw new WorkoutDiffApplyError(
      `add_exercise: client_ref '${op.client_ref}' already exists in the plan`,
      'DUPLICATE_REF',
      opIndex,
    );
  }
  exercises.push({
    client_ref: op.client_ref,
    exercise_external_id: op.exercise_external_id,
    // order is set authoritatively by renumber() below; this placeholder is
    // overwritten before the snapshot is returned.
    order: exercises.length,
    sets: op.sets,
    reps_or_duration_seconds: op.reps_or_duration_seconds,
    weight_lbs: op.weight_lbs ?? null,
    rest_seconds: op.rest_seconds ?? null,
    superset_group_id: op.superset_group_id ?? null,
    notes: op.notes ?? null,
  });
  renumber(exercises);
}

function applyUpdate(
  exercises: PlanExerciseSnapshot[],
  op: UpdateExerciseOp,
  opIndex: number,
): void {
  // Defence-in-depth: the gateway rejects an empty patch at draft creation, but
  // a drifted payload must not slip a no-field update through (would be a silent
  // no-op masquerading as an edit — R0).
  if (!updateExerciseOpChangesAField(op)) {
    throw new WorkoutDiffApplyError(
      `update_exercise: op for client_ref '${op.client_ref}' changes no field`,
      'MALFORMED_OP',
      opIndex,
    );
  }
  const i = indexOfRef(exercises, op.client_ref);
  if (i === -1) {
    throw new WorkoutDiffApplyError(
      `update_exercise: client_ref '${op.client_ref}' not found in the plan`,
      'UNKNOWN_REF',
      opIndex,
    );
  }
  const row = exercises[i];
  // Patch ONLY the fields the op carries (true patch, not replace). `notes`,
  // `weight_lbs`, `rest_seconds`, `superset_group_id` are explicitly nullable,
  // so we distinguish "field omitted" (undefined → leave as-is) from "field set
  // to null" (clear it). zod gives us `undefined` for omitted optionals.
  if (op.exercise_external_id !== undefined) {
    row.exercise_external_id = op.exercise_external_id;
  }
  if (op.sets !== undefined) row.sets = op.sets;
  if (op.reps_or_duration_seconds !== undefined) {
    row.reps_or_duration_seconds = op.reps_or_duration_seconds;
  }
  if (op.weight_lbs !== undefined) row.weight_lbs = op.weight_lbs;
  if (op.rest_seconds !== undefined) row.rest_seconds = op.rest_seconds;
  if (op.superset_group_id !== undefined) {
    row.superset_group_id = op.superset_group_id;
  }
  if (op.notes !== undefined) row.notes = op.notes;
  // No structural change → order is unaffected, but renumber is cheap and keeps
  // the post-condition (I2) unconditional. Position is unchanged so orders are
  // identical; we still call it for uniformity.
  renumber(exercises);
}

function applyRemove(
  exercises: PlanExerciseSnapshot[],
  op: RemoveExerciseOp,
  opIndex: number,
): void {
  const i = indexOfRef(exercises, op.client_ref);
  if (i === -1) {
    throw new WorkoutDiffApplyError(
      `remove_exercise: client_ref '${op.client_ref}' not found in the plan`,
      'UNKNOWN_REF',
      opIndex,
    );
  }
  exercises.splice(i, 1);
  renumber(exercises);
}

function applyReorder(
  exercises: PlanExerciseSnapshot[],
  op: ReorderOp,
  opIndex: number,
): PlanExerciseSnapshot[] {
  const current = new Set(exercises.map((e) => e.client_ref));
  const requested = op.ordered_client_refs;
  const requestedSet = new Set(requested);
  // Duplicate ref in the request (set smaller than array → at least one dup).
  if (requestedSet.size !== requested.length) {
    throw new WorkoutDiffApplyError(
      'reorder: ordered_client_refs contains duplicate refs',
      'REORDER_MISMATCH',
      opIndex,
    );
  }
  // Exact-set equality both directions (I4): no missing, no extra refs.
  if (requested.length !== current.size) {
    throw new WorkoutDiffApplyError(
      `reorder: expected ${current.size} refs, got ${requested.length}`,
      'REORDER_MISMATCH',
      opIndex,
    );
  }
  for (const ref of requested) {
    if (!current.has(ref)) {
      throw new WorkoutDiffApplyError(
        `reorder: client_ref '${ref}' is not in the plan`,
        'REORDER_MISMATCH',
        opIndex,
      );
    }
  }
  const byRef = new Map(exercises.map((e) => [e.client_ref, e]));
  // Non-null assertion is safe: the exact-set checks above prove every
  // requested ref resolves.
  const reordered = requested.map((ref) => byRef.get(ref) as PlanExerciseSnapshot);
  renumber(reordered);
  return reordered;
}

function applyPlanMeta(
  snapshot: PlanSnapshot,
  op: PlanMetaOp,
  opIndex: number,
): void {
  // Defence-in-depth: reject a no-field plan_meta op (see applyUpdate).
  if (!planMetaOpChangesAField(op)) {
    throw new WorkoutDiffApplyError(
      'plan_meta: op changes no field',
      'MALFORMED_OP',
      opIndex,
    );
  }
  if (op.name !== undefined) snapshot.meta.name = op.name;
  if (op.type !== undefined) snapshot.meta.type = op.type;
  if (op.duration_estimate_minutes !== undefined) {
    snapshot.meta.duration_estimate_minutes = op.duration_estimate_minutes;
  }
}

/**
 * Apply a validated diff to a baseline snapshot and return a NEW snapshot.
 *
 * - The baseline is never mutated (I1): a deep copy is taken up front.
 * - Each op is re-validated against `WorkoutDiffOpSchema` before being applied
 *   (defence-in-depth): a drifted op throws `WorkoutDiffApplyError(MALFORMED_OP)`.
 * - Ops apply in array order; later ops observe the effects of earlier ones.
 * - An empty `ops` array returns a faithful copy of the baseline (I5 no-op).
 *
 * @throws {WorkoutDiffApplyError} on a structurally valid but unapplicable op.
 */
export function applyWorkoutDiff(
  baseline: PlanSnapshot,
  // Accepts either parsed ops (`WorkoutDiffOp`) or raw input-shape ops
  // (`WorkoutDiffOpInput`, defaulted fields omitted). Each op is re-parsed
  // below, so both are safe; the union spares callers a cast.
  ops: ReadonlyArray<WorkoutDiffOp | WorkoutDiffOpInput>,
): PlanSnapshot {
  const next = cloneSnapshot(baseline);

  ops.forEach((rawOp, opIndex) => {
    // Defence-in-depth: re-validate the op shape. The gateway validated at
    // draft-creation, but a payload that drifted via a direct DB write or a
    // migration bug must not drive a malformed op through here.
    const parsed = WorkoutDiffOpSchema.safeParse(rawOp);
    if (!parsed.success) {
      throw new WorkoutDiffApplyError(
        `op[${opIndex}] failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
        'MALFORMED_OP',
        opIndex,
      );
    }
    const op = parsed.data;
    switch (op.kind) {
      case 'add_exercise':
        applyAdd(next.exercises, op, opIndex);
        break;
      case 'update_exercise':
        applyUpdate(next.exercises, op, opIndex);
        break;
      case 'remove_exercise':
        applyRemove(next.exercises, op, opIndex);
        break;
      case 'reorder':
        next.exercises = applyReorder(next.exercises, op, opIndex);
        break;
      case 'plan_meta':
        applyPlanMeta(next, op, opIndex);
        break;
      default: {
        // Exhaustiveness guard: if a new op kind is added to the union without
        // a branch here, TypeScript fails the build (`op` would not be `never`).
        const unreachable: never = op;
        throw new WorkoutDiffApplyError(
          `unhandled diff op kind: ${JSON.stringify(unreachable)}`,
          'MALFORMED_OP',
          opIndex,
        );
      }
    }
  });

  // Final post-condition: orders are 0-based contiguous regardless of path (I2).
  renumber(next.exercises);
  return next;
}
