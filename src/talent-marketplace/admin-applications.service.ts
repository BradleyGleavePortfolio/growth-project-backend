// TM-7b — Owner-only applicant review. Mirrors the TM-7a listing half exactly:
// keyset-paginated review queue + atomic claim-or-replay decision POST through
// the TM-4 ledger. The shared queue/ledger helpers are imported from
// admin-moderation.service (TM-7a) so the protocol lives in one place.
import { Injectable, Logger } from '@nestjs/common';
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

// Truncate a note before it lands in a structured log line so a 2k-char note
// cannot bloat the log/Sentry breadcrumb. The full note is still persisted to
// the ledger row; only the logged copy is clipped. Defined locally rather than
// imported from the TM-7a service so this half adds no edit to that audited file.
const NOTE_LOG_MAX = 256;
function truncateNote(note: string | null): string | null {
  if (note === null) return null;
  return note.length > NOTE_LOG_MAX ? `${note.slice(0, NOTE_LOG_MAX)}\u2026` : note;
}

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
  private readonly logger = new Logger(AdminApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // GET /admin/applications — keyset (created_at, id) review queue.
  async listApplications(
    query: ReviewQueueQueryDto,
  ): Promise<ReviewQueueResponse<ApplicationReviewCardDto>> {
    const limit = clampReviewLimit(query.limit);
    // keysetWhere only consumes `cursor`; pass just that so the listing-typed
    // helper signature does not clash with this queue's ApplicationStatus enum
    // (the status filter is applied below, against the indexed column).
    const where: Prisma.ApplicationWhereInput = keysetWhere({ cursor: query.cursor }, {});
    // `query.status` is already a canonical `ApplicationStatus` member (parsed by
    // ParseApplicationStatusPipe / validated by @IsIn on the DTO), so it narrows
    // directly onto the indexed column — no raw cast required.
    if (query.status) where.status = query.status;

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
    requestId?: string,
  ): Promise<ReviewDecisionResult> {
    const result = await review(
      this.idempotency,
      ownerId,
      applicationId,
      dto,
      APPLICATION_ROUTE_KEY,
      async () => {
        // One timestamp captured up front so the status enum write and the
        // durable `decided_at` on the ledger row share the exact same instant.
        // The Application model carries no lifecycle timestamp columns
        // (shortlisted_at / rejected_at), so — unlike the listing half — the
        // decision instant lives only on the ledger row, never on the entity.
        const decidedAt = new Date();
        const found = await this.prisma.application.findUnique({
          where: { id: applicationId },
          select: { id: true },
        });
        if (!found) throw notFound('application');
        // Status-guarded write: only a still-reviewable (submitted) row advances.
        // A repeat decision matches zero rows here and falls through to the
        // ledger replay, so the first stored decision can never be silently
        // overwritten (P1-3).
        const updated = await this.prisma.application.updateMany({
          where: { id: applicationId, status: APPLICATION_REVIEWABLE },
          data: { status: APPLICATION_NEXT[dto.decision] },
        });
        if (updated.count === 0) throw alreadyDecided('application');
        return {
          id: applicationId,
          status: APPLICATION_NEXT[dto.decision],
          decision: dto.decision,
          // Persisted to the idempotency ledger and round-tripped on replay so
          // the first-decision and replay responses share the same shape, in
          // line with TM-7a's evolved ReviewDecisionResult contract.
          note: dto.note ?? null,
          decided_by: ownerId,
          decided_at: decidedAt.toISOString(),
        };
      },
    );

    // Structured moderation-decision audit event on BOTH the first decision and
    // every replay (mirrors the listing half's logModerationDecision).
    this.logModerationDecision(ownerId, applicationId, result, requestId);
    return result;
  }

  private logModerationDecision(
    ownerId: string,
    applicationId: string,
    result: ReviewDecisionResult,
    requestId?: string,
  ): void {
    this.logger.log(
      {
        event: 'talent_marketplace.application.moderation_decision',
        owner_id: ownerId,
        application_id: applicationId,
        decision: result.decision,
        note: truncateNote(result.note),
        replayed: result.replayed,
        result_status: result.status,
        // Correlate the decision with the request/error/Sentry trail when the
        // request-scoped id is available; omit the key entirely otherwise so we
        // never log a `null`/`undefined` request_id (B-P2-7).
        ...(requestId ? { request_id: requestId } : {}),
      },
      'application moderation decision',
    );
  }
}
