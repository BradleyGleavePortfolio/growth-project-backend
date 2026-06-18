import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
} from '../marketplace-idempotency.service';
import { AdminModerationService } from '../admin-moderation.service';

// TM-7a — the moderation service is the owner-only listing review boundary.
// Tests pin: keyset queue projection (allow-list card, no raw entity spread),
// the status-guarded decision write, and the idempotency contract — including
// the P1-3 fix where an approve-then-reject with the DEFAULT key collides on
// the same ledger row and replays the FIRST decision rather than overwriting.

const NOW = new Date('2026-06-18T04:41:00.000Z');

function makePrisma(parts: Record<string, unknown>): PrismaService {
  return Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    parts as Partial<PrismaService>,
  ) as PrismaService;
}

function makeIdempotency(
  parts: Partial<Record<string, jest.Mock>>,
): MarketplaceIdempotencyService {
  return Object.assign(
    Object.create(
      MarketplaceIdempotencyService.prototype,
    ) as MarketplaceIdempotencyService,
    parts,
  );
}

describe('AdminModerationService.listListings — keyset queue + projection', () => {
  it('projects an allow-list card and never spreads the raw row', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => [
      {
        id: 'list-1',
        title: 'Head Strength Coach',
        specialty: 'Strength',
        status: 'draft',
        created_at: NOW,
        owner_id: 'SECRET-OWNER',
        internal_notes: 'do-not-leak',
      },
    ]);
    const prisma = makePrisma({ jobListing: { findMany } });
    const service = new AdminModerationService(prisma, makeIdempotency({}));

    const res = await service.listListings({});
    const card = res.items[0];
    expect(Object.keys(card).sort()).toEqual(
      ['created_at', 'id', 'specialty', 'status', 'title'].sort(),
    );
    expect(JSON.stringify(card)).not.toContain('SECRET-OWNER');
    expect(JSON.stringify(card)).not.toContain('do-not-leak');
    expect(card.created_at).toBe(NOW.toISOString());
  });

  it('applies an optional status filter onto the indexed column', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = makePrisma({ jobListing: { findMany } });
    const service = new AdminModerationService(prisma, makeIdempotency({}));
    await service.listListings({ status: 'draft' });
    expect(findMany.mock.calls[0][0].where.status).toBe('draft');
  });

  it('returns a next_cursor only when a full page + 1 is fetched', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `list-${i}`,
      title: 't',
      specialty: null,
      status: 'draft',
      created_at: NOW,
    }));
    const prisma = makePrisma({
      jobListing: { findMany: jest.fn(async () => rows) },
    });
    const service = new AdminModerationService(prisma, makeIdempotency({}));
    const res = await service.listListings({});
    expect(res.items).toHaveLength(20);
    expect(res.next_cursor).not.toBeNull();
  });
});

describe('AdminModerationService.reviewListing — decision + idempotency', () => {
  function serviceFor(
    claim: ClaimOrReplayResult,
    opts: {
      findUnique?: jest.Mock;
      updateMany?: jest.Mock;
      markCompleted?: jest.Mock;
      releaseClaim?: jest.Mock;
    } = {},
  ) {
    const findUnique =
      opts.findUnique ?? jest.fn(async () => ({ id: 'list-1' }));
    const updateMany =
      opts.updateMany ?? jest.fn(async () => ({ count: 1 }));
    const prisma = makePrisma({
      jobListing: { findUnique, updateMany },
    });
    const claimOrReplay = jest.fn(
      async (_key: {
        userId: string;
        routeKey: string;
        idempotencyKey: string;
      }) => claim,
    );
    const markCompleted =
      opts.markCompleted ?? jest.fn(async () => ({ outcome: 'ok' }));
    const releaseClaim =
      opts.releaseClaim ?? jest.fn(async () => ({ outcome: 'ok' }));
    const idem = makeIdempotency({
      claimOrReplay,
      markCompleted,
      releaseClaim,
    });
    return {
      service: new AdminModerationService(prisma, idem),
      findUnique,
      updateMany,
      claimOrReplay,
      markCompleted,
      releaseClaim,
    };
  }

  it('approves a draft listing → published via a status-guarded write', async () => {
    const { service, updateMany } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'approved',
    });
    expect(res.status).toBe('published');
    expect(res.decision).toBe('approved');
    expect(res.replayed).toBe(false);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('list-1');
    expect(where.status).toBe('draft');
    expect(updateMany.mock.calls[0][0].data.status).toBe('published');
  });

  it('rejects a draft listing → closed', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'rejected',
    });
    expect(res.status).toBe('closed');
  });

  it('throws an opaque listing_not_found for an unknown listing', async () => {
    const { service } = serviceFor(
      { outcome: 'claimed', claimNonce: 'n1' },
      { findUnique: jest.fn(async () => null) },
    );
    await expect(
      service.reviewListing('owner-1', 'ghost', { decision: 'approved' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reviewListing('owner-1', 'ghost', { decision: 'approved' }),
    ).rejects.toMatchObject({ response: { code: 'listing_not_found' } });
  });

  it('builds the default idem-key WITHOUT the decision (P1-3)', async () => {
    const { service, claimOrReplay } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await service.reviewListing('owner-1', 'list-1', { decision: 'approved' });
    const key = claimOrReplay.mock.calls[0][0].idempotencyKey;
    expect(key).toBe('review:list-1');
    expect(key).not.toContain('approved');
  });

  it('replays the FIRST decision when the ledger reports a replay', async () => {
    const { service, updateMany } = serviceFor({
      outcome: 'replay',
      response: { id: 'list-1', status: 'published', decision: 'approved' },
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'rejected',
    });
    // Replay returns the FIRST (approved/published) decision, not the new reject.
    expect(res.decision).toBe('approved');
    expect(res.status).toBe('published');
    expect(res.replayed).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a second decision on an already-decided row conflicts (status guard catches it)', async () => {
    const { service, releaseClaim } = serviceFor(
      { outcome: 'claimed', claimNonce: 'n2' },
      { updateMany: jest.fn(async () => ({ count: 0 })) },
    );
    await expect(
      service.reviewListing('owner-1', 'list-1', { decision: 'rejected' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The claim is released so a same-key retry can replay rather than wedge.
    expect(releaseClaim).toHaveBeenCalled();
  });

  it('surfaces an in_flight concurrent review as a typed conflict', async () => {
    const { service } = serviceFor({ outcome: 'in_flight' });
    await expect(
      service.reviewListing('owner-1', 'list-1', { decision: 'approved' }),
    ).rejects.toMatchObject({ response: { code: 'review_in_flight' } });
  });
});
