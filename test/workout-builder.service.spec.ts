/**
 * Unit tests for WorkoutBuilderService.
 * PrismaService is fully mocked; no database required.
 *
 * Covers the audit-mandated behaviors:
 *   - coach role gate (assertCoach) — student role yields 403
 *   - idempotency replay for coach mutations and completion
 *   - listMyAssignments restricts to client_id = req.user.id
 *   - setExercises soft-archives prior rows (no deleteMany)
 *   - completion accepts idempotency_key + started_at + completion_payload
 */

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { WorkoutType } from '../src/workout-builder/workout-builder.dto';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

const COACH_ID = 'coach-uuid-1';
const CLIENT_ID = 'client-uuid-1';
const STUDENT_ID = 'student-uuid-1';

const coachRow = { id: COACH_ID, role: 'coach' as const, coach_id: null };
const studentRow = { id: STUDENT_ID, role: 'student' as const, coach_id: COACH_ID };
const ownerRow = { id: 'owner-uuid', role: 'owner' as const, coach_id: null };

const basePlan = {
  id: 'plan-uuid-1',
  coach_id: COACH_ID,
  name: 'Push Day A',
  type: WorkoutType.strength,
  duration_estimate_minutes: 45,
  created_at: new Date('2025-01-01'),
  updated_at: new Date('2025-01-01'),
  archived_at: null,
  exercises: [],
};

interface PrismaMock {
  workoutPlan: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  workoutPlanExercise: {
    updateMany: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
  };
  clientWorkoutAssignment: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
  workoutBuilderIdempotencyKey: {
    findUnique: jest.Mock;
    create: jest.Mock;
  };
  $transaction: jest.Mock;
}

const makePrismaMock = (): PrismaMock => ({
  workoutPlan: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  workoutPlanExercise: {
    updateMany: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  clientWorkoutAssignment: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  workoutBuilderIdempotencyKey: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  $transaction: jest.fn(),
});

describe('WorkoutBuilderService', () => {
  let service: WorkoutBuilderService;
  let prismaMock: PrismaMock;

  beforeEach(async () => {
    prismaMock = makePrismaMock();
    // Default: assertCoach() succeeds for COACH_ID.
    prismaMock.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === COACH_ID) return Promise.resolve(coachRow);
      if (where.id === STUDENT_ID) return Promise.resolve(studentRow);
      if (where.id === ownerRow.id) return Promise.resolve(ownerRow);
      if (where.id === CLIENT_ID) return Promise.resolve({ id: CLIENT_ID, coach_id: COACH_ID });
      return Promise.resolve(null);
    });
    // Default: no cached idempotency row.
    prismaMock.workoutBuilderIdempotencyKey.findUnique.mockResolvedValue(null);
    prismaMock.workoutBuilderIdempotencyKey.create.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkoutBuilderService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<WorkoutBuilderService>(WorkoutBuilderService);
  });

  // ─── RBAC ───────────────────────────────────────────────────────────────

  describe('assertCoach', () => {
    it('rejects a student calling a coach-side route with 403', async () => {
      await expect(
        service.createPlan(STUDENT_ID, {
          name: 'sneaky',
          type: WorkoutType.strength,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts owner role on coach-side routes', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(basePlan);
      await expect(
        service.createPlan(ownerRow.id, {
          name: 'owner plan',
          type: WorkoutType.strength,
        }),
      ).resolves.toBeDefined();
    });
  });

  // ─── createPlan ─────────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('creates and returns a workout plan', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(basePlan);

      const result = await service.createPlan(COACH_ID, {
        name: 'Push Day A',
        type: WorkoutType.strength,
        duration_estimate_minutes: 45,
      });

      expect(prismaMock.workoutPlan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            coach_id: COACH_ID,
            name: 'Push Day A',
            type: WorkoutType.strength,
          }),
        }),
      );
      expect(result).toEqual(basePlan);
    });

    it('replays the cached response on a double-submit with the same Idempotency-Key', async () => {
      const cached = { ...basePlan, id: 'cached-id' };
      prismaMock.workoutBuilderIdempotencyKey.findUnique.mockResolvedValueOnce({
        response_json: cached,
      });

      const result = await service.createPlan(
        COACH_ID,
        { name: 'A', type: WorkoutType.strength },
        'idem-key-1',
      );

      expect(result).toEqual(cached);
      expect(prismaMock.workoutPlan.create).not.toHaveBeenCalled();
    });

    it('persists the response under the idempotency key on first call', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(basePlan);

      await service.createPlan(
        COACH_ID,
        { name: 'A', type: WorkoutType.strength },
        'idem-key-2',
      );

      expect(prismaMock.workoutBuilderIdempotencyKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: COACH_ID,
            route_key: 'workout-builder:createPlan',
            idempotency_key: 'idem-key-2',
          }),
        }),
      );
    });
  });

  // ─── getPlan ─────────────────────────────────────────────────────────────

  describe('getPlan', () => {
    it('returns the plan when the coach owns it', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      const result = await service.getPlan(COACH_ID, basePlan.id);
      expect(result.id).toBe(basePlan.id);
    });

    it('throws NotFoundException when plan does not exist', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(null);
      await expect(service.getPlan(COACH_ID, 'bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when the coach does not own the plan', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue({
        ...basePlan,
        coach_id: 'other-coach',
      });
      await expect(service.getPlan(COACH_ID, basePlan.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── listPlans pagination ────────────────────────────────────────────────

  describe('listPlans', () => {
    it('returns up to 50 items per page with a nextCursor when more remain', async () => {
      const rows = Array.from({ length: 51 }, (_, i) => ({
        ...basePlan,
        id: `plan-${String(i).padStart(3, '0')}`,
      }));
      prismaMock.workoutPlan.findMany.mockResolvedValue(rows);

      const result = await service.listPlans(COACH_ID, { limit: 1000 });

      expect(result.items.length).toBe(50);
      expect(result.nextCursor).toBe('plan-049');
    });

    it('returns null nextCursor on the final page', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...basePlan,
        id: `plan-${i}`,
      }));
      prismaMock.workoutPlan.findMany.mockResolvedValue(rows);

      const result = await service.listPlans(COACH_ID, { limit: 50 });

      expect(result.items.length).toBe(3);
      expect(result.nextCursor).toBeNull();
    });
  });

  // ─── setExercises soft-archive ───────────────────────────────────────────

  describe('setExercises', () => {
    it('soft-archives prior rows instead of deleting them', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      const tx = {
        workoutPlanExercise: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([{ id: 'new-row', order: 1 }]),
        },
      };
      prismaMock.$transaction.mockImplementation(
        async (fn: (innerTx: typeof tx) => unknown) => fn(tx),
      );

      await service.setExercises(COACH_ID, basePlan.id, [
        {
          exercise_external_id: 'ex-1',
          order: 1,
          sets: 3,
          reps_or_duration_seconds: 12,
        },
      ]);

      expect(tx.workoutPlanExercise.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workout_plan_id: basePlan.id, archived_at: null },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(tx.workoutPlanExercise.createMany).toHaveBeenCalled();
    });

    it('rejects duplicate order values', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      await expect(
        service.setExercises(COACH_ID, basePlan.id, [
          {
            exercise_external_id: 'ex-1',
            order: 1,
            sets: 3,
            reps_or_duration_seconds: 12,
          },
          {
            exercise_external_id: 'ex-2',
            order: 1,
            sets: 3,
            reps_or_duration_seconds: 12,
          },
        ]),
      ).rejects.toThrow(/order/i);
    });
  });

  // ─── assignPlan ──────────────────────────────────────────────────────────

  describe('assignPlan', () => {
    it('creates an assignment when coach owns plan and client belongs to coach', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      const mockAssignment = {
        id: 'asgn-1',
        workout_plan_id: basePlan.id,
        client_id: CLIENT_ID,
        assigned_by_coach_id: COACH_ID,
        scheduled_for: new Date('2025-02-01'),
        completed_at: null,
        post_rpe: null,
        post_notes: null,
      };
      prismaMock.clientWorkoutAssignment.create.mockResolvedValue(mockAssignment);

      const result = await service.assignPlan(COACH_ID, basePlan.id, {
        client_id: CLIENT_ID,
        scheduled_for: '2025-02-01T09:00:00Z',
      });

      expect((result as { client_id: string }).client_id).toBe(CLIENT_ID);
    });

    it('throws ForbiddenException when the client belongs to a different coach', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      prismaMock.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) => {
          if (where.id === COACH_ID) return Promise.resolve(coachRow);
          if (where.id === CLIENT_ID)
            return Promise.resolve({ id: CLIENT_ID, coach_id: 'other-coach' });
          return Promise.resolve(null);
        },
      );

      await expect(
        service.assignPlan(COACH_ID, basePlan.id, {
          client_id: CLIENT_ID,
          scheduled_for: '2025-02-01T09:00:00Z',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── client-facing assignment endpoints ──────────────────────────────────

  describe('listMyAssignments', () => {
    it('restricts to client_id = userId', async () => {
      prismaMock.clientWorkoutAssignment.findMany.mockResolvedValue([]);

      await service.listMyAssignments(CLIENT_ID);

      expect(prismaMock.clientWorkoutAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ client_id: CLIENT_ID }),
        }),
      );
    });

    it('caps limit at the page max', async () => {
      prismaMock.clientWorkoutAssignment.findMany.mockResolvedValue([]);

      await service.listMyAssignments(CLIENT_ID, { limit: 9999 });

      // take is limit+1, so requesting 9999 should result in 51 (50+1).
      expect(prismaMock.clientWorkoutAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 51 }),
      );
    });
  });

  describe('getMyAssignment', () => {
    it('404s when the row belongs to a different client', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue({
        id: 'asgn-x',
        client_id: 'other-client',
        workout_plan: { exercises: [] },
      });

      await expect(service.getMyAssignment(CLIENT_ID, 'asgn-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the row when the caller is the assigned client', async () => {
      const row = {
        id: 'asgn-x',
        client_id: CLIENT_ID,
        workout_plan: { exercises: [] },
      };
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(row);

      const result = await service.getMyAssignment(CLIENT_ID, 'asgn-x');
      expect(result).toEqual(row);
    });
  });

  // ─── completeAssignment idempotency ──────────────────────────────────────

  describe('completeAssignment', () => {
    const baseAssignment = {
      id: 'asgn-1',
      client_id: CLIENT_ID,
      completed_at: null,
      completion_idempotency_key: null,
    };

    it('marks the assignment completed and stores started_at + completion_payload', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(baseAssignment);
      prismaMock.clientWorkoutAssignment.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({ ...baseAssignment, ...data }),
      );

      const result = await service.completeAssignment(CLIENT_ID, baseAssignment.id, {
        idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        started_at: '2025-02-01T08:00:00Z',
        completion_payload: { sets: [{ reps: 10 }] },
        post_rpe: 8,
      });

      expect(prismaMock.clientWorkoutAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            completion_idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
            started_at: new Date('2025-02-01T08:00:00Z'),
            post_rpe: 8,
          }),
        }),
      );
      expect((result as { completed_at: Date }).completed_at).toBeInstanceOf(Date);
    });

    it('returns the original row on retry with the same idempotency_key', async () => {
      const already = {
        ...baseAssignment,
        completed_at: new Date('2025-02-01T09:00:00Z'),
        completion_idempotency_key: 'key-1',
      };
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(already);

      const result = await service.completeAssignment(CLIENT_ID, baseAssignment.id, {
        idempotency_key: 'key-1',
      });

      expect(prismaMock.clientWorkoutAssignment.update).not.toHaveBeenCalled();
      expect(result).toEqual(already);
    });

    it('409s when already completed with a different idempotency_key', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue({
        ...baseAssignment,
        completed_at: new Date(),
        completion_idempotency_key: 'old-key',
      });

      await expect(
        service.completeAssignment(CLIENT_ID, baseAssignment.id, {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('403s when the assignment belongs to a different client', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue({
        ...baseAssignment,
        client_id: 'other',
      });

      await expect(
        service.completeAssignment(CLIENT_ID, baseAssignment.id, {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── withIdempotency unique-constraint race ──────────────────────────────

  describe('withIdempotency race', () => {
    it('replays the winner row when concurrent insert hits P2002', async () => {
      const winner = { response_json: { winner: true } };
      let firstFindCall = true;
      prismaMock.workoutBuilderIdempotencyKey.findUnique.mockImplementation(() => {
        if (firstFindCall) {
          firstFindCall = false;
          return Promise.resolve(null);
        }
        return Promise.resolve(winner);
      });
      prismaMock.workoutBuilderIdempotencyKey.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );

      const result = await service.withIdempotency<{ result: string }>(
        COACH_ID,
        'route-key',
        'key-race',
        async () => ({ result: 'first' }),
      );

      expect(result).toEqual(winner.response_json);
    });
  });
});
