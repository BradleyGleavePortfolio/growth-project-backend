import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubCoachReassignService } from '../src/sub-coach/sub-coach-reassign.service';
import { PrismaService } from '../src/prisma.service';
import { SubCoachCapacityService } from '../src/sub-coach/sub-coach-capacity.service';
import { SubCoachIdempotencyService } from '../src/sub-coach/sub-coach-idempotency.service';

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
  // A handoff deletes the drafts the sub-coach handing on holds (owner decision 17).
  aIDraft: { deleteMany: jest.Mock };
  aiActionDraft: { deleteMany: jest.Mock };
  messageDraft: { deleteMany: jest.Mock };
  churnIntervention: { deleteMany: jest.Mock };
  // And their inbox rows and coach-side insight about the client (owner 4).
  coachingSession: { findMany: jest.Mock };
  notification: { deleteMany: jest.Mock };
  pushOutbox: { findMany: jest.Mock; deleteMany: jest.Mock };
  wearableInsightCache: { deleteMany: jest.Mock };
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
    aIDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    aiActionDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    messageDraft: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    churnIntervention: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coachingSession: { findMany: jest.fn().mockResolvedValue([]) },
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    pushOutbox: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    wearableInsightCache: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
}

function makePrismaWithTx(tx: TxMock): PrismaService {
  return {
    user: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown, _opts?: unknown) => fn(tx)),
  } as unknown as PrismaService;
}

/**
 * Default idempotency mock — passes the mutation through unchanged.
 * Individual tests override .runWithIdempotency to simulate replay /
 * mismatch behavior.
 */
function makeIdempotencyMock() {
  return {
    runWithIdempotency: jest.fn(async ({ runMutation }: { runMutation: () => Promise<unknown> }) => {
      const response = await runMutation();
      return { response, replay: false };
    }),
  };
}

describe('SubCoachReassignService', () => {
  let service: SubCoachReassignService;
  let prisma: PrismaService;
  let idempotency: ReturnType<typeof makeIdempotencyMock>;
  let capacity: { assertSubCoachBelongsTo: jest.Mock };
  let tx: TxMock;

  beforeEach(async () => {
    tx = makeTxMock();
    prisma = makePrismaWithTx(tx);
    idempotency = makeIdempotencyMock();
    capacity = { assertSubCoachBelongsTo: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachReassignService,
        { provide: PrismaService, useValue: prisma },
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

    expect(capacity.assertSubCoachBelongsTo).toHaveBeenCalledWith(tx, HEAD_COACH_ID, SUB_COACH_ID);
    expect(tx.subCoachAssignment.create).toHaveBeenCalled();
    expect(tx.subCoachAssignment.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(result.clientId).toBe(CLIENT_ID);
    expect(result.newSubCoachId).toBe(SUB_COACH_ID);
    expect(result.previousSubCoachId).toBeNull();
    expect(idempotency.runWithIdempotency).toHaveBeenCalled();
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
    expect(tx.aIDraft.deleteMany).toHaveBeenCalledWith({
      where: { clientId: CLIENT_ID, coachId: SUB_COACH_ID, status: { not: 'APPROVED' } },
    });
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
    idempotency.runWithIdempotency.mockResolvedValueOnce({
      response: stored,
      replay: true,
    });

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

  it('retries on P2034 serialization failure and succeeds', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });
    let attempts = 0;
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (t: TxMock) => unknown) => {
      attempts++;
      if (attempts === 1) {
        throw new Prisma.PrismaClientKnownRequestError('serialization failure', {
          code: 'P2034',
          clientVersion: '0.0.0',
        });
      }
      return fn(tx);
    });

    const result = await service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      targetSubCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });
    expect(attempts).toBe(2);
    expect(result.newSubCoachId).toBe(SUB_COACH_ID);
  });

  it('TM-P1: rethrows the serialization error after P2034 retries, never a plan 409', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });
    (prisma.$transaction as jest.Mock).mockImplementation(async () => {
      throw new Prisma.PrismaClientKnownRequestError('serialization failure', {
        code: 'P2034',
        clientVersion: '0.0.0',
      });
    });

    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: 'P2034' });
  });

  it('assignClient routes through reassignClient and checks the team', async () => {
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });

    await service.assignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      subCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(capacity.assertSubCoachBelongsTo).toHaveBeenCalledWith(tx, HEAD_COACH_ID, SUB_COACH_ID);
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it('idempotency replay with mismatched payload bubbles 422 from the idempotency service', async () => {
    idempotency.runWithIdempotency.mockRejectedValueOnce(
      new UnprocessableEntityException({
        error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
        message:
          'This idempotency key was previously used for a different action or payload',
      }),
    );

    await expect(
      service.reassignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
        clientId: CLIENT_ID,
        targetSubCoachId: SUB_COACH_ID,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('TM-P1: assigns a client to a sub-coach already above the old plan cap', async () => {
    // The real capacity service. The old plan map capped a "starter" team's sub-coach at 25.
    const teamCheck = jest.fn().mockResolvedValue({ id: SUB_COACH_ID });
    Object.assign(tx, {
      user: { findFirst: teamCheck },
      coachProfile: { findUnique: jest.fn().mockResolvedValue({ plan_tier: 'starter' }) },
    });
    Object.assign(tx.subCoachAssignment, { count: jest.fn().mockResolvedValue(1000) });
    (prisma.user.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: SUB_COACH_ID })
      .mockResolvedValueOnce({ id: CLIENT_ID, coach_id: HEAD_COACH_ID, role: 'student' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachReassignService,
        SubCoachCapacityService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubCoachIdempotencyService, useValue: idempotency },
      ],
    }).compile();
    const real = module.get(SubCoachReassignService);

    const result = await real.assignClient(HEAD_COACH_ID, ACTOR_ID, 'coach', {
      clientId: CLIENT_ID,
      subCoachId: SUB_COACH_ID,
      idempotency_key: IDEMPOTENCY_KEY,
    });

    expect(result.newSubCoachId).toBe(SUB_COACH_ID);
    expect(tx.subCoachAssignment.create).toHaveBeenCalled();
    expect(teamCheck).toHaveBeenCalled();
  });
});
