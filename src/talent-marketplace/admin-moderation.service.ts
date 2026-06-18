// TM-7a — Owner-only listing moderation.
// Reads are keyset-paginated review queues; review POSTs are atomic
// claim-or-replay via the TM-4 idempotency ledger so a double-tapped decision
// returns the FIRST decision verbatim instead of re-applying it. Every response
// is an explicit allow-list DTO — no raw entity is spread.
//
// The shared review-queue helpers (keysetWhere/page/notFound/toLedgerJson/
// fromLedger) and the atomic `review` wrapper are exported so the TM-7b
// applicant-review service can import them without duplicating the ledger
// protocol. The applications half itself ships in admin-applications.service.ts.
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
  ListingReviewCardDto,
  ReviewDecisionDto,
  ReviewDecisionResult,
  ReviewQueueQueryDto,
  ReviewQueueResponse,
} from './admin-moderation.dto';

export const LISTING_ROUTE_KEY = 'tm:admin:listings:review';

// Decision → next enum state. Kept explicit (no invented schema): listings
// approve→published / reject→closed. The pre-decision (reviewable) state is
// `draft`; the status-guarded write below pins the mutation to it so a SECOND
// decision matches zero rows and falls through to the ledger replay (P1-3).
const LISTING_NEXT = { approved: 'published', rejected: 'closed' } as const;
const LISTING_REVIEWABLE: Prisma.JobListingWhereInput['status'] = 'draft';

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
    if (query.status)
      where.status = query.status as Prisma.JobListingWhereInput['status'];

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

  async reviewListing(
    ownerId: string,
    listingId: string,
    dto: ReviewDecisionDto,
  ): Promise<ReviewDecisionResult> {
    return review(
      this.idempotency,
      ownerId,
      listingId,
      dto,
      LISTING_ROUTE_KEY,
      async () => {
        const found = await this.prisma.jobListing.findUnique({
          where: { id: listingId },
          select: { id: true },
        });
        if (!found) throw notFound('listing');
        // Status-guarded write: only a still-reviewable (draft) row advances.
        // A repeat decision (e.g. approve→reject) matches zero rows here and is
        // caught below, so the ledger's first stored result is what replays —
        // the decision can never be silently overwritten (P1-3).
        const updated = await this.prisma.jobListing.updateMany({
          where: { id: listingId, status: LISTING_REVIEWABLE },
          data: { status: LISTING_NEXT[dto.decision] },
        });
        if (updated.count === 0) throw alreadyDecided('listing');
        return {
          id: listingId,
          status: LISTING_NEXT[dto.decision],
          decision: dto.decision,
        };
      },
    );
  }
}

// ── Shared review-queue helpers (exported for TM-7b) ─────────────────────────

// (created_at, id) keyset predicate shared by both queues. Pre-cursor pages
// return everything; a cursor pins the strict "older than" tuple boundary.
export function keysetWhere<T extends { AND?: unknown }>(
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

export function page<R extends { created_at: Date; id: string }, C>(
  rows: R[],
  limit: number,
  toCard: (row: R) => C,
): ReviewQueueResponse<C> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toCard),
    next_cursor: hasMore && last ? buildReviewCursor(last) : null,
  };
}

// Shared atomic claim-or-replay wrapper. The first decision for a given
// (owner, route, idem-key) is persisted to the ledger; a replay returns it
// verbatim with replayed=true and never re-applies the mutation. The default
// idem-key intentionally OMITS the decision so approve-then-reject collides on
// the same key and replays the first stored result (P1-3).
export async function review(
  idempotency: MarketplaceIdempotencyService,
  ownerId: string,
  targetId: string,
  dto: ReviewDecisionDto,
  routeKey: string,
  apply: () => Promise<Omit<ReviewDecisionResult, 'replayed'>>,
): Promise<ReviewDecisionResult> {
  const idempotencyKey = dto.idempotency_key?.trim() || `review:${targetId}`;
  const claimKey = { userId: ownerId, routeKey, idempotencyKey };

  const claim = await idempotency.claimOrReplay(claimKey);
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
    const completed = await idempotency.markCompleted(
      claimKey,
      claim.claimNonce,
      toLedgerJson(result),
    );
    if (completed.outcome === 'conflict') return { ...result, replayed: true };
    return result;
  } catch (err) {
    await idempotency.releaseClaim(claimKey, claim.claimNonce);
    throw err;
  }
}

export function notFound(kind: 'listing' | 'application'): NotFoundException {
  return new NotFoundException({
    error: 'Not Found',
    message: `Job ${kind} not found`,
    code: `${kind}_not_found`,
  });
}

// A decision arrived for a row that is no longer in its reviewable state. This
// is released back to the ledger so a genuine retry with the SAME idem-key
// replays the first decision; only a fresh key (a real second decision) lands
// here, and it must not silently overwrite the first.
export function alreadyDecided(kind: 'listing' | 'application'): ConflictException {
  return new ConflictException({
    error: 'Conflict',
    message: `This ${kind} has already been decided.`,
    code: `${kind}_already_decided`,
  });
}

export function toLedgerJson(result: ReviewDecisionResult): Prisma.InputJsonValue {
  return {
    id: result.id,
    status: result.status,
    decision: result.decision,
  };
}

// Rebuild a decision result from a stored ledger row, validating each field so
// a corrupt row fails loudly rather than smuggling an off-shape object out.
export function fromLedger(value: Prisma.JsonValue): ReviewDecisionResult {
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
