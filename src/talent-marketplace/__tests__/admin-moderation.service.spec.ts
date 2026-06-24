import 'reflect-metadata';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
} from '../marketplace-idempotency.service';
import { AdminModerationService } from '../admin-moderation.service';
import { ReviewQueueQueryDto } from '../admin-moderation.dto';

// TM-7a — the moderation service is the owner-only listing review boundary.
// Tests pin: keyset queue projection (allow-list card, no raw entity spread),
// the status-guarded decision write, and the idempotency contract — including
// the P1-3 fix where an approve-then-reject with the DEFAULT key collides on
// the same ledger row and replays the FIRST decision rather than overwriting.

const NOW = new Date('2026-06-18T04:41:00.000Z');

// Silence + capture the structured moderation-decision log (see
// logModerationDecision). Tests that assert the audit event read this spy.
let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

function makePrisma(parts: Record<string, unknown>): PrismaService {
  return Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    parts as Partial<PrismaService>,
  ) as PrismaService;
}

function makeIdempotency(parts: Partial<Record<string, jest.Mock>>): MarketplaceIdempotencyService {
  return Object.assign(
    Object.create(MarketplaceIdempotencyService.prototype) as MarketplaceIdempotencyService,
    parts,
  );
}

describe('ReviewQueueQueryDto — status filter validation (FIX 1)', () => {
  async function validateStatus(status: unknown): Promise<string[]> {
    const dto = plainToInstance(ReviewQueueQueryDto, { status });
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
  }

  it.each(['draft', 'published', 'closed'])('accepts the canonical status %s', async (status) => {
    expect(await validateStatus(status)).toHaveLength(0);
  });

  it('rejects ?status=garbage at the validation layer', async () => {
    const constraints = await validateStatus('garbage');
    expect(constraints).toContain('isIn');
  });

  it('still allows an omitted status (optional filter)', async () => {
    const dto = plainToInstance(ReviewQueueQueryDto, {});
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });
});

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

  it.each(['published', 'closed'] as const)(
    'passes a %s status filter straight onto the indexed column',
    async (status) => {
      const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
      const prisma = makePrisma({ jobListing: { findMany } });
      const service = new AdminModerationService(prisma, makeIdempotency({}));
      await service.listListings({ status });
      expect(findMany.mock.calls[0][0].where.status).toBe(status);
    },
  );

  it('omits the status filter entirely when none is supplied', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = makePrisma({ jobListing: { findMany } });
    const service = new AdminModerationService(prisma, makeIdempotency({}));
    await service.listListings({});
    expect('status' in findMany.mock.calls[0][0].where).toBe(false);
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
    const findUnique = opts.findUnique ?? jest.fn(async () => ({ id: 'list-1' }));
    const updateMany = opts.updateMany ?? jest.fn(async () => ({ count: 1 }));
    const prisma = makePrisma({
      jobListing: { findUnique, updateMany },
    });
    const claimOrReplay = jest.fn(
      async (_key: { userId: string; routeKey: string; idempotencyKey: string }) => claim,
    );
    const markCompleted = opts.markCompleted ?? jest.fn(async () => ({ outcome: 'ok' }));
    const releaseClaim = opts.releaseClaim ?? jest.fn(async () => ({ outcome: 'ok' }));
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

  it('approves a draft listing → published via a status-guarded write, stamping published_at', async () => {
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
    const data = updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('published');
    // Lifecycle timestamp set on approval (P2-1) and echoed on the result with
    // the SAME instant.
    expect(data.published_at).toBeInstanceOf(Date);
    expect(data.closed_at).toBeUndefined();
    expect(res.decided_at).toBe((data.published_at as Date).toISOString());
    expect(res.decided_by).toBe('owner-1');
  });

  it('rejects a draft listing → closed, stamping closed_at', async () => {
    const { service, updateMany } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'rejected',
    });
    expect(res.status).toBe('closed');
    const data = updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('closed');
    // Lifecycle timestamp set on rejection (P2-1) with the same instant echoed.
    expect(data.closed_at).toBeInstanceOf(Date);
    expect(data.published_at).toBeUndefined();
    expect(res.decided_at).toBe((data.closed_at as Date).toISOString());
  });

  it('persists the moderation note onto the result and returns it', async () => {
    const { service, markCompleted } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'rejected',
      note: 'spam listing',
    });
    expect(res.note).toBe('spam listing');
    // The note is written into the ledger row JSON so it survives a replay.
    const stored = markCompleted.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.note).toBe('spam listing');
    expect(stored.decided_by).toBe('owner-1');
    expect(typeof stored.decided_at).toBe('string');
  });

  it('defaults a missing note to null on the result and ledger row', async () => {
    const { service, markCompleted } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'approved',
    });
    expect(res.note).toBeNull();
    const stored = markCompleted.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.note).toBeNull();
  });

  it('emits a structured moderation_decision audit event on a first decision', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewListing('owner-1', 'list-1', {
      decision: 'approved',
      note: 'looks good',
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.listing.moderation_decision',
        owner_id: 'owner-1',
        listing_id: 'list-1',
        decision: 'approved',
        note: 'looks good',
        replayed: false,
        result_status: 'published',
      }),
      expect.any(String),
    );
  });

  it('includes request_id on the first-decision audit event when supplied (B-P2-7)', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewListing('owner-1', 'list-1', { decision: 'approved' }, 'req-abc-123');
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.listing.moderation_decision',
        request_id: 'req-abc-123',
      }),
      expect.any(String),
    );
  });

  it('retains request_id on the replay audit event (B-P2-7)', async () => {
    const { service } = serviceFor({
      outcome: 'replay',
      response: {
        id: 'list-1',
        status: 'published',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    await service.reviewListing('owner-1', 'list-1', { decision: 'rejected' }, 'req-abc-123');
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.listing.moderation_decision',
        replayed: true,
        request_id: 'req-abc-123',
      }),
      expect.any(String),
    );
  });

  it('omits request_id entirely when none is supplied (no null/undefined key) (B-P2-7)', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewListing('owner-1', 'list-1', { decision: 'approved' });
    const payload = logSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.event).toBe('talent_marketplace.listing.moderation_decision');
    expect(payload).not.toHaveProperty('request_id');
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
      response: {
        id: 'list-1',
        status: 'published',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    const res = await service.reviewListing('owner-1', 'list-1', {
      decision: 'rejected',
    });
    // Replay returns the FIRST (approved/published) decision, not the new reject.
    expect(res.decision).toBe('approved');
    expect(res.status).toBe('published');
    expect(res.replayed).toBe(true);
    // The note + actor + timestamp round-trip through the ledger on replay so
    // the replay response shares the same shape as the first decision (FIX 3).
    expect(res.note).toBe('approved with a note');
    expect(res.decided_by).toBe('owner-1');
    expect(res.decided_at).toBe(NOW.toISOString());
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('emits the audit event with replayed=true on a replay', async () => {
    const { service } = serviceFor({
      outcome: 'replay',
      response: {
        id: 'list-1',
        status: 'published',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    await service.reviewListing('owner-1', 'list-1', { decision: 'rejected' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.listing.moderation_decision',
        owner_id: 'owner-1',
        listing_id: 'list-1',
        decision: 'approved',
        note: 'approved with a note',
        replayed: true,
        result_status: 'published',
      }),
      expect.any(String),
    );
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
