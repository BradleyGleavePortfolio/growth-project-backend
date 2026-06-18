// TM-9 — Specialty-matched listing alerts.
//
// Deterministic match: surface recently-published listings whose specialty
// intersects the applicant's saved specialties (the Applicant.specialties
// column — no new schema). Optional coarse location filter. The payload is
// public-listing fields ONLY (title/specialty/location/published_at) — never any
// hirer or applicant PII, and nothing is logged.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ListingAlertDto } from './job-hunter.dto';

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
    if (specialties === undefined) {
      const current = await this.prisma.applicant.findUnique({
        where: { user_id: userId },
        select: { specialties: true },
      });
      return { specialties: current?.specialties ?? [] };
    }
    const updated = await this.prisma.applicant.update({
      where: { user_id: userId },
      data: { specialties },
      select: { specialties: true },
    });
    return { specialties: updated.specialties };
  }
}
