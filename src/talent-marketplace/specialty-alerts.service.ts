// TM-9b — Specialty-matched listing alerts.
//
// Deterministic match: surface recently-published listings whose specialty
// intersects the applicant's saved specialties (the Applicant.specialties
// column — no new schema). The payload is public-listing fields ONLY
// (title/specialty/location/published_at) — never any hirer or applicant PII,
// and nothing is logged.

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { buildAlertCursor, parseAlertCursor } from './alert-cursor';
import { normalizeSpecialties } from './specialties';
import type { AlertsListResponseDto } from './specialty-alerts.dto';

const ALERT_LISTING_LIMIT = 20;

@Injectable()
export class SpecialtyAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  // List recent published listings matching the applicant's saved specialties.
  // Empty specialties → no alerts (we never fan out the whole board as "alerts").
  // Keyset-paginated on (published_at, id), newest-first, in pages of
  // ALERT_LISTING_LIMIT; returns an envelope with next_cursor (P1-1, P2-4).
  async listForApplicant(
    userId: string,
    cursor?: string,
  ): Promise<AlertsListResponseDto> {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
      select: { specialties: true },
    });
    // Defense in depth: even though savePreferences normalizes on write, a
    // legacy or out-of-band row could hold blanks. Trim + drop empties so a
    // stored [''] never becomes an `IN ['']` term that matches a listing with a
    // blank specialty (P1-4); short-circuit to no alerts when nothing is left.
    const queryable = (applicant?.specialties ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (queryable.length === 0) return { items: [], next_cursor: null };

    // `published_at: { not: null }` is defensive against the schema's nullable
    // column: Postgres DESC puts nulls first, so an un-timestamped published row
    // could otherwise displace genuinely-recent matches under the page cap, and
    // it keeps the keyset cursor's published_at always real (P1-2).
    const where: Prisma.JobListingWhereInput = {
      status: 'published',
      specialty: { in: queryable },
      published_at: { not: null },
    };
    // Keyset window: rows strictly older than the cursor tuple (published_at, id).
    // A malformed cursor parses to null → we silently restart at page 1.
    const decoded = cursor ? parseAlertCursor(cursor) : null;
    if (decoded) {
      where.OR = [
        { published_at: { lt: decoded.published_at } },
        { published_at: decoded.published_at, id: { lt: decoded.id } },
      ];
    }

    const rows = await this.prisma.jobListing.findMany({
      where,
      orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
      take: ALERT_LISTING_LIMIT + 1,
      select: {
        id: true,
        title: true,
        specialty: true,
        location: true,
        published_at: true,
      },
    });

    const hasMore = rows.length > ALERT_LISTING_LIMIT;
    const page = hasMore ? rows.slice(0, ALERT_LISTING_LIMIT) : rows;
    const items = page.map((row) => ({
      listing_id: row.id,
      title: row.title,
      specialty: row.specialty,
      location: row.location,
      // Non-null by the `published_at: { not: null }` filter; coalesce only to
      // satisfy the nullable column type without a cast.
      published_at: (row.published_at ?? new Date(0)).toISOString(),
    }));

    const last = page[page.length - 1];
    const next_cursor =
      hasMore && last && last.published_at
        ? buildAlertCursor({ published_at: last.published_at, id: last.id })
        : null;
    return { items, next_cursor };
  }

  // Save alert preferences. With no dedicated preferences table, the applicant's
  // own specialties column IS the saved preference (single source of truth for
  // both profile + alert matching). Returns the persisted specialty set.
  //
  // POST replaces the saved specialties when a list is provided (use [] or null
  // to clear; an omitted body returns the current set without writing). The
  // write is a full replace, not a merge, and routes through the shared
  // normalizeSpecialties so the column stays canonical across both writers
  // (P0-1, P0-2, P1-3).
  async savePreferences(
    userId: string,
    specialties: string[] | null | undefined,
  ): Promise<{ specialties: string[] }> {
    // Applicant rows exist only post-Apply; a student who has never applied has
    // none. Guard first so a missing row is a clean 404 envelope rather than a
    // raw Prisma P2025 → generic 500 (Lens A P1-1).
    const applicant = await this.requireApplicant(userId);
    if (specialties === undefined) {
      return { specialties: applicant.specialties };
    }
    // null/[]/dirty arrays all canonicalize here: null → [], blanks dropped,
    // duplicates deduped — matching TM-9a's portfolio write (P0-1, P0-2).
    const updated = await this.prisma.applicant.update({
      where: { user_id: userId },
      data: { specialties: normalizeSpecialties(specialties) },
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
