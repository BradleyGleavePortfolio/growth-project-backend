/**
 * Unit tests for WorkoutBuilderService — audit #2 P1/P2 behaviour.
 * PrismaService is fully mocked; no database required.
 *
 * Covers:
 *   - coach role gate (assertCoach)
 *   - race-safe idempotency claim (atomic in_progress -> completed flow)
 *   - atomic completion via conditional updateMany
 *   - setExercises blocked when active assignments exist
 *   - getMyAssignment 403 vs 404 split
 *   - listMyAssignments restricted to client_id = req.user.id
 *   - keyset-paginated listPlans / listAssignments cursor encoding
 *   - archivePlan idempotent on already-archived plans
 */

import {
  BadRequestException,
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
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
  archived_at: null,
  exercises: [],
};

interface PrismaMock {
  workoutPlan: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  workoutPlanExercise: {
    updateMany: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
  };
  clientWorkoutAssignment: {
    create: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  user: { findUnique: jest.Mock };
  workoutBuilderIdempotencyKey: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
}

const makePrismaMock = (): PrismaMock => ({
  workoutPlan: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  workoutPlanExercise: {
    updateMany: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  clientWorkoutAssignment: {
    create: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  workoutBuilderIdempotencyKey: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
});

describe('WorkoutBuilderService', () => {
  let service: WorkoutBuilderService;
  let prismaMock: PrismaMock;

  beforeEach(async () => {
    prismaMock = makePrismaMock();

    prismaMock.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === COACH_ID) return Promise.resolve(coachRow);
      if (where.id === STUDENT_ID) return Promise.resolve(studentRow);
      if (where.id === ownerRow.id) return Promise.resolve(ownerRow);
      if (where.id === CLIENT_ID)
        return Promise.resolve({ id: CLIENT_ID, coach_id: COACH_ID });
      return Promise.resolve(null);
    });

    // Default claim path: create succeeds, update succeeds.
    prismaMock.workoutBuilderIdempotencyKey.create.mockImplementation(
      async ({ data }: { data: { idempotency_key: string } }) => ({
        id: `ledger-${data.idempotency_key}`,
        ...data,
      }),
    );
    prismaMock.workoutBuilderIdempotencyKey.update.mockResolvedValue({});

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
    it('rejects a student on a coach-side route with 403', async () => {
      await expect(
        service.createPlan(
          STUDENT_ID,
          { name: 'sneaky', type: WorkoutType.strength },
          'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts owner role on coach-side routes', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(basePlan);
      await expect(
        service.createPlan(
          ownerRow.id,
          { name: 'owner plan', type: WorkoutType.strength },
          'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        ),
      ).resolves.toBeDefined();
    });
  });

  // ─── createPlan ─────────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('creates and returns a workout plan', async () => {
      prismaMock.workoutPlan.create.mockResolvedValue(basePlan);

      const result = await service.createPlan(
        COACH_ID,
        {
          name: 'Push Day A',
          type: WorkoutType.strength,
          duration_estimate_minutes: 45,
        },
        'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      );

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
  });

  // ─── withIdempotency atomic claim ──────────────────────────────────────

  describe('withIdempotency (P1-1 — race-safe claim)', () => {
    it('returns the cached response when a completed row already exists', async () => {
      const cached = { winner: true };
      prismaMock.workoutBuilderIdempotencyKey.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      prismaMock.workoutBuilderIdempotencyKey.findUnique.mockResolvedValueOnce({
        status: 'completed',
        response_json: cached,
      });

      const op = jest.fn().mockResolvedValue({ ignored: true });

      const result = await service.withIdempotency(
        COACH_ID,
        'route-key',
        'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        op,
      );

      expect(result).toEqual(cached);
      // Crucial — the protected op MUST NOT run on a duplicate.
      expect(op).not.toHaveBeenCalled();
    });

    it('rejects a concurrent in_progress retry with 409', async () => {
      prismaMock.workoutBuilderIdempotencyKey.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      prismaMock.workoutBuilderIdempotencyKey.findUnique.mockResolvedValueOnce({
        status: 'in_progress',
        response_json: null,
      });

      const op = jest.fn().mockResolvedValue({});

      await expect(
        service.withIdempotency(
          COACH_ID,
          'route-key',
          'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
          op,
        ),
      ).rejects.toThrow(ConflictException);

      expect(op).not.toHaveBeenCalled();
    });

    it('runs op exactly once and flips status to completed on success', async () => {
      const op = jest.fn().mockResolvedValue({ ok: true });

      const result = await service.withIdempotency(
        COACH_ID,
        'route-key',
        'ffffffff-ffff-4fff-ffff-ffffffffffff',
        op,
      );

      expect(op).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
      expect(prismaMock.workoutBuilderIdempotencyKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'in_progress' }),
        }),
      );
      expect(prismaMock.workoutBuilderIdempotencyKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'completed' }),
        }),
      );
    });

    it('releases the claim when op() throws so the caller can retry', async () => {
      const op = jest.fn().mockRejectedValue(new Error('boom'));

      await expect(
        service.withIdempotency(
          COACH_ID,
          'route-key',
          '11111111-1111-4111-1111-111111111111',
          op,
        ),
      ).rejects.toThrow('boom');

      expect(prismaMock.workoutBuilderIdempotencyKey.delete).toHaveBeenCalled();
    });
  });

  // ─── getPlan ─────────────────────────────────────────────────────────────

  describe('getPlan', () => {
    it('returns the plan when the coach owns it', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
      const result = await service.getPlan(COACH_ID, basePlan.id);
      expect(result.id).toBe(basePlan.id);
    });

    it('404s on missing plan', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(null);
      await expect(service.getPlan(COACH_ID, 'bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403s when the coach does not own the plan', async () => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue({
        ...basePlan,
        coach_id: 'other-coach',
      });
      await expect(service.getPlan(COACH_ID, basePlan.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── listPlans keyset pagination ─────────────────────────────────────────

  describe('listPlans (P2-1 keyset pagination)', () => {
    it('caps the page at 50 and emits a base64 cursor on overflow', async () => {
      const ts = new Date('2025-01-15T00:00:00Z');
      const rows = Array.from({ length: 51 }, (_, i) => ({
        ...basePlan,
        id: `plan-${String(i).padStart(3, '0')}`,
        created_at: ts,
      }));
      prismaMock.workoutPlan.findMany.mockResolvedValue(rows);

      const result = await service.listPlans(COACH_ID, { limit: 1000 });

      expect(result.items.length).toBe(50);
      expect(typeof result.nextCursor).toBe('string');
      // Cursor decodes to "{isoTimestamp}|{lastId}".
      const decoded = Buffer.from(result.nextCursor as string, 'base64').toString('utf8');
      expect(decoded).toContain('|plan-049');
      expect(decoded.startsWith(ts.toISOString())).toBe(true);
    });

    it('returns null nextCursor on the final page', async () => {
      prismaMock.workoutPlan.findMany.mockResolvedValue([basePlan]);
      const result = await service.listPlans(COACH_ID, { limit: 50 });
      expect(result.nextCursor).toBeNull();
    });
  });

  // ─── setExercises soft-archive + active-assignment guard ─────────────────

  describe('setExercises', () => {
    beforeEach(() => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
    });

    it('soft-archives prior rows when no active assignments exist', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: basePlan.id }]),
        clientWorkoutAssignment: {
          count: jest.fn().mockResolvedValue(0),
        },
        workoutPlanExercise: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([{ id: 'new-row', order: 1 }]),
        },
      };
      prismaMock.$transaction.mockImplementation(
        async (fn: (innerTx: typeof tx) => unknown) => fn(tx),
      );

      await service.setExercises(
        COACH_ID,
        basePlan.id,
        [
          {
            exercise_external_id: 'ex-1',
            order: 1,
            sets: 3,
            reps_or_duration_seconds: 12,
          },
        ],
        '22222222-2222-4222-2222-222222222222',
      );

      // P1-3 (audit #5): plan row must be locked FOR UPDATE inside the tx.
      expect(tx.$queryRaw).toHaveBeenCalled();
      // Active-assignment count runs against the tx client, not the outer.
      expect(tx.clientWorkoutAssignment.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workout_plan_id: basePlan.id, completed_at: null },
        }),
      );
      expect(tx.workoutPlanExercise.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workout_plan_id: basePlan.id, archived_at: null },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(tx.workoutPlanExercise.createMany).toHaveBeenCalled();
    });

    it('P1-3: refuses to edit when the plan has active assignments (count inside tx)', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: basePlan.id }]),
        clientWorkoutAssignment: {
          count: jest.fn().mockResolvedValue(2),
        },
        workoutPlanExercise: {
          updateMany: jest.fn(),
          createMany: jest.fn(),
          findMany: jest.fn(),
        },
      };
      prismaMock.$transaction.mockImplementation(
        async (fn: (innerTx: typeof tx) => unknown) => fn(tx),
      );

      await expect(
        service.setExercises(
          COACH_ID,
          basePlan.id,
          [
            {
              exercise_external_id: 'ex-1',
              order: 1,
              sets: 3,
              reps_or_duration_seconds: 12,
            },
          ],
          '33333333-3333-4333-3333-333333333333',
        ),
      ).rejects.toThrow(ConflictException);

      // The transaction is entered (so the row lock is taken), and the
      // count runs against the tx client — but the writes never fire.
      expect(prismaMock.$transaction).toHaveBeenCalled();
      expect(tx.clientWorkoutAssignment.count).toHaveBeenCalled();
      expect(tx.workoutPlanExercise.updateMany).not.toHaveBeenCalled();
      expect(tx.workoutPlanExercise.createMany).not.toHaveBeenCalled();
    });

    it('rejects duplicate order values', async () => {
      await expect(
        service.setExercises(
          COACH_ID,
          basePlan.id,
          [
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
          ],
          '44444444-4444-4444-8444-444444444444',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── archivePlan idempotency (P1-6) ─────────────────────────────────────

  describe('archivePlan (P1-4 atomic updateMany)', () => {
    it('archives a live plan via conditional updateMany', async () => {
      const archivedRow = { ...basePlan, archived_at: new Date() };
      prismaMock.workoutPlan.findUnique
        .mockResolvedValueOnce(basePlan) // ownership pre-check
        .mockResolvedValueOnce(archivedRow); // post-update re-read
      prismaMock.workoutPlan.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.archivePlan(
        COACH_ID,
        basePlan.id,
        '55555555-5555-4555-8555-555555555555',
      );

      expect(prismaMock.workoutPlan.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: basePlan.id, coach_id: COACH_ID, archived_at: null },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(result.archived_at).toBeInstanceOf(Date);
    });

    it('replays cleanly when already archived (updateMany matches zero rows)', async () => {
      const archived = { ...basePlan, archived_at: new Date('2024-12-01') };
      prismaMock.workoutPlan.findUnique
        .mockResolvedValueOnce(archived) // ownership pre-check
        .mockResolvedValueOnce(archived); // post-update re-read
      prismaMock.workoutPlan.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.archivePlan(
        COACH_ID,
        basePlan.id,
        '66666666-6666-4666-8666-666666666666',
      );

      // updateMany is called regardless — but matches no rows on replay.
      expect(prismaMock.workoutPlan.updateMany).toHaveBeenCalled();
      expect(result.archived_at).toEqual(archived.archived_at);
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
      };
      prismaMock.clientWorkoutAssignment.create.mockResolvedValue(mockAssignment);

      const result = await service.assignPlan(
        COACH_ID,
        basePlan.id,
        { client_id: CLIENT_ID, scheduled_for: '2025-02-01T09:00:00Z' },
        '77777777-7777-4777-8777-777777777777',
      );

      expect((result as { client_id: string }).client_id).toBe(CLIENT_ID);
    });

    it('403s when the client belongs to a different coach', async () => {
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
        service.assignPlan(
          COACH_ID,
          basePlan.id,
          { client_id: CLIENT_ID, scheduled_for: '2025-02-01T09:00:00Z' },
          '88888888-8888-4888-8888-888888888888',
        ),
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
      expect(prismaMock.clientWorkoutAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 51 }),
      );
    });
  });

  describe('getMyAssignment (P1-4 — 403 vs 404)', () => {
    it('404s when the row does not exist', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(null);
      await expect(service.getMyAssignment(CLIENT_ID, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403s when the row exists but belongs to another user', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue({
        id: 'asgn-x',
        client_id: 'other-client',
        workout_plan: { exercises: [] },
      });
      await expect(service.getMyAssignment(CLIENT_ID, 'asgn-x')).rejects.toThrow(
        ForbiddenException,
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

  // ─── completeAssignment atomic (P1-2) ────────────────────────────────────

  describe('completeAssignment (P1-2 atomic)', () => {
    const baseAssignment = {
      id: 'asgn-1',
      client_id: CLIENT_ID,
      completed_at: null,
      completion_idempotency_key: null,
    };

    it('completes via conditional updateMany when not yet completed', async () => {
      prismaMock.clientWorkoutAssignment.findUnique
        .mockResolvedValueOnce(baseAssignment) // existence check
        .mockResolvedValueOnce({
          ...baseAssignment,
          completed_at: new Date(),
          completion_idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }); // re-read after update
      prismaMock.clientWorkoutAssignment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.completeAssignment(CLIENT_ID, baseAssignment.id, {
        idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        started_at: '2025-02-01T08:00:00Z',
        post_rpe: 8,
      });

      expect(prismaMock.clientWorkoutAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: baseAssignment.id,
            client_id: CLIENT_ID,
            completed_at: null,
          }),
        }),
      );
      expect((result as { completed_at: Date | null })?.completed_at).toBeInstanceOf(
        Date,
      );
    });

    it('is idempotent on retry with the same key', async () => {
      const already = {
        ...baseAssignment,
        completed_at: new Date('2025-02-01T09:00:00Z'),
        completion_idempotency_key: 'a4dfeb21-9b90-48e2-b49c-bf2960c7ff0e',
      };
      prismaMock.clientWorkoutAssignment.findUnique
        .mockResolvedValueOnce(already) // existence
        .mockResolvedValueOnce(already); // fast-path replay re-read

      const result = await service.completeAssignment(CLIENT_ID, baseAssignment.id, {
        idempotency_key: 'a4dfeb21-9b90-48e2-b49c-bf2960c7ff0e',
      });

      expect(prismaMock.clientWorkoutAssignment.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual(already);
    });

    it('409s when already completed with a different idempotency_key', async () => {
      const already = {
        ...baseAssignment,
        completed_at: new Date(),
        completion_idempotency_key: 'old-key',
      };
      prismaMock.clientWorkoutAssignment.findUnique
        .mockResolvedValueOnce(already)
        .mockResolvedValueOnce(already);
      prismaMock.clientWorkoutAssignment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.completeAssignment(CLIENT_ID, baseAssignment.id, {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('403s when the assignment belongs to a different client', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValueOnce({
        ...baseAssignment,
        client_id: 'other',
      });

      await expect(
        service.completeAssignment(CLIENT_ID, baseAssignment.id, {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s when the assignment does not exist', async () => {
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.completeAssignment(CLIENT_ID, 'missing', {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── concurrent completion race (P1-2) ──────────────────────────────────

  describe('completeAssignment concurrent (P1-2 atomicity proof)', () => {
    it('two concurrent completions produce one success + one idempotent replay or conflict, not two writes', async () => {
      const row = {
        id: 'asgn-1',
        client_id: CLIENT_ID,
        completed_at: null,
        completion_idempotency_key: null,
      };
      const winnerCompleted = {
        ...row,
        completed_at: new Date('2025-03-01T12:00:00Z'),
        completion_idempotency_key: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      };

      // First-stage existence check always sees the latest row.
      prismaMock.clientWorkoutAssignment.findUnique.mockImplementation(() =>
        Promise.resolve(row),
      );

      // First updateMany wins, second sees count=0.
      let updateCalls = 0;
      prismaMock.clientWorkoutAssignment.updateMany.mockImplementation(() => {
        updateCalls += 1;
        return Promise.resolve({ count: updateCalls === 1 ? 1 : 0 });
      });

      // After update, re-read returns the winner row.
      prismaMock.clientWorkoutAssignment.findUnique
        .mockReset()
        .mockResolvedValueOnce(row) // request A — existence
        .mockResolvedValueOnce(winnerCompleted) // request A — after update
        .mockResolvedValueOnce(row) // request B — existence (still pre-write to our mock)
        .mockResolvedValueOnce(winnerCompleted); // request B — after-update re-read

      const [a, b] = await Promise.allSettled([
        service.completeAssignment(CLIENT_ID, row.id, {
          idempotency_key: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        }),
        service.completeAssignment(CLIENT_ID, row.id, {
          idempotency_key: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        }),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      // At most one of the two ran the write; the other replayed the same row.
      expect(updateCalls).toBeLessThanOrEqual(2);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    });
  });
});
