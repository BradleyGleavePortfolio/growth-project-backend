/**
 * UX-WORKOUT-124 (agent 124): client routines can be saved, edited and
 * deleted, and a seed exercise id resolves to its name.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { CreateRoutineDto, UpdateRoutineDto } from '../src/workout/workout.dto';
import { WorkoutService } from '../src/workout/workout.service';
import { ExerciseLibraryService } from '../src/exercise-library/exercise-library.service';

// Same options as the global pipe in src/main.ts.
const PIPE = { whitelist: true, forbidNonWhitelisted: true };

// Exactly what the mobile routine builder sends after UX-WORKOUT-124.
const MOBILE_ROUTINE_BODY = {
  name: 'Push A',
  exercises: [
    {
      exercise_name: 'Barbell Bench Press',
      muscle_group: 'chest',
      default_sets: 5,
      default_reps: 5,
      default_rest_seconds: 120,
      order_index: 0,
    },
    {
      exercise_name: 'Bicep Curl',
      muscle_group: 'arms',
      default_sets: 3,
      default_reps: 12,
      default_rest_seconds: 60,
      order_index: 1,
    },
  ],
};

describe('routine DTOs accept the mobile routine body', () => {
  it('CreateRoutineDto passes', async () => {
    const errors = await validate(plainToInstance(CreateRoutineDto, MOBILE_ROUTINE_BODY), PIPE);
    expect(errors).toHaveLength(0);
  });

  it('UpdateRoutineDto passes with exercises (was "property exercises should not exist")', async () => {
    const errors = await validate(plainToInstance(UpdateRoutineDto, MOBILE_ROUTINE_BODY), PIPE);
    expect(errors).toHaveLength(0);
  });

  it('UpdateRoutineDto still rejects a bad muscle group', async () => {
    const bad = {
      ...MOBILE_ROUTINE_BODY,
      exercises: [{ ...MOBILE_ROUTINE_BODY.exercises[0], muscle_group: 'biceps' }],
    };
    const errors = await validate(plainToInstance(UpdateRoutineDto, bad), PIPE);
    expect(errors.length).toBeGreaterThan(0);
  });
});

async function makeService() {
  const tx = {
    workoutRoutine: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: 'r1', exercises: [] }),
    },
    routineExercise: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const prisma = {
    workoutRoutine: {
      findUnique: jest.fn().mockResolvedValue({ id: 'r1', creator_id: 'u1' }),
      delete: jest.fn().mockReturnValue('DELETE_ROUTINE'),
    },
    routineExercise: {
      deleteMany: jest.fn().mockReturnValue('DELETE_CHILDREN'),
    },
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return arg(tx);
      return [{ count: 2 }, { id: 'r1' }];
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkoutService,
      { provide: PrismaService, useValue: prisma },
      { provide: PtmService, useValue: { emit: jest.fn() } },
      { provide: ClientAIContextService, useValue: { invalidateForUser: jest.fn() } },
    ],
  }).compile();
  const service = moduleRef.get(WorkoutService);
  return { service, prisma, tx };
}

describe('WorkoutService routines', () => {
  it('updateRoutine replaces the exercise list in one transaction', async () => {
    const { service, tx } = await makeService();
    await service.updateRoutine('u1', 'r1', plainToInstance(UpdateRoutineDto, MOBILE_ROUTINE_BODY));
    expect(tx.workoutRoutine.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { name: 'Push A', description: undefined },
    });
    expect(tx.routineExercise.deleteMany).toHaveBeenCalledWith({ where: { routine_id: 'r1' } });
    const rows = tx.routineExercise.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ routine_id: 'r1', exercise_name: 'Barbell Bench Press', default_sets: 5, default_reps: 5, default_rest_seconds: 120, order_index: 0 });
  });

  it('updateRoutine without exercises leaves the list alone', async () => {
    const { service, tx } = await makeService();
    await service.updateRoutine('u1', 'r1', { name: 'Renamed' });
    expect(tx.routineExercise.deleteMany).not.toHaveBeenCalled();
    expect(tx.routineExercise.createMany).not.toHaveBeenCalled();
  });

  it('updateRoutine on someone else\'s routine is a 404', async () => {
    const { service, prisma } = await makeService();
    prisma.workoutRoutine.findUnique.mockResolvedValue({ id: 'r1', creator_id: 'other' });
    await expect(service.updateRoutine('u1', 'r1', { name: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('deleteRoutine removes the exercises before the routine (FK is RESTRICT)', async () => {
    const { service, prisma } = await makeService();
    const out = await service.deleteRoutine('u1', 'r1');
    expect(prisma.routineExercise.deleteMany).toHaveBeenCalledWith({ where: { routine_id: 'r1' } });
    expect(prisma.$transaction).toHaveBeenCalledWith(['DELETE_CHILDREN', 'DELETE_ROUTINE']);
    expect(out).toEqual({ id: 'r1' });
  });
});

describe('ExerciseLibraryService.getExerciseById seed ids', () => {
  it('answers a seed: id from the seed catalog without calling upstream', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ExerciseLibraryService, { provide: ConfigService, useValue: { get: () => undefined } }],
    }).compile();
    const lib = moduleRef.get(ExerciseLibraryService);
    const fetchSpy = jest.spyOn(global, 'fetch');
    const ex = await lib.getExerciseById('seed:push-001');
    expect(ex.name).toBe('Barbell Bench Press');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
