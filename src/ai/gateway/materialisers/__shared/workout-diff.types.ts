/**
 * MWB-5 — typed workout-plan diff ops (shared by both live-create materialisers).
 *
 * A `WorkoutDiffOp[]` is the model-produced edit script that `draft.payload.diff`
 * carries. It is filled by the model BEFORE the coach approves the draft; the
 * materialiser NEVER calls the model — materialisation only applies the diff to
 * an in-memory plan snapshot and writes the resulting rows (see brief
 * §"Anti-scope": capability materialisation does NOT call the model).
 *
 * The applier (`workout-diff.applier.ts`) is the integrity boundary of the whole
 * live-create flow: it is a PURE function with NO I/O, exhaustively unit-tested.
 * These zod schemas are the single source of truth for the op shapes both the
 * gateway (draft-creation validation) and the applier (apply-time re-validation)
 * consume — defence-in-depth against a payload that drifted via direct DB write.
 *
 * Design notes:
 *   - Every exercise is addressed by a STABLE client-supplied `client_ref`
 *     (an opaque string the model assigns), NOT by array position. Position is
 *     fragile under concurrent edits and reorders; a stable ref lets `update`
 *     and `remove` target a row even after other ops shuffle the list. The
 *     materialiser maps `client_ref` -> persisted row id when it writes.
 *   - `order` is DERIVED by the applier from final list position (0-based,
 *     contiguous), never trusted from the op — so a model that emits sparse or
 *     duplicate orders can never corrupt the plan. `reorder` is the ONLY op that
 *     expresses ordering, and it does so by listing refs in the desired order.
 *   - Numeric bounds mirror the human builder's column semantics (sets >= 1,
 *     reps_or_duration_seconds >= 1) so an AI-authored plan can never persist a
 *     row the manual path would reject.
 */

import { z } from 'zod';

/** Discriminator literals for the diff op union. Exported for exhaustive switches. */
export const WORKOUT_DIFF_OP_KINDS = [
  'add_exercise',
  'update_exercise',
  'remove_exercise',
  'reorder',
  'plan_meta',
] as const;

export type WorkoutDiffOpKind = (typeof WORKOUT_DIFF_OP_KINDS)[number];

/** Allowed plan types — mirrors the Prisma `WorkoutPlanType` enum exactly. */
export const WORKOUT_PLAN_TYPES = ['strength', 'cardio', 'mobility'] as const;
export type WorkoutPlanTypeLiteral = (typeof WORKOUT_PLAN_TYPES)[number];

// A non-empty, trimmed, bounded opaque client ref. Bounded so a hostile or
// buggy payload can't smuggle a megabyte string into a map key.
const ClientRefSchema = z
  .string()
  .min(1, { message: 'client_ref must not be empty' })
  .max(128, { message: 'client_ref exceeds 128 chars' })
  .refine((s) => s.trim().length > 0, {
    message: 'client_ref must not be whitespace-only',
  });

// An ExerciseDB catalog identifier — NOT an FK to an internal table (matches
// WorkoutPlanExercise.exercise_external_id semantics).
const ExternalExerciseIdSchema = z
  .string()
  .min(1, { message: 'exercise_external_id must not be empty' })
  .max(128, { message: 'exercise_external_id exceeds 128 chars' });

const NotesSchema = z
  .string()
  .max(1000, { message: 'notes exceeds 1000 chars' })
  .nullable();

// Shared exercise attribute bounds. `sets` and `reps_or_duration_seconds` are
// the two NOT-NULL columns on WorkoutPlanExercise; the rest are nullable.
const SetsSchema = z
  .number()
  .int({ message: 'sets must be an integer' })
  .min(1, { message: 'sets must be >= 1' })
  .max(100, { message: 'sets must be <= 100' });

const RepsOrDurationSchema = z
  .number()
  .int({ message: 'reps_or_duration_seconds must be an integer' })
  .min(1, { message: 'reps_or_duration_seconds must be >= 1' })
  .max(86_400, { message: 'reps_or_duration_seconds must be <= 86400' });

const WeightLbsSchema = z
  .number()
  .min(0, { message: 'weight_lbs must be >= 0' })
  .max(10_000, { message: 'weight_lbs must be <= 10000' })
  .nullable();

const RestSecondsSchema = z
  .number()
  .int({ message: 'rest_seconds must be an integer' })
  .min(0, { message: 'rest_seconds must be >= 0' })
  .max(86_400, { message: 'rest_seconds must be <= 86400' })
  .nullable();

const SupersetGroupSchema = z
  .string()
  .min(1)
  .max(128, { message: 'superset_group_id exceeds 128 chars' })
  .nullable();

/**
 * `add_exercise` — insert a new exercise row addressed by `client_ref`.
 * The applier rejects a duplicate `client_ref` (an add for a ref already in the
 * snapshot is a programming error, never a silent overwrite). Final `order` is
 * derived by the applier, not taken from the op.
 */
export const AddExerciseOpSchema = z
  .object({
    kind: z.literal('add_exercise'),
    client_ref: ClientRefSchema,
    exercise_external_id: ExternalExerciseIdSchema,
    sets: SetsSchema,
    reps_or_duration_seconds: RepsOrDurationSchema,
    weight_lbs: WeightLbsSchema.optional().default(null),
    rest_seconds: RestSecondsSchema.optional().default(null),
    superset_group_id: SupersetGroupSchema.optional().default(null),
    notes: NotesSchema.optional().default(null),
  })
  .strict();
export type AddExerciseOp = z.infer<typeof AddExerciseOpSchema>;

/**
 * `update_exercise` — patch an existing exercise addressed by `client_ref`.
 * Only the provided fields change; omitted fields are left as-is (a true patch,
 * NOT a replace). Targeting a missing ref is an error in the applier.
 */
// NOTE: the "at least one field changed" rule is NOT expressed as a `.refine()`
// on this schema. A refined schema is a `ZodEffects`, and `z.discriminatedUnion`
// only accepts plain `ZodObject` members — wrapping in `.refine()` would break
// the discriminated-union narrowing the applier relies on. The non-empty-patch
// rule is therefore enforced (a) at the gateway boundary via `assertNonEmptyPatch`
// over the parsed union, and (b) defensively inside the applier (MALFORMED_OP).
export const UpdateExerciseOpSchema = z
  .object({
    kind: z.literal('update_exercise'),
    client_ref: ClientRefSchema,
    exercise_external_id: ExternalExerciseIdSchema.optional(),
    sets: SetsSchema.optional(),
    reps_or_duration_seconds: RepsOrDurationSchema.optional(),
    weight_lbs: WeightLbsSchema.optional(),
    rest_seconds: RestSecondsSchema.optional(),
    superset_group_id: SupersetGroupSchema.optional(),
    notes: NotesSchema.optional(),
  })
  .strict();
export type UpdateExerciseOp = z.infer<typeof UpdateExerciseOpSchema>;

/** True iff an `update_exercise` op carries at least one mutable field. */
export function updateExerciseOpChangesAField(op: UpdateExerciseOp): boolean {
  return (
    op.exercise_external_id !== undefined ||
    op.sets !== undefined ||
    op.reps_or_duration_seconds !== undefined ||
    op.weight_lbs !== undefined ||
    op.rest_seconds !== undefined ||
    op.superset_group_id !== undefined ||
    op.notes !== undefined
  );
}

/** `remove_exercise` — delete the exercise addressed by `client_ref`. */
export const RemoveExerciseOpSchema = z
  .object({
    kind: z.literal('remove_exercise'),
    client_ref: ClientRefSchema,
  })
  .strict();
export type RemoveExerciseOp = z.infer<typeof RemoveExerciseOpSchema>;

/**
 * `reorder` — set the absolute order of the plan by listing EVERY current
 * `client_ref` exactly once in the desired sequence. The applier rejects a
 * reorder whose ref set does not match the current snapshot exactly (missing,
 * extra, or duplicate refs) so a partial reorder can never silently drop a row.
 */
export const ReorderOpSchema = z
  .object({
    kind: z.literal('reorder'),
    ordered_client_refs: z
      .array(ClientRefSchema)
      .min(1, { message: 'reorder requires at least one client_ref' })
      .max(400, { message: 'reorder exceeds 400 refs' }),
  })
  .strict();
export type ReorderOp = z.infer<typeof ReorderOpSchema>;

/**
 * `plan_meta` — patch plan-level metadata (name / type / duration). Partial
 * patch like `update_exercise`. Persisted onto the WorkoutPlan row + the
 * revision's `plan_meta_json` snapshot.
 */
// Like `UpdateExerciseOpSchema`, the non-empty-patch rule is enforced outside
// the schema (see `assertNonEmptyPatch` + applier) so this stays a plain
// `ZodObject` usable as a discriminated-union member.
export const PlanMetaOpSchema = z
  .object({
    kind: z.literal('plan_meta'),
    name: z
      .string()
      .min(1, { message: 'name must not be empty' })
      .max(200, { message: 'name exceeds 200 chars' })
      .optional(),
    type: z.enum(WORKOUT_PLAN_TYPES).optional(),
    duration_estimate_minutes: z
      .number()
      .int({ message: 'duration_estimate_minutes must be an integer' })
      .min(0, { message: 'duration_estimate_minutes must be >= 0' })
      .max(1440, { message: 'duration_estimate_minutes must be <= 1440' })
      .nullable()
      .optional(),
  })
  .strict();
export type PlanMetaOp = z.infer<typeof PlanMetaOpSchema>;

/** True iff a `plan_meta` op carries at least one mutable field. */
export function planMetaOpChangesAField(op: PlanMetaOp): boolean {
  return (
    op.name !== undefined ||
    op.type !== undefined ||
    op.duration_estimate_minutes !== undefined
  );
}

/** The discriminated union of all diff ops. */
export const WorkoutDiffOpSchema = z.discriminatedUnion('kind', [
  AddExerciseOpSchema,
  UpdateExerciseOpSchema,
  RemoveExerciseOpSchema,
  ReorderOpSchema,
  PlanMetaOpSchema,
]);
export type WorkoutDiffOp = z.infer<typeof WorkoutDiffOpSchema>;

/**
 * The INPUT shape of a diff op (before zod applies `.default()` coercions on
 * the optional exercise fields). The applier re-parses every op, so it accepts
 * either the parsed output type or this raw input shape — letting callers pass
 * a freshly-authored op literal (with the defaulted fields omitted) without a
 * cast, exactly as a model-produced payload arrives.
 */
export type WorkoutDiffOpInput = z.input<typeof WorkoutDiffOpSchema>;

/** Upper bound on ops per diff (brief §4.2: 1..400 ops). */
export const MAX_DIFF_OPS = 400;

/**
 * The diff array as carried on `AiActionDraft.payload.diff`. Bounded to
 * 1..400 ops. The 256KB serialized-size cap (brief §4.2) is enforced
 * separately by the payload schemas in the materialisers, because it is a
 * property of the serialized JSON, not the parsed array.
 */
export const WorkoutDiffSchema = z
  .array(WorkoutDiffOpSchema)
  .min(1, { message: 'diff must contain at least one op' })
  .max(MAX_DIFF_OPS, { message: `diff exceeds ${MAX_DIFF_OPS} ops` })
  // The "patch must change at least one field" rule lives here (at the array
  // level), NOT as a `.refine()` on the individual op schemas — keeping each op
  // schema a plain `ZodObject` so `WorkoutDiffOpSchema` stays a usable
  // discriminated union (the applier narrows on `.kind`). Enforced once at the
  // gateway boundary when the draft is created.
  .superRefine((ops, ctx) => {
    ops.forEach((op, i) => {
      if (op.kind === 'update_exercise' && !updateExerciseOpChangesAField(op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: 'update_exercise must change at least one field',
        });
      }
      if (op.kind === 'plan_meta' && !planMetaOpChangesAField(op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: 'plan_meta must change at least one field',
        });
      }
    });
  });
export type WorkoutDiff = z.infer<typeof WorkoutDiffSchema>;

/**
 * The in-memory plan snapshot the applier operates on. This is the SAME shape
 * the persisted `WorkoutPlanRevision.exercises_json` + `plan_meta_json` carry,
 * so a snapshot read from a revision can be fed straight into the applier and
 * the result written straight back.
 */
export interface PlanExerciseSnapshot {
  /** Stable ref the diff addresses this row by. Persisted in exercises_json. */
  client_ref: string;
  exercise_external_id: string;
  /** Derived, 0-based, contiguous. Set by the applier, never trusted from a diff op. */
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs: number | null;
  rest_seconds: number | null;
  superset_group_id: string | null;
  notes: string | null;
}

export interface PlanMetaSnapshot {
  name: string;
  type: WorkoutPlanTypeLiteral;
  duration_estimate_minutes: number | null;
}

export interface PlanSnapshot {
  meta: PlanMetaSnapshot;
  exercises: PlanExerciseSnapshot[];
}

/** Sentinel for the empty-baseline create path: no exercises, default meta. */
export const EMPTY_PLAN_META: PlanMetaSnapshot = {
  name: 'Untitled plan',
  type: 'strength',
  duration_estimate_minutes: null,
};

/** A fresh empty baseline for the create path (no exercises, default meta). */
export function emptyPlanSnapshot(): PlanSnapshot {
  return { meta: { ...EMPTY_PLAN_META }, exercises: [] };
}

/**
 * Persisted row shape (DB-facing) — the fields a `WorkoutPlanExercise` row
 * carries. Note `client_ref` is NOT a DB column; it lives only in the
 * revision's `exercises_json` snapshot so a later edit-diff can re-address rows
 * by ref. The materialisers persist the columns below and serialise the full
 * snapshot (incl. client_ref) into the revision.
 */
export interface PersistableExerciseRow {
  exercise_external_id: string;
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs: number | null;
  rest_seconds: number | null;
  superset_group_id: string | null;
  notes: string | null;
}

/** Project a snapshot's exercises onto the persistable DB column set (ordered). */
export function toPersistableRows(
  snapshot: PlanSnapshot,
): PersistableExerciseRow[] {
  return snapshot.exercises
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      exercise_external_id: e.exercise_external_id,
      order: e.order,
      sets: e.sets,
      reps_or_duration_seconds: e.reps_or_duration_seconds,
      weight_lbs: e.weight_lbs ?? null,
      rest_seconds: e.rest_seconds ?? null,
      superset_group_id: e.superset_group_id ?? null,
      notes: e.notes ?? null,
    }));
}

/**
 * Serialise a full snapshot (incl. `client_ref` + derived order) into the JSON
 * blob persisted on `WorkoutPlanRevision.exercises_json`. Sorted by order so
 * the stored representation is canonical.
 */
export function serialiseSnapshotExercises(
  snapshot: PlanSnapshot,
): Array<PlanExerciseSnapshot> {
  return snapshot.exercises
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      client_ref: e.client_ref,
      exercise_external_id: e.exercise_external_id,
      order: e.order,
      sets: e.sets,
      reps_or_duration_seconds: e.reps_or_duration_seconds,
      weight_lbs: e.weight_lbs ?? null,
      rest_seconds: e.rest_seconds ?? null,
      superset_group_id: e.superset_group_id ?? null,
      notes: e.notes ?? null,
    }));
}

/**
 * Rebuild an in-memory `PlanSnapshot` from a persisted revision's
 * `exercises_json` + `plan_meta_json`. Used by the edit materialiser to load
 * the current head snapshot before applying a diff. Tolerant of a revision
 * written before client_ref existed (legacy) by synthesising a stable ref from
 * the row's order — those rows are addressable by `update`/`remove` ops that
 * target the synthesised ref.
 */
export function snapshotFromRevisionJson(
  exercisesJson: unknown,
  metaJson: unknown,
): PlanSnapshot {
  const rawMeta = (metaJson ?? {}) as Record<string, unknown>;
  const meta: PlanMetaSnapshot = {
    name: typeof rawMeta.name === 'string' ? rawMeta.name : EMPTY_PLAN_META.name,
    type: (WORKOUT_PLAN_TYPES as readonly string[]).includes(
      rawMeta.type as string,
    )
      ? (rawMeta.type as WorkoutPlanTypeLiteral)
      : EMPTY_PLAN_META.type,
    duration_estimate_minutes:
      typeof rawMeta.duration_estimate_minutes === 'number'
        ? rawMeta.duration_estimate_minutes
        : null,
  };
  const rawList = Array.isArray(exercisesJson)
    ? (exercisesJson as Array<Record<string, unknown>>)
    : [];
  const exercises: PlanExerciseSnapshot[] = rawList.map((r, i) => ({
    client_ref:
      typeof r.client_ref === 'string' && r.client_ref.length > 0
        ? r.client_ref
        : `legacy-${i}`,
    exercise_external_id: String(r.exercise_external_id ?? ''),
    order: typeof r.order === 'number' ? r.order : i,
    sets: typeof r.sets === 'number' ? r.sets : 1,
    reps_or_duration_seconds:
      typeof r.reps_or_duration_seconds === 'number'
        ? r.reps_or_duration_seconds
        : 1,
    weight_lbs: typeof r.weight_lbs === 'number' ? r.weight_lbs : null,
    rest_seconds: typeof r.rest_seconds === 'number' ? r.rest_seconds : null,
    superset_group_id:
      typeof r.superset_group_id === 'string' ? r.superset_group_id : null,
    notes: typeof r.notes === 'string' ? r.notes : null,
  }));
  // Canonicalise order on load so a legacy/sparse revision is normalised.
  exercises
    .sort((a, b) => a.order - b.order)
    .forEach((e, i) => {
      e.order = i;
    });
  return { meta, exercises };
}
