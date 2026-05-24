/**
 * CoachOfferService — unit tests
 *
 * Covers the safety guarantees added in PR #183 and the Audit #2 fixes:
 *   - idempotency_key replay returns the original offer (double-submit)
 *   - Scale+ entitlement gate blocks free-tier coaches
 *   - accept/reject fails closed for anonymous applicants
 *   - the partial-unique race surfaces as a clean BadRequestException
 *   - acceptance flips offer.status and application.status atomically and
 *     withdraws every other pending offer for the same application
 *   - compensation_terms shape is re-validated against compensation_type
 *   - concurrent accept + reject of the same offer produces one terminal state
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoachOfferService } from '../src/talent-marketplace/coach-offer.service';
import { CoachApplicationService } from '../src/talent-marketplace/coach-application.service';
import { ConnectAccountService } from '../src/talent-marketplace/connect-account.service';
import { TalentPoolService } from '../src/talent-marketplace/talent-pool.service';
import { MarketplaceIdempotencyService } from '../src/talent-marketplace/marketplace-idempotency.service';
import { PrismaService } from '../src/prisma.service';
import {
  CoachCompensationTypeDto,
  CreateOfferDto,
  FlatPeriodEnum,
} from '../src/talent-marketplace/coach-offer.dto';

function makePrisma() {
  const tx = {
    coachOffer: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    coachApplication: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  return {
    coachOffer: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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
  let idempotency: jest.Mocked<MarketplaceIdempotencyService>;

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
    idempotency = {
      findReplay: jest.fn().mockResolvedValue(null),
      record: jest.fn().mockImplementation(async (_u, _r, _k, v) => v),
    } as unknown as jest.Mocked<MarketplaceIdempotencyService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachOfferService,
        { provide: PrismaService, useValue: prisma },
        { provide: CoachApplicationService, useValue: appService },
        { provide: ConnectAccountService, useValue: connectService },
        { provide: TalentPoolService, useValue: poolService },
        { provide: MarketplaceIdempotencyService, useValue: idempotency },
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

  describe('acceptOffer — atomic + race-safe', () => {
    function arrangeAcceptOfferPath(currentStatus = 'approved'): void {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        application_id: 'app-1',
        status: 'pending',
        accepted_at: null,
        application: { applicant_user_id: 'applicant-1' },
      });
      prisma.__tx.coachApplication.findUnique.mockResolvedValue({
        status: currentStatus,
      });
      prisma.__tx.coachOffer.updateMany.mockResolvedValue({ count: 1 });
      prisma.__tx.coachApplication.update.mockResolvedValue({});
      // For the "withdraw other pending offers" step.
      // Returns count=0 in the happy path (no peer offers for this app).
      connectService.getAccountStatus.mockResolvedValue({
        stripe_account_id: 'acct_x',
        onboarding_completed: true,
        capabilities: null,
      });
    }

    it('flips offer.status and application.status inside one $transaction', async () => {
      arrangeAcceptOfferPath();

      await service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Conditional update — only flips if still pending.
      expect(prisma.__tx.coachOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'offer-1', status: 'pending' },
          data: expect.objectContaining({ status: 'accepted' }),
        }),
      );
      expect(prisma.__tx.coachApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { status: 'placed' },
      });
    });

    it('withdraws every other pending offer for the same application', async () => {
      arrangeAcceptOfferPath();

      await service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1');

      const calls = prisma.__tx.coachOffer.updateMany.mock.calls;
      // The second updateMany call is the withdraw-peers step.
      expect(calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              where: {
                application_id: 'app-1',
                status: 'pending',
                id: { not: 'offer-1' },
              },
              data: { status: 'withdrawn' },
            }),
          ],
        ]),
      );
    });

    it('returns 409 when the application is already placed (cannot double-place)', async () => {
      arrangeAcceptOfferPath('placed');

      await expect(
        service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('returns 409 when the conditional update finds the offer already non-pending', async () => {
      arrangeAcceptOfferPath();
      prisma.__tx.coachOffer.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('maps the partial-unique-accepted index violation onto a 409', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        application_id: 'app-1',
        status: 'pending',
        accepted_at: null,
        application: { applicant_user_id: 'applicant-1' },
      });
      // The $transaction itself throws P2002 (simulating a parallel accept on
      // a peer offer landing first and the partial unique index firing).
      (prisma.$transaction as jest.Mock).mockRejectedValueOnce({ code: 'P2002' });

      await expect(
        service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('replays via the idempotency ledger before touching the offer row', async () => {
      const cached = {
        offer: {
          id: 'offer-1',
          status: 'accepted',
          accepted_at: new Date('2026-05-24T00:00:00Z'),
        },
      };
      idempotency.findReplay.mockResolvedValueOnce(cached);

      const result = await service.acceptOffer(
        'offer-1',
        'applicant-1',
        'idem-acc-1',
      );

      expect(result).toBe(cached);
      expect(prisma.coachOffer.findUnique).not.toHaveBeenCalled();
    });

    it('returns the existing accepted state when the offer is already accepted', async () => {
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

  // ─── Reject ────────────────────────────────────────────────────────────────

  describe('rejectOffer — race-safe', () => {
    it('refuses to reject an already-accepted offer (returns 409)', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'accepted',
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      });

      await expect(
        service.rejectOffer('offer-1', 'applicant-1', 'idem-rej-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('returns idempotent 200 when the offer is already rejected', async () => {
      const at = new Date('2026-05-24T00:00:00Z');
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'rejected',
        updated_at: at,
        application: { applicant_user_id: 'applicant-1' },
      });

      const result = await service.rejectOffer(
        'offer-1',
        'applicant-1',
        'idem-rej-1',
      );

      expect(result).toEqual({ id: 'offer-1', status: 'rejected', updated_at: at });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('performs a conditional update inside a transaction', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      });
      prisma.__tx.coachOffer.updateMany.mockResolvedValue({ count: 1 });
      const updatedRow = {
        id: 'offer-1',
        status: 'rejected',
        updated_at: new Date(),
      };
      prisma.__tx.coachOffer.findUniqueOrThrow.mockResolvedValue(updatedRow);

      const result = await service.rejectOffer(
        'offer-1',
        'applicant-1',
        'idem-rej-1',
      );

      expect(prisma.__tx.coachOffer.updateMany).toHaveBeenCalledWith({
        where: { id: 'offer-1', status: 'pending' },
        data: { status: 'rejected' },
      });
      expect(result).toBe(updatedRow);
    });

    it('maps a concurrent accept that committed first onto a 409', async () => {
      // The pre-tx read still sees the row as pending (stale).
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      });
      // Inside the tx, the conditional update finds count=0 and the row is
      // now accepted (a parallel acceptOffer transaction committed first).
      prisma.__tx.coachOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.__tx.coachOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'accepted',
        updated_at: new Date(),
      });

      await expect(
        service.rejectOffer('offer-1', 'applicant-1', 'idem-rej-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('treats a parallel-rejected outcome as idempotent (returns the rejected row)', async () => {
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue({
        id: 'offer-1',
        status: 'pending',
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      });
      prisma.__tx.coachOffer.updateMany.mockResolvedValue({ count: 0 });
      const at = new Date('2026-05-24T00:00:00Z');
      prisma.__tx.coachOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'rejected',
        updated_at: at,
      });

      const result = await service.rejectOffer(
        'offer-1',
        'applicant-1',
        'idem-rej-1',
      );
      expect(result).toEqual({ id: 'offer-1', status: 'rejected', updated_at: at });
    });
  });

  // ─── Concurrent accept + reject race — terminal-state consistency ─────────

  describe('concurrent accept + reject (Audit #2 P1-4)', () => {
    // The simulation: two parallel calls fire against the same pending offer.
    // We sequence which one wins via the order in which prisma resolves their
    // conditional updates. Whichever wins, the final state is one of
    // {accepted, rejected} — never both, never neither, never contradictory.
    it('produces exactly one terminal state when accept wins the race', async () => {
      const offerRow = {
        id: 'offer-1',
        application_id: 'app-1',
        status: 'pending',
        accepted_at: null,
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      };
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(offerRow);

      // accept transaction sees the row as pending → succeeds.
      prisma.__tx.coachApplication.findUnique.mockResolvedValue({
        status: 'approved',
      });
      prisma.__tx.coachOffer.updateMany
        .mockResolvedValueOnce({ count: 1 }) // accept: status='pending' → 'accepted'
        .mockResolvedValueOnce({ count: 0 }) // accept: withdraw-peers (no peers)
        .mockResolvedValueOnce({ count: 0 }); // reject: status='pending' → finds 0
      prisma.__tx.coachApplication.update.mockResolvedValue({});
      connectService.getAccountStatus.mockResolvedValue({
        stripe_account_id: 'acct_x',
        onboarding_completed: true,
        capabilities: null,
      });

      // The accept call wins.
      const acceptResult = await service.acceptOffer(
        'offer-1',
        'applicant-1',
        'idem-acc-1',
      );
      expect(acceptResult.offer.status).toBe('accepted');

      // The reject call, arriving second, sees the row as accepted inside its
      // transaction and surfaces a 409 — not a contradictory rejected state.
      prisma.__tx.coachOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'accepted',
        updated_at: new Date(),
      });
      await expect(
        service.rejectOffer('offer-1', 'applicant-1', 'idem-rej-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('produces exactly one terminal state when reject wins the race', async () => {
      const offerRow = {
        id: 'offer-1',
        application_id: 'app-1',
        status: 'pending',
        accepted_at: null,
        updated_at: new Date(),
        application: { applicant_user_id: 'applicant-1' },
      };
      (prisma.coachOffer.findUnique as jest.Mock).mockResolvedValue(offerRow);

      // reject transaction wins.
      prisma.__tx.coachOffer.updateMany.mockResolvedValueOnce({ count: 1 });
      const rejectedRow = {
        id: 'offer-1',
        status: 'rejected',
        updated_at: new Date(),
      };
      prisma.__tx.coachOffer.findUniqueOrThrow.mockResolvedValue(rejectedRow);

      const rejectResult = await service.rejectOffer(
        'offer-1',
        'applicant-1',
        'idem-rej-1',
      );
      expect(rejectResult.status).toBe('rejected');

      // The accept call, arriving second, observes the row as rejected:
      // its conditional updateMany finds count=0 → 409.
      prisma.__tx.coachApplication.findUnique.mockResolvedValue({
        status: 'approved',
      });
      prisma.__tx.coachOffer.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.acceptOffer('offer-1', 'applicant-1', 'idem-acc-1'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
