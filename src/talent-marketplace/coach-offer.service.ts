/**
 * CoachOfferService — Phase 11 / Track 8
 *
 * Manages CoachOffer rows. Head-coaches (role=coach with active Scale+
 * subscription) extend offers to CoachApplication rows that are in
 * `approved` or `pool` status.
 *
 * Lifecycle:
 *   pending → accepted (applicant)
 *           → rejected (applicant)
 *           → withdrawn (head-coach via separate endpoint, not implemented this PR)
 *
 * Safety guarantees in this service:
 *   - Idempotency: createOffer / acceptOffer / rejectOffer each accept a
 *     UUID `idempotency_key`. A replay returns the original row.
 *   - Race protection: the `one pending offer per (head_coach, application)`
 *     partial unique index in the DB closes the find-then-create gap.
 *   - Atomic acceptance: offer.status and application.status flip inside a
 *     single Prisma $transaction so partial state is impossible.
 *   - Entitlement: only authenticated head-coaches with a Scale+ subscription
 *     (re-uses TalentPoolService.canViewTalentPool) may create offers.
 *   - Fail-closed accept/reject: when an offer's underlying application has
 *     `applicant_user_id = null` (anonymous applicant), no authenticated user
 *     may accept or reject. Until the invite-token flow ships, that path
 *     returns 403. This prevents a stranger from hijacking an anonymous
 *     application by guessing an offer id.
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
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConnectAccountService } from './connect-account.service';
import { CoachApplicationService } from './coach-application.service';
import { TalentPoolService } from './talent-pool.service';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import {
  CoachCompensationTypeDto,
  CreateOfferDto,
  FlatPeriodEnum,
} from './coach-offer.dto';

@Injectable()
export class CoachOfferService {
  private readonly logger = new Logger(CoachOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectService: ConnectAccountService,
    private readonly applicationService: CoachApplicationService,
    private readonly poolService: TalentPoolService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  /**
   * Head-coach creates an offer for a pool/approved application.
   *
   * Server-authoritative checks (R22, F9):
   *   1. Controller-level role guard requires role=coach (or owner-bypass).
   *   2. We re-check the Scale+ subscription entitlement here so a leaked
   *      JWT or middleware misconfiguration cannot let a free-tier coach
   *      bypass billing.
   *   3. We validate compensation_terms against the chosen compensation_type
   *      so the persisted JSON is safe for revenue-routing math (F8, F46).
   *
   * Idempotency:
   *   - The `idempotency_key` is enforced unique at the DB level. A second
   *     POST with the same key returns the original row.
   *   - The partial unique index on (head_coach_id, application_id) where
   *     status='pending' closes the find-then-create race.
   */
  async createOffer(dto: CreateOfferDto, headCoachId: string) {
    const canCreate = await this.poolService.canViewTalentPool(headCoachId);
    if (!canCreate) {
      throw new ForbiddenException(
        'Creating offers requires an active Scale+ subscription.',
      );
    }

    if (dto.idempotency_key) {
      const replay = await this.prisma.coachOffer.findUnique({
        where: { idempotency_key: dto.idempotency_key },
      });
      if (replay) {
        // Replay must come from the original head_coach — a different coach
        // re-using a leaked key cannot adopt another coach's offer.
        if (replay.head_coach_id !== headCoachId) {
          throw new ForbiddenException(
            'Idempotency key already in use by another coach.',
          );
        }
        return replay;
      }
    }

    const application = await this.applicationService.findById(dto.application_id);
    if (!application) {
      throw new NotFoundException(`Application ${dto.application_id} not found`);
    }

    if (!['approved', 'pool'].includes(application.status)) {
      throw new BadRequestException(
        `Application status must be 'approved' or 'pool' to receive an offer (current: ${application.status}).`,
      );
    }

    validateCompensationTerms(dto.compensation_type, dto.compensation_terms);

    try {
      const offer = await this.prisma.coachOffer.create({
        data: {
          head_coach_id: headCoachId,
          applicant_user_id: application.applicant_user_id ?? null,
          application_id: dto.application_id,
          compensation_type: dto.compensation_type,
          compensation_terms: dto.compensation_terms as object,
          client_capacity: dto.client_capacity,
          onboarding_message: dto.onboarding_message ?? null,
          status: 'pending',
          idempotency_key: dto.idempotency_key,
        },
      });
      this.logger.log(
        `Offer ${offer.id} created by head-coach ${headCoachId} for application ${dto.application_id}`,
      );
      return offer;
    } catch (err) {
      // Could be either: (a) the idempotency_key uniqueness lost a race, or
      // (b) the partial-unique (head_coach_id, application_id) pending index
      // rejected a second pending offer. Resolve both safely.
      if (this.isUniqueViolation(err)) {
        if (dto.idempotency_key) {
          const winner = await this.prisma.coachOffer.findUnique({
            where: { idempotency_key: dto.idempotency_key },
          });
          if (winner && winner.head_coach_id === headCoachId) return winner;
        }
        throw new BadRequestException(
          'You already have a pending offer for this application.',
        );
      }
      throw err;
    }
  }

  /**
   * Applicant accepts an offer.
   *
   * RBAC / IDOR (R22, F5, F9):
   *   - If the underlying application has applicant_user_id = null
   *     (anonymous submission), accept/reject is refused. Anyone in possession
   *     of an offer id could otherwise impersonate the applicant. The proper
   *     fix is a signed invite-token flow at submit time; until that ships
   *     this path fails closed.
   *   - Otherwise the acceptor must equal application.applicant_user_id.
   *
   * Atomicity (F44) and race safety (Audit #2 P1-3 / P1-4):
   *   The accept is performed inside one Prisma $transaction:
   *     1. Verify the application is still in `approved` or `pool` (not
   *        `placed`/`inactive`) — refuses double-placement.
   *     2. Conditional updateMany on the offer with WHERE status='pending'
   *        and require count === 1; otherwise the offer was already
   *        accepted/rejected/withdrawn in a parallel request.
   *     3. Mark the application `placed`.
   *     4. Withdraw every other pending offer for the same application so
   *        the candidate cannot accept a second one.
   *   The DB-level partial unique index
   *   `CoachOffer(application_id) WHERE status='accepted'` is the
   *   fail-closed backstop if anything slips past the transaction.
   *
   * Idempotency:
   *   Accept/reject responses live in `MarketplaceMutationIdempotency`,
   *   keyed by (acceptor_user_id, 'talent.offers.accept', idempotency_key).
   *   The original `CoachOffer.idempotency_key` slot is reserved for the
   *   create call and is never overwritten here.
   */
  async acceptOffer(
    offerId: string,
    acceptorUserId: string,
    idempotencyKey: string,
  ): Promise<{
    offer: { id: string; status: string; accepted_at: Date | null };
    onboarding_url?: string;
  }> {
    if (idempotencyKey) {
      const replay = await this.idempotency.findReplay<{
        offer: { id: string; status: string; accepted_at: Date | null };
        onboarding_url?: string;
      }>(acceptorUserId, 'talent.offers.accept', idempotencyKey);
      if (replay) return replay;
    }

    const offer = await this.prisma.coachOffer.findUnique({
      where: { id: offerId },
      include: { application: true },
    });
    if (!offer) throw new NotFoundException(`Offer ${offerId} not found`);

    // Fail closed when the application has no linked applicant user.
    if (!offer.application.applicant_user_id) {
      this.logger.warn(
        `Blocked accept on offer ${offerId}: anonymous applicant (no signed claim flow yet)`,
      );
      throw new ForbiddenException(
        'This application is not yet linked to a verified applicant. Accept/reject is disabled.',
      );
    }

    if (offer.application.applicant_user_id !== acceptorUserId) {
      throw new ForbiddenException('Only the applicant may accept this offer.');
    }

    // Replay for a same-user repeat where the offer is already accepted — the
    // ledger lookup above covers the cached-response path; this branch covers
    // a retry that arrives before the first `record()` lands.
    if (offer.status === 'accepted') {
      return {
        offer: {
          id: offer.id,
          status: offer.status,
          accepted_at: offer.accepted_at,
        },
      };
    }
    if (offer.status !== 'pending') {
      throw new BadRequestException(
        `Offer is not in pending status (current: ${offer.status}).`,
      );
    }

    // Atomic flip with conditional writes. A concurrent accept/reject loses
    // the WHERE status='pending' clause and we surface a 409.
    let updatedOffer: { id: string; status: string; accepted_at: Date | null };
    try {
      updatedOffer = await this.prisma.$transaction(async (tx) => {
        // 1. Re-read the application inside the transaction so a parallel
        //    placement is observed.
        const freshApp = await tx.coachApplication.findUnique({
          where: { id: offer.application_id },
          select: { status: true },
        });
        if (!freshApp) {
          throw new NotFoundException(
            `Application ${offer.application_id} not found`,
          );
        }
        if (!['approved', 'pool'].includes(freshApp.status)) {
          throw new ConflictException(
            `Application is no longer accepting offers (status: ${freshApp.status}).`,
          );
        }

        // 2. Conditional update: only the still-pending offer is flipped.
        const acceptedAt = new Date();
        const updateResult = await tx.coachOffer.updateMany({
          where: { id: offerId, status: 'pending' },
          data: {
            status: 'accepted',
            accepted_at: acceptedAt,
            applicant_user_id: acceptorUserId,
          },
        });
        if (updateResult.count !== 1) {
          throw new ConflictException(
            'Offer has already been accepted or rejected.',
          );
        }

        // 3. Mark the application placed.
        await tx.coachApplication.update({
          where: { id: offer.application_id },
          data: { status: 'placed' },
        });

        // 4. Withdraw every *other* pending offer for the same application.
        //    The candidate cannot accept a second head-coach's offer once one
        //    is accepted.
        await tx.coachOffer.updateMany({
          where: {
            application_id: offer.application_id,
            status: 'pending',
            id: { not: offerId },
          },
          data: { status: 'withdrawn' },
        });

        return {
          id: offerId,
          status: 'accepted' as const,
          accepted_at: acceptedAt,
        };
      });
    } catch (err) {
      // Map the partial unique index `(application_id) WHERE status='accepted'`
      // violation onto a 409 — happens only if two acceptances slip past the
      // transactional guard. Keeps responses safe and stable.
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          'Another offer for this application has already been accepted.',
        );
      }
      throw err;
    }

    // Connect onboarding is best-effort and runs outside the transaction so
    // a transient Stripe outage does not block the placement state change.
    let onboarding_url: string | undefined;
    try {
      const connectStatus = await this.connectService.getAccountStatus(acceptorUserId);
      if (!connectStatus || !connectStatus.onboarding_completed) {
        const linkResult = await this.connectService.createOnboardingLink(
          acceptorUserId,
          `accept-${offerId}-${idempotencyKey}`,
        );
        onboarding_url = linkResult.url;
        this.logger.log(
          `Generated Connect onboarding link for user ${acceptorUserId} after offer ${offerId} acceptance`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not generate Connect onboarding link for user ${acceptorUserId}: ${this.errorMessage(err)}`,
      );
    }

    const response = { offer: updatedOffer, onboarding_url };
    if (idempotencyKey) {
      await this.idempotency.record(
        acceptorUserId,
        'talent.offers.accept',
        idempotencyKey,
        response,
      );
    }
    return response;
  }

  /**
   * Applicant rejects an offer. Same fail-closed posture as acceptOffer.
   *
   * Race safety (Audit #2 P1-4):
   *   The conditional updateMany WHERE status='pending' ensures a concurrent
   *   accept that committed first cannot be flipped to `rejected`. If the
   *   offer is already rejected we return idempotently; if it was already
   *   accepted we return 409.
   */
  async rejectOffer(
    offerId: string,
    rejectorUserId: string,
    idempotencyKey: string,
  ) {
    if (idempotencyKey) {
      const replay = await this.idempotency.findReplay<{
        id: string;
        status: string;
        updated_at: Date;
      }>(rejectorUserId, 'talent.offers.reject', idempotencyKey);
      if (replay) return replay;
    }

    const offer = await this.prisma.coachOffer.findUnique({
      where: { id: offerId },
      include: { application: true },
    });
    if (!offer) throw new NotFoundException(`Offer ${offerId} not found`);

    if (!offer.application.applicant_user_id) {
      this.logger.warn(
        `Blocked reject on offer ${offerId}: anonymous applicant (no signed claim flow yet)`,
      );
      throw new ForbiddenException(
        'This application is not yet linked to a verified applicant. Accept/reject is disabled.',
      );
    }

    if (offer.application.applicant_user_id !== rejectorUserId) {
      throw new ForbiddenException('Only the applicant may reject this offer.');
    }

    // Idempotent: a same-user repeat after the row is already rejected just
    // returns the existing row (200, no state change).
    if (offer.status === 'rejected') {
      const idempotent = {
        id: offer.id,
        status: offer.status,
        updated_at: offer.updated_at,
      };
      if (idempotencyKey) {
        await this.idempotency.record(
          rejectorUserId,
          'talent.offers.reject',
          idempotencyKey,
          idempotent,
        );
      }
      return idempotent;
    }

    // Already accepted (or withdrawn) — refuse loudly. A concurrent accept
    // that committed first reaches this branch.
    if (offer.status !== 'pending') {
      throw new ConflictException(
        `Offer is no longer pending (current: ${offer.status}).`,
      );
    }

    // Conditional write + read inside one transaction so a concurrent accept
    // cannot flip an already-accepted offer to rejected.
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.coachOffer.updateMany({
        where: { id: offerId, status: 'pending' },
        data: { status: 'rejected' },
      });
      if (result.count !== 1) {
        // The offer left `pending` between our find and our update — re-read
        // to decide whether the outcome is idempotent (already rejected) or a
        // hard conflict (already accepted/withdrawn).
        const current = await tx.coachOffer.findUnique({
          where: { id: offerId },
          select: { id: true, status: true, updated_at: true },
        });
        if (!current) {
          throw new NotFoundException(`Offer ${offerId} not found`);
        }
        if (current.status === 'rejected') return current;
        throw new ConflictException(
          `Offer is no longer pending (current: ${current.status}).`,
        );
      }
      return tx.coachOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { id: true, status: true, updated_at: true },
      });
    });

    if (idempotencyKey) {
      await this.idempotency.record(
        rejectorUserId,
        'talent.offers.reject',
        idempotencyKey,
        updated,
      );
    }
    return updated;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

/**
 * Validate the shape of compensation_terms against the chosen
 * compensation_type. Throws BadRequestException with a generic message so the
 * client cannot probe the validator with crafted payloads. Numeric ranges are
 * bounded so revenue-routing cannot later compute negative fees.
 */
export function validateCompensationTerms(
  type: CoachCompensationTypeDto,
  terms: Record<string, unknown> | undefined,
): void {
  if (!terms || typeof terms !== 'object') {
    throw new BadRequestException('Invalid compensation_terms shape.');
  }

  const isPct = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  const isUsd = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;

  switch (type) {
    case CoachCompensationTypeDto.COMMISSION:
      if (!isPct(terms['rate_pct'])) {
        throw new BadRequestException(
          'commission terms require rate_pct in [0,100].',
        );
      }
      return;

    case CoachCompensationTypeDto.REV_SHARE:
      if (!isPct(terms['rate_pct'])) {
        throw new BadRequestException(
          'rev_share terms require rate_pct in [0,100].',
        );
      }
      if (terms['cap_usd'] !== undefined && !isUsd(terms['cap_usd'])) {
        throw new BadRequestException(
          'rev_share cap_usd must be a non-negative number.',
        );
      }
      return;

    case CoachCompensationTypeDto.FLAT:
      if (!isUsd(terms['amount_usd'])) {
        throw new BadRequestException(
          'flat terms require amount_usd >= 0.',
        );
      }
      if (
        terms['period'] !== FlatPeriodEnum.MONTHLY &&
        terms['period'] !== FlatPeriodEnum.WEEKLY
      ) {
        throw new BadRequestException(
          'flat terms require period in {monthly, weekly}.',
        );
      }
      return;

    case CoachCompensationTypeDto.HYBRID:
      if (!isUsd(terms['base_usd'])) {
        throw new BadRequestException(
          'hybrid terms require base_usd >= 0.',
        );
      }
      if (!isPct(terms['rate_pct'])) {
        throw new BadRequestException(
          'hybrid terms require rate_pct in [0,100].',
        );
      }
      return;

    default:
      throw new BadRequestException('Unsupported compensation_type.');
  }
}
