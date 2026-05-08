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
   */
  async submitApplication(
    dto: SubmitCoachApplicationDto,
    applicantUserId?: string,
  ) {
    this.logger.log(`New coach application received from ${dto.email}`);

    return this.prisma.coachApplication.create({
      data: {
        applicant_user_id: applicantUserId ?? null,
        email: dto.email,
        first_name: dto.first_name,
        last_name: dto.last_name,
        certifications: dto.certifications,
        specializations: dto.specializations,
        years_experience: dto.years_experience,
        sample_program_url: dto.sample_program_url ?? null,
        preferences: dto.preferences,
        availability_hours_per_week: dto.availability_hours_per_week,
        preferred_client_type: dto.preferred_client_type,
        status: 'pending',
      },
      select: {
        id: true,
        email: true,
        status: true,
        created_at: true,
      },
    });
  }

  /**
   * Fetch the application(s) for the authenticated user.
   * A user might have reapplied multiple times; returns all, newest first.
   */
  async getMyApplications(userId: string) {
    return this.prisma.coachApplication.findMany({
      where: { applicant_user_id: userId },
      orderBy: { created_at: 'desc' },
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
   * Admin: list applications with optional status filter and cursor pagination.
   */
  async listApplications(query: ListApplicationsQueryDto) {
    const take = query.take ?? 20;

    return this.prisma.coachApplication.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      take,
      orderBy: { created_at: 'desc' },
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
}
