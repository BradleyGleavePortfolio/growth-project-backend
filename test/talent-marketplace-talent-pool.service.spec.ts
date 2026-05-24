/**
 * TalentPoolService — unit tests
 *
 * Audit #2 P1-2: canViewTalentPool must
 *   1. check user.role === 'coach' BEFORE any subscription lookup; and
 *   2. fail closed when TALENT_POOL_PRICE_ID is unset under prod-like NODE_ENV.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TalentPoolService } from '../src/talent-marketplace/talent-pool.service';
import { PrismaService } from '../src/prisma.service';

function makePrisma(): PrismaService {
  return {
    user: { findUnique: jest.fn() },
    coachSubscription: { findUnique: jest.fn() },
    coachApplication: { findMany: jest.fn() },
  } as unknown as PrismaService;
}

describe('TalentPoolService.canViewTalentPool', () => {
  let service: TalentPoolService;
  let prisma: PrismaService;
  let originalPriceId: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TalentPoolService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(TalentPoolService);
    originalPriceId = process.env['TALENT_POOL_PRICE_ID'];
    originalNodeEnv = process.env['NODE_ENV'];
  });

  afterEach(() => {
    if (originalPriceId === undefined) delete process.env['TALENT_POOL_PRICE_ID'];
    else process.env['TALENT_POOL_PRICE_ID'] = originalPriceId;
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('returns false when the user is missing', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
    expect(prisma.coachSubscription.findUnique).not.toHaveBeenCalled();
  });

  it('returns false when the user role is student (even with an active subscription)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'student' });
    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
    expect(prisma.coachSubscription.findUnique).not.toHaveBeenCalled();
  });

  it('returns false when the user role is sub_coach', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'sub_coach' });
    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });

  it('returns false when the user role is owner (owners are not head-coaches)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'owner' });
    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });

  it('returns false when the coach has no active subscription', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'coach' });
    (prisma.coachSubscription.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });

  it('returns false in production when TALENT_POOL_PRICE_ID is unset (fail closed)', async () => {
    delete process.env['TALENT_POOL_PRICE_ID'];
    process.env['NODE_ENV'] = 'production';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'coach' });
    (prisma.coachSubscription.findUnique as jest.Mock).mockResolvedValue({
      status: 'active',
      stripe_price_id: 'price_anything',
    });

    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });

  it('returns false in staging when TALENT_POOL_PRICE_ID is unset (fail closed)', async () => {
    delete process.env['TALENT_POOL_PRICE_ID'];
    process.env['NODE_ENV'] = 'staging';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'coach' });
    (prisma.coachSubscription.findUnique as jest.Mock).mockResolvedValue({
      status: 'active',
      stripe_price_id: 'price_anything',
    });

    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });

  it('grants access when role=coach, subscription is active, and the price id matches', async () => {
    process.env['TALENT_POOL_PRICE_ID'] = 'price_scale_plus';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'coach' });
    (prisma.coachSubscription.findUnique as jest.Mock).mockResolvedValue({
      status: 'active',
      stripe_price_id: 'price_scale_plus',
    });

    await expect(service.canViewTalentPool('u-1')).resolves.toBe(true);
  });

  it('refuses when the subscription is on a different price id', async () => {
    process.env['TALENT_POOL_PRICE_ID'] = 'price_scale_plus';
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ role: 'coach' });
    (prisma.coachSubscription.findUnique as jest.Mock).mockResolvedValue({
      status: 'active',
      stripe_price_id: 'price_starter',
    });

    await expect(service.canViewTalentPool('u-1')).resolves.toBe(false);
  });
});
