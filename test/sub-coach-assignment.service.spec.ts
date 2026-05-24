import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SubCoachAssignmentService } from '../src/sub-coach/sub-coach-assignment.service';
import { PrismaService } from '../src/prisma.service';

const HEAD_COACH_ID = 'head-coach-1';
const SUB_COACH_ID = 'sub-coach-1';
const CLIENT_ID = 'client-1';

function makePrisma(): PrismaService {
  return {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    subCoachAssignment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe('SubCoachAssignmentService', () => {
  let service: SubCoachAssignmentService;
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachAssignmentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SubCoachAssignmentService);
  });

  describe('getAssignedClients', () => {
    it('throws NotFoundException when sub-coach does not belong to head coach', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getAssignedClients(HEAD_COACH_ID, SUB_COACH_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns empty array when no open assignments', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
      (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([]);
      const result = await service.getAssignedClients(HEAD_COACH_ID, SUB_COACH_ID);
      expect(result).toEqual([]);
    });

    it('returns clients via SubCoachAssignment join', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
      (prisma.subCoachAssignment.findMany as jest.Mock).mockResolvedValue([
        { client_id: CLIENT_ID },
      ]);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: CLIENT_ID, name: 'Alice', email: 'alice@example.com' },
      ]);
      const result = await service.getAssignedClients(HEAD_COACH_ID, SUB_COACH_ID);
      expect(prisma.subCoachAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            head_coach_id: HEAD_COACH_ID,
            sub_coach_id: SUB_COACH_ID,
            unassigned_at: null,
          }),
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(CLIENT_ID);
    });
  });

  describe('assertClientOnTeamRoster', () => {
    it('throws when client missing', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.assertClientOnTeamRoster(HEAD_COACH_ID, CLIENT_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when target is not a student', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({
        id: CLIENT_ID,
        coach_id: HEAD_COACH_ID,
        role: 'coach',
      });
      await expect(
        service.assertClientOnTeamRoster(HEAD_COACH_ID, CLIENT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when client belongs to a different team', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({
        id: CLIENT_ID,
        coach_id: 'other-head',
        role: 'student',
      });
      await expect(
        service.assertClientOnTeamRoster(HEAD_COACH_ID, CLIENT_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
