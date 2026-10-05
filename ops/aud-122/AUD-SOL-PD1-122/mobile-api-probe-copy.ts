/**
 * workoutAutosaveApi — typed, Zod-at-the-boundary client for the MWB-3 autosave
 * + real-undo surface (growth-project-backend@25dbc790, PR #386,
 * `FEATURE_MWB_AUTOSAVE_UNDO`). This is the MOBILE half (MWB-4) that consumes a
 * contract the backend already shipped; it MUST NOT drift from it.
 *
 * Backend contract source of truth (binding — extracted field-by-field, do NOT
 * loosen):
 *   growth-project-backend/src/workout-builder/workout-builder-autosave.controller.ts
 *   growth-project-backend/src/workout-builder/workout-builder-autosave.dto.ts
 *   growth-project-backend/src/workout-builder/workout-builder-autosave.service.ts
 *   growth-project-backend/src/workout-builder/lock-token.helper.ts
 *
 * Wire contract (verbatim from the backend zod DTOs):
 *   PATCH /workout-plans/:planId/autosave
 *     Headers: Idempotency-Key (UUID) — client-generated; a replayed batch
 *       carries the SAME key so the network layer dedupes a double-send. The
 *       server's durable replay-safety is the optimistic lock_token +
 *       base_revision_index pair (a re-sent already-applied batch fails the
 *       lock_token assert with a 409 the client fast-forwards through), so the
 *       Idempotency-Key is a transport convenience, not the dedup authority.
 *     Body: {
 *       base_revision_index: int >= 0,           // client's last-known head index
 *       lock_token: /^[0-9a-f]{16}$/,            // deterministic HMAC of plan state
 *       ops: AutosaveOp[] (1..200),              // ordered diff since base
 *       cause: 'manual_edit' | 'autosave' | 'ai_apply'
 *     }
 *     200 -> { head_revision_index: int, lock_token: 16-hex, saved_at: ISO-8601 }
 *     409 -> { error: 'autosave_conflict_retry' | 'autosave_lock_stale',
 *              head_revision_index: int, lock_token: 16-hex }
 *     400 -> invalid body / ops (strict schema reject server-side)
 *     403 -> no access to the plan
 *     404 -> feature off OR plan not found (the flag-dark surface looks like 404)
 *
 *   POST /workout-plans/:planId/undo
 *     Body: { to_revision_index: int >= 0 }
 *     200 -> { head_revision_index: int, lock_token: 16-hex }
 *
 * AutosaveOp is a discriminated union on `op` (mirrors the backend
 * discriminatedUnion('op', …)):
 *   - upsert_exercise { op, row_id?, payload: UpsertExerciseRow }
 *   - remove_exercise { op, row_id }
 *   - reorder         { op, row_ids[] }
 *   - plan_meta       { op, meta }
 *
 * Hard gates honoured (BUILDER_BRIEF §"Hard gates"):
 *   - Every schema is `.strict()`; uuids are `z.string().uuid()`, the saved_at
 *     timestamp is `z.string().datetime()`, integer columns are
 *     `z.number().int()` — field-for-field with the backend so a drifted shape
 *     (extra key, wrong type, bad timestamp) throws a `contract` error here
 *     rather than feeding malformed data into React state. No `.passthrough()`,
 *     no loose strings, no `as unknown as`, no `as any`.
 *   - A 409 is classified as kind `conflict` and the parsed conflict body
 *     (fresh lock_token + current head index) rides along on the error so the
 *     caller can rebase/fast-forward. Never silently swallowed (Bradley Law #36).
 */

// CI probe only: backend Zod 4 bundles the v3 API used by the mobile lockfile.
import { z } from 'zod/v3';
import axios from 'axios';
import api from '../services/api';
import { generateIdempotencyKey } from '../utils/idempotency';

// ─── Bounds (mirror workout-builder-autosave.dto.ts byte-for-byte) ───────────

/** Max diff ops in a single autosave batch (backend AUTOSAVE_OPS_MIN/MAX). */
export const AUTOSAVE_OPS_MIN = 1;
export const AUTOSAVE_OPS_MAX = 200;
/** Max serialized size of the `ops` array (backend AUTOSAVE_OPS_MAX_BYTES). */
export const AUTOSAVE_OPS_MAX_BYTES = 64 * 1024;
/** Server-issued optimistic-concurrency lock token: exactly 16 lowercase hex. */
export const LOCK_TOKEN_RE = /^[0-9a-f]{16}$/;

const NOTES_MAX_LEN = 500; // UpsertExerciseRowDto.notes @MaxLength(500)
const PLAN_NAME_MAX_LEN = 120; // UpdateWorkoutPlanDto.name @MaxLength(120)
const SETS_MAX = 100; // UpsertExerciseRowDto.sets @Max(100)
const DURATION_WEEKS_MAX = 520; // plan_meta.duration_weeks .max(520)

// ─── Exercise-row payload (mirror UpsertExerciseRowSchema) ───────────────────

/**
 * Mirror of the backend UpsertExerciseRowSchema, field-for-field. Kept strict
 * so the mobile diff path can never produce a row the backend's strict zod
 * would 400 on (one validation truth — the backend rejects anything looser).
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
export type AutosaveUpsertExerciseRow = z.infer<typeof UpsertExerciseRowSchema>;

// ─── Diff ops (mirror the backend discriminatedUnion('op', …)) ───────────────

/** `{ op: 'upsert_exercise', row_id?, payload }` — create/replace one row. */
export const UpsertExerciseOpSchema = z
  .object({
    op: z.literal('upsert_exercise'),
    // row_id present => update that live row, absent => insert a new one.
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
        duration_weeks: z.number().int().min(1).max(DURATION_WEEKS_MAX).optional(),
        week_index: z.number().int().min(0).optional(),
        day_index: z.number().int().min(0).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, {
        message: 'plan_meta.meta must set at least one field',
      }),
  })
  .strict();

/** One autosave diff op — discriminated on the `op` literal. */
export const AutosaveOpSchema = z.discriminatedUnion('op', [
  UpsertExerciseOpSchema,
  RemoveExerciseOpSchema,
  ReorderOpSchema,
  PlanMetaOpSchema,
]);
export type AutosaveOp = z.infer<typeof AutosaveOpSchema>;

/** `cause` provenance for the revision a batch produces. */
export const AutosaveCauseSchema = z.enum(['manual_edit', 'autosave', 'ai_apply']);
export type AutosaveCause = z.infer<typeof AutosaveCauseSchema>;

// ─── Request body (mirror AutosaveBatchSchema) ───────────────────────────────

/**
 * Request body for `PATCH /workout-plans/:planId/autosave`. We validate the
 * OUTGOING body against the same strict schema the backend will, so a malformed
 * batch is caught locally (a `contract` error) before it ever leaves the device
 * — the autosave can never "succeed" with a dropped/typo'd op (R0: no silent
 * failure).
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
export type AutosaveBatch = z.infer<typeof AutosaveBatchSchema>;

/** Request body for `POST /workout-plans/:planId/undo`. */
export const UndoRequestSchema = z
  .object({
    to_revision_index: z.number().int().min(0),
    /**
     * S-MWB-3 (B-328-6): the head this undo was requested against. The backend
     * applies the undo only while the head is still this index; otherwise it
     * answers 409 `undo_head_moved` with the current head, so a retry after a
     * lost response can never restore twice.
     */
    expected_head_index: z.number().int().min(0).optional(),
  })
  .strict();
export type UndoRequest = z.infer<typeof UndoRequestSchema>;

// ─── Response schemas (mirror AutosaveResponseDto / UndoResponseDto) ─────────

/** 200 response of a successful autosave. */
export const AutosaveResponseSchema = z
  .object({
    head_revision_index: z.number().int().min(0),
    lock_token: z.string().regex(LOCK_TOKEN_RE),
    saved_at: z.string().datetime(),
  })
  .strict();
export type AutosaveResponse = z.infer<typeof AutosaveResponseSchema>;

/** 200 response of a successful undo/redo. */
export const UndoResponseSchema = z
  .object({
    head_revision_index: z.number().int().min(0),
    lock_token: z.string().regex(LOCK_TOKEN_RE),
  })
  .strict();
export type UndoResponse = z.infer<typeof UndoResponseSchema>;

/**
 * 409 conflict body (mirror AutosaveConflictDto). Both discriminated causes
 * share this shape; both carry the current head index + a freshly-derived
 * lock_token so the client can rebase and retry without a separate refetch.
 *
 * Not strict (B-355-1): the reply arrives through the backend error filter,
 * which adds its envelope (statusCode, code, message, timestamp, path,
 * request_id) next to the allow-listed `head_revision_index` and
 * `lock_token`. Unknown keys are dropped from the parsed value. Parse it with
 * {@link parseNamedConflict}, which reads the cause from `code` or `error`.
 */
export const AutosaveConflictSchema = z.object({
  error: z.enum(['autosave_conflict_retry', 'autosave_lock_stale']),
  head_revision_index: z.number().int().min(0),
  lock_token: z.string().regex(LOCK_TOKEN_RE),
});
export type AutosaveConflict = z.infer<typeof AutosaveConflictSchema>;

/**
 * The machine name a 409 reply carries: the error filter's `code` when set,
 * else the service's `error`. Null when the body names neither.
 */
export function conflictNameOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { code?: unknown; error?: unknown };
  if (typeof d.code === 'string' && d.code !== '') return d.code;
  if (typeof d.error === 'string' && d.error !== '') return d.error;
  return null;
}

/** Parse a 409 body with `schema`, reading its cause through {@link conflictNameOf}. */
function parseNamedConflict<T>(
  schema: z.ZodType<T>,
  data: unknown,
): T | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const parsed = schema.safeParse({
    ...(data as Record<string, unknown>),
    error: conflictNameOf(data),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * 409 body of a fenced undo whose `expected_head_index` no longer matches the
 * plan head (S-MWB-3, backend #640). Carries the current head and a fresh lock
 * token so the screen can adopt server truth. Extra keys (`code`, `message`)
 * are allowed.
 */
export const UndoHeadMovedSchema = z.object({
  error: z.literal('undo_head_moved'),
  head_revision_index: z.number().int().min(0),
  lock_token: z.string().regex(LOCK_TOKEN_RE),
});
export type UndoHeadMoved = z.infer<typeof UndoHeadMovedSchema>;

// ─── Typed error ─────────────────────────────────────────────────────────────

/**
 * Transport / contract error surfaced to the hook + screen. `kind` is a coarse,
 * bounded label (never a raw server message) the UI branches on:
 *   - `conflict`     — HTTP 409: server moved ahead OR a stale lock_token. The
 *                      parsed `conflict` body rides along so the caller can
 *                      fast-forward to `head_revision_index` + adopt the fresh
 *                      `lock_token`. This is the ONE error the hook recovers
 *                      from automatically; everything else marks 'offline'.
 *   - `gone`         — 404 (feature dark / plan archived) or 410.
 *   - `forbidden`    — 403 (out-of-scope sub-coach / foreign tenant).
 *   - `unauthorized` — 401 (handled by the axios refresh interceptor first).
 *   - `server`       — 5xx.
 *   - `network`      — no response (offline / timeout) — the offline-mirror /
 *                      replay path keys off this.
 *   - `aborted`      — the caller cancelled the request via its AbortSignal
 *                      (e.g. the screen unmounted mid-flush). This is NOT a
 *                      failure: the batch stays in the offline mirror to replay
 *                      on the next mount, so the hook must NOT surface it as an
 *                      error or advance any baseline.
 *   - `contract`     — a request OR response shape drifted from the backend.
 *   - `unknown`      — anything else.
 */
export class WorkoutAutosaveApiError extends Error {
  constructor(
    public readonly kind:
      | 'conflict'
      | 'gone'
      | 'forbidden'
      | 'unauthorized'
      | 'server'
      | 'network'
      | 'aborted'
      | 'contract'
      | 'unknown',
    public readonly status: number,
    message: string,
    /** Parsed 409 body when `kind === 'conflict'` and the body validated. */
    public readonly conflict?: AutosaveConflict,
    public readonly cause?: unknown,
    /** Parsed 409 `undo_head_moved` body of a fenced undo (S-MWB-3). */
    public readonly headMoved?: UndoHeadMoved,
  ) {
    super(message);
    this.name = 'WorkoutAutosaveApiError';
    Object.setPrototypeOf(this, WorkoutAutosaveApiError.prototype);
  }

  /** True when the failure was the device being offline / unreachable. */
  get isNetwork(): boolean {
    return this.kind === 'network';
  }

  /** True when the caller cancelled the request (unmount / supersede). */
  get isAborted(): boolean {
    return this.kind === 'aborted';
  }
}

function classify(status: number): WorkoutAutosaveApiError['kind'] {
  if (status === 409) return 'conflict';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'gone';
  if (status >= 500) return 'server';
  if (status === 0) return 'network';
  return 'unknown';
}

/**
 * Normalise an axios failure into a WorkoutAutosaveApiError. On a 409 we parse
 * the body against AutosaveConflictSchema; a malformed conflict body still
 * yields a `conflict` error (so the caller knows to refetch) but with no
 * `conflict` payload — never a silent crash on a drifted error shape.
 */
function fromAxios(err: unknown): WorkoutAutosaveApiError {
  // A signal-triggered cancel surfaces as an axios CanceledError (code
  // 'ERR_CANCELED'). Classify it distinctly so the hook keeps the mirror for
  // replay instead of treating a deliberate unmount-abort as a transport error.
  if (axios.isCancel(err)) {
    return new WorkoutAutosaveApiError(
      'aborted',
      0,
      'autosave request aborted by the caller',
      undefined,
      err,
    );
  }
  if (axios.isAxiosError(err)) {
    if (err.code === 'ERR_CANCELED') {
      return new WorkoutAutosaveApiError(
        'aborted',
        0,
        'autosave request aborted by the caller',
        undefined,
        err,
      );
    }
    const status = err.response?.status ?? 0;
    const kind = classify(status);
    if (kind === 'conflict') {
      return new WorkoutAutosaveApiError(
        'conflict',
        status,
        'autosave conflict — the plan moved ahead; rebase and retry',
        parseNamedConflict(AutosaveConflictSchema, err.response?.data),
        err,
      );
    }
    return new WorkoutAutosaveApiError(
      kind,
      status,
      `workout autosave request failed (${status || 'network'})`,
      undefined,
      err,
    );
  }
  return new WorkoutAutosaveApiError(
    'unknown',
    -1,
    'workout autosave request failed',
    undefined,
    err,
  );
}

/** Parse a 200 response against `schema` or throw a `contract` error. */
function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new WorkoutAutosaveApiError(
      'contract',
      200,
      'workout autosave response shape drifted from the backend contract',
      undefined,
      result.error,
    );
  }
  return result.data;
}

/**
 * Guard the OUTGOING batch against the strict schema before it leaves the
 * device. A local `contract` failure here means the diff layer produced an
 * invalid op — surfaced loudly, never sent-and-silently-dropped.
 */
function assertValidBatch(body: AutosaveBatch): void {
  const result = AutosaveBatchSchema.safeParse(body);
  if (!result.success) {
    throw new WorkoutAutosaveApiError(
      'contract',
      400,
      'autosave batch failed local validation before send',
      undefined,
      result.error,
    );
  }
  // Mirror the backend's 64 KB serialized-ops cap so an oversized batch is
  // caught locally instead of bouncing as a server 400.
  const bytes = byteLengthUtf8(JSON.stringify(body.ops));
  if (bytes > AUTOSAVE_OPS_MAX_BYTES) {
    throw new WorkoutAutosaveApiError(
      'contract',
      400,
      `autosave ops payload exceeds the ${AUTOSAVE_OPS_MAX_BYTES}-byte limit`,
    );
  }
}

/**
 * UTF-8 byte length without relying on Node's Buffer (absent in the RN/Hermes
 * runtime). Mirrors the backend's Buffer.byteLength(…, 'utf8') cap check.
 */
function byteLengthUtf8(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — counts with its low surrogate as a 4-byte sequence.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface AutosaveCallArgs {
  planId: string;
  body: AutosaveBatch;
  /**
   * Idempotency-Key for the request. The hook reuses the SAME key when it
   * replays a batch that was buffered offline, so a double-send dedupes at the
   * transport layer. Generated by the caller (a UUID) so it survives an app
   * kill in the offline mirror.
   */
  idempotencyKey: string;
  /**
   * Optional AbortSignal so the caller can cancel an in-flight autosave (e.g.
   * the editor unmounts, or a newer batch supersedes this one). A cancel
   * surfaces as a WorkoutAutosaveApiError with kind 'aborted' — never a silent
   * resolve — so the hook keeps the batch in the offline mirror to replay.
   */
  signal?: AbortSignal;
}

export const workoutAutosaveApi = {
  /**
   * PATCH /workout-plans/:planId/autosave — commit one batch of diff ops.
   * Throws WorkoutAutosaveApiError on any failure; a 409 carries the parsed
   * conflict body so the caller can fast-forward.
   */
  async autosave(args: AutosaveCallArgs): Promise<AutosaveResponse> {
    assertValidBatch(args.body);
    let data: unknown;
    try {
      const res = await api.patch<unknown>(
        `/workout-plans/${args.planId}/autosave`,
        args.body,
        {
          headers: { 'Idempotency-Key': args.idempotencyKey },
          signal: args.signal,
        },
      );
      data = res.data;
    } catch (err) {
      throw fromAxios(err);
    }
    return parseResponse(AutosaveResponseSchema, data);
  },

  /**
   * POST /workout-plans/:planId/undo — undo/redo to a prior revision index.
   * Redo is "undo to a later index" — no separate call (backend §5.1).
   */
  async undo(planId: string, body: UndoRequest): Promise<UndoResponse> {
    const validated = UndoRequestSchema.safeParse(body);
    if (!validated.success) {
      throw new WorkoutAutosaveApiError(
        'contract',
        400,
        'undo request failed local validation before send',
        undefined,
        validated.error,
      );
    }
    let data: unknown;
    try {
      const res = await api.post<unknown>(
        `/workout-plans/${planId}/undo`,
        validated.data,
        { headers: { 'Idempotency-Key': generateIdempotencyKey() } },
      );
      data = res.data;
    } catch (err) {
      const mapped = fromAxios(err);
      if (mapped.kind === 'conflict' && axios.isAxiosError(err)) {
        const data: unknown = err.response?.data;
        const moved = parseNamedConflict(UndoHeadMovedSchema, data);
        if (moved) {
          throw new WorkoutAutosaveApiError(
            'conflict',
            409,
            'undo refused: the plan head moved since the undo was requested',
            undefined,
            err,
            moved,
          );
        }
        if (conflictNameOf(data) === 'undo_head_moved') {
          // B-356-1: the head moved (possibly because THIS undo landed on an
          // earlier attempt) but the reply lacks the current head or lock
          // token. That is not a definite refusal: report an unreadable
          // answer so the screen keeps editing paused and re-checks.
          throw new WorkoutAutosaveApiError(
            'contract',
            409,
            'undo answered undo_head_moved without the current head and lock token',
            undefined,
            err,
          );
        }
      }
      throw mapped;
    }
    return parseResponse(UndoResponseSchema, data);
  },
};

// Re-exported for tests + the hook so the contract bounds live in one place.
export { byteLengthUtf8 as __byteLengthUtf8ForTest };
