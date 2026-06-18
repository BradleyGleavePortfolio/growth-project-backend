// TM-9b — Specialty-matched listing alerts.
//
// Deterministic match: surface recently-published listings whose specialty
// intersects the applicant's saved specialties (the Applicant.specialties
// column — no new schema). The payload is public-listing fields ONLY
// (title/specialty/location/published_at) — never any hirer or applicant PII,
// and nothing is logged.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ListingAlertDto } from './specialty-alerts.dto';

const ALERT_LISTING_LIMIT = 20;

@Injectable()
export class SpecialtyAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  // List recent published listings matching the applicant's saved specialties.
  // Empty specialties → no alerts (we never fan out the whole board as "alerts").
  async listForApplicant(userId: string): Promise<ListingAlertDto[]> {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
      select: { specialties: true },
    });
    const specialties = applicant?.specialties ?? [];
    if (specialties.length === 0) return [];

    const rows = await this.prisma.jobListing.findMany({
      where: { status: 'published', specialty: { in: specialties } },
      orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
      take: ALERT_LISTING_LIMIT,
      select: {
        id: true,
        title: true,
        specialty: true,
        location: true,
        published_at: true,
      },
    });

    return rows.map((row) => ({
      listing_id: row.id,
      title: row.title,
      specialty: row.specialty,
      location: row.location,
      published_at: row.published_at ? row.published_at.toISOString() : null,
    }));
  }

  // Save alert preferences. With no dedicated preferences table, the applicant's
  // own specialties column IS the saved preference (single source of truth for
  // both profile + alert matching). Returns the persisted specialty set.
  async savePreferences(
    userId: string,
    specialties: string[] | undefined,
  ): Promise<{ specialties: string[] }> {
    // Applicant rows exist only post-Apply; a student who has never applied has
    // none. Guard first so a missing row is a clean 404 envelope rather than a
    // raw Prisma P2025 → generic 500 (Lens A P1-1).
    const applicant = await this.requireApplicant(userId);
    if (specialties === undefined) {
      return { specialties: applicant.specialties };
    }
    const updated = await this.prisma.applicant.update({
      where: { user_id: userId },
      data: { specialties },
      select: { specialties: true },
    });
    return { specialties: updated.specialties };
  }

  private async requireApplicant(userId: string): Promise<{ specialties: string[] }> {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
      select: { specialties: true },
    });
    if (!applicant) {
      throw new NotFoundException({
        error: 'Not Found',
        message: 'Applicant profile not found',
        code: 'applicant_not_found',
      });
    }
    return applicant;
  }
}
