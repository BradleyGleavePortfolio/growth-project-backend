/**
 * Unit tests for WorkoutBuilderService — plan creation path.
 * PrismaService is fully mocked; no database required.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkoutBuilderService } from './workout-builder.service';
import { PrismaService } from '../prisma.service';
import { WorkoutType } from './workout-builder.dto';

const COACH_ID = 'coach-uuid-1';
const CLIENT_ID = 'client-uuid-1';

const mockPlan = {
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

const prismaMock = {
  workoutPlan: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  workoutPlanExercise: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  clientWorkoutAssignment: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('WorkoutBuilderService', () => {
  let service: WorkoutBuilderService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkoutBuilderService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<WorkoutBuilderService>(WorkoutBuilderService);
  });

  // ─── createPlan ─────────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('creates and returns a workout plan', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(mockPlan);

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
      expect(result.name).toBe('Push Day A');
    });
  });

  // ─── getPlan ─────────────────────────────────────────────────────────────

  describe('getPlan', () => {
    it('returns the plan when the coach owns it', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(mockPlan);
      const result = await service.getPlan(COACH_ID, mockPlan.id);
      expect(result.id).toBe(mockPlan.id);
    });

    it('throws NotFoundException when plan does not exist', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(null);
      await expect(service.getPlan(COACH_ID, 'bad-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when the coach does not own the plan', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue({
        ...mockPlan,
        coach_id: 'other-coach',
      });
      await expect(service.getPlan(COACH_ID, mockPlan.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── assignPlan ──────────────────────────────────────────────────────────

  describe('assignPlan', () => {
    it('creates an assignment when coach owns plan and client belongs to coach', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(mockPlan);
      prismaMock.user.findUnique.mockResolvedValue({
        id: CLIENT_ID,
        coach_id: COACH_ID,
      });
      const mockAssignment = {
        id: 'asgn-1',
        workout_plan_id: mockPlan.id,
        client_id: CLIENT_ID,
        assigned_by_coach_id: COACH_ID,
        scheduled_for: new Date('2025-02-01'),
        completed_at: null,
        post_rpe: null,
        post_notes: null,
      };
      prismaMock.clientWorkoutAssignment.create.mockResolvedValue(mockAssignment);

      const result = await service.assignPlan(COACH_ID, mockPlan.id, {
        client_id: CLIENT_ID,
        scheduled_for: '2025-02-01T09:00:00Z',
      });

      expect(result.client_id).toBe(CLIENT_ID);
    });

    it('throws ForbiddenException when the client belongs to a different coach', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(mockPlan);
      prismaMock.user.findUnique.mockResolvedValue({
        id: CLIENT_ID,
        coach_id: 'other-coach',
      });

      await expect(
        service.assignPlan(COACH_ID, mockPlan.id, {
          client_id: CLIENT_ID,
          scheduled_for: '2025-02-01T09:00:00Z',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
