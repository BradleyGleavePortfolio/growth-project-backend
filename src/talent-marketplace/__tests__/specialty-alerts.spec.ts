import { SpecialtyAlertsService } from '../specialty-alerts.service';
import type { PrismaService } from '../../prisma.service';

interface PrismaDouble {
  applicant: { findUnique: jest.Mock; update: jest.Mock };
  jobListing: { findMany: jest.Mock };
}

function makeService() {
  const prisma: PrismaDouble = {
    applicant: { findUnique: jest.fn(), update: jest.fn() },
    jobListing: { findMany: jest.fn() },
  };
  return {
    prisma,
    service: new SpecialtyAlertsService(prisma as unknown as PrismaService),
  };
}

describe('SpecialtyAlertsService', () => {
  let prisma: PrismaDouble;
  let service: SpecialtyAlertsService;
  beforeEach(() => ({ prisma, service } = makeService()));

  describe('listForApplicant — deterministic specialty match', () => {
    it('returns no alerts when the applicant has no specialties', async () => {
      prisma.applicant.findUnique.mockResolvedValue({ specialties: [] });
      const res = await service.listForApplicant('me');
      expect(res).toEqual([]);
      expect(prisma.jobListing.findMany).not.toHaveBeenCalled();
    });

    it('queries published listings matching saved specialties', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        specialties: ['Strength', 'Nutrition'],
      });
      prisma.jobListing.findMany.mockResolvedValue([]);
      await service.listForApplicant('me');
      const arg = prisma.jobListing.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({
        status: 'published',
        specialty: { in: ['Strength', 'Nutrition'] },
      });
    });

    it('projects ONLY public listing fields — no hirer/applicant PII', async () => {
      prisma.applicant.findUnique.mockResolvedValue({
        specialties: ['Strength'],
      });
      prisma.jobListing.findMany.mockResolvedValue([
        {
          id: 'l1',
          title: 'Coach',
          specialty: 'Strength',
          location: 'Remote',
          published_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      const res = await service.listForApplicant('me');
      expect(res).toEqual([
        {
          listing_id: 'l1',
          title: 'Coach',
          specialty: 'Strength',
          location: 'Remote',
          published_at: '2026-01-01T00:00:00.000Z',
        },
      ]);
      // No email/phone/hirer_id keys present in the payload.
      expect(Object.keys(res[0])).toEqual([
        'listing_id',
        'title',
        'specialty',
        'location',
        'published_at',
      ]);
    });
  });

  describe('savePreferences', () => {
    it('persists specialties to the applicant column', async () => {
      prisma.applicant.update.mockResolvedValue({ specialties: ['Strength'] });
      const res = await service.savePreferences('me', ['Strength']);
      expect(prisma.applicant.update).toHaveBeenCalledWith({
        where: { user_id: 'me' },
        data: { specialties: ['Strength'] },
        select: { specialties: true },
      });
      expect(res).toEqual({ specialties: ['Strength'] });
    });

    it('reads current specialties when none supplied', async () => {
      prisma.applicant.findUnique.mockResolvedValue({ specialties: ['Nutrition'] });
      const res = await service.savePreferences('me', undefined);
      expect(prisma.applicant.update).not.toHaveBeenCalled();
      expect(res).toEqual({ specialties: ['Nutrition'] });
    });
  });
});
