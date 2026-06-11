/**
 * MWB-3 — zod schemas for the autosave + real-undo endpoints (spec §6.2 / §5.1).
 *
 * Body validation is intentionally zod, NOT class-validator — the same
 * rationale as coach-media.dto.ts / package-contents.dto.ts: the global
 * class-validator ValidationPipe (forbidNonWhitelisted) would silently strip
 * unknown payload keys before the controller saw them, which on a diff-op
 * payload would mean an unrecognised `op` field vanishes and the autosave
 * "succeeds" with the op dropped (a silent failure — forbidden by R0). With
 * `.strict()` zod schemas an unknown key is a hard 400 instead.
 *
 * The controller binds `@Body() body: unknown` and the service runs the schema
 * via `safeParse`, throwing `BadRequestException({ error: 'INVALID_BODY', ... })`
 * — identical to the coach-media surface so the API error envelope is uniform.
 */

import { z } from 'zod';

// ─── Bounds (spec §6.2; mirror UpsertExerciseRowDto class-validator bounds) ───

/** Max diff ops in a single autosave batch (spec §6.2: 1..200). */
export const AUTOSAVE_OPS_MIN = 1;
export const AUTOSAVE_OPS_MAX = 200;

/** Max serialized size of the `ops` array (spec §6.2: 64 KB). */
export const AUTOSAVE_OPS_MAX_BYTES = 64 * 1024;

/** Server-issued optimistic-concurrency lock token: exactly 16 lowercase hex chars. */
export const LOCK_TOKEN_RE = /^[0-9a-f]{16}$/;

/** Exercise-row notes ceiling — mirrors UpsertExerciseRowDto.notes (@MaxLength(500)). */
const NOTES_MAX_LEN = 500;
/** Plan name ceiling — mirrors UpdateWorkoutPlanDto.name (@MaxLength(120)). */
const PLAN_NAME_MAX_LEN = 120;
/** sets ceiling — mirrors UpsertExerciseRowDto.sets (@Max(100)). */
const SETS_MAX = 100;

// ─── Exercise-row payload (mirror UpsertExerciseRowDto bounds, spec §6.2) ─────

/**
 * Mirror of UpsertExerciseRowDto's validated bounds, expressed in zod. Kept
 * field-for-field identical so the autosave diff path can never persist a row
 * the legacy PUT /exercises path would have rejected (R0: one validation truth).
 */
export const UpsertExerciseRowSchema = z
  .object({
    exercise_external_id: z.string().min(1),
    order: z.number().int().min(1),
    sets: z.number().int().min(1).max(SETS_MAX),
    reps_or_duration_seconds: z.number().int().min(1),
    weight_lbs: z.number().min(0).nullable().optional(),
    rest_seconds: z.number().int().min(0).nullable().optional(),
    superset_group_id: z.string().min(1).nullable().optional(),
    notes: z.string().max(NOTES_MAX_LEN).nullable().optional(),
  })
  .strict();

// ─── Diff ops (spec §6.2: discriminated union on `op`) ────────────────────────

/** `{ op: 'upsert_exercise', row_id?, payload }` — create/replace one row. */
export const UpsertExerciseOpSchema = z
  .object({
    op: z.literal('upsert_exercise'),
    // row_id optional: present => update that row, absent => insert a new one.
    row_id: z.string().uuid().optional(),
    payload: UpsertExerciseRowSchema,
  })
  .strict();

/** `{ op: 'remove_exercise', row_id }` — soft-archive one row. */
export const RemoveExerciseOpSchema = z
  .object({
    op: z.literal('remove_exercise'),
    row_id: z.string().uuid(),
  })
  .strict();

/** `{ op: 'reorder', row_ids }` — set the display order of the live rows. */
export const ReorderOpSchema = z
  .object({
    op: z.literal('reorder'),
    // 0..200 ids; an empty array is a no-op reorder (still valid).
    row_ids: z.array(z.string().uuid()).max(AUTOSAVE_OPS_MAX),
  })
  .strict();

/** `{ op: 'plan_meta', meta }` — patch plan-level metadata. */
export const PlanMetaOpSchema = z
  .object({
    op: z.literal('plan_meta'),
    meta: z
      .object({
        name: z.string().min(1).max(PLAN_NAME_MAX_LEN).optional(),
        type: z.enum(['strength', 'cardio', 'mobility']).optional(),
        duration_weeks: z.number().int().min(1).max(520).optional(),
        week_index: z.number().int().min(0).optional(),
        day_index: z.number().int().min(0).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, {
        message: 'plan_meta.meta must set at least one field',
      }),
  })
  .strict();

/** One autosave diff op — discriminated on the `op` literal (spec §6.2). */
export const AutosaveOpSchema = z.discriminatedUnion('op', [
  UpsertExerciseOpSchema,
  RemoveExerciseOpSchema,
  ReorderOpSchema,
  PlanMetaOpSchema,
]);

// ─── Autosave batch (request body of PATCH …/autosave, spec §6.2) ─────────────

/** `cause` provenance for the revision a batch produces (spec §6.2). */
export const AutosaveCauseSchema = z.enum([
  'manual_edit',
  'autosave',
  'ai_apply',
]);

/**
 * Request body for `PATCH /workout-plans/:planId/autosave`. The `ops` array is
 * additionally byte-bounded in the service (the 64 KB serialized cap, spec
 * §6.2) because zod's `.max()` only counts elements, not serialized size.
 */
export const AutosaveBatchSchema = z
  .object({
    base_revision_index: z.number().int().min(0),
    lock_token: z.string().regex(LOCK_TOKEN_RE, {
      message: 'lock_token must be 16 lowercase hex chars',
    }),
    ops: z.array(AutosaveOpSchema).min(AUTOSAVE_OPS_MIN).max(AUTOSAVE_OPS_MAX),
    cause: AutosaveCauseSchema,
  })
  .strict();

// ─── Undo request (request body of POST …/undo, spec §5.1) ────────────────────

/**
 * Request body for `POST /workout-plans/:planId/undo`. Redo is "undo to a later
 * revision index" — no separate field (spec §5.1).
 */
export const UndoRequestSchema = z
  .object({
    to_revision_index: z.number().int().min(0),
  })
  .strict();

// ─── Inferred input types ─────────────────────────────────────────────────────

export type UpsertExerciseRowInput = z.infer<typeof UpsertExerciseRowSchema>;
export type AutosaveOpInput = z.infer<typeof AutosaveOpSchema>;
export type AutosaveCause = z.infer<typeof AutosaveCauseSchema>;
export type AutosaveBatchInput = z.infer<typeof AutosaveBatchSchema>;
export type UndoRequestInput = z.infer<typeof UndoRequestSchema>;

// ─── Response shapes (R68: explicit, no `unknown`/`any` across the boundary) ──

/** 200 response of a successful autosave (spec §6.2). */
export interface AutosaveResponseDto {
  head_revision_index: number;
  lock_token: string;
  /** ISO-8601 timestamp the head revision was committed. */
  saved_at: string;
}

/** 200 response of a successful undo/redo (spec §5.1). */
export interface UndoResponseDto {
  head_revision_index: number;
  lock_token: string;
}

/**
 * 409 conflict body for an autosave optimistic-concurrency failure (spec §6.2).
 * Two discriminated causes share this shape:
 *   - `autosave_lock_stale`     — the client's `lock_token` does not match the
 *     deterministic token derived from the plan's persisted (version,
 *     head_revision_id) state (a stale optimistic lock).
 *   - `autosave_conflict_retry` — a stale `base_revision_index` (or a Postgres
 *     serialization conflict coerced to this code).
 * Both carry the current head index + a freshly-derived lock_token so the client
 * can rebase and retry. The lock_token wire shape is unchanged (16 hex chars).
 */
export interface AutosaveConflictDto {
  error: 'autosave_conflict_retry' | 'autosave_lock_stale';
  head_revision_index: number;
  lock_token: string;
}
