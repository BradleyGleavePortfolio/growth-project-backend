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
  function serviceFor(status: string, claim: ClaimOrReplayResult, update = jest.fn()) {
    const prisma = makePrisma({
      application: {
        findFirst: jest.fn(async () => ({ id: 'app-1', status })),
        update,
      },
    });
    const idem = makeIdempotency({
      claimOrReplay: jest.fn(async () => claim),
      markCompleted: jest.fn(async () => ({ outcome: 'ok' })),
      releaseClaim: jest.fn(async () => ({ outcome: 'ok' })),
    });
    return { service: new ApplicantTrackingService(prisma, idem), update };
  }

  it('advances a valid transition and persists via Application.status', async () => {
    const update = jest.fn(async (_args: { data: { status: string } }) => ({}));
    const { service } = serviceFor('submitted', { outcome: 'claimed', claimNonce: 'n1' }, update);
    const res = await service.moveStage('hirer-1', 'app-1', 'screening');
    expect(res.stage).toBe('screening');
    expect(update.mock.calls[0][0].data.status).toBe('screening');
  });

  it('rejects an invalid transition (new → hired) with a typed conflict', async () => {
    const { service } = serviceFor('submitted', { outcome: 'claimed', claimNonce: 'n1' });
    await expect(service.moveStage('hirer-1', 'app-1', 'hired')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a move out of a terminal stage (hired → new)', async () => {
    const { service } = serviceFor('placed', { outcome: 'claimed', claimNonce: 'n1' });
    await expect(service.moveStage('hirer-1', 'app-1', 'new')).rejects.toMatchObject({
      response: { code: 'PIPELINE_STAGE_TERMINAL' },
    });
  });

  it('replays the first decision on a duplicate idempotency key without re-updating', async () => {
    const update = jest.fn(async () => ({}));
    const { service } = serviceFor('submitted', { outcome: 'replay', response: {} }, update);
    const res = await service.moveStage('hirer-1', 'app-1', 'screening', 'idem-key');
    expect(res.stage).toBe('screening');
    expect(update).not.toHaveBeenCalled();
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
