import { Injectable } from '@nestjs/common';
import type {
  CheckIn,
  CoachPackage,
  DailyMealPlan,
  WorkoutPlan,
  WorkoutPlanExercise,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { planStaysInTenantWhere } from '../../workout-builder/tenant-clients';

/**
 * Data access for v2-1 plan-context tag resolution.
 *
 * Tenant scoping follows the established community doctrine (see
 * community-messages.repository.ts): the app connects as the Supabase
 * service_role (BYPASSRLS), so ownership is enforced HERE / at the service
 * layer with explicit filters, never assumed from Postgres RLS. Each lookup
 * returns the raw row (including its `coach_id`) so the service can map a
 * foreign owner to 403 and a missing row to 404 without leaking existence.
 *
 * No writes live here — the resolve surface is read-only and message
 * persistence of the validated tag is handled by the messages repository.
 */
@Injectable()
export class PlanContextRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A workout plan by id, or null; a moved client's copy day is null for `coachId` (owner 4). */
  async findWorkoutPlan(id: string, coachId: string): Promise<WorkoutPlan | null> {
    return this.prisma.workoutPlan.findUnique({ where: { id, AND: [planStaysInTenantWhere(coachId)] } });
  }

  /**
   * A single exercise within a workout plan, bounded to that plan and to
   * non-archived rows. Returns null when the exercise id does not belong to
   * the plan (so a cross-plan exercise id cannot resolve).
   */
  async findWorkoutPlanExercise(
    workoutPlanId: string,
    exerciseId: string,
  ): Promise<WorkoutPlanExercise | null> {
    return this.prisma.workoutPlanExercise.findFirst({
      where: {
        id: exerciseId,
        workout_plan_id: workoutPlanId,
        archived_at: null,
      },
    });
  }

  /**
   * A live day plan (MEAL:DAY) by id, or null. An archived plan never resolves:
   * that includes the frozen copy a moved client keeps (owner 4, 139-13).
   */
  async findMealPlan(id: string): Promise<DailyMealPlan | null> {
    return this.prisma.dailyMealPlan.findFirst({ where: { id, archived_at: null } });
  }

  /** A coach package by id, or null. */
  async findCoachPackage(id: string): Promise<CoachPackage | null> {
    return this.prisma.coachPackage.findUnique({ where: { id } });
  }

  /** A check-in by id with its client's current coach, or null. */
  async findCheckIn(
    id: string,
  ): Promise<(CheckIn & { user: { coach_id: string | null } }) | null> {
    return this.prisma.checkIn.findUnique({
      where: { id },
      include: { user: { select: { coach_id: true } } },
    });
  }
}
