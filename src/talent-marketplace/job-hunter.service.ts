// TM-9 — Job-hunter (/me/*) service.
//
// PII guardrails: every read is owner-scoped to the JWT subject (user_id =
// caller) as defense-in-depth ON TOP of TM-1 RLS; never logs raw email/phone/IP;
// portfolio URLs pass the HTTPS allow-list + size + base64 guards before any
// write. Profile-strength nudges come from a fixed whitelist — no free-form
// server text that could leak internal state.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { buildTupleCursor, parseTupleCursor } from './application-cursor';
import { isTerminalStatus, isApplicationStatus } from './application-status';
import {
  checkOptionalUrl,
  checkSampleProgramUrls,
  type PortfolioShowcase,
} from './portfolio-showcase';
import type {
  MyApplicationsQueryDto,
  MyApplicationsResponse,
  ProfileStrengthDto,
  ProfileStrengthNudge,
  UpdatePortfolioDto,
} from './job-hunter.dto';

const MY_APPLICATIONS_DEFAULT_LIMIT = 20;
const MY_APPLICATIONS_MAX_LIMIT = 50;

// Fixed, calm nudge whitelist (no dark patterns, no free-form server text).
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

  // GET /me/applications — keyset (created_at, id) pagination, scoped to caller.
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
        is_terminal: isApplicationStatus(row.status)
          ? isTerminalStatus(row.status)
          : false,
        cover_note: row.cover_note,
        created_at: row.created_at.toISOString(),
      })),
      next_cursor: hasMore && last ? buildTupleCursor(last) : null,
    };
  }

  // GET /me/portfolio — the caller's showcase projected over Applicant columns.
  async getPortfolio(userId: string): Promise<PortfolioShowcase> {
    const applicant = await this.requireApplicant(userId);
    return {
      headline: applicant.headline,
      about: applicant.bio,
      specialties: applicant.specialties,
      intro_video_url: null,
      sample_program_urls: applicant.sample_program_url
        ? [applicant.sample_program_url]
        : [],
    };
  }

  // PUT /me/portfolio — bounded update. Intro-video + sample-program URLs pass
  // the HTTPS allow-list / size / base64 guards before any write.
  async updatePortfolio(
    userId: string,
    dto: UpdatePortfolioDto,
  ): Promise<PortfolioShowcase> {
    await this.requireApplicant(userId);

    const data: Prisma.ApplicantUpdateInput = {};
    if (dto.headline !== undefined) data.headline = dto.headline;
    if (dto.about !== undefined) data.bio = dto.about;
    if (dto.specialties !== undefined) data.specialties = dto.specialties;

    if (dto.intro_video_url !== undefined) {
      const check = checkOptionalUrl(dto.intro_video_url);
      if (!check.ok) this.rejectUrl();
    }

    if (dto.sample_program_urls !== undefined) {
      const check = checkSampleProgramUrls(dto.sample_program_urls);
      if (!check.ok) this.rejectUrl();
      else data.sample_program_url = check.value[0] ?? null;
    }

    await this.prisma.applicant.update({ where: { user_id: userId }, data });
    return this.getPortfolio(userId);
  }

  // GET /me/profile-strength — deterministic 0-100 score + calm whitelisted
  // nudges. Score is purely a function of which fields are populated.
  async profileStrength(userId: string): Promise<ProfileStrengthDto> {
    const a = await this.requireApplicant(userId);
    const checks: Array<[boolean, ProfileStrengthNudge]> = [
      [!!a.headline, NUDGES.add_headline],
      [!!a.bio, NUDGES.add_bio],
      [a.specialties.length > 0, NUDGES.add_specialties],
      [!!a.sample_program_url, NUDGES.add_sample],
    ];
    const filled = checks.filter(([done]) => done).length;
    const score = Math.round((filled / checks.length) * 100);
    const nudges = checks.filter(([done]) => !done).map(([, n]) => n);
    return { score, nudges };
  }

  private async requireApplicant(userId: string) {
    const applicant = await this.prisma.applicant.findUnique({
      where: { user_id: userId },
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

  private rejectUrl(): never {
    throw new BadRequestException({
      error: 'Bad Request',
      message: 'Portfolio URL must be an https link under the size limit',
      code: 'portfolio_url_invalid',
    });
  }
}
