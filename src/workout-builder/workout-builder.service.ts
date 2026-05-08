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
import {
  CreateWorkoutPlanDto,
  UpdateWorkoutPlanDto,
  UpsertExerciseRowDto,
  CreateAssignmentDto,
  CompleteAssignmentDto,
} from './workout-builder.dto';

@Injectable()
export class WorkoutBuilderService {
  constructor(private readonly prisma: PrismaService) {}

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
