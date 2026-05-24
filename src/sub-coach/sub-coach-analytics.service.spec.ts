import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { PrismaService } from '../prisma.service';

const HEAD_COACH_ID = 'head-1';
const SUB_COACH_ID = 'sub-1';

function makePrisma(): PrismaService {
  return {
    user: { findFirst: jest.fn() },
    subCoachAssignment: { findMany: jest.fn() },
    coachMessage: { findFirst: jest.fn(), findMany: jest.fn() },
    checkIn: { findMany: jest.fn() },
    workoutRoutine: { findFirst: jest.fn() },
    workoutSession: { findMany: jest.fn() },
  } as unknown as PrismaService;
}

describe('SubCoachAnalyticsService', () => {
  let service: SubCoachAnalyticsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachAnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SubCoachAnalyticsService);
  });

  it('throws NotFoundException for unknown sub-coach', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns score 0 when no signals fire', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachMessage.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.workoutRoutine.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workoutSession.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.score).toBe(0);
    expect(result.breakdown.logged_in_within_7d).toBe(0);
    expect(result.breakdown.updated_workout_plan_this_week).toBe(0);
    expect(result.breakdown.avg_workout_completion_gte_70).toBe(0);
  });

  it('awards +20 for a recent message (login proxy)', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachMessage.findFirst as jest.Mock).mockResolvedValue({ id: 'msg-1' });
    (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.workoutRoutine.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workoutSession.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.breakdown.logged_in_within_7d).toBe(20);
  });

  it('awards +25 for a workout routine created this week', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachMessage.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.workoutRoutine.findFirst as jest.Mock).mockResolvedValue({ id: 'routine-1' });
    (prisma.workoutSession.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.breakdown.updated_workout_plan_this_week).toBe(25);
  });

  it('uses SubCoachAssignment open rows to find assigned clients', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachMessage.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([
      { client_id: 'c1' },
    ]);
    (prisma.checkIn.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.workoutRoutine.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workoutSession.findMany as jest.Mock).mockResolvedValue([]);

    await service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID);

    expect(prisma.subCoachAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          head_coach_id: HEAD_COACH_ID,
          sub_coach_id: SUB_COACH_ID,
          unassigned_at: null,
        }),
      }),
    );
  });

  it('score does not exceed 100', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachMessage.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'm1' });
    (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([{ client_id: 'c1' }]);
    (prisma.checkIn.findMany as jest.Mock).mockResolvedValue([
      { user_id: 'c1', logged_at: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    ]);
    (prisma.coachMessage.findMany as jest.Mock).mockResolvedValue([
      { client_id: 'c1', created_at: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    ]);
    (prisma.workoutRoutine.findFirst as jest.Mock).mockResolvedValue({ id: 'r1' });
    const today = new Date();
    (prisma.workoutSession.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: 31 }, (_, i) => ({
        user_id: 'c1',
        date: new Date(today.getFullYear(), today.getMonth(), i + 1),
      })),
    );

    const result = await service.getEngagementScore(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
