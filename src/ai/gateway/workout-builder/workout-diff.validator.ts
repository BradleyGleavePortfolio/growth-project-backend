/**
 * B-AIB2-126 — server-side validation of a model-written workout diff (plan
 * section 2, SAFE 6 and 7). Pure: no I/O, deterministic, unit-tested.
 *
 * Order per proposed change: WorkoutDiffOpSchema -> library-id check -> hard
 * bounds -> screening / deload intensity rule -> contraindication filter ->
 * dry-run on the current snapshot with the pure applier -> workout-level caps.
 * An invalid change is dropped with a coach-facing reason and never written.
 */
import {
  PlanExerciseSnapshot,
  PlanSnapshot,
  WorkoutDiffOp,
  WorkoutDiffOpSchema,
  planMetaOpChangesAField,
  updateExerciseOpChangesAField,
} from '../materialisers/__shared/workout-diff.types';
import {
  WorkoutDiffApplyError,
  applyWorkoutDiff,
} from '../materialisers/__shared/workout-diff.applier';
import {
  INJURY_AREA_LABEL,
  InjuryArea,
  TRAINING_BOUNDS as B,
  contraindicatedAreas,
  stripMedicalClaims,
} from './training-safety.constants';

export const QUICK_ACTIONS = [
  'swap_for_injury',
  'progress',
  'deload',
  'shorten',
  'more_volume',
  'explain',
] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

export interface LibraryExercise {
  id: string;
  name: string;
  /** bodyPart / category, e.g. chest, cardio, mobility. */
  category: string;
  /** primary muscle, used for the hard-sets-per-muscle cap. */
  muscle: string;
  thumbnail_url: string | null;
}

export type ChangeKind = 'added' | 'changed' | 'removed' | 'moved' | 'meta';

export interface ValidatedChange {
  change_id: string;
  kind: ChangeKind;
  op: WorkoutDiffOp;
  before: PlanExerciseSnapshot | null;
  after: PlanExerciseSnapshot | null;
  exercise: { id: string; name: string; thumbnail_url: string | null } | null;
  reason: string;
  warnings: string[];
}

export interface ValidateInput {
  baseline: PlanSnapshot;
  rawChanges: unknown;
  library: ReadonlyMap<string, LibraryExercise>;
  injuries: readonly InjuryArea[];
  instruction: string;
  screeningFlag: boolean;
  quickAction?: QuickAction;
}

export interface ValidateResult {
  changes: ValidatedChange[];
  dropped: Array<{ reason: string }>;
  snapshot: PlanSnapshot;
}

export const MAX_PROPOSED_CHANGES = 40;

const KIND: Record<WorkoutDiffOp['kind'], ChangeKind> = {
  add_exercise: 'added',
  update_exercise: 'changed',
  remove_exercise: 'removed',
  reorder: 'moved',
  plan_meta: 'meta',
};

const DEFAULT_REASON: Record<ChangeKind, string> = {
  added: 'Added to match the request.',
  changed: 'Adjusted to match the request.',
  removed: 'Removed to match the request.',
  moved: 'Order adjusted to match the request.',
  meta: 'Workout details updated to match the request.',
};

const NOT_IN_LIBRARY = 'Not in your exercise library.';

function isTimed(ex: LibraryExercise | undefined, plan: PlanSnapshot): boolean {
  if (!ex) return plan.meta.type !== 'strength';
  return (
    ex.category === 'cardio' ||
    ex.category === 'mobility' ||
    /plank|hold|carry|stretch|pose/i.test(ex.name)
  );
}

function boundsError(
  op: { sets?: number; reps_or_duration_seconds?: number; rest_seconds?: number | null; notes?: string | null },
  timed: boolean,
): string | null {
  if (op.sets !== undefined && (op.sets < B.setsMin || op.sets > B.setsMax)) {
    return `Sets must be ${B.setsMin} to ${B.setsMax}.`;
  }
  const v = op.reps_or_duration_seconds;
  if (v !== undefined) {
    if (timed && (v < B.durationMinSeconds || v > B.durationMaxSeconds)) {
      return `Duration must be ${B.durationMinSeconds} to ${B.durationMaxSeconds} seconds.`;
    }
    if (!timed && (v < B.repsMin || v > B.repsMax)) {
      return `Reps must be ${B.repsMin} to ${B.repsMax}.`;
    }
  }
  if (op.rest_seconds != null && (op.rest_seconds < B.restMin || op.rest_seconds > B.restMax)) {
    return `Rest must be ${B.restMin} to ${B.restMax} seconds.`;
  }
  return null;
}

/** Hard sets per primary muscle across the workout. */
function maxSetsPerMuscle(snapshot: PlanSnapshot, library: ReadonlyMap<string, LibraryExercise>): number {
  const per = new Map<string, number>();
  for (const row of snapshot.exercises) {
    const ex = library.get(row.exercise_external_id);
    if (!ex || ex.category === 'cardio' || ex.category === 'mobility') continue;
    per.set(ex.muscle, (per.get(ex.muscle) ?? 0) + row.sets);
  }
  return Math.max(0, ...per.values());
}

function mentions(instruction: string, name: string): boolean {
  return name.length > 0 && instruction.toLowerCase().includes(name.toLowerCase());
}

export function validateProposedChanges(input: ValidateInput): ValidateResult {
  const { library, injuries, instruction } = input;
  const dropped: Array<{ reason: string }> = [];
  const changes: ValidatedChange[] = [];
  let current = input.baseline;
  const baselineIds = new Set(input.baseline.exercises.map((e) => e.exercise_external_id));
  const raw = Array.isArray(input.rawChanges) ? input.rawChanges : [];
  if (raw.length > MAX_PROPOSED_CHANGES) {
    dropped.push({ reason: `Only the first ${MAX_PROPOSED_CHANGES} suggestions were checked.` });
  }
  const limitSetsBefore = maxSetsPerMuscle(current, library);

  for (const item of raw.slice(0, MAX_PROPOSED_CHANGES)) {
    const rawOp = item && typeof item === 'object' ? (item as Record<string, unknown>).op : undefined;
    const rawReason = item && typeof item === 'object' ? (item as Record<string, unknown>).reason : undefined;
    const parsed = WorkoutDiffOpSchema.safeParse(rawOp);
    if (!parsed.success) {
      dropped.push({ reason: 'Not a valid workout change.' });
      continue;
    }
    const op: WorkoutDiffOp = { ...parsed.data };
    const warnings: string[] = [];
    if (op.kind === 'update_exercise' && !updateExerciseOpChangesAField(op)) continue;
    if (op.kind === 'plan_meta' && !planMetaOpChangesAField(op)) continue;

    const before =
      op.kind === 'update_exercise' || op.kind === 'remove_exercise'
        ? current.exercises.find((e) => e.client_ref === op.client_ref) ?? null
        : null;
    if ((op.kind === 'update_exercise' || op.kind === 'remove_exercise') && !before) {
      dropped.push({ reason: 'Refers to an exercise that is not in this workout.' });
      continue;
    }

    let exId: string | null = null;
    if (op.kind === 'add_exercise') exId = op.exercise_external_id;
    if (op.kind === 'update_exercise') exId = op.exercise_external_id ?? before?.exercise_external_id ?? null;
    const ex = exId ? library.get(exId) : undefined;
    const swapsExercise =
      op.kind === 'add_exercise' ||
      (op.kind === 'update_exercise' && op.exercise_external_id !== undefined && op.exercise_external_id !== before?.exercise_external_id);

    if (swapsExercise && exId && !library.has(exId) && !baselineIds.has(exId)) {
      dropped.push({ reason: NOT_IN_LIBRARY });
      continue;
    }

    if (op.kind === 'add_exercise' || op.kind === 'update_exercise') {
      const err = boundsError(op, isTimed(ex, current));
      if (err) {
        dropped.push({ reason: err });
        continue;
      }
      if (op.notes != null) op.notes = stripMedicalClaims(op.notes, B.notesMax) || null;

      // Loads: never invented. A new row carries no load (the coach fills it);
      // a changed load needs a current load and stays within one progress step.
      if (op.kind === 'add_exercise' && op.weight_lbs != null) op.weight_lbs = null;
      if (op.kind === 'update_exercise' && op.weight_lbs != null) {
        const cur = before?.weight_lbs ?? null;
        if (cur == null || swapsExercise) {
          delete op.weight_lbs;
        } else if (op.weight_lbs > cur * (1 + B.progressLoadMaxPct / 100)) {
          dropped.push({ reason: `Load increase is more than ${B.progressLoadMaxPct} percent in one step.` });
          continue;
        }
      }
      if (op.kind === 'update_exercise' && before && !swapsExercise) {
        if (
          op.reps_or_duration_seconds !== undefined &&
          !isTimed(ex, current) &&
          op.reps_or_duration_seconds > before.reps_or_duration_seconds + B.progressRepsMax
        ) {
          dropped.push({ reason: `Rep increase is more than ${B.progressRepsMax} in one step.` });
          continue;
        }
        const increases =
          (op.sets !== undefined && op.sets > before.sets) ||
          (op.reps_or_duration_seconds !== undefined && op.reps_or_duration_seconds > before.reps_or_duration_seconds) ||
          (op.weight_lbs != null && op.weight_lbs > (before.weight_lbs ?? 0));
        if (increases && input.screeningFlag) {
          dropped.push({ reason: 'Intensity stays the same until medical clearance is confirmed.' });
          continue;
        }
        if (increases && input.quickAction === 'deload') {
          dropped.push({ reason: 'A deload does not increase sets, reps or load.' });
          continue;
        }
      }
      if (op.kind === 'update_exercise' && !updateExerciseOpChangesAField(op)) continue;

      if (swapsExercise && ex) {
        const areas = contraindicatedAreas(ex, injuries);
        if (areas.length > 0) {
          const label = areas.map((a) => INJURY_AREA_LABEL[a]).join(' and ');
          if (!mentions(instruction, ex.name)) {
            dropped.push({ reason: `${ex.name} loads the ${label}. The client reported ${label} issues.` });
            continue;
          }
          warnings.push(`Loads the ${label}. The client reported ${label} issues.`);
        }
        if (injuries.includes('other')) {
          warnings.push('The client reported another injury. Check this exercise suits them.');
        }
      }
    }

    let next: PlanSnapshot;
    try {
      next = applyWorkoutDiff(current, [op]);
    } catch (e) {
      if (e instanceof WorkoutDiffApplyError) {
        dropped.push({ reason: 'Does not fit the current workout.' });
        continue;
      }
      throw e;
    }
    if (next.exercises.length > B.exercisesPerWorkoutMax && next.exercises.length > current.exercises.length) {
      dropped.push({ reason: `A workout holds at most ${B.exercisesPerWorkoutMax} exercises.` });
      continue;
    }
    const setsAfter = maxSetsPerMuscle(next, library);
    if (setsAfter > Math.max(B.hardSetsPerMuscleMax, limitSetsBefore) && setsAfter > maxSetsPerMuscle(current, library)) {
      dropped.push({ reason: `More than ${B.hardSetsPerMuscleMax} hard sets for one muscle in a workout.` });
      continue;
    }

    const kind = KIND[op.kind];
    const after =
      op.kind === 'add_exercise' || op.kind === 'update_exercise'
        ? next.exercises.find((e) => e.client_ref === op.client_ref) ?? null
        : null;
    const reasonText = typeof rawReason === 'string' ? stripMedicalClaims(rawReason, B.reasonMax) : '';
    changes.push({
      change_id: `c${changes.length}`,
      kind,
      op,
      before,
      after,
      exercise: exId ? { id: exId, name: ex?.name ?? exId, thumbnail_url: ex?.thumbnail_url ?? null } : null,
      reason: reasonText || DEFAULT_REASON[kind],
      warnings,
    });
    current = next;
  }

  return { changes, dropped, snapshot: current };
}

/**
 * Subset of an approved draft's diff: only the accepted change ids (`c<i>`
 * = diff index i). A `reorder` op depends on every other op (it lists the
 * final refs), so it is kept only when every non-reorder op is accepted.
 */
export function selectAcceptedOps<T extends { kind: string }>(
  diff: readonly T[],
  acceptedChangeIds: readonly string[],
): T[] {
  const accepted = new Set(acceptedChangeIds);
  const allOthersAccepted = diff.every((op, i) => op.kind === 'reorder' || accepted.has(`c${i}`));
  return diff.filter(
    (op, i) => accepted.has(`c${i}`) && (op.kind !== 'reorder' || allOthersAccepted),
  );
}
