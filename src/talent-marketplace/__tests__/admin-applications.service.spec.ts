import 'reflect-metadata';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
} from '../marketplace-idempotency.service';
import { AdminApplicationsService } from '../admin-applications.service';
import { APPLICATION_STATUS, ReviewQueueQueryDto } from '../admin-applications.dto';

// TM-7b — applicant review reuses the TM-7a ledger helpers and now mirrors the
// TM-7a service contract end to end. Tests pin: the application-status filter
// validation, the allow-list queue projection, the status-guarded decision
// write (submitted → shortlisted/rejected), the note/decided_by/decided_at
// ledger round-trip on first decision + replay, the structured audit event
// (request_id present / retained on replay / omitted when absent), and the
// idempotency contract — including the P1-3 fix where an approve-then-reject
// with the DEFAULT key replays the first decision rather than overwriting.

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

describe('ReviewQueueQueryDto (applications) — status filter validation', () => {
  async function validateStatus(status: unknown): Promise<string[]> {
    const dto = plainToInstance(ReviewQueueQueryDto, { status });
    const errors = await validate(dto as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
  }

  it.each([...APPLICATION_STATUS])('accepts the canonical status %s', async (status) => {
    expect(await validateStatus(status)).toHaveLength(0);
  });

  it('rejects ?status=garbage at the validation layer', async () => {
    const constraints = await validateStatus('garbage');
    expect(constraints).toContain('isIn');
  });

  it('rejects a listing-only status (draft) that is not an application status', async () => {
    const constraints = await validateStatus('draft');
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
        cover_note: 'do-not-leak',
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

  it.each(['shortlisted', 'rejected', 'withdrawn'] as const)(
    'passes a %s status filter straight onto the indexed column',
    async (status) => {
      const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
      const prisma = makePrisma({ application: { findMany } });
      const service = new AdminApplicationsService(prisma, makeIdempotency({}));
      await service.listApplications({ status });
      expect(findMany.mock.calls[0][0].where.status).toBe(status);
    },
  );

  it('omits the status filter entirely when none is supplied', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = makePrisma({ application: { findMany } });
    const service = new AdminApplicationsService(prisma, makeIdempotency({}));
    await service.listApplications({});
    expect('status' in findMany.mock.calls[0][0].where).toBe(false);
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
      findUnique,
      updateMany,
      claimOrReplay,
      markCompleted,
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
    expect(res.decision).toBe('approved');
    expect(res.replayed).toBe(false);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('app-1');
    expect(where.status).toBe('submitted');
    expect(updateMany.mock.calls[0][0].data.status).toBe('shortlisted');
    // The acting owner + decision instant are echoed on the result.
    expect(res.decided_by).toBe('owner-1');
    expect(typeof res.decided_at).toBe('string');
    expect(Number.isNaN(Date.parse(res.decided_at))).toBe(false);
  });

  it('rejects a submitted application → rejected', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'rejected',
    });
    expect(res.status).toBe('rejected');
  });

  it('does NOT write a lifecycle timestamp column (Application has none)', async () => {
    // Unlike the listing half (published_at / closed_at), the Application model
    // carries no shortlisted_at / rejected_at columns, so the decision write
    // must touch ONLY status — never an invented timestamp column.
    const { service, updateMany } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await service.reviewApplication('owner-1', 'app-1', { decision: 'approved' });
    const data = updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['status']);
    expect(data).not.toHaveProperty('shortlisted_at');
    expect(data).not.toHaveProperty('rejected_at');
    expect(data).not.toHaveProperty('decided_at');
  });

  it('persists the moderation note onto the result and the ledger row', async () => {
    const { service, markCompleted } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'rejected',
      note: 'not a fit',
    });
    expect(res.note).toBe('not a fit');
    // The note + actor + timestamp are written into the ledger row JSON so they
    // survive a replay (the Application row itself has no note column).
    const stored = markCompleted.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.note).toBe('not a fit');
    expect(stored.decided_by).toBe('owner-1');
    expect(typeof stored.decided_at).toBe('string');
  });

  it('defaults a missing note to null on the result and ledger row', async () => {
    const { service, markCompleted } = serviceFor({
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'approved',
    });
    expect(res.note).toBeNull();
    const stored = markCompleted.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.note).toBeNull();
  });

  it('emits a structured moderation_decision audit event on a first decision', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewApplication('owner-1', 'app-1', {
      decision: 'approved',
      note: 'looks good',
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.application.moderation_decision',
        owner_id: 'owner-1',
        application_id: 'app-1',
        decision: 'approved',
        note: 'looks good',
        replayed: false,
        result_status: 'shortlisted',
      }),
      expect.any(String),
    );
  });

  it('includes request_id on the first-decision audit event when supplied (B-P2-7)', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewApplication(
      'owner-1',
      'app-1',
      { decision: 'approved' },
      'req-abc-123',
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.application.moderation_decision',
        request_id: 'req-abc-123',
      }),
      expect.any(String),
    );
  });

  it('retains request_id on the replay audit event (B-P2-7)', async () => {
    const { service } = serviceFor({
      outcome: 'replay',
      response: {
        id: 'app-1',
        status: 'shortlisted',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    await service.reviewApplication(
      'owner-1',
      'app-1',
      { decision: 'rejected' },
      'req-abc-123',
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.application.moderation_decision',
        replayed: true,
        request_id: 'req-abc-123',
      }),
      expect.any(String),
    );
  });

  it('omits request_id entirely when none is supplied (no null/undefined key) (B-P2-7)', async () => {
    const { service } = serviceFor({ outcome: 'claimed', claimNonce: 'n1' });
    await service.reviewApplication('owner-1', 'app-1', { decision: 'approved' });
    const payload = logSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.event).toBe('talent_marketplace.application.moderation_decision');
    expect(payload).not.toHaveProperty('request_id');
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
      response: {
        id: 'app-1',
        status: 'shortlisted',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    const res = await service.reviewApplication('owner-1', 'app-1', {
      decision: 'rejected',
    });
    // Replay returns the FIRST (approved/shortlisted) decision, not the new reject.
    expect(res.decision).toBe('approved');
    expect(res.status).toBe('shortlisted');
    expect(res.replayed).toBe(true);
    // The note + actor + timestamp round-trip through the ledger on replay so
    // the replay response shares the same shape as the first decision.
    expect(res.note).toBe('approved with a note');
    expect(res.decided_by).toBe('owner-1');
    expect(res.decided_at).toBe(NOW.toISOString());
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('emits the audit event with replayed=true on a replay', async () => {
    const { service } = serviceFor({
      outcome: 'replay',
      response: {
        id: 'app-1',
        status: 'shortlisted',
        decision: 'approved',
        note: 'approved with a note',
        decided_by: 'owner-1',
        decided_at: NOW.toISOString(),
      },
    });
    await service.reviewApplication('owner-1', 'app-1', { decision: 'rejected' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_marketplace.application.moderation_decision',
        owner_id: 'owner-1',
        application_id: 'app-1',
        decision: 'approved',
        note: 'approved with a note',
        replayed: true,
        result_status: 'shortlisted',
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
      service.reviewApplication('owner-1', 'app-1', { decision: 'rejected' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The claim is released so a same-key retry can replay rather than wedge.
    expect(releaseClaim).toHaveBeenCalled();
  });

  it('surfaces an in_flight concurrent review as a typed conflict', async () => {
    const { service } = serviceFor({ outcome: 'in_flight' });
    await expect(
      service.reviewApplication('owner-1', 'app-1', { decision: 'approved' }),
    ).rejects.toMatchObject({ response: { code: 'review_in_flight' } });
  });
});
