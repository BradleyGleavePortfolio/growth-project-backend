/**
 * Unit tests for PlanContextService (v2-1 plan-context tags).
 *
 * Mocks PlanContextRepository (no DB). Covers validate() and resolve() for
 * each tag type (workout, meal, package, check_in): owner success, foreign-
 * coach rejection (validate → 403, resolve → 404), missing reference
 * (validate → 422, resolve → 404), null-owner unownability, and the
 * workout exercise sub-reference gate.
 */
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { PlanContextTag } from '../../../src/community/plan-context/plan-context.dto';

const COACH = 'cccccccc-0000-0000-0000-00000000000a';
const OTHER_COACH = 'cccccccc-0000-0000-0000-00000000000b';
const PLAN = 'aaaaaaaa-0000-0000-0000-000000000001';
const EX = 'bbbbbbbb-0000-0000-0000-000000000001';
const MEAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const PKG = 'aaaaaaaa-0000-0000-0000-000000000003';
const CHECKIN = 'aaaaaaaa-0000-0000-0000-000000000004';

const coach = { id: COACH, role: 'coach' } as unknown as User;

describe('PlanContextService', () => {
  let repo: {
    findWorkoutPlan: jest.Mock;
    findWorkoutPlanExercise: jest.Mock;
    findMealPlan: jest.Mock;
    findCoachPackage: jest.Mock;
    findCheckIn: jest.Mock;
  };
  let service: PlanContextService;

  beforeEach(() => {
    repo = {
      findWorkoutPlan: jest.fn(),
      findWorkoutPlanExercise: jest.fn(),
      findMealPlan: jest.fn(),
      findCoachPackage: jest.fn(),
      findCheckIn: jest.fn(),
    };
    service = new PlanContextService(repo as never);
  });

  // ── validate(): workout ──────────────────────────────────────────────────

  describe('validate() — workout', () => {
    const tag: PlanContextTag = {
      type: 'workout',
      workout_plan_id: PLAN,
      week_index: 2,
      day_index: 1,
    };

    it('returns the tag when the caller owns the plan', async () => {
      repo.findWorkoutPlan.mockResolvedValue({ id: PLAN, coach_id: COACH });
      await expect(service.validate(coach, tag)).resolves.toEqual(tag);
    });

    it('throws 422 when the plan does not exist', async () => {
      repo.findWorkoutPlan.mockResolvedValue(null);
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('throws 403 when the plan belongs to another coach', async () => {
      repo.findWorkoutPlan.mockResolvedValue({
        id: PLAN,
        coach_id: OTHER_COACH,
      });
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('validates the exercise sub-reference against the plan (422 when foreign)', async () => {
      repo.findWorkoutPlan.mockResolvedValue({ id: PLAN, coach_id: COACH });
      repo.findWorkoutPlanExercise.mockResolvedValue(null);
      await expect(
        service.validate(coach, { ...tag, exercise_id: EX }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.findWorkoutPlanExercise).toHaveBeenCalledWith(PLAN, EX);
    });

    it('accepts a valid exercise sub-reference', async () => {
      repo.findWorkoutPlan.mockResolvedValue({ id: PLAN, coach_id: COACH });
      repo.findWorkoutPlanExercise.mockResolvedValue({
        id: EX,
        workout_plan_id: PLAN,
      });
      await expect(
        service.validate(coach, { ...tag, exercise_id: EX }),
      ).resolves.toMatchObject({ exercise_id: EX });
    });
  });

  // ── validate(): meal / package / check_in ──────────────────────────────────

  describe('validate() — meal', () => {
    const tag: PlanContextTag = { type: 'meal', meal_plan_id: MEAL };

    it('returns the tag when the caller owns the meal plan', async () => {
      repo.findMealPlan.mockResolvedValue({ id: MEAL, coach_id: COACH });
      await expect(service.validate(coach, tag)).resolves.toEqual(tag);
    });

    it('throws 422 when the meal plan is missing', async () => {
      repo.findMealPlan.mockResolvedValue(null);
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('throws 403 when the meal plan owner is null (unownable)', async () => {
      repo.findMealPlan.mockResolvedValue({ id: MEAL, coach_id: null });
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('validate() — package', () => {
    const tag: PlanContextTag = { type: 'package', package_id: PKG };

    it('returns the tag when the caller owns the package', async () => {
      repo.findCoachPackage.mockResolvedValue({ id: PKG, coach_id: COACH });
      await expect(service.validate(coach, tag)).resolves.toEqual(tag);
    });

    it('throws 403 for a foreign package', async () => {
      repo.findCoachPackage.mockResolvedValue({
        id: PKG,
        coach_id: OTHER_COACH,
      });
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws 422 when the package is missing', async () => {
      repo.findCoachPackage.mockResolvedValue(null);
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe('validate() — check_in', () => {
    const tag: PlanContextTag = { type: 'check_in', check_in_id: CHECKIN };

    it('returns the tag when the caller is the assigned coach', async () => {
      repo.findCheckIn.mockResolvedValue({ id: CHECKIN, coach_id: COACH });
      await expect(service.validate(coach, tag)).resolves.toEqual(tag);
    });

    it('throws 403 when the check-in is assigned to another coach', async () => {
      repo.findCheckIn.mockResolvedValue({
        id: CHECKIN,
        coach_id: OTHER_COACH,
      });
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws 422 when the check-in is missing', async () => {
      repo.findCheckIn.mockResolvedValue(null);
      await expect(service.validate(coach, tag)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  // ── resolve(): snapshots + non-leak ────────────────────────────────────────

  describe('resolve()', () => {
    it('returns a workout snapshot with the exercise sub-reference', async () => {
      repo.findWorkoutPlan.mockResolvedValue({
        id: PLAN,
        coach_id: COACH,
        name: 'Push Day',
        type: 'strength',
        week_index: 2,
        day_index: 1,
      });
      repo.findWorkoutPlanExercise.mockResolvedValue({
        id: EX,
        exercise_external_id: 'edb-0001',
        order: 0,
        sets: 5,
        reps_or_duration_seconds: 5,
      });
      const snap = await service.resolve(coach, {
        type: 'workout',
        id: PLAN,
        exercise_id: EX,
      });
      expect(snap).toMatchObject({
        type: 'workout',
        workout_plan_id: PLAN,
        name: 'Push Day',
        plan_type: 'strength',
        week_index: 2,
        day_index: 1,
        exercise: { id: EX, sets: 5 },
      });
    });

    it('404s a foreign workout plan (existence non-leak)', async () => {
      repo.findWorkoutPlan.mockResolvedValue({
        id: PLAN,
        coach_id: OTHER_COACH,
        name: 'x',
        type: 'strength',
        week_index: null,
        day_index: null,
      });
      await expect(
        service.resolve(coach, { type: 'workout', id: PLAN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a missing workout plan', async () => {
      repo.findWorkoutPlan.mockResolvedValue(null);
      await expect(
        service.resolve(coach, { type: 'workout', id: PLAN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a meal snapshot', async () => {
      repo.findMealPlan.mockResolvedValue({
        id: MEAL,
        coach_id: COACH,
        title: 'Cut Phase',
      });
      const snap = await service.resolve(coach, {
        type: 'meal',
        id: MEAL,
        meal_id: 'breakfast',
      });
      expect(snap).toEqual({
        type: 'meal',
        meal_plan_id: MEAL,
        title: 'Cut Phase',
        meal_id: 'breakfast',
      });
    });

    it('returns a package snapshot', async () => {
      repo.findCoachPackage.mockResolvedValue({
        id: PKG,
        coach_id: COACH,
        name: '12-week transformation',
        amount_cents: 30000,
        currency: 'usd',
        billing_type: 'one_time',
      });
      const snap = await service.resolve(coach, { type: 'package', id: PKG });
      expect(snap).toMatchObject({
        type: 'package',
        package_id: PKG,
        amount_cents: 30000,
      });
    });

    it('returns a check_in snapshot', async () => {
      repo.findCheckIn.mockResolvedValue({
        id: CHECKIN,
        coach_id: COACH,
        date: new Date('2026-01-05T00:00:00.000Z'),
        type: 'morning',
        reviewed_by_coach: false,
      });
      const snap = await service.resolve(coach, { type: 'check_in', id: CHECKIN });
      expect(snap).toEqual({
        type: 'check_in',
        check_in_id: CHECKIN,
        date: '2026-01-05',
        check_in_type: 'morning',
        reviewed_by_coach: false,
      });
    });
  });
});
