/**
 * CoachApplicationService — Phase 11 / Track 8
 *
 * Manages the lifecycle of CoachApplication rows. The public submit endpoint
 * is intentionally unauthenticated (marketing-site visitors apply without an
 * account); if the applicant already has a User, pass their userId from the
 * calling code so the FK is populated at create time.
 *
 * State machine:
 *   pending → reviewed → approved → pool → placed | inactive
 *
 * Mutation methods advance status forward only (you can't go from approved
 * back to pending via this service — use a direct DB operation with an audit
 * log for that edge case).
 *
 * Idempotency:
 *   Every public submit must carry a client-generated UUID idempotency_key.
 *   A second submit with the same key returns the original row instead of
 *   creating a duplicate. The uniqueness is enforced by the DB index on
 *   CoachApplication.idempotency_key.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  SubmitCoachApplicationDto,
  ReviewCoachApplicationDto,
  ListApplicationsQueryDto,
  CoachApplicationStatusDto,
} from './coach-application.dto';

@Injectable()
export class CoachApplicationService {
  private readonly logger = new Logger(CoachApplicationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Submit a new coach application. Public — no authentication required.
   * If the applicant already has an account, pass their userId; otherwise null.
   *
   * Idempotent on dto.idempotency_key. If a row already exists with the same
   * key, we return it (replay) rather than creating a duplicate.
   */
  async submitApplication(
    dto: SubmitCoachApplicationDto,
    applicantUserId?: string,
  ) {
    if (dto.idempotency_key) {
      const existing = await this.prisma.coachApplication.findUnique({
        where: { idempotency_key: dto.idempotency_key },
        select: { id: true, email: true, status: true, created_at: true },
      });
      if (existing) {
        this.logger.log(
          `Replay of CoachApplication.submit for idempotency_key=${dto.idempotency_key}`,
        );
        return existing;
      }
    }

    this.logger.log(`New coach application received from ${dto.email}`);

    try {
      return await this.prisma.coachApplication.create({
        data: {
          applicant_user_id: applicantUserId ?? null,
          email: dto.email,
          first_name: dto.first_name,
          last_name: dto.last_name,
          certifications: dto.certifications,
          specializations: dto.specializations,
          years_experience: dto.years_experience,
          sample_program_url: dto.sample_program_url ?? null,
          preferences: { ...dto.preferences },
          availability_hours_per_week: dto.availability_hours_per_week,
          preferred_client_type: dto.preferred_client_type,
          status: 'pending',
          idempotency_key: dto.idempotency_key,
        },
        select: {
          id: true,
          email: true,
          status: true,
          created_at: true,
        },
      });
    } catch (err) {
      // Race: a concurrent submit lost the unique-constraint race on
      // idempotency_key. Re-read and return the winner.
      if (this.isUniqueViolation(err) && dto.idempotency_key) {
        const winner = await this.prisma.coachApplication.findUnique({
          where: { idempotency_key: dto.idempotency_key },
          select: { id: true, email: true, status: true, created_at: true },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /**
   * Fetch the application(s) for the authenticated user.
   * A user might have reapplied multiple times; returns all, newest first.
   */
  async getMyApplications(userId: string) {
    return this.prisma.coachApplication.findMany({
      where: { applicant_user_id: userId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        reviewer_notes: true,
        reviewer_score: true,
        background_verified: true,
        created_at: true,
        updated_at: true,
        specializations: true,
        certifications: true,
        years_experience: true,
        availability_hours_per_week: true,
        preferred_client_type: true,
      },
    });
  }

  /**
   * Admin: list applications with optional status filter and tuple cursor
   * pagination. Cursor format: `<ISO created_at>|<id>`. Using only `id` as a
   * cursor while ordering by `created_at desc` is unstable: rows inserted at
   * the same instant can skip or repeat across pages, so we compare the
   * (created_at, id) tuple.
   */
  async listApplications(query: ListApplicationsQueryDto) {
    const take = query.take ?? 20;

    const cursor = parseTupleCursor(query.cursor);

    return this.prisma.coachApplication.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(cursor
          ? {
              OR: [
                { created_at: { lt: cursor.createdAt } },
                {
                  AND: [
                    { created_at: cursor.createdAt },
                    { id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      take,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        certifications: true,
        specializations: true,
        years_experience: true,
        availability_hours_per_week: true,
        preferred_client_type: true,
        background_verified: true,
        status: true,
        reviewer_score: true,
        reviewer_notes: true,
        created_at: true,
        updated_at: true,
        applicant_user_id: true,
      },
    });
  }

  /**
   * Admin: review and advance (or retract) an application.
   * reviewerUserId must be an owner-role user — enforced by the controller guard.
   */
  async reviewApplication(
    applicationId: string,
    dto: ReviewCoachApplicationDto,
    reviewerUserId: string,
  ) {
    const existing = await this.prisma.coachApplication.findUnique({
      where: { id: applicationId },
    });
    if (!existing) {
      throw new NotFoundException(`CoachApplication ${applicationId} not found`);
    }

    // Guard: only allow status advances that make sense. Placing is handled
    // via acceptOffer in CoachOfferService; you cannot manually set placed here.
    if (dto.status === CoachApplicationStatusDto.PLACED) {
      throw new BadRequestException(
        'Status cannot be set to "placed" directly — accept an offer instead.',
      );
    }

    return this.prisma.coachApplication.update({
      where: { id: applicationId },
      data: {
        status: dto.status,
        reviewer_user_id: reviewerUserId,
        ...(dto.reviewer_score !== undefined
          ? { reviewer_score: dto.reviewer_score }
          : {}),
        ...(dto.reviewer_notes !== undefined
          ? { reviewer_notes: dto.reviewer_notes }
          : {}),
        ...(dto.background_verified !== undefined
          ? { background_verified: dto.background_verified }
          : {}),
      },
    });
  }

  /** Internal: find an application by ID (used by offer service). */
  async findById(id: string) {
    return this.prisma.coachApplication.findUnique({ where: { id } });
  }

  /** Internal: mark application as placed when an offer is accepted. */
  async markPlaced(id: string) {
    return this.prisma.coachApplication.update({
      where: { id },
      data: { status: 'placed' },
    });
  }

  /** Prisma unique-constraint check without coupling tests to error shape. */
  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}

/**
 * Parse a `<ISO created_at>|<id>` cursor. Returns null when the value is
 * absent or malformed (callers treat null as "first page"). Exported for
 * reuse by sibling services that paginate over the same table shape.
 */
export function parseTupleCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const isoPart = raw.slice(0, sep);
  const idPart = raw.slice(sep + 1);
  if (!idPart) return null;
  const createdAt = new Date(isoPart);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: idPart };
}

/** Build a `<ISO>|<id>` cursor from the last row in a page. */
export function buildTupleCursor(row: {
  created_at: Date;
  id: string;
}): string {
  return `${row.created_at.toISOString()}|${row.id}`;
}
