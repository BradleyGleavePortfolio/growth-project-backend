// TM-7 — Owner-only listing moderation + applicant review.
// Reads are keyset-paginated review queues; review POSTs are atomic
// claim-or-replay via the TM-4 idempotency ledger so a double-tapped decision
// returns the FIRST decision verbatim instead of re-applying it. Every response
// is an explicit allow-list DTO — no raw entity is spread.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import {
  buildReviewCursor,
  clampReviewLimit,
  parseReviewCursor,
} from './admin-review-cursor';
import type {
  ApplicationReviewCardDto,
  ListingReviewCardDto,
  ReviewDecisionDto,
  ReviewDecisionResult,
  ReviewQueueQueryDto,
  ReviewQueueResponse,
} from './admin-moderation.dto';

const LISTING_ROUTE_KEY = 'tm:admin:listings:review';
const APPLICATION_ROUTE_KEY = 'tm:admin:applications:review';

// Decision → next enum state per queue. Kept explicit (no invented schema):
// listings approve→published / reject→closed; applications approve→shortlisted
// / reject→rejected.
const LISTING_NEXT = { approved: 'published', rejected: 'closed' } as const;
const APPLICATION_NEXT = {
  approved: 'shortlisted',
  rejected: 'rejected',
} as const;

@Injectable()
export class AdminModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // GET /admin/listings — keyset (created_at, id) review queue.
  async listListings(
    query: ReviewQueueQueryDto,
  ): Promise<ReviewQueueResponse<ListingReviewCardDto>> {
    const limit = clampReviewLimit(query.limit);
    const where: Prisma.JobListingWhereInput = keysetWhere(query, {});
    if (query.status) where.status = query.status as Prisma.JobListingWhereInput['status'];

    const rows = await this.prisma.jobListing.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return page(rows, limit, (r) => ({
      id: r.id,
      title: r.title,
      specialty: r.specialty,
      status: r.status,
      created_at: r.created_at.toISOString(),
    }));
  }

  // GET /admin/applications — same cursor pattern.
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

  async reviewListing(
    ownerId: string,
    listingId: string,
    dto: ReviewDecisionDto,
  ): Promise<ReviewDecisionResult> {
    return this.review(ownerId, listingId, dto, LISTING_ROUTE_KEY, async () => {
      const found = await this.prisma.jobListing.findUnique({
        where: { id: listingId },
        select: { id: true },
      });
      if (!found) throw notFound('listing');
      const updated = await this.prisma.jobListing.update({
        where: { id: listingId },
        data: { status: LISTING_NEXT[dto.decision] },
        select: { id: true, status: true },
      });
      return { id: updated.id, status: updated.status, decision: dto.decision };
    });
  }

  async reviewApplication(
    ownerId: string,
    applicationId: string,
    dto: ReviewDecisionDto,
  ): Promise<ReviewDecisionResult> {
    return this.review(
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
        const updated = await this.prisma.application.update({
          where: { id: applicationId },
          data: { status: APPLICATION_NEXT[dto.decision] },
          select: { id: true, status: true },
        });
        return {
          id: updated.id,
          status: updated.status,
          decision: dto.decision,
        };
      },
    );
  }

  // Shared atomic claim-or-replay wrapper. The first decision for a given
  // (owner, route, idem-key) is persisted to the ledger; a replay returns it
  // verbatim with replayed=true and never re-applies the mutation.
  private async review(
    ownerId: string,
    targetId: string,
    dto: ReviewDecisionDto,
    routeKey: string,
    apply: () => Promise<Omit<ReviewDecisionResult, 'replayed'>>,
  ): Promise<ReviewDecisionResult> {
    const idempotencyKey =
      dto.idempotency_key?.trim() || `review:${targetId}:${dto.decision}`;
    const claimKey = { userId: ownerId, routeKey, idempotencyKey };

    const claim = await this.idempotency.claimOrReplay(claimKey);
    if (claim.outcome === 'replay') return fromLedger(claim.response);
    if (claim.outcome === 'in_flight') {
      throw new ConflictException({
        error: 'Conflict',
        message: 'A review for this item is already in progress; retry shortly.',
        code: 'review_in_flight',
      });
    }

    try {
      const decided = await apply();
      const result: ReviewDecisionResult = { ...decided, replayed: false };
      const completed = await this.idempotency.markCompleted(
        claimKey,
        claim.claimNonce,
        toLedgerJson(result),
      );
      if (completed.outcome === 'conflict') return { ...result, replayed: true };
      return result;
    } catch (err) {
      await this.idempotency.releaseClaim(claimKey, claim.claimNonce);
      throw err;
    }
  }
}

// (created_at, id) keyset predicate shared by both queues. Pre-cursor pages
// return everything; a cursor pins the strict "older than" tuple boundary.
function keysetWhere<T extends { AND?: unknown }>(
  query: ReviewQueueQueryDto,
  base: T,
): T {
  const cursor = query.cursor ? parseReviewCursor(query.cursor) : null;
  if (!cursor) return base;
  return {
    ...base,
    AND: [
      {
        OR: [
          { created_at: { lt: cursor.created_at } },
          { created_at: cursor.created_at, id: { lt: cursor.id } },
        ],
      },
    ],
  };
}

function page<R extends { created_at: Date; id: string }, C>(
  rows: R[],
  limit: number,
  toCard: (row: R) => C,
): ReviewQueueResponse<C> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toCard),
    next_cursor:
      hasMore && last ? buildReviewCursor(last) : null,
  };
}

function notFound(kind: 'listing' | 'application'): NotFoundException {
  return new NotFoundException({
    error: 'Not Found',
    message: `Job ${kind} not found`,
    code: `${kind}_not_found`,
  });
}

function toLedgerJson(result: ReviewDecisionResult): Prisma.InputJsonValue {
  return {
    id: result.id,
    status: result.status,
    decision: result.decision,
  };
}

// Rebuild a decision result from a stored ledger row, validating each field so
// a corrupt row fails loudly rather than smuggling an off-shape object out.
function fromLedger(value: Prisma.JsonValue): ReviewDecisionResult {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (
      typeof row.id === 'string' &&
      typeof row.status === 'string' &&
      (row.decision === 'approved' || row.decision === 'rejected')
    ) {
      return {
        id: row.id,
        status: row.status,
        decision: row.decision,
        replayed: true,
      };
    }
  }
  throw new ConflictException({
    error: 'Conflict',
    message: 'Review replay corrupt',
    code: 'review_replay_corrupt',
  });
}
