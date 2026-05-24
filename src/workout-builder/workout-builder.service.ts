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
   * Cursor is the last row's `id`. Forward-only; consumers paginate by
   * passing the previous `nextCursor` back as `cursor`.
   */
  private cursorToWhere(cursor: string | null | undefined): { id: { gt: string } } | undefined {
    return cursor ? { id: { gt: cursor } } : undefined;
  }

  // ─── Idempotency helper ──────────────────────────────────────────────────

  /**
   * Generic per-user idempotency. Looks up
   * (user_id, route_key, idempotency_key) and returns the cached
   * response if present; otherwise runs the operation, stores the result,
   * and returns it. The unique index on the ledger guarantees that two
   * concurrent retries with the same key cannot both insert.
   */
  async withIdempotency<T>(
    userId: string,
    routeKey: string,
    idempotencyKey: string | null | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) return op();

    const existing = await this.prisma.workoutBuilderIdempotencyKey.findUnique({
      where: {
        WorkoutBuilderIdempotencyKey_user_route_key_key: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
        },
      },
    });
    if (existing) {
      // Cached response replay. We typed response_json as `unknown` and
      // cast at the call site — the cached shape is whatever the
      // original operation returned.
      return existing.response_json as unknown as T;
    }

    const result = await op();

    try {
      await this.prisma.workoutBuilderIdempotencyKey.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          response_json: result as unknown as Prisma.InputJsonValue,
          status_code: 200,
        },
      });
    } catch (err) {
      // Unique-constraint race: another concurrent retry got there
      // first. Read its cached response and return it.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.workoutBuilderIdempotencyKey.findUnique({
          where: {
            WorkoutBuilderIdempotencyKey_user_route_key_key: {
              user_id: userId,
              route_key: routeKey,
              idempotency_key: idempotencyKey,
            },
          },
        });
        if (winner) return winner.response_json as unknown as T;
      }
      throw err;
    }

    return result;
  }

  // ─── WorkoutPlan ──────────────────────────────────────────────────────────

  async listPlans(
    coachId: string,
    query: PaginatedQuery = {},
  ): Promise<Paginated<unknown>> {
    await this.assertCoach(coachId);
    const limit = this.resolveLimit(query.limit);
    const items = await this.prisma.workoutPlan.findMany({
      where: {
        coach_id: coachId,
        archived_at: null,
        ...this.cursorToWhere(query.cursor),
      },
      orderBy: { id: 'asc' },
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
    const nextCursor = hasMore ? page[page.length - 1].id : null;
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

  async archivePlan(coachId: string, planId: string) {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    return this.prisma.workoutPlan.update({
      where: { id: planId },
      data: { archived_at: new Date() },
    });
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
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);

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
      () =>
        this.prisma.$transaction(async (tx) => {
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
        }),
    );
  }

  // ─── ClientWorkoutAssignment ──────────────────────────────────────────────

  async assignPlan(
    coachId: string,
    planId: string,
    dto: CreateAssignmentDto,
    idempotencyKey?: string | null,
  ) {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    await this.assertClientBelongsToCoach(coachId, dto.client_id);

    return this.withIdempotency(
      coachId,
      `workout-builder:assignPlan:${planId}`,
      idempotencyKey,
      () =>
        this.prisma.clientWorkoutAssignment.create({
          data: {
            workout_plan_id: planId,
            client_id: dto.client_id,
            assigned_by_coach_id: coachId,
            scheduled_for: new Date(dto.scheduled_for),
          },
        }),
    );
  }

  async listAssignments(
    coachId: string,
    planId: string,
    query: PaginatedQuery = {},
  ): Promise<Paginated<unknown>> {
    await this.assertCoach(coachId);
    await this.assertPlanOwnership(coachId, planId);
    const limit = this.resolveLimit(query.limit);
    const items = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        workout_plan_id: planId,
        ...this.cursorToWhere(query.cursor),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : null;
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
    const items = await this.prisma.clientWorkoutAssignment.findMany({
      where: {
        client_id: userId,
        ...this.cursorToWhere(query.cursor),
      },
      orderBy: { id: 'asc' },
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
    const nextCursor = hasMore ? page[page.length - 1].id : null;
    return { items: page, nextCursor };
  }

  /**
   * Client-facing single-assignment read. 404 when the row does not exist
   * or belongs to another user (we intentionally do NOT distinguish
   * "missing" from "not yours" to avoid leaking existence).
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
    if (!assignment || assignment.client_id !== userId) {
      throw new NotFoundException('Assignment not found');
    }
    return assignment;
  }

  async completeAssignment(
    clientId: string,
    assignmentId: string,
    dto: CompleteAssignmentDto,
  ) {
    const assignment = await this.prisma.clientWorkoutAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.client_id !== clientId) throw new ForbiddenException();

    // Idempotency: if the same key has already been recorded against this
    // assignment, return the original completed row without re-processing.
    if (
      assignment.completion_idempotency_key &&
      assignment.completion_idempotency_key === dto.idempotency_key
    ) {
      return assignment;
    }

    if (assignment.completed_at) {
      // Already completed with a *different* key. Surface as conflict
      // rather than silently overwrite, so the mobile client can prompt
      // the user rather than discard their new data.
      throw new ConflictException('Assignment already completed');
    }

    return this.prisma.clientWorkoutAssignment.update({
      where: { id: assignmentId },
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
