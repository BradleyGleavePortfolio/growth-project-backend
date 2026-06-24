import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import {
  MarketplaceIdempotencyService,
  type ClaimOrReplayResult,
} from '../marketplace-idempotency.service';
import { ApplicantTrackingService } from '../applicant-tracking.service';

// TM-8 — applicant-tracking service is the PII boundary + hirer-scope boundary.
// Tests assert: reads pinned to the caller hirer_id, CandidateCard carries NO
// email/phone columns, pipeline transitions (valid + invalid + terminal), and
// idempotent replay on the stage PATCH.

const NOW = new Date('2026-06-18T04:41:00.000Z');

function makePrisma(parts: Record<string, unknown>): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, parts);
}

function makeIdempotency(
  parts: Partial<Record<string, jest.Mock>>,
): MarketplaceIdempotencyService {
  return Object.assign(
    Object.create(MarketplaceIdempotencyService.prototype) as MarketplaceIdempotencyService,
    parts,
  );
}

describe('ApplicantTrackingService.listApplicants — hirer-scope + PII projection', () => {
  it('pins the query to the caller hirer_id and listing, and projects PII-stripped cards', async () => {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => [
      {
        id: 'app-1',
        applicant_id: 'cand-1',
        fit_score: 88,
        status: 'screening',
        created_at: NOW,
      },
    ]);
    const applicantFindMany = jest.fn(async () => [
      { id: 'cand-1', first_name: 'Jordan', last_name: 'Rivera', specialties: ['Strength'] },
    ]);
    const prisma = makePrisma({
      application: { findMany },
      applicant: { findMany: applicantFindMany },
    });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));

    const page = await service.listApplicants('hirer-1', 'listing-1', {});

    const where = findMany.mock.calls[0][0].where;
    expect(where.hirer_id).toBe('hirer-1');
    expect(where.listing_id).toBe('listing-1');

    const card = page.items[0];
    expect(card.first_name).toBe('Jordan');
    expect(card.last_initial).toBe('R.');
    expect(card.stage).toBe('screening');
    expect(card.fit_score).toBe(88);
    // PII allow-list: no email / phone / full last name fields present.
    expect(Object.keys(card).sort()).toEqual(
      [
        'application_id',
        'applied_at',
        'first_name',
        'fit_score',
        'last_initial',
        'specialty',
        'stage',
      ].sort(),
    );
    expect(JSON.stringify(card)).not.toContain('Rivera');
  });

  it('returns a next_cursor only when a full page + 1 is fetched', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `app-${i}`,
      applicant_id: `cand-${i}`,
      fit_score: 50,
      status: 'submitted',
      created_at: NOW,
    }));
    const prisma = makePrisma({
      application: { findMany: jest.fn(async () => rows) },
      applicant: { findMany: jest.fn(async () => []) },
    });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));
    const page = await service.listApplicants('hirer-1', 'listing-1', {});
    expect(page.items).toHaveLength(20);
    expect(page.next_cursor).not.toBeNull();
  });
});

describe('ApplicantTrackingService.getApplicantDetail — redaction + opaque 404', () => {
  it('redacts email to domain only and never returns the local part', async () => {
    const prisma = makePrisma({
      application: {
        findFirst: jest.fn(async () => ({
          id: 'app-1',
          applicant_id: 'cand-1',
          fit_score: 70,
          status: 'offered',
          created_at: NOW,
        })),
      },
      applicant: {
        findUnique: jest.fn(async () => ({
          email: 'secret.person@example.com',
          first_name: 'Sam',
          last_name: 'Okoro',
          headline: 'Coach',
          specialties: ['Mobility'],
          years_experience: 4,
        })),
      },
    });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));
    const detail = await service.getApplicantDetail('hirer-1', 'app-1');
    expect(detail.email_domain).toBe('example.com');
    expect(detail.phone_last4).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('secret.person');
    expect(JSON.stringify(detail)).not.toContain('Okoro');
  });

  it('never returns the applicant headline (raw free-text PII), even when one exists in DB', async () => {
    const prisma = makePrisma({
      application: {
        findFirst: jest.fn(async () => ({
          id: 'app-1',
          applicant_id: 'cand-1',
          fit_score: 70,
          status: 'offered',
          created_at: NOW,
        })),
      },
      applicant: {
        findUnique: jest.fn(async () => ({
          email: 'sam@example.com',
          first_name: 'Sam',
          last_name: 'Okoro',
          // A malicious/leaky headline carrying contact PII — must never cross
          // the hirer boundary (B-P0-1). headline is not in the allow-list.
          headline: 'Reach me at sam.okoro@gmail.com / 555-0100',
          specialties: ['Mobility'],
          years_experience: 4,
        })),
      },
    });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));
    const detail = await service.getApplicantDetail('hirer-1', 'app-1');
    expect(Object.keys(detail)).not.toContain('headline');
    expect(JSON.stringify(detail)).not.toContain('sam.okoro@gmail.com');
    expect(JSON.stringify(detail)).not.toContain('555-0100');
  });

  it('throws an opaque APPLICANT_NOT_FOUND for a non-owned application', async () => {
    const prisma = makePrisma({
      application: { findFirst: jest.fn(async () => null) },
      applicant: { findUnique: jest.fn() },
    });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));
    await expect(service.getApplicantDetail('hirer-1', 'app-x')).rejects.toMatchObject({
      response: { code: 'APPLICANT_NOT_FOUND' },
    });
    await expect(service.getApplicantDetail('hirer-1', 'app-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ApplicantTrackingService.moveStage — transitions + idempotency', () => {
  // Default helper: a `claimed` outcome with a configurable status, an
  // updateMany returning count:1, and ok markCompleted/releaseClaim. Exposes the
  // mocks so individual tests can assert call counts and where-clauses.
  function serviceFor(
    status: string,
    claim: ClaimOrReplayResult,
    opts: {
      updateMany?: jest.Mock;
      markCompleted?: jest.Mock;
      releaseClaim?: jest.Mock;
    } = {},
  ) {
    const updateMany =
      opts.updateMany ?? jest.fn(async () => ({ count: 1 }));
    const markCompleted =
      opts.markCompleted ?? jest.fn(async () => ({ outcome: 'ok' }));
    const releaseClaim =
      opts.releaseClaim ?? jest.fn(async () => ({ outcome: 'ok' }));
    const prisma = makePrisma({
      application: {
        findFirst: jest.fn(async () => ({ id: 'app-1', status })),
        updateMany,
      },
    });
    const idem = makeIdempotency({
      claimOrReplay: jest.fn(async () => claim),
      markCompleted,
      releaseClaim,
    });
    return {
      service: new ApplicantTrackingService(prisma, idem),
      updateMany,
      markCompleted,
      releaseClaim,
    };
  }

  it('advances a valid transition via an atomic hirer-scoped compare-and-set', async () => {
    const { service, updateMany } = serviceFor('submitted', {
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    const res = await service.moveStage('hirer-1', 'app-1', 'screening');
    expect(res.stage).toBe('screening');
    const args = updateMany.mock.calls[0][0];
    // CAS guard + defense-in-depth: the write is pinned to id + hirer_id + the
    // previously-read status, and sets the mapped persisted status.
    expect(args.where.id).toBe('app-1');
    expect(args.where.hirer_id).toBe('hirer-1');
    expect(args.where.status).toBe('submitted');
    expect(args.data.status).toBe('screening');
  });

  it('rejects an invalid transition (new → hired) with a typed conflict', async () => {
    const { service, updateMany } = serviceFor('submitted', {
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await expect(service.moveStage('hirer-1', 'app-1', 'hired')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a move out of a terminal stage (hired → new)', async () => {
    const { service, updateMany } = serviceFor('placed', {
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await expect(service.moveStage('hirer-1', 'app-1', 'new')).rejects.toMatchObject({
      response: { code: 'PIPELINE_STAGE_TERMINAL' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses to resurrect a withdrawn applicant (PIPELINE_STAGE_IMMUTABLE, no write)', async () => {
    // withdrawn has no pipeline representation: moveStage must reject rather
    // than coerce it to `new` and pull the applicant back into the pipeline
    // (A-P0-1 / B-P1-1).
    const { service, updateMany, markCompleted } = serviceFor('withdrawn', {
      outcome: 'claimed',
      claimNonce: 'n1',
    });
    await expect(service.moveStage('hirer-1', 'app-1', 'screening')).rejects.toMatchObject({
      response: { code: 'PIPELINE_STAGE_IMMUTABLE' },
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('treats a compare-and-set miss (count:0) as a stale conflict and releases the claim', async () => {
    // A concurrent move changed the row between our read and our write: the
    // CAS where-clause matches zero rows. Surface PIPELINE_STAGE_STALE (NOT a
    // 404 — ownership was verified) and release the claim (B-P1-2 / A-P2-1).
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const releaseClaim = jest.fn(async () => ({ outcome: 'ok' }));
    const { service } = serviceFor(
      'submitted',
      { outcome: 'claimed', claimNonce: 'n1' },
      { updateMany, releaseClaim },
    );
    await expect(service.moveStage('hirer-1', 'app-1', 'screening')).rejects.toMatchObject({
      response: { code: 'PIPELINE_STAGE_STALE' },
    });
    expect(releaseClaim).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
      'n1',
    );
  });

  it('returns the STORED ledger response on replay, ignoring the request target', async () => {
    // B-P3-1 / A-P1-1 / B-P2-1: a reused idempotency key replays the FIRST
    // decision verbatim. The stored stage was `interview`; this call requests
    // `screening` but must get back `interview` with NO write.
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const markCompleted = jest.fn(async () => ({ outcome: 'ok' }));
    const releaseClaim = jest.fn(async () => ({ outcome: 'ok' }));
    const { service } = serviceFor(
      'shortlisted',
      {
        outcome: 'replay',
        response: { application_id: 'app-7', stage: 'interview' },
      },
      { updateMany, markCompleted, releaseClaim },
    );
    const res = await service.moveStage('hirer-1', 'app-1', 'screening', 'idem-key');
    expect(res.stage).toBe('interview');
    expect(res.application_id).toBe('app-7');
    expect(updateMany).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('replays the stored success after a terminal move instead of 409 (retry-after-terminal)', async () => {
    // B-P2-2: the original move landed the applicant on `passed` (terminal) and
    // completed the ledger. A legitimate retry with the same key replays the
    // stored response rather than tripping the now-terminal status gate.
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const { service } = serviceFor(
      'rejected', // persisted status corresponding to the terminal `passed`
      {
        outcome: 'replay',
        response: { application_id: 'app-1', stage: 'passed' },
      },
      { updateMany },
    );
    const res = await service.moveStage('hirer-1', 'app-1', 'passed', 'idem-key');
    expect(res.stage).toBe('passed');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('throws STAGE_LEDGER_CORRUPT when the stored replay response is malformed', async () => {
    const { service } = serviceFor('submitted', {
      outcome: 'replay',
      response: {},
    });
    await expect(service.moveStage('hirer-1', 'app-1', 'screening', 'idem-key')).rejects.toMatchObject({
      response: { code: 'STAGE_LEDGER_CORRUPT' },
    });
  });

  it('surfaces STAGE_CHANGE_IN_FLIGHT on an in-flight claim and never writes', async () => {
    // A-P2-2: a sibling request owns this key right now.
    const { service, updateMany } = serviceFor('submitted', {
      outcome: 'in_flight',
    });
    await expect(service.moveStage('hirer-1', 'app-1', 'screening')).rejects.toMatchObject({
      response: { code: 'STAGE_CHANGE_IN_FLIGHT' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('releases the claim exactly once and rethrows when the write fails', async () => {
    // A-P2-2: on a genuine mutation failure, releaseClaim(claimKey, nonce) runs
    // once and the original error propagates.
    const boom = new Error('db down');
    const updateMany = jest.fn(async () => {
      throw boom;
    });
    const releaseClaim = jest.fn(async () => ({ outcome: 'ok' }));
    const { service } = serviceFor(
      'submitted',
      { outcome: 'claimed', claimNonce: 'n1' },
      { updateMany, releaseClaim },
    );
    await expect(service.moveStage('hirer-1', 'app-1', 'screening')).rejects.toBe(boom);
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(releaseClaim).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
      'n1',
    );
  });

  it('opaque 404 for a stage move on a non-owned application', async () => {
    const prisma = makePrisma({ application: { findFirst: jest.fn(async () => null) } });
    const service = new ApplicantTrackingService(prisma, makeIdempotency({}));
    await expect(service.moveStage('hirer-1', 'ghost', 'screening')).rejects.toMatchObject({
      response: { code: 'APPLICANT_NOT_FOUND' },
    });
  });
});

describe('ApplicantTrackingService — 8b deferrals surface 501', () => {
  it('appendNote and toggleShortlist throw NotImplemented (no faked storage)', () => {
    const service = new ApplicantTrackingService(makePrisma({}), makeIdempotency({}));
    expect(() => service.appendNote()).toThrow();
    expect(() => service.toggleShortlist()).toThrow();
  });
});
