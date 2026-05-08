/**
 * CoachOfferService — Phase 11 / Track 8
 *
 * Manages CoachOffer rows. Head-coaches (role=coach with active subscription)
 * extend offers to CoachApplication rows that are in `approved` or `pool` status.
 *
 * Lifecycle:
 *   pending → accepted (applicant)
 *           → rejected (applicant)
 *           → withdrawn (head-coach via separate endpoint, not implemented this PR)
 *
 * On acceptOffer:
 *   1. CoachOffer.status → accepted, accepted_at stamped.
 *   2. CoachApplication.status → placed.
 *   3. If the applicant has no CoachConnectAccount, the service calls
 *      ConnectAccountService.createOnboardingLink and returns the URL.
 *      The calling controller returns { offer, onboarding_url } so the mobile
 *      app can deep-link the user to Stripe onboarding.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConnectAccountService } from './connect-account.service';
import { CoachApplicationService } from './coach-application.service';
import type { CreateOfferDto } from './coach-offer.dto';

@Injectable()
export class CoachOfferService {
  private readonly logger = new Logger(CoachOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectService: ConnectAccountService,
    private readonly applicationService: CoachApplicationService,
  ) {}

  /**
   * Head-coach creates an offer for a pool/approved application.
   * Validates that the application is in a state that accepts offers.
   */
  async createOffer(
    dto: CreateOfferDto,
    headCoachId: string,
  ) {
    const application = await this.applicationService.findById(dto.application_id);
    if (!application) {
      throw new NotFoundException(`Application ${dto.application_id} not found`);
    }

    if (!['approved', 'pool'].includes(application.status)) {
      throw new BadRequestException(
        `Application status must be 'approved' or 'pool' to receive an offer (current: ${application.status}).`,
      );
    }

    // One pending offer per head-coach per application is sufficient.
    const existingOffer = await this.prisma.coachOffer.findFirst({
      where: {
        head_coach_id: headCoachId,
        application_id: dto.application_id,
        status: 'pending',
      },
    });
    if (existingOffer) {
      throw new BadRequestException(
        'You already have a pending offer for this application.',
      );
    }

    const offer = await this.prisma.coachOffer.create({
      data: {
        head_coach_id: headCoachId,
        applicant_user_id: application.applicant_user_id ?? null,
        application_id: dto.application_id,
        compensation_type: dto.compensation_type,
        // dto.compensation_terms is already typed as Prisma.InputJsonObject
        compensation_terms: dto.compensation_terms,
        client_capacity: dto.client_capacity,
        onboarding_message: dto.onboarding_message ?? null,
        status: 'pending',
      },
    });

    this.logger.log(
      `Offer ${offer.id} created by head-coach ${headCoachId} for application ${dto.application_id}`,
    );
    return offer;
  }

  /**
   * Applicant accepts an offer. The acceptor must be the applicant user
   * linked to the application (or any authenticated user if the application
   * is not linked to a user — handle that edge with a note).
   *
   * On acceptance:
   *   1. Stamp accepted_at.
   *   2. Mark application as placed.
   *   3. If no Connect account, create onboarding link and return it.
   */
  async acceptOffer(
    offerId: string,
    acceptorUserId: string,
  ): Promise<{
    offer: { id: string; status: string; accepted_at: Date | null };
    onboarding_url?: string;
  }> {
    const offer = await this.prisma.coachOffer.findUnique({
      where: { id: offerId },
      include: { application: true },
    });
    if (!offer) throw new NotFoundException(`Offer ${offerId} not found`);
    if (offer.status !== 'pending') {
      throw new BadRequestException(
        `Offer is not in pending status (current: ${offer.status}).`,
      );
    }

    // If the application has a linked user, only that user may accept.
    if (
      offer.application.applicant_user_id &&
      offer.application.applicant_user_id !== acceptorUserId
    ) {
      throw new ForbiddenException(
        'Only the applicant may accept this offer.',
      );
    }

    const updatedOffer = await this.prisma.coachOffer.update({
      where: { id: offerId },
      data: {
        status: 'accepted',
        accepted_at: new Date(),
        applicant_user_id: acceptorUserId,
      },
      select: { id: true, status: true, accepted_at: true },
    });

    await this.applicationService.markPlaced(offer.application_id);

    // Ensure the acceptor has a Connect account; if not, generate onboarding URL.
    let onboarding_url: string | undefined;
    try {
      const connectStatus = await this.connectService.getAccountStatus(acceptorUserId);
      if (!connectStatus) {
        const linkResult = await this.connectService.createOnboardingLink(acceptorUserId);
        onboarding_url = linkResult.url;
        this.logger.log(
          `Generated Connect onboarding link for user ${acceptorUserId} after offer ${offerId} acceptance`,
        );
      } else if (!connectStatus.onboarding_completed) {
        const linkResult = await this.connectService.createOnboardingLink(acceptorUserId);
        onboarding_url = linkResult.url;
      }
    } catch (err) {
      // Connect onboarding link generation failure is non-fatal.
      // Log and return the accepted offer; the user can retrieve the link
      // separately via GET /talent/connect/status.
      this.logger.warn(
        `Could not generate Connect onboarding link for user ${acceptorUserId}: ${String(err)}`,
      );
    }

    return { offer: updatedOffer, onboarding_url };
  }

  /**
   * Applicant rejects an offer.
   */
  async rejectOffer(offerId: string, rejectorUserId: string) {
    const offer = await this.prisma.coachOffer.findUnique({
      where: { id: offerId },
      include: { application: true },
    });
    if (!offer) throw new NotFoundException(`Offer ${offerId} not found`);
    if (offer.status !== 'pending') {
      throw new BadRequestException(
        `Offer is not in pending status (current: ${offer.status}).`,
      );
    }

    if (
      offer.application.applicant_user_id &&
      offer.application.applicant_user_id !== rejectorUserId
    ) {
      throw new ForbiddenException('Only the applicant may reject this offer.');
    }

    return this.prisma.coachOffer.update({
      where: { id: offerId },
      data: { status: 'rejected' },
      select: { id: true, status: true, updated_at: true },
    });
  }
}
