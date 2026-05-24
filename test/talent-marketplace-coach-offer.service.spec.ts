/**
 * CoachOfferService — unit tests
 *
 * Covers the safety guarantees added in PR #183:
 *   - idempotency_key replay returns the original offer (double-submit)
 *   - Scale+ entitlement gate blocks free-tier coaches
 *   - accept/reject fails closed for anonymous applicants
 *   - the partial-unique race surfaces as a clean BadRequestException
 *   - acceptance flips offer.status and application.status atomically
 *   - compensation_terms shape is re-validated against compensation_type
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoachOfferService } from '../src/talent-marketplace/coach-offer.service';
import { CoachApplicationService } from '../src/talent-marketplace/coach-application.service';
import { ConnectAccountService } from '../src/talent-marketplace/connect-account.service';
import { TalentPoolService } from '../src/talent-marketplace/talent-pool.service';
import { PrismaService } from '../src/prisma.service';
import {
  CoachCompensationTypeDto,
  CreateOfferDto,
  FlatPeriodEnum,
} from '../src/talent-marketplace/coach-offer.dto';

function makePrisma() {
  const tx = {
    coachOffer: { update: jest.fn() },
    coachApplication: { update: jest.fn() },
  };
  return {
    coachOffer: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    coachApplication: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    __tx: tx,
  } as unknown as PrismaService & {
    __tx: typeof tx;
  };
}

function makeCreateOfferDto(
  overrides: Partial<CreateOfferDto> = {},
): CreateOfferDto {
  return {
    application_id: 'app-1',
    compensation_type: CoachCompensationTypeDto.COMMISSION,
    compensation_terms: { rate_pct: 85 },
    client_capacity: 10,
    idempotency_key: '00000000-0000-4000-8000-000000000abc',
    ...overrides,
  };
}

describe('CoachOfferService', () => {
  let service: CoachOfferService;
  let prisma: ReturnType<typeof makePrisma>;
  let appService: jest.Mocked<CoachApplicationService>;
  let connectService: jest.Mocked<ConnectAccountService>;
  let poolService: jest.Mocked<TalentPoolService>;

  beforeEach(async () => {
    prisma = makePrisma();
    appService = {
      findById: jest.fn(),
      markPlaced: jest.fn(),
    } as unknown as jest.Mocked<CoachApplicationService>;
    connectService = {
      getAccountStatus: jest.fn(),
      createOnboardingLink: jest.fn(),
    } as unknown as jest.Mocked<ConnectAccountService>;
    poolService = {
      canViewTalentPool: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<TalentPoolService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachOfferService,
        { provide: PrismaService, useValue: prisma },
        { provide: CoachApplicationService, useValue: appService },
        { provide: ConnectAccountService, useValue: connectService },
        { provide: TalentPoolService, useValue: poolService },
      ],
    }).compile();

    service = module.get(CoachOfferService);
  });

  // ─── RBAC ──────────────────────────────────────────────────────────────────

  describe('createOffer — entitlement', () => {
    it('throws Forbidden when the head-coach lacks an active Scale+ subscription', async () => {
      poolService.canViewTalentPool.mockResolvedValueOnce(false);

      await expect(
        service.createOffer(makeCreateOfferDto(), 'coach-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── Idempotency ───────────────────────────────────────────────────────────

  describe('createOffer — idempotency', () => {
    it('replays the existing offer when idempotency_key is repeated by the same coach', async () => {
      const existing = {
        id: 'offer-1',
        head_coach_id: 'coach-1',
        application_id: 'app-1',
        status: 'pending',
      };
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(existing);

      const result = await service.createOffer(makeCreateOfferDto(), 'coach-1');

      expect(result).toBe(existing);
      // Replay must skip create entirely
      expect(prisma.coachOffer.create).not.toHaveBeenCalled();
    });

    it('rejects replay when another coach reuses the same idempotency_key', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        head_coach_id: 'other-coach',
        application_id: 'app-1',
        status: 'pending',
      });

      await expect(
        service.createOffer(makeCreateOfferDto(), 'coach-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('surfaces a clean BadRequest when the partial-unique pending offer index fires', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(null);
      appService.findById.mockResolvedValue({
        id: 'app-1',
        status: 'pool',
        applicant_user_id: 'applicant-1',
      } as never);
      (prisma.coachOffer.create as jest.Mock).mockRejectedValue({ code: 'P2002' });

      await expect(
        service.createOffer(makeCreateOfferDto(), 'coach-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  describe('createOffer — compensation_terms validation', () => {
    beforeEach(() => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(null);
      appService.findById.mockResolvedValue({
        id: 'app-1',
        status: 'pool',
        applicant_user_id: 'applicant-1',
      } as never);
      (prisma.coachOffer.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'offer-new', ...data }),
      );
    });

    it('rejects rate_pct above 100 for commission', async () => {
      const dto = makeCreateOfferDto({
        compensation_type: CoachCompensationTypeDto.COMMISSION,
        compensation_terms: { rate_pct: 250 },
      });
      await expect(service.createOffer(dto, 'coach-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects negative amount_usd for flat', async () => {
      const dto = makeCreateOfferDto({
        compensation_type: CoachCompensationTypeDto.FLAT,
        compensation_terms: { amount_usd: -1, period: FlatPeriodEnum.MONTHLY },
      });
      await expect(service.createOffer(dto, 'coach-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects unsupported period for flat', async () => {
      const dto = makeCreateOfferDto({
        compensation_type: CoachCompensationTypeDto.FLAT,
        compensation_terms: { amount_usd: 100, period: 'yearly' },
      });
      await expect(service.createOffer(dto, 'coach-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts a well-formed rev_share with cap_usd', async () => {
      const dto = makeCreateOfferDto({
        compensation_type: CoachCompensationTypeDto.REV_SHARE,
        compensation_terms: { rate_pct: 30, cap_usd: 5000 },
      });
      const result = await service.createOffer(dto, 'coach-1');
      expect((result as { id: string }).id).toBe('offer-new');
    });
  });

  // ─── Fail-closed anonymous applicant ───────────────────────────────────────

  describe('acceptOffer / rejectOffer — anonymous applicant', () => {
    it('blocks accept when the application has no linked user', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        application: { applicant_user_id: null },
      });

      await expect(
        service.acceptOffer('offer-1', 'attacker-1', 'idem-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks reject when the application has no linked user', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        application: { applicant_user_id: null },
      });

      await expect(
        service.rejectOffer('offer-1', 'attacker-1', 'idem-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks accept when the acceptor is not the linked applicant', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        application: { applicant_user_id: 'applicant-1' },
      });

      await expect(
        service.acceptOffer('offer-1', 'other-user', 'idem-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── Atomic acceptance ─────────────────────────────────────────────────────

  describe('acceptOffer — atomic', () => {
    it('flips offer.status and application.status inside one $transaction', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        application_id: 'app-1',
        status: 'pending',
        accepted_at: null,
        application: { applicant_user_id: 'applicant-1' },
      });
      prisma.__tx.coachOffer.update.mockResolvedValue({
        id: 'offer-1',
        status: 'accepted',
        accepted_at: new Date(),
      });
      connectService.getAccountStatus.mockResolvedValue({
        stripe_account_id: 'acct_x',
        onboarding_completed: true,
        capabilities: null,
      });

      await service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.__tx.coachOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'offer-1' },
          data: expect.objectContaining({ status: 'accepted' }),
        }),
      );
      expect(prisma.__tx.coachApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { status: 'placed' },
      });
    });

    it('replays a previously accepted offer instead of double-updating', async () => {
      const acceptedAt = new Date('2026-05-01T00:00:00Z');
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        application_id: 'app-1',
        status: 'accepted',
        accepted_at: acceptedAt,
        application: { applicant_user_id: 'applicant-1' },
      });

      const result = await service.acceptOffer(
        'offer-1',
        'applicant-1',
        'idem-acc-1',
      );

      expect(result.offer.status).toBe('accepted');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFound when the offer id does not exist', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.acceptOffer('missing', 'applicant-1', 'idem-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
