/**
 * CoachApplicationService — unit tests
 *
 * Tests the service layer in isolation. PrismaService is replaced with a
 * jest mock whose shape mirrors the methods exercised in each test case.
 * No database or network calls are made.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoachApplicationService } from '../coach-application.service';
import { PrismaService } from '../../prisma.service';
import {
  SubmitCoachApplicationDto,
  ReviewCoachApplicationDto,
  CoachApplicationStatusDto,
  CoachClientTypeDto,
} from '../coach-application.dto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSubmitDto(
  overrides: Partial<SubmitCoachApplicationDto> = {},
): SubmitCoachApplicationDto {
  return {
    email: 'coach@example.com',
    first_name: 'Alex',
    last_name: 'Rivera',
    certifications: ['NASM-CPT'],
    specializations: ['strength', 'weight-loss'],
    years_experience: 4,
    availability_hours_per_week: 20,
    preferred_client_type: CoachClientTypeDto.FITNESS,
    preferences: { commission: true, rev_share: false, w2: false, hybrid: false },
    ...overrides,
  };
}

function makePrismaService(): PrismaService {
  return {
    coachApplication: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CoachApplicationService', () => {
  let service: CoachApplicationService;
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = makePrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachApplicationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CoachApplicationService>(CoachApplicationService);
  });

  // ─── submitApplication ─────────────────────────────────────────────────────

  describe('submitApplication', () => {
    it('creates a new application row with status pending', async () => {
      const dto = makeSubmitDto();
      const mockResult = {
        id: 'app-uuid-1',
        email: dto.email,
        status: 'pending',
        created_at: new Date(),
      };

      (prisma.coachApplication.create as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.submitApplication(dto, undefined);

      expect(prisma.coachApplication.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'coach@example.com',
            status: 'pending',
            applicant_user_id: null,
          }),
        }),
      );
      expect(result.status).toBe('pending');
    });

    it('populates applicant_user_id when userId is provided', async () => {
      const dto = makeSubmitDto();
      (prisma.coachApplication.create as jest.Mock).mockResolvedValue({
        id: 'app-uuid-2',
        email: dto.email,
        status: 'pending',
        created_at: new Date(),
      });

      await service.submitApplication(dto, 'user-123');

      expect(prisma.coachApplication.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ applicant_user_id: 'user-123' }),
        }),
      );
    });
  });

  // ─── getMyApplications ─────────────────────────────────────────────────────

  describe('getMyApplications', () => {
    it('returns applications for the given user id', async () => {
      const apps = [
        { id: 'app-1', status: 'pending', created_at: new Date(), updated_at: new Date() },
      ];
      (prisma.coachApplication.findMany as jest.Mock).mockResolvedValue(apps);

      const result = await service.getMyApplications('user-123');

      expect(prisma.coachApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { applicant_user_id: 'user-123' },
        }),
      );
      expect(result).toHaveLength(1);
    });
  });

  // ─── reviewApplication ─────────────────────────────────────────────────────

  describe('reviewApplication', () => {
    it('throws NotFoundException when application does not exist', async () => {
      (prisma.coachApplication.findUnique as jest.Mock).mockResolvedValue(null);

      const dto: ReviewCoachApplicationDto = {
        status: CoachApplicationStatusDto.REVIEWED,
      };

      await expect(
        service.reviewApplication('nonexistent-id', dto, 'owner-user-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when trying to set status to placed directly', async () => {
      (prisma.coachApplication.findUnique as jest.Mock).mockResolvedValue({
        id: 'app-1',
        status: 'approved',
      });

      const dto: ReviewCoachApplicationDto = {
        status: CoachApplicationStatusDto.PLACED,
      };

      await expect(
        service.reviewApplication('app-1', dto, 'owner-user-id'),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates the application with reviewer data on valid review', async () => {
      (prisma.coachApplication.findUnique as jest.Mock).mockResolvedValue({
        id: 'app-1',
        status: 'pending',
      });
      (prisma.coachApplication.update as jest.Mock).mockResolvedValue({
        id: 'app-1',
        status: 'reviewed',
        reviewer_score: 4,
        reviewer_notes: 'Strong candidate',
        reviewer_user_id: 'owner-user-id',
      });

      const dto: ReviewCoachApplicationDto = {
        status: CoachApplicationStatusDto.REVIEWED,
        reviewer_score: 4,
        reviewer_notes: 'Strong candidate',
      };

      const result = await service.reviewApplication('app-1', dto, 'owner-user-id');

      expect(prisma.coachApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: expect.objectContaining({
            status: 'reviewed',
            reviewer_user_id: 'owner-user-id',
            reviewer_score: 4,
            reviewer_notes: 'Strong candidate',
          }),
        }),
      );
      expect(result.status).toBe('reviewed');
    });
  });

  // ─── listApplications ──────────────────────────────────────────────────────

  describe('listApplications', () => {
    it('applies status filter when provided', async () => {
      (prisma.coachApplication.findMany as jest.Mock).mockResolvedValue([]);

      await service.listApplications({
        status: CoachApplicationStatusDto.POOL,
        take: 10,
      });

      expect(prisma.coachApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pool' }),
          take: 10,
        }),
      );
    });

    it('defaults take to 20 when not specified', async () => {
      (prisma.coachApplication.findMany as jest.Mock).mockResolvedValue([]);

      await service.listApplications({});

      expect(prisma.coachApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });
});
