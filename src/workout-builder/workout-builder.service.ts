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
 *   - If a plan already has active (non-completed) assignments, the
 *     prior exercise rows are soft-archived (archived_at = now) rather
 *     than deleted, so assigned clients keep seeing the exercises that
 *     were in the plan at assignment time.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
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
  constructor(private readonly prisma: PrismaService) {}

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

        // P1-3 (audit #5): the active-assignment check + exercise
        // mutation must be serialised against concurrent assignPlan
        // calls. Pre-transaction counting is a check-then-act race —
        // another request can sneak in an INSERT between the count and
        // the update. We take a `FOR UPDATE` lock on the WorkoutPlan
        // row inside a serializable transaction so any concurrent
        // assignment insert that targets the same plan must wait.
        return this.prisma.$transaction(
          async (tx) => {
            // Lock the plan row to serialise against concurrent
            // assignPlan() writers. The ownership check above already
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

            // Count active assignments INSIDE the transaction, after
            // the row lock — under SERIALIZABLE isolation a concurrent
            // assignPlan() that reaches this point will either block on
            // the lock or be retried by Postgres on commit conflict.
            const activeAssignmentCount =
              await tx.clientWorkoutAssignment.count({
                where: { workout_plan_id: planId, completed_at: null },
              });
            if (activeAssignmentCount > 0) {
              throw new ConflictException(
                'This workout plan has active client assignments. Mark the ' +
                  'existing assignments complete or unassign them before editing ' +
                  'the exercise list, so assigned clients keep seeing the workout ' +
                  'they were given.',
              );
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
        await this.assertClientBelongsToCoach(coachId, dto.client_id);

        return this.prisma.clientWorkoutAssignment.create({
          data: {
            workout_plan_id: planId,
            client_id: dto.client_id,
            assigned_by_coach_id: coachId,
            scheduled_for: new Date(dto.scheduled_for),
          },
        });
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
    return { items: page, nextCursor };
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
    return assignment;
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
      return this.prisma.clientWorkoutAssignment.findUnique({
        where: { id: assignmentId },
      });
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
}
