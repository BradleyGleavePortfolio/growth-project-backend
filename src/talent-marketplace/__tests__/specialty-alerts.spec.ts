import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { SpecialtyAlertsService } from '../specialty-alerts.service';
import { JobHunterService } from '../job-hunter.service';
import { AlertPreferencesDto } from '../specialty-alerts.dto';
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
    const result = await service.listForApplicant('u1');
    expect(result).toEqual({ items: [], next_cursor: null });
    expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
  });

  // P1-4: a legacy/out-of-band row holding only blanks must short-circuit to no
  // alerts — never an `IN ['']` term that matches a blank-specialty listing.
  it('returns no alerts when stored specialties are all blank', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['', '  '] });
    const result = await service.listForApplicant('u1');
    expect(result).toEqual({ items: [], next_cursor: null });
    expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
  });

  it('returns no alerts when the applicant row is missing', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue(null);
    const result = await service.listForApplicant('u1');
    expect(result).toEqual({ items: [], next_cursor: null });
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

    const result = await service.listForApplicant('u1');

    const where = prisma.jobListing.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('published');
    expect(where.specialty).toEqual({ in: ['Strength', 'Mobility'] });
    // P1-2: null-published rows are filtered at the query, never sorted ahead.
    expect(where.published_at).toEqual({ not: null });

    expect(result.items).toEqual([
      {
        listing_id: 'listing-1',
        title: 'Head Strength Coach',
        specialty: 'Strength',
        location: 'Remote',
        published_at: '2026-06-18T04:41:00.000Z',
      },
    ]);
    expect(result.next_cursor).toBeNull();

    // P2-3: pin the exact card shape (no hirer/applicant PII keys) and the exact
    // no-overfetch Prisma select — stronger than a substring scan, which could
    // false-pass on a benign value or miss a future over-selected column.
    const items = result.items;
    expect(Object.keys(items[0]).sort()).toEqual(
      ['listing_id', 'location', 'published_at', 'specialty', 'title'].sort(),
    );
    expect(prisma.jobListing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          title: true,
          specialty: true,
          location: true,
          published_at: true,
        },
      }),
    );
  });

  // P1-1: when more than a page matches, the overflow row is sliced off and a
  // next_cursor is emitted; supplying it as the cursor opens the keyset window.
  it('paginates with a keyset cursor and resumes on page 2', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength'] });
    // 21 rows (LIMIT + 1) → page 1 returns 20 items + a next_cursor.
    const page1 = Array.from({ length: 21 }, (_, i) => ({
      id: `l${i}`,
      title: `T${i}`,
      specialty: 'Strength',
      location: null,
      published_at: new Date(Date.UTC(2026, 5, 20, 0, 0, 21 - i)),
    }));
    prisma.jobListing.findMany.mockResolvedValueOnce(page1);

    const r1 = await service.listForApplicant('u1');
    expect(r1.items).toHaveLength(20);
    expect(r1.next_cursor).toEqual(expect.any(String));
    expect(prisma.jobListing.findMany.mock.calls[0][0].take).toBe(21);

    // Page 2: passing the cursor adds the OR keyset window to the where clause.
    prisma.jobListing.findMany.mockResolvedValueOnce([
      {
        id: 'l20',
        title: 'T20',
        specialty: 'Strength',
        location: null,
        published_at: new Date('2026-06-19T00:00:00.000Z'),
      },
    ]);
    const r2 = await service.listForApplicant('u1', r1.next_cursor as string);
    expect(r2.items).toHaveLength(1);
    expect(r2.next_cursor).toBeNull();
    const where2 = prisma.jobListing.findMany.mock.calls[1][0].where;
    expect(where2.OR).toHaveLength(2);
  });

  // P1-2 (was P3-1): a null-published row never reaches mapping because the
  // query filters `published_at: { not: null }`. The publish paths invariant-set
  // published_at on status change, so this is defense in depth against the
  // schema's nullable column; the feed only ever carries real timestamps.
  it('filters null-published listings at the query (feed carries real timestamps)', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Strength'] });
    prisma.jobListing.findMany.mockResolvedValue([
      {
        id: 'l2',
        title: 'T',
        specialty: 'Strength',
        location: null,
        published_at: new Date('2026-06-18T04:41:00.000Z'),
      },
    ]);
    const result = await service.listForApplicant('u1');
    expect(prisma.jobListing.findMany.mock.calls[0][0].where.published_at).toEqual({
      not: null,
    });
    expect(result.items[0].published_at).toBe('2026-06-18T04:41:00.000Z');
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

// P1-4 (read-path defense): blank members stored alongside real specialties must
// be trimmed out of the `IN` list so a blank-specialty listing can never match.
describe('SpecialtyAlertsService.listForApplicant — blank-specialty read defense', () => {
  it('drops blank stored specialties from the IN filter', async () => {
    const { prisma, service } = makeService();
    prisma.applicant.findUnique.mockResolvedValue({
      specialties: ['', '  ', 'Strength', '  Mobility  '],
    });
    prisma.jobListing.findMany.mockResolvedValue([]);

    await service.listForApplicant('u1');

    // Only the trimmed, non-blank specialties reach Prisma — never '' or '  '.
    expect(prisma.jobListing.findMany.mock.calls[0][0].where.specialty).toEqual({
      in: ['Strength', 'Mobility'],
    });
  });
});

// P1-5: cross-surface integrity. The Applicant.specialties column is the single
// source of truth for both the alerts writer and the portfolio reader. Writing
// dirty prefs via SpecialtyAlertsService.savePreferences must leave the column
// canonical, so JobHunterService.getPortfolio sees the cleaned set — proving the
// two surfaces share one normalization (the whole point of the shared helper).
describe('cross-surface integrity — alerts write, portfolio read see the same canonical set', () => {
  it('savePreferences cleans the column so getPortfolio returns the canonical set', async () => {
    // One shared in-memory Applicant row, backing a Prisma double both services use.
    const store: {
      headline: string | null;
      bio: string | null;
      specialties: string[];
      sample_program_url: string | null;
    } = { headline: null, bio: null, specialties: [], sample_program_url: null };

    const applicant = {
      findUnique: jest.fn(async () => ({ ...store })),
      update: jest.fn(async ({ data }: { data: { specialties?: string[] } }) => {
        if (data.specialties !== undefined) store.specialties = data.specialties;
        return { ...store };
      }),
    };
    const delegates = {
      applicant,
      jobListing: { findMany: jest.fn() },
      application: { findMany: jest.fn() },
    };
    const prisma = Object.assign(
      Object.create(PrismaService.prototype) as PrismaService,
      delegates,
    );
    const alerts = new SpecialtyAlertsService(prisma);
    const jobHunter = new JobHunterService(prisma);

    // Write a deliberately dirty array through the alerts surface.
    const saved = await alerts.savePreferences('u1', ['', '  ', 'Strength', 'Strength']);
    expect(saved).toEqual({ specialties: ['Strength'] });

    // The portfolio reader sees the SAME canonical column — no blanks/dupes.
    const portfolio = await jobHunter.getPortfolio('u1');
    expect(portfolio.specialties).toEqual(['Strength']);
  });
});

// P1-3 / P3 (DTO boundary): the production ValidationPipe is the public entry
// point. Prove the 21+ specialty cap rejects with a 400 and that null/[]/omitted
// pass validation (clear/read semantics) the way the service expects.
describe('AlertPreferencesDto — production ValidationPipe boundary', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const meta: ArgumentMetadata = {
    type: 'body',
    metatype: AlertPreferencesDto,
    data: '',
  };

  it('rejects 21+ specialties with a 400', async () => {
    await expect(
      pipe.transform({ specialties: Array(21).fill('x') }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-array specialties value (e.g. number)', async () => {
    await expect(pipe.transform({ specialties: 5 }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts null (clear semantics)', async () => {
    await expect(pipe.transform({ specialties: null }, meta)).resolves.toEqual({
      specialties: null,
    });
  });

  it('accepts an empty body (read-current semantics)', async () => {
    await expect(pipe.transform({}, meta)).resolves.toEqual({});
  });

  it('accepts a valid 20-element list', async () => {
    const list = Array.from({ length: 20 }, (_, i) => `s${i}`);
    await expect(pipe.transform({ specialties: list }, meta)).resolves.toEqual({
      specialties: list,
    });
  });
});
