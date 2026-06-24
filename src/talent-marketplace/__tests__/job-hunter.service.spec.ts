import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobHunterService } from '../job-hunter.service';
import { buildTupleCursor, parseTupleCursor } from '../application-cursor';
import { PrismaService } from '../../prisma.service';

// Minimal Prisma double — only the methods JobHunterService touches, assembled
// onto a real PrismaService prototype so the value stays structurally a
// PrismaService without any forbidden double cast.
interface PrismaDouble {
  application: { findMany: jest.Mock };
  applicant: { findUnique: jest.Mock; update: jest.Mock };
}

function makeService(): { prisma: PrismaDouble; service: JobHunterService } {
  const delegates: PrismaDouble = {
    application: { findMany: jest.fn() },
    applicant: { findUnique: jest.fn(), update: jest.fn() },
  };
  const prisma = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    delegates,
  );
  return { prisma: delegates, service: new JobHunterService(prisma) };
}

const row = (id: string, created: string) => ({
  id,
  listing_id: `l-${id}`,
  status: 'submitted',
  cover_note: null,
  created_at: new Date(created),
});

describe('JobHunterService', () => {
  let prisma: PrismaDouble;
  let service: JobHunterService;
  beforeEach(() => ({ prisma, service } = makeService()));

  describe('myApplications — keyset cursor invariants', () => {
    it('scopes the query to the caller (applicant_user_id = self)', async () => {
      prisma.application.findMany.mockResolvedValue([]);
      await service.myApplications('me', {});
      const arg = prisma.application.findMany.mock.calls[0][0];
      expect(arg.where.applicant_user_id).toBe('me');
      expect(arg.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    });

    it('returns next_cursor only when a full+1 page is fetched, and it round-trips', async () => {
      // limit 2 → service fetches 3; the 3rd signals hasMore.
      prisma.application.findMany.mockResolvedValue([
        row('a', '2026-01-03T00:00:00.000Z'),
        row('b', '2026-01-02T00:00:00.000Z'),
        row('c', '2026-01-01T00:00:00.000Z'),
      ]);
      const res = await service.myApplications('me', { limit: 2 });
      expect(res.items).toHaveLength(2);
      expect(res.next_cursor).not.toBeNull();
      const decoded = parseTupleCursor(res.next_cursor as string);
      expect(decoded?.id).toBe('b');
    });

    it('returns a null cursor on the last page', async () => {
      prisma.application.findMany.mockResolvedValue([
        row('a', '2026-01-03T00:00:00.000Z'),
      ]);
      const res = await service.myApplications('me', { limit: 2 });
      expect(res.next_cursor).toBeNull();
    });

    it('returns an empty page shape when the applicant owns no applications (B-P1-6)', async () => {
      prisma.application.findMany.mockResolvedValue([]);
      const res = await service.myApplications('me', {});
      expect(res).toEqual({ items: [], next_cursor: null });
    });

    it('degrades a malformed cursor to page 1 (no OR clause) (B-P1-4)', async () => {
      prisma.application.findMany.mockResolvedValue([]);
      await service.myApplications('me', { cursor: 'not-a-cursor' });
      const arg = prisma.application.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ applicant_user_id: 'me' });
      expect(arg.where.OR).toBeUndefined();
    });

    it('applies a well-formed cursor as a keyset OR clause', async () => {
      prisma.application.findMany.mockResolvedValue([]);
      const cursor = buildTupleCursor({
        created_at: new Date('2026-01-02T00:00:00.000Z'),
        id: 'b',
      });
      await service.myApplications('me', { cursor });
      const arg = prisma.application.findMany.mock.calls[0][0];
      expect(arg.where.applicant_user_id).toBe('me');
      expect(Array.isArray(arg.where.OR)).toBe(true);
    });

    it('marks terminal statuses', async () => {
      prisma.application.findMany.mockResolvedValue([
        { ...row('a', '2026-01-03T00:00:00.000Z'), status: 'placed' },
      ]);
      const res = await service.myApplications('me', {});
      expect(res.items[0].is_terminal).toBe(true);
    });
  });

  describe('getPortfolio — projection over Applicant columns, no PII leak fields', () => {
    it('throws opaque 404 when no profile exists', async () => {
      prisma.applicant.findUnique.mockResolvedValue(null);
      await expect(service.getPortfolio('me')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('maps headline/bio/specialties/sample to the showcase shape', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: 'Coach',
        bio: 'about',
        specialties: ['Strength'],
        sample_program_url: 'https://x.com/p',
      });
      const p = await service.getPortfolio('me');
      // No intro_video_url key — the phantom field was removed from the
      // contract; it does not exist on TM-9a (A-P0-1 / B-P0-1).
      expect(p).toEqual({
        headline: 'Coach',
        about: 'about',
        specialties: ['Strength'],
        sample_program_urls: ['https://x.com/p'],
      });
    });
  });

  describe('updatePortfolio — URL validation + null/clear semantics', () => {
    const updated = {
      headline: null,
      bio: null,
      specialties: [],
      sample_program_url: null,
    };

    it('rejects a base64 blob sample program', async () => {
      await expect(
        service.updatePortfolio('me', {
          sample_program_urls: ['data:x;base64,AAAA'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an over-cap sample-program list rather than silently truncating (P2-1)', async () => {
      await expect(
        service.updatePortfolio('me', {
          sample_program_urls: ['https://x.com/a', 'https://x.com/b'],
        }),
      ).rejects.toMatchObject({
        response: { code: 'too_many_sample_urls' },
      });
      expect(prisma.applicant.update).not.toHaveBeenCalled();
    });

    it('writes valid fields via a single update+select and maps the result', async () => {
      prisma.applicant.update.mockResolvedValue({ ...updated, headline: 'Coach' });
      const res = await service.updatePortfolio('me', { headline: 'Coach' });
      // Single read: update carries the projection; no upfront findUnique (B-P1-3).
      expect(prisma.applicant.findUnique).not.toHaveBeenCalled();
      const arg = prisma.applicant.update.mock.calls[0][0];
      expect(arg.where).toEqual({ user_id: 'me' });
      expect(arg.data).toEqual({ headline: 'Coach' });
      expect(arg.select).toMatchObject({
        headline: true,
        bio: true,
        specialties: true,
        sample_program_url: true,
      });
      expect(res.headline).toBe('Coach');
    });

    it('maps a Prisma P2025 (row vanished) to the opaque 404 (B-P1-3)', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError('missing', {
        code: 'P2025',
        clientVersion: 'test',
      });
      prisma.applicant.update.mockRejectedValue(p2025);
      await expect(
        service.updatePortfolio('me', { headline: 'Coach' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('clears headline with an explicit null (B-P1-5)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', { headline: null });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        headline: null,
      });
    });

    it('clears about → bio with an explicit null (B-P1-5)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', { about: null });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        bio: null,
      });
    });

    it('clears specialties to [] when sent explicit null (B-P0-2)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', { specialties: null });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        specialties: [],
      });
    });

    it('clears the sample URL when sent explicit null (B-P0-2)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', { sample_program_urls: null });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        sample_program_url: null,
      });
    });

    it('clears the sample URL when sent an empty list (B-P2-1)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', { sample_program_urls: [] });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        sample_program_url: null,
      });
    });

    it('trims, drops empties, and dedupes specialties (A-P1-1)', async () => {
      prisma.applicant.update.mockResolvedValue(updated);
      await service.updatePortfolio('me', {
        specialties: ['', '  ', 'Strength', 'Strength'],
      });
      expect(prisma.applicant.update.mock.calls[0][0].data).toEqual({
        specialties: ['Strength'],
      });
    });
  });

  describe('profileStrength — deterministic', () => {
    it('scores 100 with all fields filled, no nudges', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: 'h',
        bio: 'b',
        specialties: ['s'],
        sample_program_url: 'https://x.com',
      });
      const r = await service.profileStrength('me');
      expect(r.score).toBe(100);
      expect(r.nudges).toEqual([]);
    });

    it('scores 0 with an empty profile and emits whitelisted nudges only', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: null,
        bio: null,
        specialties: [],
        sample_program_url: null,
      });
      const r = await service.profileStrength('me');
      expect(r.score).toBe(0);
      expect(r.nudges.map((n) => n.kind)).toEqual([
        'add_headline',
        'add_bio',
        'add_specialties',
        'add_sample',
      ]);
    });

    it('is deterministic across calls', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: 'h',
        bio: null,
        specialties: ['s'],
        sample_program_url: null,
      });
      const a = await service.profileStrength('me');
      const b = await service.profileStrength('me');
      expect(a).toEqual(b);
      expect(a.score).toBe(50);
    });

    it('scores 25 with exactly one field filled (B-P2-4)', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: 'h',
        bio: null,
        specialties: [],
        sample_program_url: null,
      });
      const r = await service.profileStrength('me');
      expect(r.score).toBe(25);
    });

    it('scores 75 with exactly three fields filled (B-P2-4)', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: 'h',
        bio: 'b',
        specialties: ['s'],
        sample_program_url: null,
      });
      const r = await service.profileStrength('me');
      expect(r.score).toBe(75);
    });

    it('does not credit a whitespace-only specialty (A-P1-1)', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        headline: null,
        bio: null,
        specialties: [''],
        sample_program_url: null,
      });
      const r = await service.profileStrength('me');
      expect(r.score).toBe(0);
      expect(r.nudges.map((n) => n.kind)).toContain('add_specialties');
    });
  });
});
