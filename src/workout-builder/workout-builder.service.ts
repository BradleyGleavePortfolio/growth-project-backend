/**
 * WorkoutBuilderService — CRUD for WorkoutPlan, WorkoutPlanExercise, and
 * ClientWorkoutAssignment models.
 *
 * Tenancy rules:
 *   - A coach can only read/mutate their own plans (coach_id = req.user.id).
 *   - Assignment creation checks that the target client belongs to the coach.
 *   - Archived plans are excluded from default list queries.
 */

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ExerciseCatalogService } from '../exercise-catalog/exercise-catalog.service';
import {
  CreateWorkoutPlanDto,
  UpdateWorkoutPlanDto,
  UpsertExerciseRowDto,
  CreateAssignmentDto,
  CompleteAssignmentDto,
} from './workout-builder.dto';

@Injectable()
export class WorkoutBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ExerciseCatalogService,
  ) {}

  // ─── WorkoutPlan ──────────────────────────────────────────────────────────

  async listPlans(coachId: string) {
    return this.prisma.workoutPlan.findMany({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'desc' },
      include: { exercises: { orderBy: { order: 'asc' } } },
    });
  }

  async getPlan(coachId: string, planId: string) {
    const plan = await this.prisma.workoutPlan.findUnique({
      where: { id: planId },
      include: { exercises: { orderBy: { order: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('Workout plan not found');
    if (plan.coach_id !== coachId) throw new ForbiddenException();
    return plan;
  }

  async createPlan(coachId: string, dto: CreateWorkoutPlanDto) {
    return this.prisma.workoutPlan.create({
      data: {
        coach_id: coachId,
        name: dto.name,
        type: dto.type,
        duration_estimate_minutes: dto.duration_estimate_minutes ?? null,
      },
      include: { exercises: true },
    });
  }

  async updatePlan(coachId: string, planId: string, dto: UpdateWorkoutPlanDto) {
    await this.assertPlanOwnership(coachId, planId);
    return this.prisma.workoutPlan.update({
      where: { id: planId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.duration_estimate_minutes !== undefined && {
          duration_estimate_minutes: dto.duration_estimate_minutes,
        }),
      },
      include: { exercises: { orderBy: { order: 'asc' } } },
    });
  }

  async archivePlan(coachId: string, planId: string) {
    await this.assertPlanOwnership(coachId, planId);
    return this.prisma.workoutPlan.update({
      where: { id: planId },
      data: { archived_at: new Date() },
    });
  }

  // ─── WorkoutPlanExercise rows ─────────────────────────────────────────────

  /**
   * Replace all exercise rows for a plan in a single transaction.
   * Accepts the full ordered list; deletes existing rows and re-inserts.
   */
  async setExercises(
    coachId: string,
    planId: string,
    rows: UpsertExerciseRowDto[],
  ) {
    await this.assertPlanOwnership(coachId, planId);

    // Validate order uniqueness
    const orders = rows.map((r) => r.order);
    if (new Set(orders).size !== orders.length) {
      throw new BadRequestException('Exercise order values must be unique within a plan');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.workoutPlanExercise.deleteMany({ where: { workout_plan_id: planId } });
      if (rows.length === 0) return [];
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
      return tx.workoutPlanExercise.findMany({
        where: { workout_plan_id: planId },
        orderBy: { order: 'asc' },
      });
    });
  }

  // ─── ClientWorkoutAssignment ──────────────────────────────────────────────

  async assignPlan(coachId: string, planId: string, dto: CreateAssignmentDto) {
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
  }

  async listAssignments(coachId: string, planId: string) {
    await this.assertPlanOwnership(coachId, planId);
    return this.prisma.clientWorkoutAssignment.findMany({
      where: { workout_plan_id: planId },
      orderBy: { scheduled_for: 'asc' },
    });
  }

  // Sprint B — client-side reads. The mobile client lists its own
  // assignments via /assignments/me; tenancy is by req.user.id.
  //
  // Video library v1 — assignment reads enrich each exercise row with
  // `playbackUrl` and `catalog` metadata when its `exercise_external_id`
  // resolves to an ExerciseCatalogItem. When it doesn't (legacy
  // ExerciseDB ids), playbackUrl is null and the mobile client falls
  // back to its existing detail-screen flow.
  async listAssignmentsForClient(clientId: string) {
    const assignments = await this.prisma.clientWorkoutAssignment.findMany({
      where: { client_id: clientId },
      orderBy: { scheduled_for: 'asc' },
      include: {
        workout_plan: {
          include: { exercises: { orderBy: { order: 'asc' } } },
        },
      },
    });
    await this.attachPlaybackUrls(assignments);
    return assignments;
  }

  async getAssignmentForClient(clientId: string, assignmentId: string) {
    const assignment = await this.prisma.clientWorkoutAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        workout_plan: {
          include: { exercises: { orderBy: { order: 'asc' } } },
        },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.client_id !== clientId) throw new ForbiddenException();
    await this.attachPlaybackUrls([assignment]);
    return assignment;
  }

  /**
   * Mutates the given assignment-with-plan rows in place, attaching
   * `playbackUrl` and `catalog` to every `workout_plan.exercises` entry
   * whose `exercise_external_id` resolves to an internal
   * ExerciseCatalogItem. Done in a single batched query rather than one
   * lookup per row so a 12-exercise plan stays a single round-trip.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async attachPlaybackUrls(assignments: any[]) {
    if (assignments.length === 0) return;
    const refs = new Set<string>();
    for (const a of assignments) {
      for (const ex of a.workout_plan?.exercises ?? []) {
        if (ex.exercise_external_id) refs.add(ex.exercise_external_id);
      }
    }
    if (refs.size === 0) return;
    const list = Array.from(refs);
    // Single query: rows matching either id or slug.
    const rows = await this.prisma.exerciseCatalogItem.findMany({
      where: { OR: [{ id: { in: list } }, { slug: { in: list } }] },
    });
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      byKey.set(row.id, row);
      byKey.set(row.slug, row);
    }
    for (const a of assignments) {
      for (const ex of a.workout_plan?.exercises ?? []) {
        const row = byKey.get(ex.exercise_external_id);
        if (!row) {
          ex.playbackUrl = null;
          ex.catalog = null;
          continue;
        }
        // Reuse the catalog service's URL-minting + DTO shaping against
        // the row we already loaded — no second DB round-trip.
        const info = this.catalog.playbackInfoFromRow(row);
        ex.playbackUrl = info.playbackUrl;
        ex.catalog = info.item;
      }
    }
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
    if (assignment.completed_at) {
      throw new BadRequestException('Assignment already completed');
    }

    return this.prisma.clientWorkoutAssignment.update({
      where: { id: assignmentId },
      data: {
        completed_at: new Date(),
        post_rpe: dto.post_rpe ?? null,
        post_notes: dto.post_notes ?? null,
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
    if (client.coach_id !== coachId) throw new ForbiddenException('Client does not belong to this coach');
  }
}
