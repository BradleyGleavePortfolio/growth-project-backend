import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SubCoachReassignService } from './sub-coach-reassign.service';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';

const HEAD_COACH_ID = 'head-1';
const SUB_COACH_ID = 'sub-1';
const CLIENT_ID = 'client-1';
const ACTOR_ID = 'head-1';

function makePrisma(): PrismaService {
  return {
    user: { findFirst: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        user: { update: jest.fn().mockResolvedValue({}) },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      }),
    ),
  } as unknown as PrismaService;
}

describe('SubCoachReassignService', () => {
  let service: SubCoachReassignService;
  let prisma: PrismaService;
  let capacityService: SubCoachCapacityService;

  beforeEach(async () => {
    prisma = makePrisma();
    const mockCapacity = { assertHasCapacity: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachReassignService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: SubCoachCapacityService, useValue: mockCapacity },
      ],
    }).compile();
    service = module.get(SubCoachReassignService);
    capacityService = module.get(SubCoachCapacityService);
  });

  it('throws NotFoundException when destination sub-coach not found', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        toSubCoachId: SUB_COACH_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when client not found', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID }) // destination check
      .mockResolvedValueOnce(null); // client lookup
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        toSubCoachId: SUB_COACH_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when client already assigned to destination', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID }) // destination valid
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: SUB_COACH_ID, role: 'student' }); // client already there
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        toSubCoachId: SUB_COACH_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('calls $transaction and returns result for valid reassignment', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID }) // destination valid
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' }); // client belongs to head coach

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      toSubCoachId: SUB_COACH_ID,
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.clientId).toBe(CLIENT_ID);
    expect(result.newCoachId).toBe(SUB_COACH_ID);
    expect(result.previousCoachId).toBe(HEAD_COACH_ID);
    expect(result.auditLogId).toBe('audit-1');
  });
});
