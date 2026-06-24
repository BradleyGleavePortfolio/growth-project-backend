// TM-9 — Job-hunter (/me/*) service. Reads are owner-scoped to the JWT subject
// on top of TM-1 RLS; portfolio URLs pass the HTTPS allow-list before any write.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { buildTupleCursor, parseTupleCursor } from './application-cursor';
import { isTerminalStatus } from './application-status';
import {
  PORTFOLIO_MAX_SAMPLE_PROGRAMS,
  checkSampleProgramUrls,
  type PortfolioShowcase,
} from './portfolio-showcase';
import { normalizeSpecialties } from './specialties';
import type {
  MyApplicationsQueryDto,
  MyApplicationsResponse,
  ProfileStrengthDto,
  ProfileStrengthNudge,
  UpdatePortfolioDto,
} from './job-hunter.dto';

const MY_APPLICATIONS_DEFAULT_LIMIT = 20;
const MY_APPLICATIONS_MAX_LIMIT = 50;

// The projected Applicant columns the portfolio showcase reads + writes. Shared
// by getPortfolio and the single-read updatePortfolio so both map identically.
const PORTFOLIO_SELECT = {
  headline: true,
  bio: true,
  specialties: true,
  sample_program_url: true,
} as const;

interface PortfolioRow {
  headline: string | null;
  bio: string | null;
  specialties: string[];
  sample_program_url: string | null;
}

function toPortfolioShape(applicant: PortfolioRow): PortfolioShowcase {
  return {
    headline: applicant.headline,
    about: applicant.bio,
    specialties: applicant.specialties,
    sample_program_urls: applicant.sample_program_url
      ? [applicant.sample_program_url]
      : [],
  };
}

// Applicant.specialties normalization (trim → drop empties → dedupe, first-seen
// order; null clears to []) now lives in ./specialties so the alerts writer
// (TM-9b) and this portfolio writer (TM-9a) share one canonical implementation.

const NUDGES: Record<string, ProfileStrengthNudge> = {
  add_headline: { kind: 'add_headline', message: 'Add a headline to introduce yourself.' },
  add_bio: { kind: 'add_bio', message: 'A short bio helps hirers get to know you.' },
  add_specialties: { kind: 'add_specialties', message: 'List your specialties to match more roles.' },
  add_sample: { kind: 'add_sample', message: 'Share a sample program to show your work.' },
};

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return MY_APPLICATIONS_DEFAULT_LIMIT;
  return Math.min(limit, MY_APPLICATIONS_MAX_LIMIT);
}

@Injectable()
export class JobHunterService {
  constructor(private readonly prisma: PrismaService) {}

  async myApplications(
    userId: string,
    query: MyApplicationsQueryDto,
  ): Promise<MyApplicationsResponse> {
    const limit = clampLimit(query.limit);
    const where: Prisma.ApplicationWhereInput = { applicant_user_id: userId };
    const cursor = query.cursor ? parseTupleCursor(query.cursor) : null;
    if (cursor) {
      where.OR = [
        { created_at: { lt: cursor.created_at } },
        { created_at: cursor.created_at, id: { lt: cursor.id } },
      ];
    }

    const rows = await this.prisma.application.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        listing_id: true,
        status: true,
        cover_note: true,
        created_at: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        listing_id: row.listing_id,
        status: row.status,
        // row.status is the Prisma ApplicationStatus enum (byte-equal to our
        // mirror, asserted in application-status.spec) — isTerminalStatus takes
        // unknown, so no guard/cast is needed at the call site (A-P2-2).
        is_terminal: isTerminalStatus(row.status),
        cover_note: row.cover_note,
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: hasMore && last ? buildTupleCursor(last) : null,
    };
  }

  async getPortfolio(userId: string): Promise<PortfolioShowcase> {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
      select: PORTFOLIO_SELECT,
    });
    if (!applicant) this.rejectMissingApplicant();
    return toPortfolioShape(applicant);
  }

  async updatePortfolio(
    userId: string,
    dto: UpdatePortfolioDto,
  ): Promise<PortfolioShowcase> {
    const data: Prisma.ApplicantUpdateInput = {};
    if (dto.headline !== undefined) data.headline = dto.headline;
    if (dto.about !== undefined) data.bio = dto.about;
    // Explicit null clears to [] (the column is non-null String[]); a present
    // list is trimmed/deduped before persist (A-P1-1 + B-P0-2).
    if (dto.specialties !== undefined) {
      data.specialties = normalizeSpecialties(dto.specialties);
    }
    if (dto.sample_program_urls !== undefined) {
      // null clears; [] also clears — PUT-replacement semantics: omission means
      // "unchanged", an empty list means "clear the persisted URL" (B-P0-2, B-P2-1).
      const urls = dto.sample_program_urls ?? [];
      // The Applicant column persists ONE sample-program URL; an over-cap
      // submission is rejected outright, never silently truncated.
      if (urls.length > PORTFOLIO_MAX_SAMPLE_PROGRAMS) {
        throw new BadRequestException({
          error: 'Bad Request',
          message: `At most ${PORTFOLIO_MAX_SAMPLE_PROGRAMS} sample program URL is supported`,
          code: 'too_many_sample_urls',
        });
      }
      const check = checkSampleProgramUrls(urls);
      if (!check.ok) this.rejectUrl();
      // [] → value[0] is undefined → null: clears the persisted single URL.
      else data.sample_program_url = check.value[0] ?? null;
    }

    // Single read-write: update + project in one round-trip, then map directly.
    // A concurrent delete surfaces as Prisma P2025 → the same opaque 404 the
    // upfront existence check used to throw (B-P1-3).
    try {
      const applicant = await this.prisma.applicant.update({
        where: { user_id: userId },
        data,
        select: PORTFOLIO_SELECT,
      });
      return toPortfolioShape(applicant);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        this.rejectMissingApplicant();
      }
      throw err;
    }
  }

  async profileStrength(userId: string): Promise<ProfileStrengthDto> {
    const a = await this.requireApplicant(userId);
    const checks: Array<[boolean, ProfileStrengthNudge]> = [
      [!!a.headline, NUDGES.add_headline],
      [!!a.bio, NUDGES.add_bio],
      // Non-empty rule mirrors normalizeSpecialties so a stored [''] (legacy
      // row) does not score positive or suppress the add_specialties nudge (A-P1-1).
      [a.specialties.some((s) => s.trim().length > 0), NUDGES.add_specialties],
      [!!a.sample_program_url, NUDGES.add_sample],
    ];
    const filled = checks.filter(([done]) => done).length;
    // Math.floor so the score can never over-report completion: 100 only when
    // every check passes. At today's denominator (4) the buckets are exact
    // quarters, so this is behavior-neutral now and safe if checks are added (A-P2-1).
    const score = Math.floor((filled / checks.length) * 100);
    const nudges = checks.filter(([done]) => !done).map(([, n]) => n);
    return { score, nudges };
  }

  private async requireApplicant(userId: string) {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
    });
    if (!applicant) this.rejectMissingApplicant();
    return applicant;
  }

  private rejectMissingApplicant(): never {
    throw new NotFoundException({
      error: 'Not Found',
      message: 'Applicant profile not found',
      code: 'applicant_not_found',
    });
  }

  private rejectUrl(): never {
    throw new BadRequestException({
      error: 'Bad Request',
      message: 'Portfolio URL must be an https link under the size limit',
      code: 'portfolio_url_invalid',
    });
  }
}
