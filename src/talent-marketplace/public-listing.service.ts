import { Injectable, NotFoundException } from '@nestjs/common';
import type { CoachCompensationType, JobListing, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { buildJobPostingJsonLd, JobPostingJsonLd } from './job-posting-jsonld';
import {
  buildTupleCursor,
  parseTupleCursor,
} from './public-listing.cursor';
import {
  BrowseListingsQueryDto,
  BrowseListingsResponse,
  PublicListingCardDto,
  PublicListingDetailDto,
  PUBLIC_LISTING_DEFAULT_LIMIT,
  PUBLIC_LISTING_MAX_LIMIT,
} from './public-listing.dto';

// TM-3 — public browse + detail. Adds an explicit status:'published' filter
// (defence-in-depth over TM-1 RLS) and maps rows through an allow-list DTO so no
// PII escapes. Keyset tuple pagination on (created_at, id) — never offset.
@Injectable()
export class PublicListingService {
  constructor(private readonly prisma: PrismaService) {}

  async browse(query: BrowseListingsQueryDto): Promise<BrowseListingsResponse> {
    const limit = clampLimit(query.limit);
    const comp = asCompensationType(query.compensation_type);
    const where: Prisma.JobListingWhereInput = {
      status: 'published',
      ...(query.specialty ? { specialty: query.specialty } : {}),
      ...(query.location ? { location: query.location } : {}),
      ...(query.modality ? { modality: query.modality } : {}),
      ...(comp ? { compensation_type: comp } : {}),
    };

    // Keyset boundary under the stable (created_at DESC, id DESC) sort. A
    // malformed/stale cursor parses to null and degrades to page 1.
    const cursor = query.cursor ? parseTupleCursor(query.cursor) : null;
    if (cursor) {
      where.AND = [
        {
          OR: [
            { created_at: { lt: cursor.created_at } },
            { created_at: cursor.created_at, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    // Over-fetch one row to learn whether a further page exists.
    const rows = await this.prisma.jobListing.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toCard(row)),
      next_cursor: hasMore && last ? buildTupleCursor(last) : null,
    };
  }

  async detail(
    id: string,
  ): Promise<{ listing: PublicListingDetailDto; json_ld: JobPostingJsonLd }> {
    // Explicit published filter (defence-in-depth alongside RLS): a draft/closed
    // or non-existent id is a 404, never leaked.
    const row = await this.prisma.jobListing.findFirst({
      where: { id, status: 'published' },
    });
    if (!row) throw new NotFoundException({ kind: 'job_listing_not_found' });
    const listing = toDetail(row);
    return { listing, json_ld: buildJobPostingJsonLd(listing) };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PUBLIC_LISTING_DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), PUBLIC_LISTING_MAX_LIMIT);
}

// Narrow the free-text comp_type facet to the enum; an unknown value is dropped
// (undefined) rather than matching zero rows.
const COMPENSATION_TYPES: readonly CoachCompensationType[] = [
  'commission',
  'rev_share',
  'flat',
  'hybrid',
];
function asCompensationType(
  value: string | undefined,
): CoachCompensationType | undefined {
  return COMPENSATION_TYPES.find((t) => t === value);
}

// ── Allow-list mappers — copy ONLY public fields; never spread the entity. ──

function toCard(row: JobListing): PublicListingCardDto {
  return {
    id: row.id,
    title: row.title,
    specialty: row.specialty,
    location: row.location,
    modality: row.modality,
    compensation_summary: compensationSummary(row),
    published_at: row.published_at ? row.published_at.toISOString() : null,
    cta_listing_id: row.id,
  };
}

function toDetail(row: JobListing): PublicListingDetailDto {
  return {
    ...toCard(row),
    description: row.description,
    compensation_type: row.compensation_type,
    compensation_terms: asTerms(row.compensation_terms),
    expectations: row.expectations,
    created_at: row.created_at.toISOString(),
  };
}

function asTerms(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// One-line comp summary for the compact card, shaped per compensation type.
function compensationSummary(row: JobListing): string {
  const terms = asTerms(row.compensation_terms);
  const num = (k: string): number | null =>
    typeof terms[k] === 'number' ? (terms[k] as number) : null;
  const pct = (k: string) => (num(k) === null ? null : `${num(k)}%`);
  const usd = (k: string) => {
    const n = num(k);
    return n === null ? null : `$${n.toLocaleString('en-US')}`;
  };
  switch (row.compensation_type) {
    case 'commission':
      return pct('rate_pct') ? `${pct('rate_pct')} commission` : 'Commission';
    case 'rev_share': {
      const r = pct('rate_pct');
      const cap = usd('cap_usd');
      return r ? `${r} rev share${cap ? ` (cap ${cap})` : ''}` : 'Revenue share';
    }
    case 'flat': {
      const amt = usd('amount_usd');
      const period = typeof terms.period === 'string' ? terms.period : null;
      return amt ? `${amt}${period ? `/${period}` : ''}` : 'Flat rate';
    }
    case 'hybrid': {
      const base = usd('base_usd');
      const r = pct('rate_pct');
      return base && r ? `${base} base + ${r}` : 'Hybrid';
    }
    default:
      return 'Compensation on application';
  }
}
