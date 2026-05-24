import { Test, TestingModule } from '@nestjs/testing';
import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubCoachIdempotencyService } from '../src/sub-coach/sub-coach-idempotency.service';
import { PrismaService } from '../src/prisma.service';

const ACTOR_ID = 'actor-1';
const KEY = '11111111-1111-1111-1111-111111111111';

function makePrismaMock() {
  return {
    subCoachMutationIdempotency: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as unknown as PrismaService & {
    subCoachMutationIdempotency: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
}

describe('SubCoachIdempotencyService', () => {
  let service: SubCoachIdempotencyService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        SubCoachIdempotencyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(SubCoachIdempotencyService);
  });

  it('canonical hash is stable across object key order', () => {
    const h1 = SubCoachIdempotencyService.canonicalHash('act', { a: 1, b: 2 });
    const h2 = SubCoachIdempotencyService.canonicalHash('act', { b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('canonical hash differs across actions and payloads', () => {
    expect(
      SubCoachIdempotencyService.canonicalHash('a', { x: 1 }),
    ).not.toBe(SubCoachIdempotencyService.canonicalHash('b', { x: 1 }));
    expect(
      SubCoachIdempotencyService.canonicalHash('a', { x: 1 }),
    ).not.toBe(SubCoachIdempotencyService.canonicalHash('a', { x: 2 }));
  });

  it('first call: claims, runs mutation, persists response', async () => {
    prisma.subCoachMutationIdempotency.create.mockResolvedValue({});
    prisma.subCoachMutationIdempotency.update.mockResolvedValue({});

    const mutation = jest.fn().mockResolvedValue({ ok: true });
    const result = await service.runWithIdempotency({
      actorId: ACTOR_ID,
      idempotencyKey: KEY,
      action: 'sub_coach.assign',
      payload: { clientId: 'c1' },
      runMutation: mutation,
    });

    expect(prisma.subCoachMutationIdempotency.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor_id: ACTOR_ID,
          idempotency_key: KEY,
          action: 'sub_coach.assign',
          status: 'in_progress',
        }),
      }),
    );
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(prisma.subCoachMutationIdempotency.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(result.replay).toBe(false);
    expect(result.response).toEqual({ ok: true });
  });

  it('concurrent same-key same-body returns original response without re-executing', async () => {
    prisma.subCoachMutationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '0.0.0',
      }),
    );
    const hash = SubCoachIdempotencyService.canonicalHash(
      'sub_coach.assign',
      { clientId: 'c1' },
    );
    prisma.subCoachMutationIdempotency.findUnique.mockResolvedValue({
      action: 'sub_coach.assign',
      request_hash: hash,
      response: { ok: true, original: 1 },
      status: 'completed',
    });

    const mutation = jest.fn();
    const result = await service.runWithIdempotency({
      actorId: ACTOR_ID,
      idempotencyKey: KEY,
      action: 'sub_coach.assign',
      payload: { clientId: 'c1' },
      runMutation: mutation,
    });

    expect(mutation).not.toHaveBeenCalled();
    expect(result.replay).toBe(true);
    expect(result.response).toEqual({ ok: true, original: 1 });
  });

  it('same key different body returns 422', async () => {
    prisma.subCoachMutationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '0.0.0',
      }),
    );
    const originalHash = SubCoachIdempotencyService.canonicalHash(
      'sub_coach.assign',
      { clientId: 'c1' },
    );
    prisma.subCoachMutationIdempotency.findUnique.mockResolvedValue({
      action: 'sub_coach.assign',
      request_hash: originalHash,
      response: { ok: true },
      status: 'completed',
    });

    await expect(
      service.runWithIdempotency({
        actorId: ACTOR_ID,
        idempotencyKey: KEY,
        action: 'sub_coach.assign',
        payload: { clientId: 'DIFFERENT-CLIENT' },
        runMutation: jest.fn(),
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('same key different action returns 422', async () => {
    prisma.subCoachMutationIdempotency.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '0.0.0',
      }),
    );
    prisma.subCoachMutationIdempotency.findUnique.mockResolvedValue({
      action: 'sub_coach.assign',
      request_hash: SubCoachIdempotencyService.canonicalHash(
        'sub_coach.assign',
        { clientId: 'c1' },
      ),
      response: { ok: true },
      status: 'completed',
    });

    await expect(
      service.runWithIdempotency({
        actorId: ACTOR_ID,
        idempotencyKey: KEY,
        action: 'sub_coach.unassign',
        payload: { clientId: 'c1' },
        runMutation: jest.fn(),
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('mutation error releases the claim so a corrected retry can proceed', async () => {
    prisma.subCoachMutationIdempotency.create.mockResolvedValue({});
    prisma.subCoachMutationIdempotency.delete.mockResolvedValue({});

    const err = new Error('boom');
    await expect(
      service.runWithIdempotency({
        actorId: ACTOR_ID,
        idempotencyKey: KEY,
        action: 'sub_coach.assign',
        payload: { clientId: 'c1' },
        runMutation: jest.fn().mockRejectedValue(err),
      }),
    ).rejects.toThrow('boom');
    expect(prisma.subCoachMutationIdempotency.delete).toHaveBeenCalled();
  });
});
