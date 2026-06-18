import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobHunterService } from '../job-hunter.service';
import { parseTupleCursor } from '../application-cursor';
import type { PrismaService } from '../../prisma.service';

// Minimal Prisma double — only the methods JobHunterService touches.
interface PrismaDouble {
  application: { findMany: jest.Mock };
  applicant: { findUnique: jest.Mock; update: jest.Mock };
}

function makeService(): { prisma: PrismaDouble; service: JobHunterService } {
  const prisma: PrismaDouble = {
    application: { findMany: jest.fn() },
    applicant: { findUnique: jest.fn(), update: jest.fn() },
  };
  return {
    prisma,
    service: new JobHunterService(prisma as unknown as PrismaService),
  };
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
      expect(p).toEqual({
        headline: 'Coach',
        about: 'about',
        specialties: ['Strength'],
        intro_video_url: null,
        sample_program_urls: ['https://x.com/p'],
      });
    });
  });

  describe('updatePortfolio — URL validation', () => {
    const profile = {
      headline: null,
      bio: null,
      specialties: [],
      sample_program_url: null,
    };
    it('rejects a non-HTTPS intro video URL with an opaque code', async () => {
      prisma.applicant.findUnique.mockResolvedValue(profile);
      await expect(
        service.updatePortfolio('me', { intro_video_url: 'http://x.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.applicant.update).not.toHaveBeenCalled();
    });

    it('rejects a base64 blob sample program', async () => {
      prisma.applicant.findUnique.mockResolvedValue(profile);
      await expect(
        service.updatePortfolio('me', {
          sample_program_urls: ['data:x;base64,AAAA'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('writes valid fields then re-reads the portfolio', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        ...profile,
        headline: 'Coach',
      });
      prisma.applicant.update.mockResolvedValue({});
      await service.updatePortfolio('me', { headline: 'Coach' });
      expect(prisma.applicant.update).toHaveBeenCalledWith({
        where: { user_id: 'me' },
        data: { headline: 'Coach' },
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
  });
});
