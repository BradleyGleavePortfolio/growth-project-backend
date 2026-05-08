import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SubCoachAssignmentService } from './sub-coach-assignment.service';
import { PrismaService } from '../prisma.service';

const HEAD_COACH_ID = 'head-coach-1';
const SUB_COACH_ID = 'sub-coach-1';
const CLIENT_ID = 'client-1';

function makePrisma(overrides: Record<string, unknown> = {}): PrismaService {
  return {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
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

    it('returns clients list when sub-coach is valid', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SUB_COACH_ID });
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: CLIENT_ID, name: 'Alice', email: 'alice@example.com' },
      ]);
      const result = await service.getAssignedClients(HEAD_COACH_ID, SUB_COACH_ID);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(CLIENT_ID);
    });
  });

  describe('assignClient', () => {
    it('throws when client not found', async () => {
      // First call: sub-coach lookup — found. Second: client lookup — not found.
      (prisma.user.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: SUB_COACH_ID }) // assertSubCoachBelongsTo
        .mockResolvedValueOnce(null);                 // client lookup

      await expect(
        service.assignClient(HEAD_COACH_ID, { clientId: CLIENT_ID, subCoachId: SUB_COACH_ID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when target is not a student', async () => {
      (prisma.user.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: SUB_COACH_ID })
        .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'coach' });

      await expect(
        service.assignClient(HEAD_COACH_ID, { clientId: CLIENT_ID, subCoachId: SUB_COACH_ID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates coach_id when all validations pass', async () => {
      (prisma.user.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: SUB_COACH_ID })  // assertSubCoachBelongsTo
        .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' }); // client
      // assertClientInTeam: coach_id === headCoachId so no extra findFirst call
      (prisma.user.update as jest.Mock).mockResolvedValue({ id: CLIENT_ID, name: 'Alice', coach_id: SUB_COACH_ID });

      const result = await service.assignClient(HEAD_COACH_ID, { clientId: CLIENT_ID, subCoachId: SUB_COACH_ID });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CLIENT_ID }, data: { coach_id: SUB_COACH_ID } }),
      );
      expect(result.coach_id).toBe(SUB_COACH_ID);
    });
  });
});
