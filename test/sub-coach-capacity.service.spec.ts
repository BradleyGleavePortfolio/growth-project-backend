import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SubCoachCapacityService } from '../src/sub-coach/sub-coach-capacity.service';
import { PrismaService } from '../src/prisma.service';

const HEAD_COACH_ID = 'head-1';
const SUB_COACH_ID = 'sub-1';

function makePrisma(): PrismaService {
  return {
    user: { findFirst: jest.fn() },
    coachProfile: { findUnique: jest.fn() },
    subCoachAssignment: { count: jest.fn() },
  } as unknown as PrismaService;
}

describe('SubCoachCapacityService', () => {
  let service: SubCoachCapacityService;
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachCapacityService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SubCoachCapacityService);
  });

  it('throws NotFoundException for unknown sub-coach', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      service.getCapacity(HEAD_COACH_ID, SUB_COACH_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('TM-P1: returns the client count with no plan cap, even above the old starter cap', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachProfile.findUnique as jest.Mock).mockResolvedValue({ plan_tier: 'starter' });
    (prisma.subCoachAssignment.count as jest.Mock).mockResolvedValue(1000);

    const result = await service.getCapacity(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result).toEqual({ subCoachId: SUB_COACH_ID, assignedClients: 1000 });
    expect(prisma.coachProfile.findUnique).not.toHaveBeenCalled();
  });

  it('assertSubCoachBelongsTo uses the provided transaction client', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: SUB_COACH_ID }) },
    } as unknown as Parameters<typeof service.assertSubCoachBelongsTo>[0];
    await expect(
      service.assertSubCoachBelongsTo(tx, HEAD_COACH_ID, SUB_COACH_ID),
    ).resolves.toBeUndefined();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('assertSubCoachBelongsTo throws NotFoundException for a coach off the team', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as Parameters<typeof service.assertSubCoachBelongsTo>[0];
    await expect(
      service.assertSubCoachBelongsTo(tx, HEAD_COACH_ID, SUB_COACH_ID),
    ).rejects.toThrow(NotFoundException);
  });
});
