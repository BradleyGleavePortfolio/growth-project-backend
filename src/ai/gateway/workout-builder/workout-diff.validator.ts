// B-AIB2-126 — validation of a model-written diff (SAFE 6/7). Pure. Per change: schema -> library id -> bounds -> loads ->
// screening/deload -> contraindications -> dry-run with the pure applier -> workout caps. Invalid changes are dropped with a reason.
import {
  PlanExerciseSnapshot, PlanSnapshot, WorkoutDiffOp, WorkoutDiffOpSchema, planMetaOpChangesAField, updateExerciseOpChangesAField,
} from '../materialisers/__shared/workout-diff.types';
import { WorkoutDiffApplyError, applyWorkoutDiff } from '../materialisers/__shared/workout-diff.applier';
import {
  INJURY_AREA_LABEL, InjuryArea, MEDICAL_CLAIM_PATTERN, TRAINING_BOUNDS as B, contraindicatedAreas, stripMedicalClaims,
} from './training-safety.constants';

export const QUICK_ACTIONS = ['swap_for_injury', 'progress', 'deload', 'shorten', 'more_volume', 'explain'] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];
export interface LibraryExercise { id: string; name: string; category: string; muscle: string; thumbnail_url: string | null }
export type ChangeKind = 'added' | 'changed' | 'removed' | 'moved' | 'meta';
export interface ValidatedChange {
  change_id: string; kind: ChangeKind; op: WorkoutDiffOp; before: PlanExerciseSnapshot | null; after: PlanExerciseSnapshot | null;
  exercise: { id: string; name: string; thumbnail_url: string | null }; reason: string; warnings: string[];
}
export interface ValidateInput {
  baseline: PlanSnapshot; rawChanges: unknown; library: ReadonlyMap<string, LibraryExercise>; injuries: readonly InjuryArea[];
  instruction: string; screeningFlag: boolean; quickAction?: QuickAction;
  /** Program-week context: hard sets per muscle on the week's OTHER days, and the client's weekly cap (plan section 2). */
  weekly?: { otherSetsByMuscle: ReadonlyMap<string, number>; cap: number };
}
export interface ValidateResult { changes: ValidatedChange[]; dropped: Array<{ reason: string }>; snapshot: PlanSnapshot }

export const MAX_PROPOSED_CHANGES = 40;
const KIND: Record<WorkoutDiffOp['kind'], ChangeKind> = {
  add_exercise: 'added', update_exercise: 'changed', remove_exercise: 'removed', reorder: 'moved', plan_meta: 'meta',
};
// Card title when a change names no single exercise (contract: `exercise` is always present).
const NO_EXERCISE_LABEL: Partial<Record<ChangeKind, string>> = { moved: 'Exercise order', meta: 'Workout details' };
const DEFAULT_REASON: Record<ChangeKind, string> = {
  added: 'Added to match the request.', changed: 'Adjusted to match the request.', removed: 'Removed to match the request.',
  moved: 'Order adjusted to match the request.', meta: 'Workout details updated to match the request.',
};

function isTimed(ex: LibraryExercise | undefined, plan: PlanSnapshot): boolean {
  if (!ex) return plan.meta.type !== 'strength';
  return ex.category === 'cardio' || ex.category === 'mobility' || /plank|hold|carry|stretch|pose/i.test(ex.name);
}
type Fields = { sets?: number; reps_or_duration_seconds?: number; rest_seconds?: number | null };
function boundsError(op: Fields, timed: boolean): string | null {
  if (op.sets !== undefined && (op.sets < B.setsMin || op.sets > B.setsMax)) return `Sets must be ${B.setsMin} to ${B.setsMax}.`;
  const v = op.reps_or_duration_seconds;
  if (v !== undefined && timed && (v < B.durationMinSeconds || v > B.durationMaxSeconds)) {
    return `Duration must be ${B.durationMinSeconds} to ${B.durationMaxSeconds} seconds.`;
  }
  if (v !== undefined && !timed && (v < B.repsMin || v > B.repsMax)) return `Reps must be ${B.repsMin} to ${B.repsMax}.`;
  if (op.rest_seconds != null && (op.rest_seconds < B.restMin || op.rest_seconds > B.restMax)) return `Rest must be ${B.restMin} to ${B.restMax} seconds.`;
  return null;
}

export function setsPerMuscle(snapshot: PlanSnapshot, library: ReadonlyMap<string, LibraryExercise>): Map<string, number> {
  const per = new Map<string, number>();
  for (const row of snapshot.exercises) {
    const ex = library.get(row.exercise_external_id);
    if (ex && ex.category !== 'cardio' && ex.category !== 'mobility') per.set(ex.muscle, (per.get(ex.muscle) ?? 0) + row.sets);
  }
  return per;
}
function maxSetsPerMuscle(snapshot: PlanSnapshot, library: ReadonlyMap<string, LibraryExercise>): number {
  return Math.max(0, ...setsPerMuscle(snapshot, library).values());
}
/** True when `next` takes a muscle's program-week total over the cap AND above where the week already was. */
function overWeeklyCap(current: PlanSnapshot, next: PlanSnapshot, library: ReadonlyMap<string, LibraryExercise>,
  weekly: NonNullable<ValidateInput['weekly']>): boolean {
  const [before, after] = [setsPerMuscle(current, library), setsPerMuscle(next, library)];
  for (const [muscle, sets] of after) {
    const other = weekly.otherSetsByMuscle.get(muscle) ?? 0;
    if (sets + other > weekly.cap && sets > (before.get(muscle) ?? 0)) return true;
  }
  return false;
}

/** One change: null = keep (op may be adjusted in place), string = drop with this reason. */
function checkChange(op: WorkoutDiffOp, before: PlanExerciseSnapshot | null, ex: LibraryExercise | undefined, swaps: boolean,
  input: ValidateInput, current: PlanSnapshot, warnings: string[]): string | null {
  // U1: a workout name the client may see never carries a medical claim.
  if (op.kind === 'plan_meta' && op.name !== undefined && MEDICAL_CLAIM_PATTERN.test(op.name)) return 'Workout names cannot make medical claims.';
  if (op.kind !== 'add_exercise' && op.kind !== 'update_exercise') return null;
  const timed = isTimed(ex, current);
  const err = boundsError(op, timed);
  if (err) return err;
  if (op.notes != null) op.notes = stripMedicalClaims(op.notes, B.notesMax) || null;
  // Loads are never invented: a new row has none (the coach fills it); a changed load needs a current load, max one step.
  let increases = false;
  if (op.kind === 'add_exercise') op.weight_lbs = null;
  if (op.kind === 'update_exercise' && before) {
    if (op.weight_lbs != null && (before.weight_lbs == null || swaps)) delete op.weight_lbs;
    if (op.weight_lbs != null && before.weight_lbs != null && op.weight_lbs > before.weight_lbs * (1 + B.progressLoadMaxPct / 100)) {
      return `Load increase is more than ${B.progressLoadMaxPct} percent in one step.`;
    }
    const reps = op.reps_or_duration_seconds;
    if (!swaps && reps !== undefined && !timed && reps > before.reps_or_duration_seconds + B.progressRepsMax) {
      return `Rep increase is more than ${B.progressRepsMax} in one step.`;
    }
    increases = !swaps && ((op.sets !== undefined && op.sets > before.sets) || (reps !== undefined && reps > before.reps_or_duration_seconds) ||
      (op.weight_lbs != null && op.weight_lbs > (before.weight_lbs ?? 0)));
    if (increases && input.screeningFlag) return 'Intensity stays the same until medical clearance is confirmed.';
    if (increases && input.quickAction === 'deload') return 'A deload does not increase sets, reps or load.';
  }
  // Injury screen: a new or swapped-in exercise, AND more sets / reps / load on an exercise already in the workout.
  if ((swaps || increases) && ex) {
    const areas = contraindicatedAreas(ex, input.injuries);
    const label = areas.map((a) => INJURY_AREA_LABEL[a]).join(' and ');
    const named = input.instruction.toLowerCase().includes(ex.name.toLowerCase());
    if (areas.length > 0 && !named) return `${ex.name} loads the ${label}. The client reported ${label} issues.`;
    if (areas.length > 0) warnings.push(`Loads the ${label}. The client reported ${label} issues.`);
    if (input.injuries.includes('other')) warnings.push('The client reported another injury. Check this exercise suits them.');
  }
  return null;
}

export function validateProposedChanges(input: ValidateInput): ValidateResult {
  const { library } = input;
  const dropped: Array<{ reason: string }> = [];
  const changes: ValidatedChange[] = [];
  let current = input.baseline;
  const baselineIds = new Set(input.baseline.exercises.map((e) => e.exercise_external_id));
  const raw = Array.isArray(input.rawChanges) ? input.rawChanges : [];
  if (raw.length > MAX_PROPOSED_CHANGES) dropped.push({ reason: `Only the first ${MAX_PROPOSED_CHANGES} suggestions were checked.` });
  const setsCap = Math.max(B.hardSetsPerMuscleMax, maxSetsPerMuscle(current, library));
  for (const item of raw.slice(0, MAX_PROPOSED_CHANGES)) {
    const rec: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
    const parsed = WorkoutDiffOpSchema.safeParse(rec.op);
    if (!parsed.success) { dropped.push({ reason: 'Not a valid workout change.' }); continue; }
    const op: WorkoutDiffOp = { ...parsed.data };
    if (op.kind === 'update_exercise' && !updateExerciseOpChangesAField(op)) continue;
    if (op.kind === 'plan_meta' && !planMetaOpChangesAField(op)) continue;
    const hasRef = op.kind === 'update_exercise' || op.kind === 'remove_exercise';
    const before = hasRef ? current.exercises.find((e) => e.client_ref === op.client_ref) ?? null : null;
    if (hasRef && !before) { dropped.push({ reason: 'Refers to an exercise that is not in this workout.' }); continue; }
    const exId = op.kind === 'add_exercise' ? op.exercise_external_id
      : op.kind === 'update_exercise' ? op.exercise_external_id ?? before?.exercise_external_id ?? null : null;
    const cardId = exId ?? before?.exercise_external_id ?? null;
    const ex = exId ? library.get(exId) : undefined;
    const swaps = op.kind === 'add_exercise' ||
      (op.kind === 'update_exercise' && op.exercise_external_id !== undefined && op.exercise_external_id !== before?.exercise_external_id);
    if (swaps && exId && !library.has(exId) && !baselineIds.has(exId)) { dropped.push({ reason: 'Not in your exercise library.' }); continue; }
    const warnings: string[] = [];
    const why = checkChange(op, before, ex, swaps, input, current, warnings);
    if (why) { dropped.push({ reason: why }); continue; }
    if (op.kind === 'update_exercise' && !updateExerciseOpChangesAField(op)) continue;
    let next: PlanSnapshot;
    try {
      next = applyWorkoutDiff(current, [op]);
    } catch (e) {
      if (!(e instanceof WorkoutDiffApplyError)) throw e;
      dropped.push({ reason: 'Does not fit the current workout.' });
      continue;
    }
    if (next.exercises.length > B.exercisesPerWorkoutMax && next.exercises.length > current.exercises.length) {
      dropped.push({ reason: `A workout holds at most ${B.exercisesPerWorkoutMax} exercises.` });
      continue;
    }
    const setsAfter = maxSetsPerMuscle(next, library);
    if (setsAfter > setsCap && setsAfter > maxSetsPerMuscle(current, library)) {
      dropped.push({ reason: `More than ${B.hardSetsPerMuscleMax} hard sets for one muscle in a workout.` });
      continue;
    }
    if (input.weekly && overWeeklyCap(current, next, library, input.weekly)) {
      dropped.push({ reason: `More than ${input.weekly.cap} hard sets for one muscle in this program week.` });
      continue;
    }
    const kind = KIND[op.kind];
    const after = op.kind === 'add_exercise' || op.kind === 'update_exercise'
      ? next.exercises.find((e) => e.client_ref === op.client_ref) ?? null : null;
    const reason = typeof rec.reason === 'string' ? stripMedicalClaims(rec.reason, B.reasonMax) : '';
    changes.push({
      change_id: `c${changes.length}`, kind, op, before, after, warnings, reason: reason || DEFAULT_REASON[kind],
      exercise: cardId
        ? { id: cardId, name: library.get(cardId)?.name ?? 'Exercise in this workout', thumbnail_url: library.get(cardId)?.thumbnail_url ?? null }
        : { id: '', name: NO_EXERCISE_LABEL[kind] ?? 'Workout', thumbnail_url: null },
    });
    current = next;
  }
  return { changes, dropped, snapshot: current };
}
