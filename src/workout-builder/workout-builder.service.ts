/**
 * WorkoutBuilderService — CRUD for WorkoutPlan, WorkoutPlanExercise, and
 * ClientWorkoutAssignment.
 *
 * Tenancy / RBAC rules:
 *   - Coach-side writes require role ∈ {coach, owner}. The controller
 *     enforces this with RolesGuard; the service re-checks via
 *     assertCoach() before any coach_id-owned write as a defense-in-depth
 *     server-authoritative gate (R22).
 *   - A coach can only read/mutate their own plans (coach_id = req.user.id).
 *   - Assignment creation checks that the target client belongs to the
 *     coach.
 *   - Archived plans are excluded from default list queries.
 *
 * Idempotency:
 *   - Coach mutations (create plan, update plan, replace exercises,
 *     create assignment) accept an Idempotency-Key UUID. The service
 *     stores the response in WorkoutBuilderIdempotencyKey keyed by
 *     (user_id, route_key, idempotency_key); retries replay the cached
 *     response without re-executing.
 *   - Assignment completion uses a per-assignment idempotency_key stored
 *     on the row itself; replays return the original record.
 *
 * Soft-archive on setExercises:
 *   - The prior exercise rows are soft-archived (archived_at = now) rather
 *     than deleted, so the partial unique index on (workout_plan_id, order)
 *     can re-use order slots cleanly and historical rows remain auditable.
 *
 * MWB-1 (§3.3) snapshots:
 *   - assignPlan writes an immutable ClientWorkoutAssignmentSnapshot inside
 *     the assign transaction. Assigned clients render from that snapshot, so
 *     a coach may freely edit a plan that already has active assignments
 *     (the legacy 409 guard is removed). Pre-MWB-1 assignments have no
 *     snapshot and fall back to the live workout_plan join.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { DripTriggerService } from '../packages/drip-trigger.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { isMwbTemplatesEnabled } from './mwb-templates.feature';
import {
  AssignProgramDto,
  CloneProgramResultDto,
  CompleteAssignmentDto,
  CreateAssignmentDto,
  CreateWorkoutPlanDto,
  UpdateWorkoutPlanDto,
  UpsertExerciseRowDto,
} from './workout-builder.dto';

/** Hard cap so paginated list endpoints can't be coerced into unbounded reads. */
export const WORKOUT_BUILDER_PAGE_MAX = 50;

export interface PaginatedQuery {
  limit?: number;
  cursor?: string | null;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class WorkoutBuilderService {
  private readonly logger = new Logger(WorkoutBuilderService.name);

  constructor(
    private readonly prisma: PrismaService,
    // PR-11 — optional injection for the on_completion drip trigger. Marked
    // @Optional so legacy unit-tests that construct WorkoutBuilderService
    // with a single PrismaService keep working (the dozens of pre-existing
    // tests under test/workout-builder.service.spec.ts and the materialiser
    // suite construct the service directly). forwardRef breaks the
    // module-load cycle PackagesModule <-> WorkoutBuilderModule that would
    // otherwise form via AssignableAssetResolversModule's transitive imports.
    @Optional()
    @Inject(forwardRef(() => DripTriggerService))
    private readonly dripTrigger?: DripTriggerService,
    // MWB-1 — sub-coach scope (§7.2). Injected to widen client-access checks
    // from "head coach owns client" to "head coach OR sub-coach with an open
    // assignment". @Optional so the dozens of pre-existing unit tests that
    // construct WorkoutBuilderService with just a PrismaService keep working;
    // when absent we fall back to the head-coach-only ownership check.
    @Optional()
    private readonly subCoachScope?: SubCoachScopeService,
    // MWB-1 — coach-driven assignment push (§3.3 gap (i)). Mirrors the AI
    // assign-workout materialiser's WORKOUT_ASSIGNED push so a human-assigned
    // workout notifies the client too. @Optional + fire-and-forget: a missing
    // service or a push failure never blocks the authoritative assignment row.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  // ─── RBAC guard ───────────────────────────────────────────────────────────

  /**
   * Server-authoritative coach gate. The controller's RolesGuard already
   * blocks non-coach roles, but every coach-side write also re-checks
   * here so a misconfigured guard (or a service called from a non-HTTP
   * path) can never create coach_id-owned data on behalf of a student.
   */
  private async assertCoach(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new ForbiddenException('User not found');
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException('Coach role required');
    }
  }

  // ─── Pagination helpers ───────────────────────────────────────────────────

  private resolveLimit(raw?: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return WORKOUT_BUILDER_PAGE_MAX;
    }
    return Math.min(Math.floor(raw), WORKOUT_BUILDER_PAGE_MAX);
  }

  /**
   * Keyset pagination cursor. We encode the sort-leading field plus the
   * row id so two rows sharing the same timestamp can still be ordered
   * deterministically. The encoded payload is base64'd so it stays
   * opaque to clients.
   *
   * Format (after base64 decode): `${isoTimestamp}|${id}`
   */
  private encodeCursor(timestamp: Date | string, id: string): string {
    const iso =
      typeof timestamp === 'string' ? timestamp : timestamp.toISOString();
    return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64');
  }

  private decodeCursor(
    cursor: string | null | undefined,
  ): { timestamp: Date; id: string } | null {
    if (!cursor) return null;
    try {
      const raw = Buffer.from(cursor, 'base64').toString('utf8');
      const sep = raw.indexOf('|');
      if (sep <= 0) return null;
      const iso = raw.slice(0, sep);
      const id = raw.slice(sep + 1);
      const timestamp = new Date(iso);
      if (Number.isNaN(timestamp.getTime()) || !id) return null;
      return { timestamp, id };
    } catch {
      return null;
    }
  }

  // ─── Idempotency helper ──────────────────────────────────────────────────

  /**
   * Generic per-user idempotency. RACE-SAFE: the key is CLAIMED atomically
   * BEFORE the mutation runs, not after.
   *
   * Flow:
   *   1. Attempt to insert a ledger row with status='in_progress'.
   *      - P2002 (duplicate key) → another request already holds the key.
   *        - If existing.status === 'completed': return cached response.
   *        - If existing.status === 'in_progress': 409 — concurrent retry.
   *   2. If the insert succeeded, run op(). The lock is the in_progress row.
   *   3. Update the same row to status='completed' with the response.
   *   4. If op() throws, delete the in_progress row so the caller can retry.
   *
   * This ensures the protected mutation runs exactly once even under
   * concurrent retries with the same key — not just that the same response
   * is returned after duplicate side effects.
   */
  async withIdempotency<T>(
    userId: string,
    routeKey: string,
    idempotencyKey: string | null | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) return op();

    // Step 1: atomically claim the key.
    let claimId: string | null = null;
    try {
      const claim = await this.prisma.workoutBuilderIdempotencyKey.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: 'in_progress',
        },
      });
      claimId = claim.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Another request already holds (or completed with) this key.
        const existing = await this.prisma.workoutBuilderIdempotencyKey.findUnique({
          where: {
            WorkoutBuilderIdempotencyKey_user_route_key_key: {
              user_id: userId,
              route_key: routeKey,
              idempotency_key: idempotencyKey,
            },
          },
        });
        if (!existing) {
          // Race: row was just deleted (op() failed). Try once more.
          throw new ConflictException(
            'Request in progress — retry in a moment',
          );
        }
        if (existing.status === 'completed') {
          return existing.response_json as unknown as T;
        }
        // status === 'in_progress' → concurrent retry. Surface 409 so
        // the client can back off; we do NOT run the mutation a second time.
        throw new ConflictException(
          'Request in progress — retry in a moment',
        );
      }
      throw err;
    }

    // Step 2: run the protected operation under the claim.
    let result: T;
    try {
      result = await op();
    } catch (err) {
      // Release the claim so the client can retry with the same key.
      // best-effort: ignore delete failures so the original error wins.
      try {
        await this.prisma.workoutBuilderIdempotencyKey.delete({
          where: { id: claimId },
        });
      } catch {
        /* swallow */
      }
      throw err;
    }

    // Step 3: persist the cached response and flip status to 'completed'.
    await this.prisma.workoutBuilderIdempotencyKey.update({
      where: { id: claimId },
      data: {
        status: 'completed',
        response_json: result as unknown as Prisma.InputJsonValue,
        status_code: 200,
      },
    });

    return result;
  }

  // ─── WorkoutPlan ──────────────────────────────────────────────────────────

  /**
   * Coach plan list. Keyset paginated by (created_at DESC, id DESC) so
   * newest plans come first and the ordering matches the composite
   * index (coach_id, archived_at, created_at DESC) without a sort step.
   */
  async listPlans(
    coachId: string,
    query: PaginatedQuery = {},
  ): Promise<Paginated<unknown>> {
    await this.assertCoach(coachId);
    const limit = this.resolveLimit(query.limit);
    const decoded = this.decodeCursor(query.cursor);
    // (created_at, id) DESC tiebreak: next page starts strictly after
    // the cursor row. Use OR to express the lexicographic "<".
    const cursorWhere: Prisma.WorkoutPlanWhereInput | undefined = decoded
      ? {
          OR: [
            { created_at: { lt: decoded.timestamp } },
            {
              created_at: decoded.timestamp,
              id: { lt: decoded.id },
            },
          ],
        }
      : undefined;
    const items = await this.prisma.workoutPlan.findMany({
      where: {
        coach_id: coachId,
        archived_at: null,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        exercises: {
          where: { archived_at: null },
          orderBy: { order: 'asc' },
        },
      },
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? this.encodeCursor(last.created_at, last.id) : null;
    return { items: page, nextCursor };
  }

  async getPlan(coachId: string, planId: string) {
    await this.assertCoach(coachId);
    const plan = await this.prisma.workoutPlan.findUnique({
      where: { id: planId },
      include: {
        exercises: {
          where: { archived_at: null },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!plan) throw new NotFoundException('Workout plan not found');
    if (plan.coach_id !== coachId) throw new ForbiddenException();
    return plan;
  }

  async createPlan(
    coachId: string,
    dto: CreateWorkoutPlanDto,
    idempotencyKey?: string | null,
  ) {
    await this.assertCoach(coachId);
    return this.withIdempotency(
      coachId,
      'workout-builder:createPlan',
      idempotencyKey,
      () =>
        this.prisma.workoutPlan.create({
          data: {
            coach_id: coachId,
            name: dto.name,
            type: dto.type,
            duration_estimate_minutes: dto.duration_estimate_minutes ?? null,
          },
          include: { exercises: true },
        }),
    );
  }

  async updatePlan(
    coachId: string,
    planId: string,
    dto: UpdateWorkoutPlanDto,
    idempotencyKey?: string | null,
  ) {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    return this.withIdempotency(
      coachId,
      `workout-builder:updatePlan:${planId}`,
      idempotencyKey,
      () =>
        this.prisma.workoutPlan.update({
          where: { id: planId },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.type !== undefined && { type: dto.type }),
            ...(dto.duration_estimate_minutes !== undefined && {
              duration_estimate_minutes: dto.duration_estimate_minutes,
            }),
          },
          include: {
            exercises: {
              where: { archived_at: null },
              orderBy: { order: 'asc' },
            },
          },
        }),
    );
  }

  /**
   * Soft-archive a plan.
   *
   * P1-4 (audit #5): uses a single conditional `updateMany WHERE
   * archived_at IS NULL` so two concurrent archive requests can't both
   * stamp the timestamp. The first matches and stamps; the second sees
   * count=0 and falls through to re-read the row. Both return the same
   * (archived) record without a transaction.
   *
   * Idempotency ledger is still consulted so concurrent retries collapse
   * to one cached response just like the other coach writes.
   */
  async archivePlan(
    coachId: string,
    planId: string,
    idempotencyKey?: string | null,
  ) {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    return this.withIdempotency(
      coachId,
      `workout-builder:archivePlan:${planId}`,
      idempotencyKey,
      async () => {
        // Atomic conditional update — safe under concurrent DELETEs.
        // Whichever request matches first stamps archived_at; replays
        // (and concurrent losers) match zero rows and no-op.
        await this.prisma.workoutPlan.updateMany({
          where: { id: planId, coach_id: coachId, archived_at: null },
          data: { archived_at: new Date() },
        });

        // Re-read the row regardless. Handles both first-archive and
        // replay: in both cases we return the now-archived plan.
        const plan = await this.prisma.workoutPlan.findUnique({
          where: { id: planId },
        });
        if (!plan) throw new NotFoundException('Workout plan not found');
        if (plan.coach_id !== coachId) throw new ForbiddenException();
        return plan;
      },
    );
  }

  // ─── WorkoutPlanExercise rows ─────────────────────────────────────────────

  /**
   * Replace the live exercise rows for a plan.
   *
   * If the plan already has any active (non-completed) assignments, the
   * existing live rows are soft-archived (archived_at = now) so the
   * assigned clients keep seeing the snapshot they were assigned. If
   * there are no active assignments, soft-archiving still happens — it
   * is the safe default and keeps history queryable.
   *
   * Read paths filter WHERE archived_at IS NULL, so the new rows become
   * the visible list. The partial unique index on (workout_plan_id,
   * order) WHERE archived_at IS NULL prevents two live rows from
   * colliding on the same order slot.
   */
  async setExercises(
    coachId: string,
    planId: string,
    rows: UpsertExerciseRowDto[],
    idempotencyKey?: string | null,
  ) {
    // Static (non-volatile) request-shape validation runs outside the
    // ledger so a malformed retry never claims an idempotency key.
    const orders = rows.map((r) => r.order);
    if (new Set(orders).size !== orders.length) {
      throw new BadRequestException(
        'Exercise order values must be unique within a plan',
      );
    }

    return this.withIdempotency(
      coachId,
      `workout-builder:setExercises:${planId}`,
      idempotencyKey,
      async () => {
        // Auth/ownership checks run only after the ledger confirms no
        // completed response exists for this key. Otherwise a client
        // that legitimately succeeded once would get a 409 on retry
        // because an assignment was created in between.
        await this.assertCoach(coachId);
        await this.assertPlanOwnership(coachId, planId);

        // The exercise mutation is serialised against concurrent
        // setExercises calls on the same plan via a `FOR UPDATE` lock on
        // the WorkoutPlan row inside a serializable transaction, so two
        // concurrent edits cannot interleave their soft-archive + insert.
        //
        // MWB-1 (§3.3): the legacy 409 "plan has active assignments" guard is
        // REMOVED. Editing an assigned plan is now safe because each
        // assignment carries an immutable ClientWorkoutAssignmentSnapshot
        // taken at assign time — assigned clients keep seeing exactly the
        // workout they were given regardless of later edits to the source
        // plan. Coaches can therefore freely iterate on a plan that already
        // has active assignments.
        return this.prisma.$transaction(
          async (tx) => {
            // Lock the plan row to serialise against concurrent
            // setExercises() writers. The ownership check above already
            // confirmed the plan exists, but we still re-check inside
            // the lock because a concurrent archive could have run.
            const planRows = await tx.$queryRaw<{ id: string }[]>`
              SELECT "id" FROM "WorkoutPlan"
              WHERE "id" = ${planId}
              FOR UPDATE
            `;
            if (planRows.length === 0) {
              throw new NotFoundException('Workout plan not found');
            }

            // Soft-archive all live rows. The partial unique index only
            // applies WHERE archived_at IS NULL, so once we stamp these
            // rows the new ones can re-use their order slots cleanly.
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
                  weight_lbs: r.weight_lbs ?? null,
                  rest_seconds: r.rest_seconds ?? null,
                  superset_group_id: r.superset_group_id ?? null,
                  notes: r.notes ?? null,
                })),
              });
            }

            return tx.workoutPlanExercise.findMany({
              where: { workout_plan_id: planId, archived_at: null },
              orderBy: { order: 'asc' },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      },
    );
  }

  // ─── ClientWorkoutAssignment ──────────────────────────────────────────────

  async assignPlan(
    coachId: string,
    planId: string,
    dto: CreateAssignmentDto,
    idempotencyKey?: string | null,
  ) {
    return this.withIdempotency(
      coachId,
      `workout-builder:assignPlan:${planId}`,
      idempotencyKey,
      async () => {
        // Auth/ownership and the client-belongs check run only after the
        // ledger confirms no completed response exists for this key. If
        // the original call succeeded and a sub-coach reassignment later
        // changed who owns the client, the retry should still replay the
        // cached success rather than 4xx on a now-stale precondition.
        await this.assertCoach(coachId);
        await this.assertPlanOwnership(coachId, planId);
        // MWB-1 (§7.2): widen from head-coach-only to head-coach OR open
        // sub-coach. Legacy head-coach behaviour is preserved exactly when
        // SubCoachScopeService is not wired (unit-test construction).
        await this.assertCanAccessClient(coachId, dto.client_id);

        // MWB-1 (§3.3): the assignment row AND its immutable plan snapshot are
        // written in one transaction so a client can never observe an
        // assignment without its frozen exercise list. Later coach edits to
        // the source plan never mutate the snapshot (read path renders it).
        const created = await this.prisma.$transaction(async (tx) => {
          const assignment = await tx.clientWorkoutAssignment.create({
            data: {
              workout_plan_id: planId,
              client_id: dto.client_id,
              assigned_by_coach_id: coachId,
              scheduled_for: new Date(dto.scheduled_for),
            },
          });
          await this.writeAssignmentSnapshot(tx, assignment.id, planId);
          return assignment;
        });

        // Fire-and-forget WORKOUT_ASSIGNED push (mirrors the AI assign path).
        this.emitAssignmentPush(dto.client_id, created.id, planId);
        return created;
      },
    );
  }

  /**
   * Per-plan assignment list. Keyset paginated by (scheduled_for ASC,
   * id ASC) so upcoming sessions come first and ordering matches the
   * (workout_plan_id, scheduled_for) composite index.
   */
  async listAssignments(
    coachId: string,
    planId: string,
    query: PaginatedQuery = {},
  ): Promise<Paginated<unknown>> {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    const limit = this.resolveLimit(query.limit);
    const decoded = this.decodeCursor(query.cursor);
    const cursorWhere: Prisma.ClientWorkoutAssignmentWhereInput | undefined =
      decoded
        ? {
            OR: [
              { scheduled_for: { gt: decoded.timestamp } },
              {
                scheduled_for: decoded.timestamp,
                id: { gt: decoded.id },
              },
            ],
          }
        : undefined;
    const items = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        workout_plan_id: planId,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ scheduled_for: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? this.encodeCursor(last.scheduled_for, last.id)
        : null;
    return { items: page, nextCursor };
  }

  /**
   * Client-facing: list the calling user's assignments, including the
   * owning plan and its live (non-archived) exercises in order.
   * Restricted to client_id = userId so a leaked URL cannot expose
   * another user's training history (defense-in-depth atop RLS).
   */
  async listMyAssignments(
    userId: string,
    query: PaginatedQuery = {},
  ): Promise<Paginated<unknown>> {
    const limit = this.resolveLimit(query.limit);
    const decoded = this.decodeCursor(query.cursor);
    const cursorWhere: Prisma.ClientWorkoutAssignmentWhereInput | undefined =
      decoded
        ? {
            OR: [
              { scheduled_for: { gt: decoded.timestamp } },
              {
                scheduled_for: decoded.timestamp,
                id: { gt: decoded.id },
              },
            ],
          }
        : undefined;
    const items = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        client_id: userId,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ scheduled_for: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: {
        // MWB-1 (§3.3): include the immutable snapshot. When present, the
        // client reads the frozen exercise list (presentAssignment below);
        // the live join is the backward-compat fallback for pre-MWB-1 rows.
        snapshot: true,
        workout_plan: {
          include: {
            exercises: {
              where: { archived_at: null },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? this.encodeCursor(last.scheduled_for, last.id)
        : null;
    return { items: page.map((a) => this.presentAssignment(a)), nextCursor };
  }

  /**
   * Client-facing single-assignment read.
   *
   * - 404 when the row does not exist.
   * - 403 when the row exists but belongs to a different user.
   * - returns the row when it exists and the caller is the owner.
   *
   * The 403 / 404 split is intentional: it surfaces the right semantic
   * to the mobile app (an unknown id vs. a permission problem) without
   * leaking sensitive cross-tenant detail beyond "this id is taken".
   * The audit explicitly flagged collapsing both into 404 as a P1.
   */
  async getMyAssignment(userId: string, assignmentId: string) {
    const assignment = await this.prisma.clientWorkoutAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        snapshot: true,
        workout_plan: {
          include: {
            exercises: {
              where: { archived_at: null },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });
    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }
    if (assignment.client_id !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return this.presentAssignment(assignment);
  }

  /**
   * Atomically mark an assignment complete.
   *
   * Race-safety: uses a single conditional updateMany() (WHERE
   * completed_at IS NULL) so two concurrent completion requests can't
   * both succeed. Whichever one matches first stamps completed_at; the
   * other sees count=0 and falls through to the "already completed"
   * branch — idempotent if the keys match, conflict if they differ.
   *
   * Authorisation: existence check is separate from ownership check so
   * a foreign assignment gets a 403 (not a 404 that leaks existence).
   */
  async completeAssignment(
    clientId: string,
    assignmentId: string,
    dto: CompleteAssignmentDto,
  ) {
    // Existence + ownership disambiguation (R22 server-authoritative gate).
    const existing = await this.prisma.clientWorkoutAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        client_id: true,
        completed_at: true,
        completion_idempotency_key: true,
      },
    });
    if (!existing) throw new NotFoundException('Assignment not found');
    if (existing.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }

    // Fast-path replay: same idempotency key on an already-completed row
    // returns the full record without a write.
    if (
      existing.completed_at &&
      existing.completion_idempotency_key === dto.idempotency_key
    ) {
      return this.prisma.clientWorkoutAssignment.findUnique({
        where: { id: assignmentId },
      });
    }

    // Conditional atomic update: only succeeds if the row is still not
    // completed. Two concurrent requests can't both match.
    const updated = await this.prisma.clientWorkoutAssignment.updateMany({
      where: {
        id: assignmentId,
        client_id: clientId,
        completed_at: null,
      },
      data: {
        completed_at: new Date(),
        post_rpe: dto.post_rpe ?? null,
        post_notes: dto.post_notes ?? null,
        completion_idempotency_key: dto.idempotency_key,
        started_at: dto.started_at ? new Date(dto.started_at) : null,
        completion_payload:
          (dto.completion_payload as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    if (updated.count === 1) {
      const completed = await this.prisma.clientWorkoutAssignment.findUnique({
        where: { id: assignmentId },
      });
      // PR-11 — fire on_completion drip trigger. Only on the real
      // completion path (updated.count===1), NEVER on the idempotent
      // replay branch above (which short-circuits before this update).
      // Best-effort: DripTriggerService.onContentCompleted never throws,
      // but we wrap defensively so even a future regression in the
      // trigger pipeline cannot break a legitimate workout completion.
      // The asset_type passed matches the snapshot side
      // (workout.resolver.ts handles both 'workout_plan' and
      // 'workout_program' and they reference the same WorkoutPlan id);
      // we pass 'workout_plan' since the DripTriggerService matches
      // ScheduledDrop.asset_type+asset_id verbatim against the snapshot
      // — see drip-trigger.service.ts for why both kinds resolve here.
      if (this.dripTrigger && completed) {
        try {
          await this.dripTrigger.onContentCompleted({
            buyerUserId: completed.client_id,
            assetType: 'workout_plan',
            assetId: completed.workout_plan_id,
          });
          // Also fire for the workout_program alias: a coach may have
          // attached the same plan as cadence_kind=workout_program
          // (the snapshot's asset_type would then be 'workout_program').
          // Both forms resolve to the same underlying WorkoutPlan id —
          // the trigger query filters by asset_type+asset_id so the
          // two emits each scope to their own snapshot type and do not
          // double-fire.
          await this.dripTrigger.onContentCompleted({
            buyerUserId: completed.client_id,
            assetType: 'workout_program',
            assetId: completed.workout_plan_id,
          });
        } catch (err) {
          this.logger.warn(
            `WorkoutBuilderService: DripTrigger emit failed (completion still recorded) assignment=${assignmentId}: ${(err as Error).message}`,
          );
        }
      }
      return completed;
    }

    // Update didn't take effect: the row is already completed (by us
    // or by a concurrent request). Re-read and decide.
    const after = await this.prisma.clientWorkoutAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!after) throw new NotFoundException('Assignment not found');
    if (after.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }
    if (after.completion_idempotency_key === dto.idempotency_key) {
      // Idempotent replay — same key, already completed.
      return after;
    }
    // Different key against an already-completed row. Surface as
    // conflict so the mobile client can prompt the user rather than
    // silently overwrite earlier session data.
    throw new ConflictException('Assignment already completed');
  }

  // ─── Guards ───────────────────────────────────────────────────────────────

  private async assertPlanOwnership(coachId: string, planId: string) {
    const plan = await this.prisma.workoutPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Workout plan not found');
    if (plan.coach_id !== coachId) throw new ForbiddenException();
  }

  private async assertClientBelongsToCoach(coachId: string, clientId: string) {
    const client = await this.prisma.user.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.coach_id !== coachId)
      throw new ForbiddenException('Client does not belong to this coach');
  }

  /**
   * MWB-1 (§7.2) — widened client-access gate. Returns normally when the
   * acting user may act on `clientId`, i.e. EITHER:
   *   - they are the client's head coach/owner (client.coach_id === actingUserId), OR
   *   - they are a sub-coach with an OPEN SubCoachAssignment to that client
   *     (delegated to SubCoachScopeService — the single source of truth).
   *
   * Throws NotFoundException if the client does not exist, ForbiddenException
   * if the acting user has no access. When SubCoachScopeService is not
   * injected (legacy unit-test construction) we degrade to the original
   * head-coach-only check so existing behaviour is preserved exactly.
   */
  async assertCanAccessClient(actingUserId: string, clientId: string) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    // Head coach / owner direct ownership.
    if (client.coach_id === actingUserId) return;
    // Sub-coach overlay (open SubCoachAssignment). Only consulted when the
    // service is wired with the scope helper.
    if (this.subCoachScope) {
      const ok = await this.subCoachScope.canAccessClient(actingUserId, clientId);
      if (ok) return;
    }
    throw new ForbiddenException('Client does not belong to this coach');
  }

  // ─── MWB-1: programs — fork / clone / fan-out (§3.2, §3.4, §7.3) ──────────

  /**
   * Deep-copy (by value) every plan + exercise under `sourceProgramId` into
   * `newProgramId`, inside the caller's transaction. Returns the created
   * plans. Each plan gets a fresh id and an `initial`/`clone` revision
   * baseline so undo (later phase) has an anchor. `superset_group_id`s are
   * re-mapped into the NEW plan's namespace so two cloned plans can never
   * collide on a shared group id. Shared by forkTemplate + cloneProgramToClient.
   */
  private async copyProgramPlans(
    tx: Prisma.TransactionClient,
    sourceProgramId: string,
    newProgramId: string,
    opts: {
      isTemplate: boolean;
      actingUserId: string;
      authorKind: 'coach' | 'sub_coach' | 'ai';
      // 'clone' for clone-to-client, 'initial' for a fork baseline.
      cause: 'clone' | 'initial';
      coachId: string;
    },
  ) {
    const sourcePlans = await tx.workoutPlan.findMany({
      where: { program_id: sourceProgramId, archived_at: null },
      orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
      include: {
        exercises: {
          where: { archived_at: null },
          orderBy: { order: 'asc' },
        },
      },
    });

    const created: Array<{ id: string }> = [];
    for (const src of sourcePlans) {
      // Per-plan superset namespace remap: deterministic within this plan so
      // grouped exercises stay grouped, but never shared across plans.
      const groupRemap = new Map<string, string>();
      const remapGroup = (g: string | null): string | null => {
        if (g == null) return null;
        const existing = groupRemap.get(g);
        if (existing) return existing;
        const fresh = `${newProgramId}:${created.length}:${groupRemap.size}`;
        groupRemap.set(g, fresh);
        return fresh;
      };

      const newPlan = await tx.workoutPlan.create({
        data: {
          coach_id: opts.coachId,
          name: src.name,
          type: src.type,
          duration_estimate_minutes: src.duration_estimate_minutes,
          program_id: newProgramId,
          week_index: src.week_index,
          day_index: src.day_index,
          is_template: opts.isTemplate,
          version: 1,
          cloned_from_plan_id: src.id,
        },
      });

      const rows = src.exercises.map((e) => ({
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs ?? null,
        rest_seconds: e.rest_seconds ?? null,
        superset_group_id: remapGroup(e.superset_group_id ?? null),
        notes: e.notes ?? null,
      }));
      if (rows.length > 0) {
        await tx.workoutPlanExercise.createMany({
          data: rows.map((r) => ({ ...r, workout_plan_id: newPlan.id })),
        });
      }

      // Initial revision baseline (§5): full ordered snapshot so undo has
      // an anchor and provenance is preserved (never pruned).
      const revision = await tx.workoutPlanRevision.create({
        data: {
          workout_plan_id: newPlan.id,
          revision_index: 0,
          exercises_json: this.serialiseExerciseRows(rows),
          plan_meta_json: {
            name: newPlan.name,
            type: newPlan.type,
            duration_estimate_minutes: newPlan.duration_estimate_minutes ?? null,
            week_index: newPlan.week_index ?? null,
            day_index: newPlan.day_index ?? null,
          } as unknown as Prisma.InputJsonValue,
          author_id: opts.actingUserId,
          author_kind: opts.authorKind,
          cause: opts.cause,
        },
      });
      await tx.workoutPlan.update({
        where: { id: newPlan.id },
        data: { head_revision_id: revision.id },
      });

      created.push({ id: newPlan.id });
    }
    return created;
  }

  /**
   * MWB-1 (§7.3) — fork a template program into a NEW program owned by the
   * acting user. "Grab a building block, make it your own." The source must
   * be either `visibility='tenant_shared'` within the actor's tenant OR owned
   * by the actor. The fork is a deep copy by value and fully independent of
   * the source thereafter (the sub-coach's editing affordance — no
   * canEditTemplates flag needed; a sub-coach never mutates a shared master).
   */
  async forkTemplate(sourceTemplateId: string, actingUserId: string) {
    const source = await this.prisma.workoutProgram.findUnique({
      where: { id: sourceTemplateId },
    });
    if (!source) throw new NotFoundException('Source template not found');

    // Authorisation: owner, OR a tenant_shared building block within the
    // actor's tenant. We resolve the actor's tenant from their own user row
    // (head coaches: their own id is the tenant; sub-coaches: their coach_id).
    const actor = await this.prisma.user.findUnique({
      where: { id: actingUserId },
      select: { id: true, coach_id: true },
    });
    if (!actor) throw new ForbiddenException('Acting user not found');
    const actorTenantId = actor.coach_id ?? actor.id;
    const isOwner = source.owner_user_id === actingUserId;
    const isSharedInTenant =
      source.visibility === 'tenant_shared' &&
      source.coach_id === actorTenantId;
    if (!isOwner && !isSharedInTenant) {
      throw new ForbiddenException(
        'You may only fork a program you own or a tenant-shared building block in your business',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const program = await tx.workoutProgram.create({
          data: {
            coach_id: actorTenantId,
            owner_user_id: actingUserId,
            visibility: 'owner_only',
            forked_from_id: sourceTemplateId,
            name: source.name,
            description: source.description,
            weeks: source.weeks,
            days_per_week: source.days_per_week,
            is_template: true,
            goal_tag: source.goal_tag,
            version: 1,
          },
        });
        const plans = await this.copyProgramPlans(tx, sourceTemplateId, program.id, {
          isTemplate: true,
          actingUserId,
          authorKind: actor.coach_id ? 'sub_coach' : 'coach',
          cause: 'initial',
          coachId: actorTenantId,
        });
        return { program, plans };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * MWB-2 (§3.3, Decision A LOCKED) — clone a master template program onto a
   * specific client. Deep-copy BY VALUE into a NEW non-template program
   * (`cloned_from_id` set) so the coach keeps refining the master without ever
   * disturbing the client mid-program ("grab-a-copy, never mutate source").
   *
   * Order of operations (hard gates, BUILDER_BRIEF):
   *   1. FEATURE_MWB_TEMPLATES flag re-check — defence-in-depth so an internal
   *      caller cannot drive a clone while the feature is OFF (R0: never a
   *      silent bypass). Surfaces as 404 to match the route guard, never
   *      leaking that the feature exists.
   *   2. Sub-coach scope check is consulted via assertCanAccessClient (head
   *      coach OR open sub-coach), AFTER cheap role + reachability gates that
   *      decide 403/404 without leaking cross-tenant existence.
   *   3. The whole clone runs in a SERIALIZABLE transaction so a concurrent
   *      write to the source program forces one of the two to roll back
   *      deterministically (no torn copy).
   *
   * Decision A invariants enforced here:
   *   - every cloned plan + exercise is copied by value (copyProgramPlans),
   *   - `cloned_from_plan_id` is set on each new plan to its source plan,
   *   - `is_template=false` on the program and all cloned children,
   *   - a FRESH program-level WorkoutProgramRevision (revision_index 0,
   *     cause='clone') is written and the clone's `head_revision_id` is
   *     pointed at it, so the clone starts from its own "v1" rather than
   *     inheriting the master's revision lineage.
   *
   * Foreign-coach (no reach to master) → 403. Foreign-tenant / missing master
   * → 404 (do not leak that the program exists). Flag OFF → 404.
   *
   * Returns the new program, its plans, and the fresh program revision. The
   * controller maps this to the typed CloneProgramResultDto.
   */
  async cloneProgramToClient(
    masterProgramId: string,
    clientId: string,
    coachId: string,
  ) {
    // (1) Flag gate FIRST — before any DB read — so the feature is genuinely
    // unreachable when OFF. 404 (NotFound), never 403, to hide its existence.
    if (!isMwbTemplatesEnabled()) {
      throw new NotFoundException('Master program not found');
    }
    await this.assertCoach(coachId);
    const master = await this.prisma.workoutProgram.findUnique({
      where: { id: masterProgramId },
    });
    if (!master) throw new NotFoundException('Master program not found');
    // The coach must own the master (or it must be a tenant_shared block they
    // can reach) AND have access to the target client.
    const actor = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { id: true, coach_id: true },
    });
    if (!actor) throw new ForbiddenException('Acting user not found');
    const actorTenantId = actor.coach_id ?? actor.id;
    const canReachMaster =
      master.owner_user_id === coachId ||
      (master.visibility === 'tenant_shared' &&
        master.coach_id === actorTenantId);
    if (!canReachMaster) {
      // A program the coach cannot reach (foreign owner / foreign tenant) must
      // look NOT FOUND rather than forbidden — never leak that it exists
      // across a tenant boundary (BUILDER_BRIEF hard gate).
      throw new NotFoundException('Master program not found');
    }
    // (2) Sub-coach scope: head coach OR open SubCoachAssignment. Foreign
    // coach with no access → 403 (assertCanAccessClient).
    await this.assertCanAccessClient(coachId, clientId);

    // (3) Serializable transaction — a concurrent mutation of the source
    // program serialises against this read+copy and one side rolls back.
    return this.prisma.$transaction(
      async (tx) => {
        const program = await tx.workoutProgram.create({
          data: {
            coach_id: actorTenantId,
            owner_user_id: coachId,
            visibility: 'owner_only',
            name: master.name,
            description: master.description,
            weeks: master.weeks,
            days_per_week: master.days_per_week,
            is_template: false,
            cloned_from_id: masterProgramId,
            goal_tag: master.goal_tag,
            version: 1,
          },
        });
        const plans = await this.copyProgramPlans(tx, masterProgramId, program.id, {
          isTemplate: false,
          actingUserId: coachId,
          authorKind: actor.coach_id ? 'sub_coach' : 'coach',
          cause: 'clone',
          coachId: actorTenantId,
        });
        // Decision A: fresh program-level revision so the clone starts at v1
        // (its own lineage), and head_revision_id points at it. Written inside
        // the same Serializable txn as the program + plans so the clone is
        // atomic — a partial clone (program with no head revision) can never
        // be observed.
        const programRevision = await tx.workoutProgramRevision.create({
          data: {
            program_id: program.id,
            revision_index: 0,
            structure_json: this.serialiseProgramStructure(
              program,
              plans,
            ),
            author_id: coachId,
            author_kind: actor.coach_id ? 'sub_coach' : 'coach',
            cause: 'clone',
          },
        });
        const programWithHead = await tx.workoutProgram.update({
          where: { id: program.id },
          data: { head_revision_id: programRevision.id },
        });
        return { program: programWithHead, plans, programRevision };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * MWB-2 (§3.3) typed facade over cloneProgramToClient for the
   * clone-to-client HTTP surface. Runs the full clone (flag gate → scope →
   * Serializable txn) and projects the result onto the explicit
   * CloneProgramResultDto shape (R68: no `unknown`/`any` leaks across the API
   * boundary). The plan ids are returned in (week_index, day_index) order as
   * produced by copyProgramPlans.
   */
  async cloneProgramToClientResult(
    masterProgramId: string,
    clientId: string,
    coachId: string,
  ): Promise<CloneProgramResultDto> {
    const { program, plans, programRevision } = await this.cloneProgramToClient(
      masterProgramId,
      clientId,
      coachId,
    );
    return {
      program_id: program.id,
      cloned_from_id: program.cloned_from_id ?? masterProgramId,
      is_template: program.is_template,
      head_revision_id: programRevision.id,
      plan_ids: plans.map((p) => p.id),
    };
  }

  /**
   * Frozen structural snapshot of a freshly-cloned program: its week/day
   * layout plus the ordered ids of the plans that make it up. Stored as the
   * `structure_json` of the program-level WorkoutProgramRevision (§5) so the
   * clone's "v1" revision records exactly which plans composed it at clone
   * time — the anchor for later program-level undo / history.
   */
  private serialiseProgramStructure(
    program: {
      id: string;
      weeks: number;
      days_per_week: number;
      cloned_from_id: string | null;
    },
    plans: Array<{ id: string }>,
  ): Prisma.InputJsonValue {
    return {
      program_id: program.id,
      weeks: program.weeks,
      days_per_week: program.days_per_week,
      cloned_from_id: program.cloned_from_id ?? null,
      plan_ids: plans.map((p) => p.id),
    } as unknown as Prisma.InputJsonValue;
  }

  /**
   * MWB-1 (§3.4) — program-level assignment fan-out. Assigns every plan in
   * `programId` to `dto.client_id`, scheduling each plan's `scheduled_for`
   * by its (week_index, day_index) offset from `dto.start_date`. A single
   * idempotency key (header) covers the whole fan-out: the key is claimed
   * once and all N assignment rows + snapshots are emitted in one
   * transaction, so a retry replays the cached batch rather than
   * double-assigning.
   */
  async assignProgramToClient(
    coachId: string,
    programId: string,
    dto: AssignProgramDto,
    idempotencyKey?: string | null,
  ) {
    return this.withIdempotency(
      coachId,
      `workout-builder:assignProgram:${programId}`,
      idempotencyKey,
      async () => {
        await this.assertCoach(coachId);
        const program = await this.prisma.workoutProgram.findUnique({
          where: { id: programId },
          select: { id: true, owner_user_id: true, coach_id: true, visibility: true },
        });
        if (!program) throw new NotFoundException('Program not found');
        const actor = await this.prisma.user.findUnique({
          where: { id: coachId },
          select: { id: true, coach_id: true },
        });
        if (!actor) throw new ForbiddenException('Acting user not found');
        const actorTenantId = actor.coach_id ?? actor.id;
        const canReach =
          program.owner_user_id === coachId ||
          (program.visibility === 'tenant_shared' &&
            program.coach_id === actorTenantId);
        if (!canReach) throw new ForbiddenException('You cannot assign this program');
        await this.assertCanAccessClient(coachId, dto.client_id);

        const plans = await this.prisma.workoutPlan.findMany({
          where: { program_id: programId, archived_at: null },
          orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
          select: { id: true, week_index: true, day_index: true },
        });
        if (plans.length === 0) {
          throw new BadRequestException('Program has no plans to assign');
        }

        const startDate = new Date(dto.start_date);
        const DAY_MS = 24 * 60 * 60 * 1000;

        const created = await this.prisma.$transaction(async (tx) => {
          const out: Array<{ id: string }> = [];
          for (const plan of plans) {
            // Offset = full weeks (7 days each) + day-of-week within the week.
            const offsetDays =
              (plan.week_index ?? 0) * 7 + (plan.day_index ?? 0);
            const scheduledFor = new Date(
              startDate.getTime() + offsetDays * DAY_MS,
            );
            const assignment = await tx.clientWorkoutAssignment.create({
              data: {
                workout_plan_id: plan.id,
                client_id: dto.client_id,
                assigned_by_coach_id: coachId,
                scheduled_for: scheduledFor,
              },
            });
            await this.writeAssignmentSnapshot(tx, assignment.id, plan.id);
            out.push({ id: assignment.id });
          }
          return out;
        });

        // One push for the whole program (avoid N notifications).
        this.emitAssignmentPush(dto.client_id, created[0].id, plans[0].id);
        return { assignments: created };
      },
    );
  }

  // ─── MWB-1: snapshot helpers (§3.3) ───────────────────────────────────────

  /**
   * Client read-path presenter. When the assignment carries a snapshot
   * (MWB-1, §3.3) the returned `exercises` come from the frozen
   * `exercises_json` — immune to later edits of the source plan. When there
   * is no snapshot (pre-MWB-1 assignment) we fall back to the live
   * workout_plan.exercises join, preserving the exact legacy shape. A
   * `snapshot_source` flag is added so callers can tell which path was used
   * without changing the existing fields.
   */
  private presentAssignment<
    T extends {
      snapshot?: { exercises_json: unknown } | null;
      workout_plan?: { exercises?: unknown[] } | null;
    },
  >(assignment: T): T & { exercises: unknown[]; snapshot_source: boolean } {
    if (assignment.snapshot) {
      const frozen = assignment.snapshot.exercises_json;
      return {
        ...assignment,
        exercises: Array.isArray(frozen) ? (frozen as unknown[]) : [],
        snapshot_source: true,
      };
    }
    return {
      ...assignment,
      exercises: assignment.workout_plan?.exercises ?? [],
      snapshot_source: false,
    };
  }

  /**
   * Frozen, ordered representation of a plan's live exercise rows, used as the
   * `exercises_json` payload of a ClientWorkoutAssignmentSnapshot. Field set
   * mirrors WorkoutPlanExercise so the client read path can render a snapshot
   * exactly like a live join.
   */
  private serialiseExerciseRows(
    rows: Array<{
      exercise_external_id: string;
      order: number;
      sets: number;
      reps_or_duration_seconds: number;
      weight_lbs: number | null;
      rest_seconds: number | null;
      superset_group_id: string | null;
      notes: string | null;
    }>,
  ): Prisma.InputJsonValue {
    return rows
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((r) => ({
        exercise_external_id: r.exercise_external_id,
        order: r.order,
        sets: r.sets,
        reps_or_duration_seconds: r.reps_or_duration_seconds,
        weight_lbs: r.weight_lbs ?? null,
        rest_seconds: r.rest_seconds ?? null,
        superset_group_id: r.superset_group_id ?? null,
        notes: r.notes ?? null,
      })) as unknown as Prisma.InputJsonValue;
  }

  /**
   * Take an immutable point-in-time snapshot of `planId` and attach it to
   * `assignmentId`, inside the caller's transaction (`tx`). Reads the plan +
   * its live (non-archived) exercise rows and writes one
   * ClientWorkoutAssignmentSnapshot row. Idempotent at the schema layer via
   * the @unique(assignment_id): a second call for the same assignment is a
   * no-op (we upsert-by-skip). See spec §3.3.
   */
  private async writeAssignmentSnapshot(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    planId: string,
  ): Promise<void> {
    const plan = await tx.workoutPlan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        name: true,
        type: true,
        version: true,
        exercises: {
          where: { archived_at: null },
          orderBy: { order: 'asc' },
          select: {
            exercise_external_id: true,
            order: true,
            sets: true,
            reps_or_duration_seconds: true,
            weight_lbs: true,
            rest_seconds: true,
            superset_group_id: true,
            notes: true,
          },
        },
      },
    });
    if (!plan) throw new NotFoundException('Workout plan not found');
    // @unique(assignment_id) means a re-emit would P2002; guard with a
    // pre-check so a retried fan-out (same assignment) is a clean no-op.
    const existing = await tx.clientWorkoutAssignmentSnapshot.findUnique({
      where: { assignment_id: assignmentId },
      select: { id: true },
    });
    if (existing) return;
    await tx.clientWorkoutAssignmentSnapshot.create({
      data: {
        assignment_id: assignmentId,
        plan_name: plan.name,
        plan_type: plan.type,
        exercises_json: this.serialiseExerciseRows(plan.exercises),
        source_plan_id: plan.id,
        source_version: plan.version,
      },
    });
  }

  /**
   * Fire-and-forget WORKOUT_ASSIGNED push for a coach-driven assignment
   * (§3.3 gap (i)). Mirrors AssignWorkoutMaterializer's notification so the
   * human and AI assign paths behave identically. Never throws: the
   * assignment row is authoritative, a push failure must not roll it back.
   */
  private emitAssignmentPush(
    clientId: string,
    assignmentId: string,
    workoutPlanId: string,
  ): void {
    if (!this.notifications) return;
    void this.notifications
      .createNotification({
        user_id: clientId,
        kind: NotificationKind.WORKOUT_ASSIGNED,
        body: 'Your coach assigned a new workout.',
        deep_link: `tgp://workouts/${assignmentId}`,
        channel: 'push',
        payload: { assignmentId, workoutPlanId },
      })
      .catch((err) => {
        this.logger.warn(
          `WorkoutBuilderService: workout-assigned push failed (assignment ${assignmentId} still authoritative): ${(err as Error).message}`,
        );
      });
  }
}
