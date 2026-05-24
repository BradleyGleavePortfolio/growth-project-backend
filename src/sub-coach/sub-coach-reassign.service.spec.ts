import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubCoachReassignService } from './sub-coach-reassign.service';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachIdempotencyService } from './sub-coach-idempotency.service';

const HEAD_COACH_ID = 'head-1';
const SUB_COACH_ID = 'sub-1';
const OTHER_SUB_COACH_ID = 'sub-2';
const CLIENT_ID = 'client-1';
const ACTOR_ID = 'head-1';
const IDEMPOTENCY_KEY = '11111111-1111-1111-1111-111111111111';

type TxMock = {
  subCoachAssignment: {
    findFirst: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  auditLog: { create: jest.Mock };
};

function makeTxMock(initialOpen: unknown = null): TxMock {
  return {
    subCoachAssignment: {
      findFirst: jest.fn().mockResolvedValue(initialOpen),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'sca-1' }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
}

function makePrismaWithTx(tx: TxMock): PrismaService {
  return {
    user: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown, _opts?: unknown) => fn(tx)),
  } as unknown as PrismaService;
}

describe('SubCoachReassignService', () => {
  let service: SubCoachReassignService;
  let prisma: PrismaService;
  let idempotency: { findExisting: jest.Mock; store: jest.Mock };
  let capacity: { assertHasCapacityTx: jest.Mock; assertHasCapacity: jest.Mock };
  let tx: TxMock;

  beforeEach(async () => {
    tx = makeTxMock();
    prisma = makePrismaWithTx(tx);
    idempotency = {
      findExisting: jest.fn().mockResolvedValue(null),
      store: jest.fn().mockImplementation((_a, _k, _act, response) => response),
    };
    capacity = {
      assertHasCapacityTx: jest.fn().mockResolvedValue(undefined),
      assertHasCapacity: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachReassignService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: SubCoachCapacityService, useValue: capacity },
        { provide: SubCoachIdempotencyService, useValue: idempotency },
      ],
    }).compile();
    service = module.get(SubCoachReassignService);
  });

  it('throws NotFoundException when destination sub-coach not found', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when client not found', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce(null);
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when client belongs to a different team', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: 'other-head', role: 'student' });
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('opens an assignment + writes audit log on first assign', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      targetSubCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(capacity.assertHasCapacityTx).toHaveBeenCalled();
    expect(tx.subCoachAssignment.create).toHaveBeenCalled();
    expect(tx.subCoachAssignment.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(result.clientId).toBe(CLIENT_ID);
    expect(result.newSubCoachId).toBe(SUB_COACH_ID);
    expect(result.previousSubCoachId).toBeNull();
    expect(idempotency.store).toHaveBeenCalled();
  });

  it('closes prior assignment + opens new on reassign to a different sub-coach', async () => {
    tx.subCoachAssignment.findFirst.mockResolvedValue({
      id: 'open-1',
      sub_coach_id: SUB_COACH_ID,
      head_coach_id: HEAD_COACH_ID,
    });
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: OTHER_SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      targetSubCoachId: OTHER_SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(tx.subCoachAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'open-1' } }),
    );
    expect(tx.subCoachAssignment.create).toHaveBeenCalled();
    expect(result.previousSubCoachId).toBe(SUB_COACH_ID);
    expect(result.newSubCoachId).toBe(OTHER_SUB_COACH_ID);
  });

  it('same-destination reassignment returns idempotent success (no 400)', async () => {
    tx.subCoachAssignment.findFirst.mockResolvedValue({
      id: 'open-1',
      sub_coach_id: SUB_COACH_ID,
      head_coach_id: HEAD_COACH_ID,
    });
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      targetSubCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(tx.subCoachAssignment.create).not.toHaveBeenCalled();
    expect(tx.subCoachAssignment.update).not.toHaveBeenCalled();
    expect(result.newSubCoachId).toBe(SUB_COACH_ID);
    expect(result.previousSubCoachId).toBe(SUB_COACH_ID);
  });

  it('unassign to head coach when no open assignment is an idempotent no-op', async () => {
    tx.subCoachAssignment.findFirst.mockResolvedValue(null);
    (prisma.user.findFirst as jest.Mock).mockResolvedValueOnce({
      id: CLIENT_ID,
      coach_id: HEAD_COACH_ID,
      role: 'student',
    });

    const result = await service.unassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(tx.subCoachAssignment.create).not.toHaveBeenCalled();
    expect(tx.subCoachAssignment.update).not.toHaveBeenCalled();
    expect(result.newSubCoachId).toBeNull();
  });

  it('replays stored idempotent response on double-submit', async () => {
    const stored = {
      clientId: CLIENT_ID,
      previousSubCoachId: null,
      newSubCoachId: SUB_COACH_ID,
      auditLogId: 'audit-prev',
    };
    idempotency.findExisting.mockResolvedValueOnce(stored);

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      targetSubCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.auditLogId).toBe('audit-prev');
    expect(result.idempotent_replay).toBe(true);
  });

  it('translates partial-unique race to ConflictException', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });
    (prisma.$transaction as jest.Mock).mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: '0.0.0',
      });
    });
    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('assignClient routes through reassignClient and enforces capacity', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });

    await service.assignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      subCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(capacity.assertHasCapacityTx).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });
});
