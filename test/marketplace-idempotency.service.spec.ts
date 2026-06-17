import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { MarketplaceIdempotencyService } from '../src/talent-marketplace/marketplace-idempotency.service';
import { PrismaService } from '../src/prisma.service';

const USER_ID = 'user-1';
const ROUTE_KEY = 'talent-marketplace.apply';
const KEY = '11111111-1111-1111-1111-111111111111';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '0.0.0',
  });
}

type IdempotencyMock = {
  marketplaceMutationIdempotency: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};

function makePrismaMock(): IdempotencyMock {
  return {
    marketplaceMutationIdempotency: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

const KEY_ARGS = { userId: USER_ID, routeKey: ROUTE_KEY, idempotencyKey: KEY };

describe('MarketplaceIdempotencyService', () => {
  let service: MarketplaceIdempotencyService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceIdempotencyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(MarketplaceIdempotencyService);
    delete process.env.MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS;
  });

  afterEach(() => {
    delete process.env.MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS;
  });

  it('fresh claim succeeds (no existing row) and stamps a fencing nonce', async () => {
    prisma.marketplaceMutationIdempotency.create.mockResolvedValue({});

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result.outcome).toBe('claimed');
    if (result.outcome !== 'claimed') throw new Error('expected claimed');
    expect(typeof result.claimNonce).toBe('string');
    expect(result.claimNonce.length).toBeGreaterThan(0);
    expect(prisma.marketplaceMutationIdempotency.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: USER_ID,
          route_key: ROUTE_KEY,
          idempotency_key: KEY,
          status: 'pending',
          claim_nonce: result.claimNonce,
        }),
      }),
    );
    expect(prisma.marketplaceMutationIdempotency.findUnique).not.toHaveBeenCalled();
  });

  // F2: a fresh `pending` sibling within the TTL is genuinely in flight. It MUST
  // surface as `in_flight` — NOT a bogus {outcome:'replay', response:null} that
  // is indistinguishable from a completed-null response and would let the caller
  // treat an unfinished mutation as a success.
  it('duplicate within window returns in_flight (no re-execute, no bogus replay)', async () => {
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique.mockResolvedValue({
      id: 'row-1',
      status: 'pending',
      response: null,
      created_at: new Date(), // fresh — within TTL
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result).toEqual({ outcome: 'in_flight' });
    expect(prisma.marketplaceMutationIdempotency.updateMany).not.toHaveBeenCalled();
  });

  it('completed claim replays the stored response', async () => {
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique.mockResolvedValue({
      id: 'row-1',
      status: 'completed',
      response: { ok: true, applicationId: 'app-9' },
      created_at: new Date(Date.now() - 5_000),
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result).toEqual({
      outcome: 'replay',
      response: { ok: true, applicationId: 'app-9' },
    });
  });

  // P1-8 REGRESSION: a `pending` claim older than the TTL is abandoned (the
  // owner crashed before releaseClaim, or releaseClaim failed). It MUST be
  // reclaimable — not block replays forever.
  it('P1-8: stale pending claim past TTL is reclaimable', async () => {
    process.env.MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS = '600000';
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique.mockResolvedValue({
      id: 'stale-row',
      status: 'pending',
      response: null,
      created_at: new Date(Date.now() - 700_000), // older than 10min TTL
    });
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 1,
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result.outcome).toBe('claimed');
    if (result.outcome !== 'claimed') throw new Error('expected claimed');
    expect(typeof result.claimNonce).toBe('string');
    expect(prisma.marketplaceMutationIdempotency.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stale-row', status: 'pending' },
        data: expect.objectContaining({ claim_nonce: result.claimNonce }),
      }),
    );
  });

  it('P1-8: stale-claim TTL falls back to default when env unset', async () => {
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique.mockResolvedValue({
      id: 'stale-row',
      status: 'pending',
      response: null,
      created_at: new Date(Date.now() - 11 * 60_000), // 11min > 10min default
    });
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 1,
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result.outcome).toBe('claimed');
  });

  it('stale reclaim lost to a concurrent winner re-reads and replays', async () => {
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique
      .mockResolvedValueOnce({
        id: 'stale-row',
        status: 'pending',
        response: null,
        created_at: new Date(Date.now() - 700_000),
      })
      .mockResolvedValueOnce({
        id: 'stale-row',
        status: 'completed',
        response: { ok: true, winner: true },
        created_at: new Date(),
      });
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 0, // someone else reclaimed/completed first
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result).toEqual({
      outcome: 'replay',
      response: { ok: true, winner: true },
    });
  });

  // F3: when the stale reclaim loses the race AND the winner is itself a fresh
  // pending claim still within the TTL, the recursive re-read must surface
  // `in_flight` — never the old bogus {outcome:'replay', response:null}.
  it('stale reclaim lost to a fresh-pending winner returns in_flight', async () => {
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(p2002());
    prisma.marketplaceMutationIdempotency.findUnique
      .mockResolvedValueOnce({
        id: 'stale-row',
        status: 'pending',
        response: null,
        created_at: new Date(Date.now() - 700_000), // stale on first read
      })
      .mockResolvedValueOnce({
        id: 'stale-row',
        status: 'pending',
        response: null,
        created_at: new Date(), // winner's fresh claim, within TTL
      });
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 0, // someone else reclaimed first
    });

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result).toEqual({ outcome: 'in_flight' });
  });

  it('row vanished between insert and read is reclaimed', async () => {
    prisma.marketplaceMutationIdempotency.create
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({});
    prisma.marketplaceMutationIdempotency.findUnique.mockResolvedValue(null);

    const result = await service.claimOrReplay(KEY_ARGS);

    expect(result.outcome).toBe('claimed');
    expect(prisma.marketplaceMutationIdempotency.create).toHaveBeenCalledTimes(2);
  });

  it('non-P2002 create error propagates', async () => {
    const boom = new Error('db down');
    prisma.marketplaceMutationIdempotency.create.mockRejectedValue(boom);

    await expect(service.claimOrReplay(KEY_ARGS)).rejects.toThrow('db down');
  });

  const NONCE = 'nonce-aaaa';

  it('markCompleted persists response and flips status to completed (nonce match)', async () => {
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 1,
    });

    const result = await service.markCompleted(KEY_ARGS, NONCE, { ok: true });

    expect(result).toEqual({ outcome: 'ok' });
    expect(prisma.marketplaceMutationIdempotency.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_id: USER_ID,
          route_key: ROUTE_KEY,
          idempotency_key: KEY,
          claim_nonce: NONCE,
        }),
        data: expect.objectContaining({
          status: 'completed',
          response: { ok: true },
        }),
      }),
    );
  });

  // F1 REGRESSION: a reclaimed original owner (slow-but-alive, past TTL) holds a
  // STALE nonce. The TTL sweep rotated the row's nonce to the new owner's, so
  // the dead owner's markCompleted matches zero rows. It MUST be rejected as a
  // typed conflict — never a silent blind update that double-executes the
  // mutation alongside the reclaiming caller.
  it('F1: reclaimed owner markCompleted is fenced (typed conflict, no blind write)', async () => {
    prisma.marketplaceMutationIdempotency.updateMany.mockResolvedValue({
      count: 0, // row's claim_nonce was rotated by reclaimStale — no match
    });

    const result = await service.markCompleted(KEY_ARGS, 'stale-nonce', {
      ok: true,
    });

    expect(result).toEqual({ outcome: 'conflict' });
  });

  // P1-8 root cause: releaseClaim must NOT swallow its error. A failed delete
  // surfaces (fail-fast / R70) instead of silently orphaning the pending row.
  it('releaseClaim surfaces delete errors (no swallow)', async () => {
    const delErr = new Error('delete failed');
    prisma.marketplaceMutationIdempotency.deleteMany.mockRejectedValue(delErr);

    await expect(service.releaseClaim(KEY_ARGS, NONCE)).rejects.toThrow(
      'delete failed',
    );
  });

  it('releaseClaim deletes the pending claim on success (nonce match)', async () => {
    prisma.marketplaceMutationIdempotency.deleteMany.mockResolvedValue({
      count: 1,
    });

    const result = await service.releaseClaim(KEY_ARGS, NONCE);

    expect(result).toEqual({ outcome: 'ok' });
    expect(prisma.marketplaceMutationIdempotency.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_id: USER_ID,
          route_key: ROUTE_KEY,
          idempotency_key: KEY,
          claim_nonce: NONCE,
        }),
      }),
    );
  });

  // F1: a reclaimed owner's releaseClaim must not delete the NEW owner's live
  // claim — nonce mismatch matches zero rows and returns a typed conflict.
  it('F1: reclaimed owner releaseClaim is fenced (no-op conflict)', async () => {
    prisma.marketplaceMutationIdempotency.deleteMany.mockResolvedValue({
      count: 0,
    });

    const result = await service.releaseClaim(KEY_ARGS, 'stale-nonce');

    expect(result).toEqual({ outcome: 'conflict' });
  });
});
