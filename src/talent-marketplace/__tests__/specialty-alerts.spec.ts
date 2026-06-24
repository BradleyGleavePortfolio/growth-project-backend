import { NotFoundException } from '@nestjs/common';
import { SpecialtyAlertsService } from '../specialty-alerts.service';
import { PrismaService } from '../../prisma.service';

// TM-9b — specialty alerts are owner-scoped and PII-free. Invariants:
//   1. MATCH — only published listings whose specialty ∈ the applicant's saved
//      specialties surface; empty specialties → no alerts (never the whole board).
//   2. PII-FREE — alert cards carry public listing fields only.
//   3. SAVE GUARD — savePreferences on a student with NO Applicant row returns a
//      clean 404 `applicant_not_found` envelope, never a raw Prisma 500 (P1-1).

// Minimal Prisma double — only the delegates the service touches, assembled onto
// a real PrismaService prototype so the value stays structurally a PrismaService
// without any forbidden double cast (sanctioned pattern; doctrine bans
// `as unknown as`).
interface PrismaDouble {
  applicant: { findUnique: jest.Mock; update: jest.Mock };
  jobListing: { findMany: jest.Mock };
}

function makeService(): { prisma: PrismaDouble; service: SpecialtyAlertsService } {
  const delegates: PrismaDouble = {
    applicant: { findUnique: jest.fn(), update: jest.fn() },
    jobListing: { findMany: jest.fn() },
  };
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    delegates,
  );
  return { prisma: delegates, service: new SpecialtyAlertsService(prisma) };
}

describe('SpecialtyAlertsService.listForApplicant — matched + PII-free', () => {
  it('returns no alerts when the applicant has no saved specialties', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: [] });
    const alerts = await service.listForApplicant('u1');
    expect(alerts).toEqual([]);
    expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
  });

  // P1-4: a legacy/out-of-band row holding only blanks must short-circuit to no
  // alerts — never an `IN ['']` term that matches a blank-specialty listing.
  it('returns no alerts when stored specialties are all blank', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['', '  '] });
    const alerts = await service.listForApplicant('u1');
    expect(alerts).toEqual([]);
    expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
  });

  it('returns no alerts when the applicant row is missing', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue(null);
    const alerts = await service.listForApplicant('u1');
    expect(alerts).toEqual([]);
    expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
  });

  it('queries only published listings within the saved specialties and projects public fields', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength', 'Mobility'] });
    prisma.jobListing.findMany.mockResolvedValue([
      {
        id: 'listing-1',
        title: 'Head Strength Coach',
        specialty: 'Strength',
        location: 'Remote',
        published_at: new Date('2026-06-18T04:41:00.000Z'),
      },
    ]);

    const alerts = await service.listForApplicant('u1');

    const where = prisma.jobListing.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('published');
    expect(where.specialty).toEqual({ in: ['Strength', 'Mobility'] });

    expect(alerts).toEqual([
      {
        listing_id: 'listing-1',
        title: 'Head Strength Coach',
        specialty: 'Strength',
        location: 'Remote',
        published_at: '2026-06-18T04:41:00.000Z',
      },
    ]);
    // PII-free: no hirer/applicant identity fields leak onto the card.
    expect(JSON.stringify(alerts)).not.toContain('hirer');
    expect(JSON.stringify(alerts)).not.toContain('email');
  });

  it('echoes a null published_at rather than crashing', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength'] });
    prisma.jobListing.findMany.mockResolvedValue([
      { id: 'l2', title: 'T', specialty: 'Strength', location: null, published_at: null },
    ]);
    const alerts = await service.listForApplicant('u1');
    expect(alerts[0].published_at).toBeNull();
  });
});

describe('SpecialtyAlertsService.savePreferences — guard + persist', () => {
  it('persists the supplied specialties for an existing applicant', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: [] });
    prisma.applicant.update.mockResolvedValue({ specialties: ['Strength'] });

    const res = await service.savePreferences('u1', ['Strength']);

    expect(prisma.applicant.update.mock.calls[0][0]).toMatchObject({
      where: { user_id: 'u1' },
      data: { specialties: ['Strength'] },
    });
    expect(res).toEqual({ specialties: ['Strength'] });
  });

  // P0-1: the alerts writer must canonicalize exactly like TM-9a's portfolio
  // write — trim, drop blanks, dedupe — so the shared column never dirties.
  it('normalizes a dirty array on save (trim + drop blanks + dedupe)', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: [] });
    prisma.applicant.update.mockResolvedValue({ specialties: ['Strength'] });

    const res = await service.savePreferences('u1', ['', '  ', 'Strength', 'Strength']);

    expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
      specialties: ['Strength'],
    });
    expect(res).toEqual({ specialties: ['Strength'] });
  });

  // P0-2: an explicit null body clears to [] (matches TM-9a) instead of reaching
  // Prisma as a non-null-column violation → 500.
  it('clears to [] when specialties is null', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength'] });
    prisma.applicant.update.mockResolvedValue({ specialties: [] });

    const res = await service.savePreferences('u1', null);

    expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({ specialties: [] });
    expect(res).toEqual({ specialties: [] });
  });

  it('clears to [] when specialties is an empty array', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength'] });
    prisma.applicant.update.mockResolvedValue({ specialties: [] });

    const res = await service.savePreferences('u1', []);

    expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({ specialties: [] });
    expect(res).toEqual({ specialties: [] });
  });

  it('returns the current specialties without writing when none are supplied', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Mobility'] });

    const res = await service.savePreferences('u1', undefined);

    expect(res).toEqual({ specialties: ['Mobility'] });
    expect(prisma.applicant.update).not.toHaveBeenCalled();
  });

  // P1-1 regression: a student who has never applied has no Applicant row. The
  // write must NOT reach Prisma (raw P2025 → 500); it must surface the
  // applicant_not_found 404 envelope.
  it('throws a 404 applicant_not_found envelope for a student with no Applicant row', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue(null);

    await expect(service.savePreferences('ghost', ['Strength'])).rejects.toMatchObject({
      response: { code: 'applicant_not_found', error: 'Not Found' },
    });
    await expect(service.savePreferences('ghost', ['Strength'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.applicant.update).not.toHaveBeenCalled();
  });
});
