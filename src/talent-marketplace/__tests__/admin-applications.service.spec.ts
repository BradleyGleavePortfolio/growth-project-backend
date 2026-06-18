import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
} from '../marketplace-idempotency.service';
import { AdminApplicationsService } from '../admin-applications.service';

// TM-7b — applicant review reuses the TM-7a ledger helpers. Tests pin the
// allow-list queue projection, the status-guarded decision write (submitted →
// shortlisted/rejected), and the idempotency contract — including the P1-3 fix
// where an approve-then-reject with the DEFAULT key replays the first decision.

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

describe('AdminApplicationsService.listApplications — queue + projection', () => {
  it('projects an allow-list card and never spreads the raw row', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => [
      {
        id: 'app-1',
        listing_id: 'list-9',
        status: 'submitted',
        fit_score: 77,
        created_at: NOW,
        applicant_id: 'SECRET-CAND',
        cover_letter: 'do-not-leak',
      },
    ]);
    const prisma = makePrisma({ application: { findMany } });
    const service = new AdminApplicationsService(prisma, makeIdempotency({}));

    const res = await service.listApplications({});
    const card = res.items[0];
    expect(Object.keys(card).sort()).toEqual(
      ['created_at', 'fit_score', 'id', 'listing_id', 'status'].sort(),
    );
    expect(JSON.stringify(card)).not.toContain('SECRET-CAND');
    expect(JSON.stringify(card)).not.toContain('do-not-leak');
    expect(card.created_at).toBe(NOW.toISOString());
  });

  it('applies an optional status filter onto the indexed column', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = makePrisma({ application: { findMany } });
    const service = new AdminApplicationsService(prisma, makeIdempotency({}));
    await service.listApplications({ status: 'submitted' });
    expect(findMany.mock.calls[0][0].where.status).toBe('submitted');
  });

  it('returns a next_cursor only when a full page + 1 is fetched', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `app-${i}`,
      listing_id: 'list-9',
      status: 'submitted',
      fit_score: null,
      created_at: NOW,
    }));
    const prisma = makePrisma({
      application: { findMany: jest.fn(async () => rows) },
    });
    const service = new AdminApplicationsService(prisma, makeIdempotency({}));
    const res = await service.listApplications({});
    expect(res.items).toHaveLength(20);
    expect(res.next_cursor).not.toBeNull();
  });
});

describe('AdminApplicationsService.reviewApplication — decision + idempotency', () => {
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
      opts.findUnique ?? jest.fn(async () => ({ id: 'app-1' }));
    const updateMany =
      opts.updateMany ?? jest.fn(async () => ({ count: 1 }));
    const prisma = makePrisma({
      application: { findUnique, updateMany },
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
      service: new AdminApplicationsService(prisma, idem),
      updateMany,
      claimOrReplay,
      releaseClaim,
    };
  }

  it('approves a submitted application → shortlisted via a status-guarded write', async () => {
    const { service, updateMany } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'approved',
    });
    expect(res.status).toBe('shortlisted');
    const where = updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('app-1');
    expect(where.status).toBe('submitted');
    expect(updateMany.mock.calls[0][0].data.status).toBe('shortlisted');
  });

  it('rejects a submitted application → rejected', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'rejected',
    });
    expect(res.status).toBe('rejected');
  });

  it('throws an opaque application_not_found for an unknown application', async () => {
    const { service } = serviceFor(
      { outcome: 'claimed', claimNonce: 'n1' },
      { findUnique: jest.fn(async () => null) },
    );
    await expect(
      service.reviewApplication('owner-1', 'ghost', { decision: 'approved' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reviewApplication('owner-1', 'ghost', { decision: 'approved' }),
    ).rejects.toMatchObject({ response: { code: 'application_not_found' } });
  });

  it('builds the default idem-key WITHOUT the decision (P1-3)', async () => {
    const { service, claimOrReplay } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await service.reviewApplication('owner-1', 'app-1', { decision: 'approved' });
    const key = claimOrReplay.mock.calls[0][0].idempotencyKey;
    expect(key).toBe('review:app-1');
    expect(key).not.toContain('approved');
  });

  it('replays the FIRST decision when the ledger reports a replay', async () => {
    const { service, updateMany } = serviceFor({
      outcome: 'replay',
      response: { id: 'app-1', status: 'shortlisted', decision: 'approved' },
    });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'rejected',
    });
    expect(res.decision).toBe('approved');
    expect(res.status).toBe('shortlisted');
    expect(res.replayed).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a second decision on an already-decided row conflicts (status guard catches it)', async () => {
    const { service, releaseClaim } = serviceFor(
      { outcome: 'claimed', claimNonce: 'n2' },
      { updateMany: jest.fn(async () => ({ count: 0 })) },
    );
    await expect(
      service.reviewApplication('owner-1', 'app-1', { decision: 'rejected' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(releaseClaim).toHaveBeenCalled();
  });

  it('surfaces an in_flight concurrent review as a typed conflict', async () => {
    const { service } = serviceFor({ outcome: 'in_flight' });
    await expect(
      service.reviewApplication('owner-1', 'app-1', { decision: 'approved' }),
    ).rejects.toMatchObject({ response: { code: 'review_in_flight' } });
  });
});
