import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { PlanContextRepository } from './plan-context.repository';
import {
  PlanContextSnapshot,
  PlanContextSnapshotSchema,
  PlanContextTag,
  ResolvePlanContextQuery,
} from './plan-context.dto';

/**
 * Whether the v2-1 plan-context-tag feature is active. Default OFF
 * (FEATURE_COMMUNITY_PLAN_TAGS unset or anything but the literal "true"). When
 * OFF the message path drops any incoming tag and the resolve route 404s
 * across the board. Read per-call so the flag can be flipped without a
 * process restart (mirrors resolveCommunityFlag in community-feature-flag.guard).
 */
export function planTagsEnabled(): boolean {
  return process.env.FEATURE_COMMUNITY_PLAN_TAGS === 'true';
}

const INVALID_REFERENCE = {
  error: 'unprocessable_entity',
  code: 'community.plan_context.invalid_reference',
  message: 'The referenced plan item does not exist.',
} as const;

const FOREIGN_OWNER = {
  error: 'forbidden',
  code: 'community.plan_context.foreign_owner',
  message: 'You cannot tag a plan item that belongs to another coach.',
} as const;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.plan_context.not_found',
} as const;

/**
 * Resolves and authorizes v2-1 plan-context tags.
 *
 * Two responsibilities:
 *  - validate(): called on message send. Confirms the referenced entity exists
 *    and is owned by the caller, returning a normalized tag for persistence.
 *    A missing entity → 422 (the id is well-formed but resolves to nothing); a
 *    foreign-coach entity → 403. The DTO layer has already rejected malformed
 *    ids/coordinates with 422 before we get here.
 *  - resolve(): backs the read-only GET resolve route. Same ownership gate, but
 *    a missing OR foreign entity maps to 404 so a coach cannot probe another
 *    coach's id space for existence (cross-tenant non-leak doctrine).
 *
 * Ownership model (from prisma/schema.prisma):
 *  - WorkoutPlan.coach_id  (required) — coach-owned.
 *  - CoachPackage.coach_id (required) — coach-owned.
 *  - MealPlan.coach_id     (nullable, SetNull) — owned when set; a null owner
 *    is unownable and therefore never taggable.
 *  - CheckIn.coach_id      (nullable) — the coach the check-in is assigned to;
 *    null is unownable.
 */
@Injectable()
export class PlanContextService {
  constructor(private readonly repo: PlanContextRepository) {}

  /**
   * Validate a tag for the SEND path. Throws 422 for a non-resolving reference
   * and 403 for a foreign-owned one. Returns the tag unchanged on success so
   * the caller persists exactly what was validated.
   */
  async validate(user: User, tag: PlanContextTag): Promise<PlanContextTag> {
    switch (tag.type) {
      case 'workout': {
        const plan = await this.repo.findWorkoutPlan(tag.workout_plan_id);
        if (!plan) throw new UnprocessableEntityException(INVALID_REFERENCE);
        this.assertOwner(plan.coach_id, user.id);
        if (tag.exercise_id) {
          const exercise = await this.repo.findWorkoutPlanExercise(
            tag.workout_plan_id,
            tag.exercise_id,
          );
          if (!exercise) {
            throw new UnprocessableEntityException(INVALID_REFERENCE);
          }
        }
        return tag;
      }
      case 'meal': {
        const plan = await this.repo.findMealPlan(tag.meal_plan_id);
        if (!plan) throw new UnprocessableEntityException(INVALID_REFERENCE);
        this.assertOwner(plan.coach_id, user.id);
        return tag;
      }
      case 'package': {
        const pkg = await this.repo.findCoachPackage(tag.package_id);
        if (!pkg) throw new UnprocessableEntityException(INVALID_REFERENCE);
        this.assertOwner(pkg.coach_id, user.id);
        return tag;
      }
      case 'check_in': {
        const checkIn = await this.repo.findCheckIn(tag.check_in_id);
        if (!checkIn) throw new UnprocessableEntityException(INVALID_REFERENCE);
        this.assertOwner(checkIn.coach_id, user.id);
        return tag;
      }
    }
  }

  /**
   * Resolve a tag to its render snapshot for the read-only preview route. A
   * missing or foreign reference both map to 404 (existence non-leak). Returns
   * a Zod-validated snapshot.
   */
  async resolve(
    user: User,
    query: ResolvePlanContextQuery,
  ): Promise<PlanContextSnapshot> {
    switch (query.type) {
      case 'workout': {
        const plan = await this.repo.findWorkoutPlan(query.id);
        if (!plan || !this.ownedBy(plan.coach_id, user.id)) {
          throw new NotFoundException(NOT_FOUND);
        }
        let exercise = null as null | {
          id: string;
          exercise_external_id: string;
          order: number;
          sets: number;
          reps_or_duration_seconds: number;
        };
        if (query.exercise_id) {
          const row = await this.repo.findWorkoutPlanExercise(
            query.id,
            query.exercise_id,
          );
          if (!row) throw new NotFoundException(NOT_FOUND);
          exercise = {
            id: row.id,
            exercise_external_id: row.exercise_external_id,
            order: row.order,
            sets: row.sets,
            reps_or_duration_seconds: row.reps_or_duration_seconds,
          };
        }
        return PlanContextSnapshotSchema.parse({
          type: 'workout',
          workout_plan_id: plan.id,
          name: plan.name,
          plan_type: plan.type,
          week_index: query.week_index ?? plan.week_index ?? null,
          day_index: query.day_index ?? plan.day_index ?? null,
          exercise,
        });
      }
      case 'meal': {
        const plan = await this.repo.findMealPlan(query.id);
        if (!plan || !this.ownedBy(plan.coach_id, user.id)) {
          throw new NotFoundException(NOT_FOUND);
        }
        return PlanContextSnapshotSchema.parse({
          type: 'meal',
          meal_plan_id: plan.id,
          title: plan.title,
          meal_id: query.meal_id ?? null,
        });
      }
      case 'package': {
        const pkg = await this.repo.findCoachPackage(query.id);
        if (!pkg || !this.ownedBy(pkg.coach_id, user.id)) {
          throw new NotFoundException(NOT_FOUND);
        }
        return PlanContextSnapshotSchema.parse({
          type: 'package',
          package_id: pkg.id,
          name: pkg.name,
          amount_cents: pkg.amount_cents,
          currency: pkg.currency,
          billing_type: pkg.billing_type,
        });
      }
      case 'check_in': {
        const checkIn = await this.repo.findCheckIn(query.id);
        if (!checkIn || !this.ownedBy(checkIn.coach_id, user.id)) {
          throw new NotFoundException(NOT_FOUND);
        }
        return PlanContextSnapshotSchema.parse({
          type: 'check_in',
          check_in_id: checkIn.id,
          date: checkIn.date.toISOString().slice(0, 10),
          check_in_type: checkIn.type,
          reviewed_by_coach: checkIn.reviewed_by_coach,
        });
      }
    }
  }

  /** True when `ownerId` is set and equals the caller. A null owner is unownable. */
  private ownedBy(ownerId: string | null, userId: string): boolean {
    return ownerId !== null && ownerId === userId;
  }

  /** Throw 403 unless the caller owns the entity. */
  private assertOwner(ownerId: string | null, userId: string): void {
    if (!this.ownedBy(ownerId, userId)) {
      throw new ForbiddenException(FOREIGN_OWNER);
    }
  }
}
