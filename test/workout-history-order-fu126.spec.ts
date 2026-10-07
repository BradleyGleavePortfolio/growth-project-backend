/**
 * FU-WORKLOG2-126 (agent 126): GET /workouts returns the newest saved workout
 * first within a calendar day. `date` is @db.Date, so two workouts on the same
 * day used to tie and come back in any order.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WorkoutService } from '../src/workout/workout.service';

describe('WorkoutService.getWorkouts order', () => {
  it('orders by calendar day, then by save time, newest first, for the caller only', async () => {
    const findMany = jest.fn(async () => []);
    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkoutService,
        { provide: PrismaService, useValue: { workoutSession: { findMany } } },
        { provide: PtmService, useValue: { emit: jest.fn() } },
        { provide: ClientAIContextService, useValue: { invalidateForUser: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(WorkoutService);
    await service.getWorkouts('client-1', 5);
    expect(findMany).toHaveBeenCalledWith({
      where: { user_id: 'client-1' },
      include: { exercises: true },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      take: 5,
    });
  });
});
