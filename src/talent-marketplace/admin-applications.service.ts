// TM-7b — Owner-only applicant review. Mirrors the TM-7a listing half exactly:
// keyset-paginated review queue + atomic claim-or-replay decision POST through
// the TM-4 ledger. The shared queue/ledger helpers are imported from
// admin-moderation.service (TM-7a) so the protocol lives in one place.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import { clampReviewLimit } from './admin-review-cursor';
import {
  alreadyDecided,
  keysetWhere,
  notFound,
  page,
  review,
} from './admin-moderation.service';
import type {
  ApplicationReviewCardDto,
  ReviewDecisionDto,
  ReviewDecisionResult,
  ReviewQueueQueryDto,
  ReviewQueueResponse,
} from './admin-applications.dto';

const APPLICATION_ROUTE_KEY = 'tm:admin:applications:review';

// Decision → next enum state: approve→shortlisted / reject→rejected. The
// reviewable (pre-decision) state is `submitted`; the status-guarded write
// pins the mutation to it so a second decision matches zero rows and falls
// through to the ledger replay (P1-3).
const APPLICATION_NEXT = {
  approved: 'shortlisted',
  rejected: 'rejected',
} as const;
const APPLICATION_REVIEWABLE: Prisma.ApplicationWhereInput['status'] =
  'submitted';

@Injectable()
export class AdminApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // GET /admin/applications — keyset (created_at, id) review queue.
  async listApplications(
    query: ReviewQueueQueryDto,
  ): Promise<ReviewQueueResponse<ApplicationReviewCardDto>> {
    const limit = clampReviewLimit(query.limit);
    const where: Prisma.ApplicationWhereInput = keysetWhere(query, {});
    if (query.status)
      where.status = query.status as Prisma.ApplicationWhereInput['status'];

    const rows = await this.prisma.application.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return page(rows, limit, (r) => ({
      id: r.id,
      listing_id: r.listing_id,
      status: r.status,
      fit_score: r.fit_score,
      created_at: r.created_at.toISOString(),
    }));
  }

  async reviewApplication(
    ownerId: string,
    applicationId: string,
    dto: ReviewDecisionDto,
  ): Promise<ReviewDecisionResult> {
    return review(
      this.idempotency,
      ownerId,
      applicationId,
      dto,
      APPLICATION_ROUTE_KEY,
      async () => {
        const found = await this.prisma.application.findUnique({
          where: { id: applicationId },
          select: { id: true },
        });
        if (!found) throw notFound('application');
        const updated = await this.prisma.application.updateMany({
          where: { id: applicationId, status: APPLICATION_REVIEWABLE },
          data: { status: APPLICATION_NEXT[dto.decision] },
        });
        if (updated.count === 0) throw alreadyDecided('application');
        return {
          id: applicationId,
          status: APPLICATION_NEXT[dto.decision],
          decision: dto.decision,
        };
      },
    );
  }
}
