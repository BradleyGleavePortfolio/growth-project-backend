/**
 * WorkoutBuilderAutosaveService — MWB-3 autosave + real-undo domain logic
 * (MASTER_WORKOUT_BUILDER_SPEC.md §5 real undo, §6 autosave).
 *
 * Responsibilities:
 *   - PATCH /workout-plans/:planId/autosave  -> applyAutosave()
 *   - POST  /workout-plans/:planId/undo      -> applyUndo()
 *   - pruneRevisionsForPlan() — used by the revision-prune cron (operator
 *     decision C: keep 30 newest, never the head, never < 24h old).
 *
 * INVARIANTS (R0 — decacorn quality, no stubs, no silent failures):
 *   - FEATURE_MWB_AUTOSAVE_UNDO is re-checked as the FIRST op inside every
 *     Serializable transaction (defence-in-depth atop the controller guard), so
 *     an operator who flips the flag OFF mid-flight aborts the unit with 404 —
 *     never committing a write the feature forbids.
 *   - Optimistic concurrency: a `SELECT … FOR UPDATE` on the plan row plus a
 *     `base_revision_index === head.revision_index` assert. A stale token => a
 *     typed 409 carrying the current head index + a freshly-rotated lock_token.
 *   - Serializable isolation; a Postgres 40001 (Prisma P2034) write-conflict is
 *     coerced to ConflictException('autosave_conflict_retry') — never a leaked
 *     Prisma error (raw HTTP 500). Mirrors cloneProgramToClient's P2034 posture.
 *   - The revision row's exercises_json is the FULL post-ops ordered snapshot,
 *     so undo can restore any point without replaying diffs.
 *
 * Authorisation is delegated to WorkoutBuilderService.assertCanAccessClient
 * (the MWB-1/§7.2 single source of truth: head coach OR sub-coach with an open
 * SubCoachAssignment), so the autosave + undo routes honour sub-coach scope
 * identically to clone-to-client.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { WorkoutBuilderService } from './workout-builder.service';
import { isMwbAutosaveUndoEnabled } from './workout-builder-autosave.feature';
import {
  AUTOSAVE_OPS_MAX_BYTES,
  AutosaveBatchInput,
  AutosaveBatchSchema,
  AutosaveCause,
  AutosaveOpInput,
  AutosaveResponseDto,
  UndoRequestInput,
  UndoRequestSchema,
  UndoResponseDto,
  UpsertExerciseRowInput,
} from './workout-builder-autosave.dto';

/** author_kind written onto a revision row (mirrors the schema comment). */
export type AuthorKind = 'coach' | 'sub_coach' | 'ai';

/** Operator decision C (spec §5.2): keep at most this many revisions per plan. */
export const REVISION_RETENTION_LIMIT = 30;

/**
 * Safety net (spec §5.2): never prune a revision younger than this, even if the
 * plan exceeds the retention limit — protects against a rapid-fire burst of
 * autosaves being GC'd before the client can undo through them.
 */
export const REVISION_PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Frozen, ordered exercise-row shape stored in WorkoutPlanRevision.exercises_json.
 * Field set mirrors WorkoutPlanExercise + the serialiseExerciseRows projection on
 * WorkoutBuilderService so a revision snapshot round-trips a live plan exactly.
 */
interface RevisionExerciseRow {
  exercise_external_id: string;
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs: number | null;
  rest_seconds: number | null;
  superset_group_id: string | null;
  notes: string | null;
}

/** Identity of the acting principal, resolved by the controller from the JWT. */
export interface AutosaveActor {
  /** JWT subject (req.user.id). Authorisation + author_id provenance. */
  userId: string;
  /**
   * True when the call originates from an AI apply path (author_kind='ai').
   * MWB-3's HTTP surface is coach-driven, so this is false for both endpoints;
   * the field exists so a future internal AI caller (MWB-5) writes the correct
   * provenance through the same helper without a second write path. The unit
   * matrix (#11) pins all three author_kind values through resolveAuthorKind().
   */
  isAi?: boolean;
}

@Injectable()
export class WorkoutBuilderAutosaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workoutBuilder: WorkoutBuilderService,
    // @Global AnalyticsModule provides this; used by the prune cron telemetry.
    // Not @Optional — the module always has it in the DI graph. The wrapper is
    // itself a no-op when POSTHOG_KEY is unset, so tests need no PostHog.
    private readonly analytics: AnalyticsService,
  ) {}

  // ─── Public: autosave (spec §6.2) ──────────────────────────────────────────

  /**
   * Apply a batch of diff ops to `planId` and commit a new head revision.
   *
   * Validates the raw body (zod), authorises the actor against the plan's
   * owning client (sub-coach scope), then runs a Serializable transaction:
   * lock the plan, assert the optimistic-concurrency token, apply ops to the
   * live rows, write the full post-ops snapshot as revision head+1, advance the
   * head pointer + bump version, and return a freshly-rotated lock_token.
   */
  async applyAutosave(
    planId: string,
    actor: AutosaveActor,
    rawBody: unknown,
  ): Promise<AutosaveResponseDto> {
    if (!isMwbAutosaveUndoEnabled()) {
      // Defence-in-depth: the controller guard already 404s, but an internal
      // caller must hit the same wall. 404 (not 403) hides the feature.
      throw new NotFoundException(`Cannot PATCH /workout-plans/${planId}/autosave`);
    }
    const body: AutosaveBatchInput = this.parse(AutosaveBatchSchema, rawBody);
    this.assertOpsByteBudget(body.ops);

    const authorKind = await this.resolveAuthorKind(actor);
    // Authorise BEFORE the transaction: read the plan's owning client and run
    // the MWB-1 §7.2 access gate (head coach OR open sub-coach). A non-existent
    // plan is a 404; out-of-scope is a 403 — identical to clone-to-client.
    await this.authorisePlanAccess(planId, actor.userId);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // (a) Flag re-check as the first DB-adjacent op (mirrors clone path).
          if (!isMwbAutosaveUndoEnabled()) {
            throw new NotFoundException(
              `Cannot PATCH /workout-plans/${planId}/autosave`,
            );
          }
          // (b) Lock the plan row + load its current head index. FOR UPDATE so
          // two concurrent autosaves serialise on the same row.
          const locked = await this.lockPlanAndHead(tx, planId);

          // (c) Optimistic-concurrency assert. A stale base index => 409 with
          // the current head index + a fresh lock_token so the client rebases.
          if (body.base_revision_index !== locked.headIndex) {
            throw new ConflictException({
              error: 'autosave_conflict_retry',
              head_revision_index: locked.headIndex,
              lock_token: this.issueLockToken(),
            });
          }

          // (d) Apply ops to the in-memory snapshot, then persist row mutations
          // + plan-meta mutations. Returns the full post-ops snapshot + meta.
          const { snapshot, meta } = await this.applyOps(
            tx,
            planId,
            body.ops,
          );

          // (e) Write the new head revision (index = head+1) with the FULL
          // post-ops snapshot, then advance head + bump version atomically.
          const nextIndex = locked.headIndex + 1;
          const revision = await this.writeRevision(tx, {
            planId,
            revisionIndex: nextIndex,
            exercises: snapshot,
            planMeta: meta,
            authorId: actor.userId,
            authorKind,
            cause: body.cause,
          });
          await tx.workoutPlan.update({
            where: { id: planId },
            data: {
              head_revision_id: revision.id,
              version: { increment: 1 },
            },
          });

          return {
            head_revision_index: nextIndex,
            lock_token: this.issueLockToken(),
            saved_at: revision.created_at.toISOString(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      throw this.coerceSerializationConflict(err);
    }
  }

  // ─── Public: undo / redo (spec §5.1) ────────────────────────────────────────

  /**
   * Undo (or redo) `planId` to the snapshot at `to_revision_index` by writing a
   * NEW head revision whose exercises = the target revision's snapshot (spec
   * §5.1). Redo is simply "undo to a later index" — there is no separate
   * endpoint. The target must be an EARLIER index than the current head (you
   * can only restore an already-recorded state, never fabricate a future one)
   * and must exist for this plan.
   */
  async applyUndo(
    planId: string,
    actor: AutosaveActor,
    rawBody: unknown,
  ): Promise<UndoResponseDto> {
    if (!isMwbAutosaveUndoEnabled()) {
      throw new NotFoundException(`Cannot POST /workout-plans/${planId}/undo`);
    }
    const body: UndoRequestInput = this.parse(UndoRequestSchema, rawBody);
    const authorKind = await this.resolveAuthorKind(actor);
    await this.authorisePlanAccess(planId, actor.userId);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          if (!isMwbAutosaveUndoEnabled()) {
            throw new NotFoundException(
              `Cannot POST /workout-plans/${planId}/undo`,
            );
          }
          const locked = await this.lockPlanAndHead(tx, planId);

          // (a) The target must be strictly earlier than the current head — you
          // can only restore a state that already exists in history.
          if (body.to_revision_index >= locked.headIndex) {
            throw new BadRequestException(
              'to_revision_index must be earlier than the current head revision',
            );
          }

          // (b) Load the target revision's snapshot (must exist for this plan).
          const target = await tx.workoutPlanRevision.findUnique({
            where: {
              workout_plan_id_revision_index: {
                workout_plan_id: planId,
                revision_index: body.to_revision_index,
              },
            },
            select: { exercises_json: true, plan_meta_json: true },
          });
          if (!target) {
            throw new NotFoundException('Target revision not found for this plan');
          }
          const snapshot = this.deserialiseSnapshot(target.exercises_json);

          // (c) Replace the plan's live exercise rows with the target snapshot,
          // then write a NEW head revision (index = head+1, cause='undo') and
          // advance the head pointer + version.
          await this.replaceLiveRows(tx, planId, snapshot);
          const nextIndex = locked.headIndex + 1;
          const revision = await this.writeRevision(tx, {
            planId,
            revisionIndex: nextIndex,
            exercises: snapshot,
            // Carry the target's plan-meta snapshot forward verbatim so undo
            // restores plan metadata too, not just the exercise rows.
            planMeta: target.plan_meta_json,
            authorId: actor.userId,
            authorKind,
            cause: 'undo',
          });
          await tx.workoutPlan.update({
            where: { id: planId },
            data: {
              head_revision_id: revision.id,
              version: { increment: 1 },
            },
          });

          return {
            head_revision_index: nextIndex,
            lock_token: this.issueLockToken(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      throw this.coerceSerializationConflict(err);
    }
  }

  // ─── Public: revision prune (spec §5.2 — used by the cron) ──────────────────

  /**
   * Prune `planId`'s revisions down to REVISION_RETENTION_LIMIT (operator
   * decision C: 30). Deletes the OLDEST revisions first, but NEVER:
   *   - the current head_revision_id (the live state must always be restorable),
   *   - any revision younger than REVISION_PRUNE_MIN_AGE_MS (24h safety net).
   * Returns the number of revisions actually deleted (0 when nothing to do).
   *
   * Runs in its own Serializable transaction so a concurrent autosave (which
   * appends a new head) cannot race the delete into removing a row the autosave
   * still considers head. The flag is re-checked inside the txn.
   */
  async pruneRevisionsForPlan(planId: string): Promise<number> {
    if (!isMwbAutosaveUndoEnabled()) return 0;

    const deletedCount = await this.prisma.$transaction(
      async (tx) => {
        if (!isMwbAutosaveUndoEnabled()) return 0;

        const plan = await tx.workoutPlan.findUnique({
          where: { id: planId },
          select: { head_revision_id: true },
        });
        if (!plan) return 0;

        const total = await tx.workoutPlanRevision.count({
          where: { workout_plan_id: planId },
        });
        if (total <= REVISION_RETENTION_LIMIT) return 0;

        const cutoff = new Date(Date.now() - REVISION_PRUNE_MIN_AGE_MS);
        const overflow = total - REVISION_RETENTION_LIMIT;

        // Oldest-first candidates: only revisions older than the 24h safety net,
        // never the head pointer. We take at most `overflow` of them so the
        // youngest 30 are always retained.
        const candidates = await tx.workoutPlanRevision.findMany({
          where: {
            workout_plan_id: planId,
            created_at: { lt: cutoff },
            ...(plan.head_revision_id
              ? { id: { not: plan.head_revision_id } }
              : {}),
          },
          orderBy: [{ revision_index: 'asc' }],
          take: overflow,
          select: { id: true },
        });
        if (candidates.length === 0) return 0;

        const result = await tx.workoutPlanRevision.deleteMany({
          where: { id: { in: candidates.map((c) => c.id) } },
        });
        return result.count;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (deletedCount > 0) {
      // Telemetry (spec §5.2). distinctId is the plan id (never PII); the
      // AnalyticsService wrapper is a no-op when PostHog is unconfigured and
      // never throws, so this cannot break the cron.
      this.analytics.capture(planId, Events.MWB_AUTOSAVE_REVISION_PRUNED, {
        plan_id: planId,
        deleted_count: deletedCount,
      });
    }
    return deletedCount;
  }

  /** Every non-archived plan id that currently exceeds the retention limit. */
  async findPlanIdsExceedingRetention(): Promise<string[]> {
    if (!isMwbAutosaveUndoEnabled()) return [];
    const grouped = await this.prisma.workoutPlanRevision.groupBy({
      by: ['workout_plan_id'],
      _count: { _all: true },
      having: { workout_plan_id: { _count: { gt: REVISION_RETENTION_LIMIT } } },
    });
    return grouped.map((g) => g.workout_plan_id);
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the revision `author_kind` from the acting principal (matrix #11):
   *   - an AI apply path  -> 'ai'
   *   - a sub-coach (User.coach_id set) -> 'sub_coach'
   *   - a head coach / owner            -> 'coach'
   * Mirrors cloneProgramToClient's `actor.coach_id ? 'sub_coach' : 'coach'`
   * derivation so provenance is consistent across the builder.
   */
  async resolveAuthorKind(actor: AutosaveActor): Promise<AuthorKind> {
    if (actor.isAi) return 'ai';
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { coach_id: true },
    });
    if (!user) throw new ForbiddenException('User not found');
    return user.coach_id ? 'sub_coach' : 'coach';
  }

  /**
   * Authorise the actor against the plan's owning client. The plan's coach_id
   * IS the owning client-side coach context; we delegate to the MWB-1 §7.2
   * gate so a sub-coach with an open SubCoachAssignment to the plan's coach
   * team passes, and an out-of-scope sub-coach is rejected with 403.
   *
   * assertCanAccessClient(actingUserId, clientId) returns when acting user is
   * the client's head coach OR a scoped sub-coach. For a coach-owned plan the
   * "client" relationship is the plan.coach_id tenant: a head coach editing
   * their own plan satisfies `coach_id === actingUserId`; a sub-coach satisfies
   * it via SubCoachScopeService.canAccessClient against the head coach team.
   */
  private async authorisePlanAccess(
    planId: string,
    actingUserId: string,
  ): Promise<void> {
    const plan = await this.prisma.workoutPlan.findUnique({
      where: { id: planId },
      select: { coach_id: true },
    });
    if (!plan) throw new NotFoundException('Workout plan not found');
    // Head coach / owner editing their own plan: direct ownership.
    if (plan.coach_id === actingUserId) return;
    // Sub-coach overlay: the actor must have an open assignment that grants
    // access to the plan's coach tenant. assertCanAccessClient throws 403 when
    // out of scope; we map a "not in scope" outcome to 403 explicitly so the
    // route never leaks a 404 for an existing-but-forbidden plan.
    await this.workoutBuilder.assertCanAccessClient(actingUserId, plan.coach_id);
  }

  /**
   * Lock the plan row (SELECT … FOR UPDATE) and resolve its current head
   * revision_index. A plan with no head revision is rejected: MWB-1 guarantees
   * every program/plan is created with an initial revision (index 0), so a
   * null head means the plan predates the revision baseline and cannot be
   * autosaved/undone without an anchor (R0: never silently invent one).
   */
  private async lockPlanAndHead(
    tx: Prisma.TransactionClient,
    planId: string,
  ): Promise<{ headIndex: number; headRevisionId: string }> {
    // FOR UPDATE via raw SQL — Prisma's typed API has no row-lock modifier.
    // Parameterised (never interpolated): no injection surface.
    const rows = await tx.$queryRaw<Array<{ head_revision_id: string | null }>>`
      SELECT "head_revision_id" FROM "WorkoutPlan" WHERE "id" = ${planId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Workout plan not found');
    }
    const headRevisionId = rows[0].head_revision_id;
    if (!headRevisionId) {
      throw new ConflictException(
        'Plan has no revision baseline; cannot autosave/undo',
      );
    }
    const head = await tx.workoutPlanRevision.findUnique({
      where: { id: headRevisionId },
      select: { revision_index: true },
    });
    if (!head) {
      // head_revision_id dangles — a data-integrity violation, never silently
      // tolerated (R0).
      throw new ConflictException('Plan head revision is missing');
    }
    return { headIndex: head.revision_index, headRevisionId };
  }

  /**
   * Apply the ops to the plan's live (non-archived) exercise rows and the
   * plan-meta, persisting each mutation, and return the FULL post-ops snapshot
   * (ordered) plus the resolved plan-meta snapshot for the revision row.
   *
   * Strategy: load the current live rows keyed by id, fold the ops over an
   * in-memory model, then persist by soft-archiving the prior live rows and
   * re-creating the resulting set. This mirrors the legacy setExercises
   * soft-archive contract so assigned-client snapshots are never disturbed,
   * and lets a single batch mix upserts / removes / reorders coherently.
   */
  private async applyOps(
    tx: Prisma.TransactionClient,
    planId: string,
    ops: AutosaveOpInput[],
  ): Promise<{ snapshot: RevisionExerciseRow[]; meta: Prisma.JsonValue }> {
    const liveRows = await tx.workoutPlanExercise.findMany({
      where: { workout_plan_id: planId, archived_at: null },
      orderBy: { order: 'asc' },
    });

    // In-memory model keyed by row id, preserving insertion order.
    const model = new Map<string, RevisionExerciseRow & { _key: string }>();
    let synthCounter = 0;
    const synthKey = () => `__new_${synthCounter++}`;
    for (const r of liveRows) {
      model.set(r.id, {
        _key: r.id,
        exercise_external_id: r.exercise_external_id,
        order: r.order,
        sets: r.sets,
        reps_or_duration_seconds: r.reps_or_duration_seconds,
        weight_lbs: r.weight_lbs ?? null,
        rest_seconds: r.rest_seconds ?? null,
        superset_group_id: r.superset_group_id ?? null,
        notes: r.notes ?? null,
      });
    }

    let metaPatch: Record<string, unknown> = {};

    for (const op of ops) {
      switch (op.op) {
        case 'upsert_exercise': {
          const row = this.fromRowInput(op.payload);
          if (op.row_id) {
            if (!model.has(op.row_id)) {
              throw new BadRequestException(
                `upsert_exercise row_id ${op.row_id} is not a live row`,
              );
            }
            model.set(op.row_id, { _key: op.row_id, ...row });
          } else {
            const key = synthKey();
            model.set(key, { _key: key, ...row });
          }
          break;
        }
        case 'remove_exercise': {
          if (!model.delete(op.row_id)) {
            throw new BadRequestException(
              `remove_exercise row_id ${op.row_id} is not a live row`,
            );
          }
          break;
        }
        case 'reorder': {
          // Re-key the model into the requested order. Every id must be live
          // and the set must match exactly (no missing / extra ids) so a
          // reorder can never silently drop or duplicate a row.
          const keys = [...model.keys()];
          const requested = op.row_ids;
          if (
            requested.length !== keys.length ||
            !requested.every((id) => model.has(id)) ||
            new Set(requested).size !== requested.length
          ) {
            throw new BadRequestException(
              'reorder row_ids must be a permutation of the live row ids',
            );
          }
          const reordered = new Map<
            string,
            RevisionExerciseRow & { _key: string }
          >();
          requested.forEach((id, idx) => {
            const existing = model.get(id)!;
            reordered.set(id, { ...existing, order: idx + 1 });
          });
          model.clear();
          for (const [k, v] of reordered) model.set(k, v);
          break;
        }
        case 'plan_meta': {
          metaPatch = { ...metaPatch, ...op.meta };
          break;
        }
      }
    }

    // Normalise the final order to a 1-based dense sequence in model order so
    // upserts that supplied an arbitrary `order` and inserts interleave
    // deterministically (the revision snapshot is the authority, not the raw
    // op-supplied order ints).
    const finalRows: RevisionExerciseRow[] = [...model.values()].map(
      (r, idx) => ({
        exercise_external_id: r.exercise_external_id,
        order: idx + 1,
        sets: r.sets,
        reps_or_duration_seconds: r.reps_or_duration_seconds,
        weight_lbs: r.weight_lbs,
        rest_seconds: r.rest_seconds,
        superset_group_id: r.superset_group_id,
        notes: r.notes,
      }),
    );

    // Persist: soft-archive the prior live rows, then re-create the result set.
    await this.replaceLiveRows(tx, planId, finalRows);

    // Resolve the plan-meta snapshot. plan_meta ops patch name/type/duration/
    // week/day; we apply the patch to the plan row (only the columns that exist
    // on WorkoutPlan) and fold the rest into the JSON snapshot.
    const meta = await this.applyPlanMeta(tx, planId, metaPatch);
    return { snapshot: finalRows, meta };
  }

  /**
   * Replace `planId`'s live exercise rows with `rows`: soft-archive the current
   * live set (archived_at = now, mirroring setExercises) then createMany the new
   * set. Used by both the autosave op-apply path and the undo restore path so
   * the two share one persistence contract.
   */
  private async replaceLiveRows(
    tx: Prisma.TransactionClient,
    planId: string,
    rows: RevisionExerciseRow[],
  ): Promise<void> {
    await tx.workoutPlanExercise.updateMany({
      where: { workout_plan_id: planId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (rows.length > 0) {
      await tx.workoutPlanExercise.createMany({
        data: rows.map((r) => ({
          workout_plan_id: planId,
          exercise_external_id: r.exercise_external_id,
          order: r.order,
          sets: r.sets,
          reps_or_duration_seconds: r.reps_or_duration_seconds,
          weight_lbs: r.weight_lbs,
          rest_seconds: r.rest_seconds,
          superset_group_id: r.superset_group_id,
          notes: r.notes,
        })),
      });
    }
  }

  /**
   * Apply the plan_meta patch to the WorkoutPlan row (only the columns that
   * physically exist: name, type, duration_estimate_minutes, week_index,
   * day_index) and return the full plan-meta JSON snapshot for the revision row.
   * `duration_weeks` from the op is a program-level concept with no plan column;
   * it is preserved in the JSON snapshot only (never silently dropped).
   */
  private async applyPlanMeta(
    tx: Prisma.TransactionClient,
    planId: string,
    patch: Record<string, unknown>,
  ): Promise<Prisma.JsonValue> {
    const data: Prisma.WorkoutPlanUpdateInput = {};
    if (typeof patch.name === 'string') data.name = patch.name;
    if (typeof patch.type === 'string') {
      data.type = patch.type as Prisma.WorkoutPlanUpdateInput['type'];
    }
    if (typeof patch.duration_weeks === 'number') {
      // duration_weeks has no plan column; only mapped into the JSON snapshot.
    }
    if (typeof patch.week_index === 'number') data.week_index = patch.week_index;
    if (typeof patch.day_index === 'number') data.day_index = patch.day_index;

    const plan =
      Object.keys(data).length > 0
        ? await tx.workoutPlan.update({ where: { id: planId }, data })
        : await tx.workoutPlan.findUniqueOrThrow({ where: { id: planId } });

    const snapshot: Record<string, unknown> = {
      name: plan.name,
      type: plan.type,
      duration_estimate_minutes: plan.duration_estimate_minutes ?? null,
      week_index: plan.week_index ?? null,
      day_index: plan.day_index ?? null,
    };
    if (typeof patch.duration_weeks === 'number') {
      snapshot.duration_weeks = patch.duration_weeks;
    }
    return snapshot as Prisma.JsonValue;
  }

  /**
   * Write one WorkoutPlanRevision row inside the caller's transaction.
   *
   * NOTE (BUILDER_BRIEF file-surface §, shared-helper decision): the brief
   * permits extracting the literal `tx.workoutPlanRevision.create` block at
   * workout-builder.service.ts:984-1004 into a shared `writePlanRevision`
   * ONLY if the extraction touches <=10 lines of that function. It does not —
   * the existing block also computes plan_meta_json inline AND performs a
   * follow-up `workoutPlan.update({ head_revision_id })`, so a faithful
   * extraction would restructure ~20 lines of cloneProgramToClient/copyProgramPlans.
   * Per the brief that forbids the extraction, so this is the DUPLICATED literal
   * create call (the brief's explicit fallback), kept byte-faithful to the
   * MWB-1 shape (same columns, same InputJsonValue cast).
   */
  private async writeRevision(
    tx: Prisma.TransactionClient,
    args: {
      planId: string;
      revisionIndex: number;
      exercises: RevisionExerciseRow[];
      planMeta: Prisma.JsonValue;
      authorId: string;
      authorKind: AuthorKind;
      cause: AutosaveCause | 'undo';
    },
  ): Promise<{ id: string; created_at: Date }> {
    return tx.workoutPlanRevision.create({
      data: {
        workout_plan_id: args.planId,
        revision_index: args.revisionIndex,
        exercises_json: args.exercises as unknown as Prisma.InputJsonValue,
        plan_meta_json: (args.planMeta ?? {}) as Prisma.InputJsonValue,
        author_id: args.authorId,
        author_kind: args.authorKind,
        cause: args.cause,
      },
      select: { id: true, created_at: true },
    });
  }

  /** Map a validated row input onto the internal snapshot row shape. */
  private fromRowInput(input: UpsertExerciseRowInput): RevisionExerciseRow {
    return {
      exercise_external_id: input.exercise_external_id,
      order: input.order,
      sets: input.sets,
      reps_or_duration_seconds: input.reps_or_duration_seconds,
      weight_lbs: input.weight_lbs ?? null,
      rest_seconds: input.rest_seconds ?? null,
      superset_group_id: input.superset_group_id ?? null,
      notes: input.notes ?? null,
    };
  }

  /**
   * Deserialise a stored exercises_json snapshot back into ordered rows. The
   * snapshot is always an array of RevisionExerciseRow (written by writeRevision
   * or the MWB-1 baseline serialiseExerciseRows). A non-array payload is a
   * data-integrity violation, surfaced loudly (R0) rather than silently treated
   * as empty.
   */
  private deserialiseSnapshot(json: Prisma.JsonValue): RevisionExerciseRow[] {
    if (!Array.isArray(json)) {
      throw new ConflictException('Revision snapshot is malformed (not an array)');
    }
    return (json as unknown as RevisionExerciseRow[])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((r, idx) => ({
        exercise_external_id: r.exercise_external_id,
        order: idx + 1,
        sets: r.sets,
        reps_or_duration_seconds: r.reps_or_duration_seconds,
        weight_lbs: r.weight_lbs ?? null,
        rest_seconds: r.rest_seconds ?? null,
        superset_group_id: r.superset_group_id ?? null,
        notes: r.notes ?? null,
      }));
  }

  /** Reject an ops batch whose serialized size exceeds the 64 KB cap (§6.2). */
  private assertOpsByteBudget(ops: AutosaveOpInput[]): void {
    const bytes = Buffer.byteLength(JSON.stringify(ops), 'utf8');
    if (bytes > AUTOSAVE_OPS_MAX_BYTES) {
      throw new BadRequestException(
        `ops payload exceeds the ${AUTOSAVE_OPS_MAX_BYTES}-byte limit`,
      );
    }
  }

  /** Issue a fresh server-side lock token: 16 lowercase hex chars (§6.2). */
  private issueLockToken(): string {
    return randomBytes(8).toString('hex');
  }

  /**
   * Coerce a Postgres serialization/deadlock failure raised under Serializable
   * isolation into a typed ConflictException('autosave_conflict_retry') — never
   * a leaked Prisma error (raw HTTP 500). Any other error is rethrown unchanged.
   * Mirrors cloneProgramToClient's P2034 posture (MWB-2 R3).
   *
   * Two Prisma surfaces can carry the same underlying conflict and BOTH must be
   * coerced:
   *   - P2034 — Prisma's own "transaction conflict / write conflict" code,
   *     raised when a serialization failure occurs inside a TYPED query Prisma
   *     manages directly.
   *   - P2010 — "raw query failed", raised when the failure occurs inside a
   *     `$queryRaw`/`$executeRaw`. The optimistic lock here is a raw
   *     `SELECT … FOR UPDATE`, so under Serializable a concurrent committed
   *     update surfaces as P2010 whose message carries the Postgres SQLSTATE
   *     `40001` (serialization_failure) — and, defensively, `40P01`
   *     (deadlock_detected), the same optimistic-conflict class. Without this
   *     branch the loser of a real race leaks a raw 500 instead of a typed 409
   *     (proven by the live concurrency spec, matrix #1/#8).
   */
  private coerceSerializationConflict(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2034') {
        return new ConflictException('autosave_conflict_retry');
      }
      if (err.code === 'P2010' && this.isPgSerializationFailure(err.message)) {
        return new ConflictException('autosave_conflict_retry');
      }
    }
    return err;
  }

  /**
   * True when a raw-query error message carries a Postgres serialization-class
   * SQLSTATE: `40001` (serialization_failure) or `40P01` (deadlock_detected).
   * Both are transient optimistic-concurrency conflicts the client should
   * retry, not server faults.
   */
  private isPgSerializationFailure(message: string): boolean {
    return /\b(40001|40P01)\b/.test(message);
  }

  /** Validate `raw` against a zod schema or throw a uniform 400 envelope. */
  private parse<T>(
    schema: {
      safeParse: (v: unknown) => {
        success: boolean;
        data?: T;
        error?: { issues: unknown[] };
      };
    },
    raw: unknown,
  ): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        issues: result.error?.issues ?? [],
      });
    }
    return result.data as T;
  }
}
