/**
 * RBAC + DTO validation tests for the Phase 11 workout builder controllers.
 *
 * Three concerns covered:
 *   1. The class-level @Roles('coach','owner') on WorkoutBuilderController is
 *      readable by RolesGuard and rejects students with 403 while letting
 *      coach/owner through. JwtAuthGuard is exercised by the broader auth
 *      suite; this file verifies the role wiring.
 *   2. The new completion DTO rejects payloads missing idempotency_key
 *      (proves the controller will 400 mobile retries that lack the key).
 *   3. UpsertExerciseRowsDto runs class-validator on each row (proves the
 *      array-body fix actually validates per-element).
 */

import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/auth/roles.guard';
import {
  CompleteAssignmentDto,
  UpsertExerciseRowsDto,
} from '../src/workout-builder/workout-builder.dto';
import {
  AssignmentController,
  WorkoutBuilderController,
} from '../src/workout-builder/workout-builder.controller';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function makeContext(role: string | null) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req: { user: typeof user } = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => WorkoutBuilderController.prototype.listPlans,
    getClass: () => WorkoutBuilderController,
  } as unknown as Parameters<RolesGuard['canActivate']>[0];
}

describe('WorkoutBuilderController — class-level RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('coach passes', () => {
    expect(guard.canActivate(makeContext('coach'))).toBe(true);
  });

  it('owner passes (hierarchy bypass)', () => {
    expect(guard.canActivate(makeContext('owner'))).toBe(true);
  });

  it('student is rejected with 403', () => {
    expect(() => guard.canActivate(makeContext('student'))).toThrow(
      'Insufficient role',
    );
  });

  it('unauthenticated request rejected before role lookup', () => {
    expect(() => guard.canActivate(makeContext(null))).toThrow(
      'Authenticated user required',
    );
  });
});

describe('AssignmentController — has no class-level @Roles', () => {
  // Client-facing routes intentionally have no role gate (clients hold
  // role='student'). Access is enforced at the service layer by
  // client_id = req.user.id. The test asserts the absence so a future
  // accidental @Roles annotation here is caught early.
  it('does not require a coach/owner role', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: 'student' } }) }),
      getHandler: () => AssignmentController.prototype.listMine,
      getClass: () => AssignmentController,
    } as unknown as Parameters<RolesGuard['canActivate']>[0];
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('CompleteAssignmentDto', () => {
  it('rejects payloads missing idempotency_key', async () => {
    await expect(
      pipe.transform({}, { type: 'body', metatype: CompleteAssignmentDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-UUID idempotency_key', async () => {
    await expect(
      pipe.transform(
        { idempotency_key: 'not-a-uuid' },
        { type: 'body', metatype: CompleteAssignmentDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid completion payload', async () => {
    const result = await pipe.transform(
      {
        idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
        started_at: '2025-02-01T08:00:00Z',
        completion_payload: { sets: [{ reps: 10 }] },
        post_rpe: 8,
      },
      { type: 'body', metatype: CompleteAssignmentDto },
    );
    expect((result as CompleteAssignmentDto).idempotency_key).toBe(
      '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
    );
  });

  it('strips unknown keys when forbidNonWhitelisted is on', async () => {
    // forbidNonWhitelisted: true causes the pipe to throw rather than strip
    // when a non-whitelisted property is present. This verifies that the
    // DTO is locked down to its declared fields.
    await expect(
      pipe.transform(
        {
          idempotency_key: '4dfeb217-9b90-48e2-b49c-bf2960c7ff0e',
          surprise_field: 'reject me',
        },
        { type: 'body', metatype: CompleteAssignmentDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UpsertExerciseRowsDto (array wrapper)', () => {
  it('rejects rows whose sets value is negative', async () => {
    await expect(
      pipe.transform(
        {
          rows: [
            {
              exercise_external_id: 'ex-1',
              order: 1,
              sets: -1,
              reps_or_duration_seconds: 12,
            },
          ],
        },
        { type: 'body', metatype: UpsertExerciseRowsDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-integer order values', async () => {
    await expect(
      pipe.transform(
        {
          rows: [
            {
              exercise_external_id: 'ex-1',
              order: 1.5,
              sets: 3,
              reps_or_duration_seconds: 12,
            },
          ],
        },
        { type: 'body', metatype: UpsertExerciseRowsDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects rows with unknown extra fields', async () => {
    await expect(
      pipe.transform(
        {
          rows: [
            {
              exercise_external_id: 'ex-1',
              order: 1,
              sets: 3,
              reps_or_duration_seconds: 12,
              surprise: 'reject me',
            },
          ],
        },
        { type: 'body', metatype: UpsertExerciseRowsDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects arrays larger than ArrayMaxSize (200)', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      exercise_external_id: 'ex',
      order: i + 1,
      sets: 1,
      reps_or_duration_seconds: 10,
    }));
    await expect(
      pipe.transform({ rows }, { type: 'body', metatype: UpsertExerciseRowsDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid 3-row payload', async () => {
    const rows = [
      { exercise_external_id: 'a', order: 1, sets: 3, reps_or_duration_seconds: 12 },
      { exercise_external_id: 'b', order: 2, sets: 3, reps_or_duration_seconds: 10 },
      { exercise_external_id: 'c', order: 3, sets: 4, reps_or_duration_seconds: 8 },
    ];
    const result = (await pipe.transform(
      { rows },
      { type: 'body', metatype: UpsertExerciseRowsDto },
    )) as UpsertExerciseRowsDto;
    expect(result.rows).toHaveLength(3);
  });
});
