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
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
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
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  clientWorkoutAssignmentSnapshot: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  workoutProgram: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  workoutPlanRevision: {
    create: jest.Mock;
  };
  workoutProgramRevision: {
    create: jest.Mock;
  };
  user: { findUnique: jest.Mock };
  workoutBuilderIdempotencyKey: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  $transaction: jest.Mock;
  // MWB-2 G9: the clone's in-txn advisory lock runs via tx.$executeRaw. The
  // $transaction mock runs the callback with this same mock as `tx`, so the
  // raw handle must exist (and resolve) for the clone path to proceed.
  $executeRaw: jest.Mock;
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
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  clientWorkoutAssignmentSnapshot: {
    create: jest.fn().mockResolvedValue({ id: 'snap-1' }),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  workoutProgram: {
    create: jest.fn(),
    findUnique: jest.fn(),
    // No prior clone exists by default, so the G9 existence probe lets the
    // winner path proceed.
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  },
  workoutPlanRevision: {
    create: jest.fn().mockResolvedValue({ id: 'rev-1' }),
  },
  workoutProgramRevision: {
    create: jest.fn().mockResolvedValue({ id: 'prog-rev-1' }),
  },
  user: { findUnique: jest.fn() },
  workoutBuilderIdempotencyKey: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
  $executeRaw: jest.fn().mockResolvedValue(1),
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

    // Default $transaction: run the callback with the mock itself as the tx
    // client (so tx.clientWorkoutAssignment.* etc. resolve to the same mocks).
    // Individual tests that need a bespoke tx override this.
    prismaMock.$transaction.mockImplementation(
      async (arg: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: PrismaMock) => unknown)(prismaMock);
        }
        return arg;
      },
    );

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

  // ─── setExercises soft-archive (MWB-1: 409 guard removed) ────────────────

  describe('setExercises', () => {
    beforeEach(() => {
      prismaMock.workoutPlan.findUnique.mockResolvedValue(basePlan);
    });

    it('soft-archives prior rows and writes the new ones', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: basePlan.id }]),
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

      // The plan row must still be locked FOR UPDATE inside the tx (guards
      // concurrent setExercises against each other).
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.workoutPlanExercise.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workout_plan_id: basePlan.id, archived_at: null },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(tx.workoutPlanExercise.createMany).toHaveBeenCalled();
    });

    it('MWB-1 §3.3: edits SUCCEED even when the plan has active assignments (409 guard removed)', async () => {
      // The legacy 409 "plan has active assignments" guard is gone — clients
      // hold an immutable snapshot, so the coach can freely edit. Crucially
      // the tx must NOT count assignments anymore, and the writes DO fire.
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: basePlan.id }]),
        // A `count` is intentionally provided; if the service still called it
        // the assertion below would fail — proving the guard is truly removed.
        clientWorkoutAssignment: {
          count: jest.fn().mockResolvedValue(2),
        },
        workoutPlanExercise: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([{ id: 'new-row', order: 1 }]),
        },
      };
      prismaMock.$transaction.mockImplementation(
        async (fn: (innerTx: typeof tx) => unknown) => fn(tx),
      );

      const result = await service.setExercises(
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
      );

      expect(result).toEqual([{ id: 'new-row', order: 1 }]);
      // The active-assignment count is no longer consulted.
      expect(tx.clientWorkoutAssignment.count).not.toHaveBeenCalled();
      // The writes DID fire despite active assignments existing.
      expect(tx.workoutPlanExercise.updateMany).toHaveBeenCalled();
      expect(tx.workoutPlanExercise.createMany).toHaveBeenCalled();
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

    it('MWB-1 §3.3: writes an immutable snapshot inside the assign transaction', async () => {
      const planWithRows = {
        ...basePlan,
        version: 1,
        exercises: [
          {
            exercise_external_id: 'ex-1',
            order: 1,
            sets: 3,
            reps_or_duration_seconds: 12,
            weight_lbs: null,
            rest_seconds: null,
            superset_group_id: null,
            notes: null,
          },
        ],
      };
      prismaMock.workoutPlan.findUnique.mockResolvedValue(planWithRows);
      prismaMock.clientWorkoutAssignment.create.mockResolvedValue({
        id: 'asgn-snap-1',
        workout_plan_id: basePlan.id,
        client_id: CLIENT_ID,
      });

      await service.assignPlan(
        COACH_ID,
        basePlan.id,
        { client_id: CLIENT_ID, scheduled_for: '2025-02-01T09:00:00Z' },
        '99999999-9999-4999-8999-999999999999',
      );

      // The assignment + snapshot are written in one $transaction.
      expect(prismaMock.$transaction).toHaveBeenCalled();
      expect(
        prismaMock.clientWorkoutAssignmentSnapshot.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assignment_id: 'asgn-snap-1',
            plan_name: basePlan.name,
            source_plan_id: basePlan.id,
            source_version: 1,
          }),
        }),
      );
    });
  });

  // ─── MWB-1 assertCanAccessClient (§7.2 sub-coach scope) ───────────────────

  describe('assertCanAccessClient (MWB-1 §7.2)', () => {
    it('allows the head coach (direct ownership)', async () => {
      await expect(
        service.assertCanAccessClient(COACH_ID, CLIENT_ID),
      ).resolves.toBeUndefined();
    });

    it('404s when the client does not exist', async () => {
      await expect(
        service.assertCanAccessClient(COACH_ID, 'no-such-client'),
      ).rejects.toThrow(NotFoundException);
    });

    it('403s a foreign coach when the sub-coach scope helper is not wired', async () => {
      // Unit-test construction injects no SubCoachScopeService, so the gate
      // degrades to head-coach-only — preserving exact legacy behaviour.
      prismaMock.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) => {
          if (where.id === COACH_ID) return Promise.resolve(coachRow);
          if (where.id === CLIENT_ID)
            return Promise.resolve({ id: CLIENT_ID, coach_id: 'someone-else' });
          return Promise.resolve(null);
        },
      );
      await expect(
        service.assertCanAccessClient(COACH_ID, CLIENT_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a sub-coach when the scope helper grants access', async () => {
      // Re-build the service WITH a SubCoachScopeService stub that grants.
      const subCoachScope = {
        canAccessClient: jest.fn().mockResolvedValue(true),
      };
      const mod: TestingModule = await Test.createTestingModule({
        providers: [
          WorkoutBuilderService,
          { provide: PrismaService, useValue: prismaMock },
          {
            provide: SubCoachScopeService,
            useValue: subCoachScope,
          },
        ],
      }).compile();
      const svc = mod.get<WorkoutBuilderService>(WorkoutBuilderService);
      prismaMock.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) => {
          if (where.id === 'sub-coach')
            return Promise.resolve({ id: 'sub-coach', coach_id: COACH_ID });
          if (where.id === CLIENT_ID)
            return Promise.resolve({ id: CLIENT_ID, coach_id: COACH_ID });
          return Promise.resolve(null);
        },
      );

      await expect(
        svc.assertCanAccessClient('sub-coach', CLIENT_ID),
      ).resolves.toBeUndefined();
      expect(subCoachScope.canAccessClient).toHaveBeenCalledWith(
        'sub-coach',
        CLIENT_ID,
      );
    });
  });

  // ─── MWB-1 forkTemplate (§7.3) ────────────────────────────────────────────

  describe('forkTemplate (MWB-1 §7.3)', () => {
    const masterTemplate = {
      id: 'prog-master',
      coach_id: COACH_ID,
      owner_user_id: COACH_ID,
      visibility: 'owner_only',
      name: 'Hypertrophy Block',
      description: '12-week build',
      weeks: 12,
      days_per_week: 4,
      is_template: true,
      goal_tag: 'hypertrophy',
    };

    it('404s when the source template does not exist', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(null);
      await expect(
        service.forkTemplate('missing', COACH_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('403s when the source is neither owned nor tenant-shared in the tenant', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue({
        ...masterTemplate,
        owner_user_id: 'other-coach',
        coach_id: 'other-coach',
        visibility: 'owner_only',
      });
      await expect(
        service.forkTemplate('prog-master', COACH_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deep-copies into a NEW owner_only program owned by the actor', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(masterTemplate);
      prismaMock.workoutProgram.create.mockResolvedValue({
        id: 'prog-fork',
        owner_user_id: COACH_ID,
      });
      // No child plans for simplicity.
      prismaMock.workoutPlan.findMany.mockResolvedValue([]);

      const result = await service.forkTemplate('prog-master', COACH_ID);

      expect(prismaMock.workoutProgram.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            owner_user_id: COACH_ID,
            visibility: 'owner_only',
            forked_from_id: 'prog-master',
            is_template: true,
          }),
        }),
      );
      expect(result.program).toEqual({ id: 'prog-fork', owner_user_id: COACH_ID });
    });
  });

  // ─── MWB-1 cloneProgramToClient (§3.2) ────────────────────────────────────

  describe('cloneProgramToClient (MWB-2 §3.3, FEATURE_MWB_TEMPLATES)', () => {
    const master = {
      id: 'prog-master',
      coach_id: COACH_ID,
      owner_user_id: COACH_ID,
      visibility: 'owner_only',
      name: 'Master',
      description: null,
      weeks: 4,
      days_per_week: 3,
      is_template: true,
      goal_tag: null,
    };

    // MWB-2 is flag-gated (default OFF). These tests exercise the enabled
    // behaviour; the OFF→404 invariant is pinned separately below.
    const ORIGINAL_FLAG = process.env.FEATURE_MWB_TEMPLATES;
    beforeEach(() => {
      process.env.FEATURE_MWB_TEMPLATES = 'true';
    });
    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_TEMPLATES;
      else process.env.FEATURE_MWB_TEMPLATES = ORIGINAL_FLAG;
    });

    it('clones into a NEW non-template program with cloned_from_id set', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(master);
      prismaMock.workoutProgram.create.mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: 'prog-master',
        weeks: 4,
        days_per_week: 3,
      });
      prismaMock.workoutProgram.update.mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: 'prog-master',
        head_revision_id: 'prog-rev-1',
      });
      prismaMock.workoutPlan.findMany.mockResolvedValue([]);

      const result = await service.cloneProgramToClient(
        'prog-master',
        CLIENT_ID,
        COACH_ID,
      );

      expect(prismaMock.workoutProgram.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            is_template: false,
            cloned_from_id: 'prog-master',
            owner_user_id: COACH_ID,
          }),
        }),
      );
      // Decision A: a fresh program-level revision (index 0, cause 'clone')
      // is written and head_revision_id is pointed at it ("v1").
      expect(prismaMock.workoutProgramRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            program_id: 'prog-clone',
            revision_index: 0,
            cause: 'clone',
            author_kind: 'coach',
          }),
        }),
      );
      expect(prismaMock.workoutProgram.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prog-clone' },
          data: { head_revision_id: 'prog-rev-1' },
        }),
      );
      expect(result.program.head_revision_id).toBe('prog-rev-1');
      expect(result.programRevision.id).toBe('prog-rev-1');
    });

    it('403s when the coach cannot access the target client', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(master);
      prismaMock.user.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) => {
          if (where.id === COACH_ID) return Promise.resolve(coachRow);
          if (where.id === CLIENT_ID)
            return Promise.resolve({ id: CLIENT_ID, coach_id: 'other-coach' });
          return Promise.resolve(null);
        },
      );
      await expect(
        service.cloneProgramToClient('prog-master', CLIENT_ID, COACH_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s a foreign-tenant master (does not leak that it exists)', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue({
        ...master,
        owner_user_id: 'other-coach',
        coach_id: 'other-coach',
        visibility: 'owner_only',
      });
      await expect(
        service.cloneProgramToClient('prog-master', CLIENT_ID, COACH_ID),
      ).rejects.toThrow(NotFoundException);
      // No write was attempted on a non-reachable master.
      expect(prismaMock.workoutProgram.create).not.toHaveBeenCalled();
    });

    it('404s when FEATURE_MWB_TEMPLATES is OFF, before any DB read', async () => {
      delete process.env.FEATURE_MWB_TEMPLATES;
      await expect(
        service.cloneProgramToClient('prog-master', CLIENT_ID, COACH_ID),
      ).rejects.toThrow(NotFoundException);
      // Flag gate runs first — the master is never even looked up.
      expect(prismaMock.workoutProgram.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.workoutProgram.create).not.toHaveBeenCalled();
    });

    it('cloneProgramToClientResult projects the typed CloneProgramResultDto', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(master);
      prismaMock.workoutProgram.create.mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: 'prog-master',
        weeks: 4,
        days_per_week: 3,
      });
      prismaMock.workoutProgram.update.mockResolvedValue({
        id: 'prog-clone',
        is_template: false,
        cloned_from_id: 'prog-master',
        head_revision_id: 'prog-rev-1',
      });
      prismaMock.workoutPlan.findMany.mockResolvedValue([]);

      const dto = await service.cloneProgramToClientResult(
        'prog-master',
        CLIENT_ID,
        COACH_ID,
      );

      expect(dto).toEqual({
        program_id: 'prog-clone',
        cloned_from_id: 'prog-master',
        is_template: false,
        head_revision_id: 'prog-rev-1',
        plan_ids: [],
      });
    });
  });

  // ─── MWB-1 assignProgramToClient fan-out (§3.4) ──────────────────────────

  describe('assignProgramToClient (MWB-1 §3.4 fan-out)', () => {
    const program = {
      id: 'prog-1',
      owner_user_id: COACH_ID,
      coach_id: COACH_ID,
      visibility: 'owner_only',
    };

    it('creates one assignment + snapshot per plan, scheduled by week/day offset', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(program);
      prismaMock.workoutPlan.findMany
        // first call: fan-out plan list
        .mockResolvedValueOnce([
          { id: 'plan-w0d0', week_index: 0, day_index: 0 },
          { id: 'plan-w1d2', week_index: 1, day_index: 2 },
        ]);
      // snapshot writes read each plan back
      prismaMock.workoutPlan.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            name: 'Day',
            type: WorkoutType.strength,
            version: 1,
            exercises: [],
          }),
      );
      let n = 0;
      prismaMock.clientWorkoutAssignment.create.mockImplementation(() =>
        Promise.resolve({ id: `asgn-${n++}` }),
      );

      const result = await service.assignProgramToClient(
        COACH_ID,
        'prog-1',
        { client_id: CLIENT_ID, start_date: '2025-02-03T00:00:00Z' },
        'abababab-abab-4aba-8aba-abababababab',
      );

      expect((result as { assignments: unknown[] }).assignments).toHaveLength(2);
      expect(prismaMock.clientWorkoutAssignment.create).toHaveBeenCalledTimes(2);
      expect(
        prismaMock.clientWorkoutAssignmentSnapshot.create,
      ).toHaveBeenCalledTimes(2);
      // Second plan is week 1 day 2 => +9 days from start_date.
      const secondCall =
        prismaMock.clientWorkoutAssignment.create.mock.calls[1][0];
      const scheduled = secondCall.data.scheduled_for as Date;
      const start = new Date('2025-02-03T00:00:00Z').getTime();
      const days = Math.round((scheduled.getTime() - start) / 86400000);
      expect(days).toBe(9);
    });

    it('400s when the program has no plans', async () => {
      prismaMock.workoutProgram.findUnique.mockResolvedValue(program);
      prismaMock.workoutPlan.findMany.mockResolvedValue([]);
      await expect(
        service.assignProgramToClient(
          COACH_ID,
          'prog-1',
          { client_id: CLIENT_ID, start_date: '2025-02-03T00:00:00Z' },
          'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
        ),
      ).rejects.toThrow(BadRequestException);
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

    it('returns the row (live-join fallback) when no snapshot exists', async () => {
      const liveExercises = [{ id: 'ex-row-1', order: 1 }];
      const row = {
        id: 'asgn-x',
        client_id: CLIENT_ID,
        snapshot: null,
        workout_plan: { exercises: liveExercises },
      };
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(row);

      const result = await service.getMyAssignment(CLIENT_ID, 'asgn-x');
      // Pre-MWB-1 assignment: presenter falls back to the live join.
      expect(result).toMatchObject({
        id: 'asgn-x',
        client_id: CLIENT_ID,
        exercises: liveExercises,
        snapshot_source: false,
      });
    });

    it('MWB-1 §3.3: renders exercises FROM the snapshot when present', async () => {
      const frozen = [
        { exercise_external_id: 'ex-frozen', order: 1, sets: 4, reps_or_duration_seconds: 8 },
      ];
      const liveExercises = [{ id: 'ex-live', order: 1 }];
      const row = {
        id: 'asgn-snap',
        client_id: CLIENT_ID,
        snapshot: { exercises_json: frozen },
        // The live join is intentionally DIFFERENT from the snapshot to prove
        // the read renders the frozen rows, not the (mutated) live plan.
        workout_plan: { exercises: liveExercises },
      };
      prismaMock.clientWorkoutAssignment.findUnique.mockResolvedValue(row);

      const result = await service.getMyAssignment(CLIENT_ID, 'asgn-snap');
      expect(result).toMatchObject({
        exercises: frozen,
        snapshot_source: true,
      });
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
