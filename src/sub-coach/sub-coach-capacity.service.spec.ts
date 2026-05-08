import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { PrismaService } from '../prisma.service';

const HEAD_COACH_ID = 'head-1';
const SUB_COACH_ID = 'sub-1';

function makePrisma(): PrismaService {
  return {
    user: { findFirst: jest.fn(), count: jest.fn() },
    coachProfile: { findUnique: jest.fn() },
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

  it('returns capacity with flat_300 defaults when no profile', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachProfile.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.user.count as jest.Mock).mockResolvedValue(10);

    const result = await service.getCapacity(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.maxClients).toBe(50);
    expect(result.planTier).toBe('flat_300');
    expect(result.assignedClients).toBe(10);
    expect(result.hasCapacity).toBe(true);
  });

  it('returns hasCapacity=false when at limit', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachProfile.findUnique as jest.Mock).mockResolvedValue({ plan_tier: 'starter' });
    (prisma.user.count as jest.Mock).mockResolvedValue(25);

    const result = await service.getCapacity(HEAD_COACH_ID, SUB_COACH_ID);
    expect(result.maxClients).toBe(25);
    expect(result.hasCapacity).toBe(false);
  });

  it('assertHasCapacity throws ConflictException when at limit', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
    (prisma.coachProfile.findUnique as jest.Mock).mockResolvedValue({ plan_tier: 'starter' });
    (prisma.user.count as jest.Mock).mockResolvedValue(25);

    await expect(
      service.assertHasCapacity(HEAD_COACH_ID, SUB_COACH_ID),
    ).rejects.toThrow(ConflictException);
  });
});
