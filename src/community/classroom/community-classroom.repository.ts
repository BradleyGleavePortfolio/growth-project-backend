import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityClassroomMediaAsset,
  CommunityClassroomPost,
  CommunityClassroomPostStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import type { ClassroomMediaKind } from './community-classroom.dto';

/**
 * A single page of a cursor-paginated read (D-040). `items` is at most `limit`
 * rows; `nextCursor` is the id of the last item when a further page exists (the
 * repository fetched `limit + 1` rows and saw the overflow row), else null.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const PAGE_DEFAULT_LIMIT = 20;
const PAGE_MAX_LIMIT = 50;

/**
 * Clamp a repository limit defensively. The DTO already enforces 1..50, but the
 * repository is the last line before the database, so an internal caller that
 * bypasses the DTO still cannot trigger an unbounded `take`.
 */
function clampLimit(limit: number | undefined): number {
  const n = limit ?? PAGE_DEFAULT_LIMIT;
  if (!Number.isFinite(n)) return PAGE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PAGE_MAX_LIMIT, Math.trunc(n)));
}

/** A lesson row joined with its media assets — the unit every read returns. */
export type ClassroomPostWithMedia = CommunityClassroomPost & {
  media_assets: CommunityClassroomMediaAsset[];
};

/** One media asset to persist alongside a new lesson, with its server key. */
export interface ClassroomMediaSeed {
  kind: ClassroomMediaKind;
  storageKey: string;
  bytes: number;
  mimeType: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Data access for community classroom posts (v3-2).
 *
 * Tenant scoping follows the v1-2 / v3-1 doctrine: the app connects as the
 * Supabase service_role (BYPASSRLS), so isolation is enforced HERE in explicit
 * query filters, never assumed from Postgres RLS (the migration's RLS policies
 * are defence-in-depth). Every method takes an already-authorised workspace /
 * cohort / post id resolved by the service layer.
 *
 * The feed read joins media in a SINGLE query via Prisma `include` (NOT a
 * per-post media loop) so the classroom feed is N+1-free (Failure #1). Multi-row
 * writes (a post + its media assets) go through `$transaction` so a partial
 * write can never leave an orphaned post or asset (Failure #18).
 */
@Injectable()
export class CommunityClassroomRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Slice a `limit + 1` fetch down to one page and derive the cursor. */
  private paginate<T extends { id: string }>(rows: T[], limit: number): Page<T> {
    if (rows.length > limit) {
      const items = rows.slice(0, limit);
      return { items, nextCursor: items[items.length - 1].id };
    }
    return { items: rows, nextCursor: null };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Create a lesson and its declared media assets in ONE transaction. The post
   * is created first (it owns the id the assets FK to), then every asset row is
   * created inside the same `$transaction` callback, so either the whole lesson
   * (post + all media) commits or none of it does — there is no window where a
   * post exists without its declared media, or an asset exists without a post.
   */
  async createPostWithMedia(params: {
    workspaceId: string;
    cohortId: string | null;
    coachId: string;
    title: string;
    bodyMarkdown: string;
    status: CommunityClassroomPostStatus;
    pinned: boolean;
    pinnedOrder: number | null;
    releaseAt: Date | null;
    publishedAt: Date | null;
    media: ClassroomMediaSeed[];
  }): Promise<ClassroomPostWithMedia> {
    return this.prisma.$transaction(async (tx) => {
      const post = await tx.communityClassroomPost.create({
        data: {
          workspace_id: params.workspaceId,
          cohort_id: params.cohortId,
          coach_id: params.coachId,
          title: params.title,
          body_markdown: params.bodyMarkdown,
          status: params.status,
          pinned: params.pinned,
          pinned_order: params.pinnedOrder,
          release_at: params.releaseAt,
          published_at: params.publishedAt,
        },
      });

      if (params.media.length > 0) {
        await tx.communityClassroomMediaAsset.createMany({
          data: params.media.map((m) => ({
            post_id: post.id,
            workspace_id: params.workspaceId,
            kind: m.kind,
            storage_key: m.storageKey,
            bytes: m.bytes === null ? null : BigInt(m.bytes),
            mime_type: m.mimeType,
            duration_sec: m.durationSec,
            width: m.width,
            height: m.height,
          })),
        });
      }

      const assets = await tx.communityClassroomMediaAsset.findMany({
        where: { post_id: post.id },
        orderBy: { created_at: 'asc' },
      });
      return { ...post, media_assets: assets };
    });
  }

  async findPostById(postId: string): Promise<ClassroomPostWithMedia | null> {
    return this.prisma.communityClassroomPost.findUnique({
      where: { id: postId },
      include: { media_assets: { orderBy: { created_at: 'asc' } } },
    });
  }

  async updatePost(
    postId: string,
    data: Prisma.CommunityClassroomPostUpdateInput,
  ): Promise<ClassroomPostWithMedia> {
    return this.prisma.communityClassroomPost.update({
      where: { id: postId },
      data,
      include: { media_assets: { orderBy: { created_at: 'asc' } } },
    });
  }

  /** Soft-delete a lesson (the row stays for audit; reads exclude it). */
  async softDeletePost(postId: string, now: Date): Promise<void> {
    await this.prisma.communityClassroomPost.update({
      where: { id: postId },
      data: { soft_deleted_at: now, status: 'archived' },
    });
  }

  // ── Coach feed (authoring view — every non-deleted lesson) ─────────────────

  /**
   * The coach's authoring feed: every non-soft-deleted lesson in the workspace
   * (optionally a cohort), ordered pinned-first. Includes drafts and scheduled
   * lessons the coach owns — visibility gating is the student feed's job, not
   * this one's. Cursor-paginated (D-040).
   */
  async listForCoach(params: {
    workspaceId: string;
    cohortId: string | null;
    limit?: number;
    cursor?: string;
  }): Promise<Page<ClassroomPostWithMedia>> {
    const limit = clampLimit(params.limit);
    const filter: Prisma.CommunityClassroomPostWhereInput = {
      workspace_id: params.workspaceId,
      soft_deleted_at: null,
      ...(params.cohortId !== null ? { cohort_id: params.cohortId } : {}),
    };
    return this.runFeedQuery(filter, limit, params.cursor);
  }

  // ── Student feed (released, published, membership-scoped) ──────────────────

  /**
   * The student feed: only published, released (release_at null or <= now),
   * non-soft-deleted lessons the member may see — workspace-wide rows
   * (cohort_id = null) plus exactly the cohorts they actively belong to. The
   * release predicate is pushed INTO the query (not post-filtered) so the page,
   * its cursor anchor, and the overflow row that becomes nextCursor all share
   * one predicate — a release-locked or hidden-cohort lesson can never be
   * returned NOR become a public cursor token (Failure #5 IDOR). Mirrors the
   * RLS member-select policy.
   */
  async listForStudent(params: {
    workspaceId: string;
    // null → workspace-wide only; a list → workspace-wide plus these cohorts.
    visibleCohortIds: string[];
    cohortFilter: string | null;
    now: Date;
    limit?: number;
    cursor?: string;
  }): Promise<Page<ClassroomPostWithMedia>> {
    const limit = clampLimit(params.limit);
    const filter: Prisma.CommunityClassroomPostWhereInput = {
      workspace_id: params.workspaceId,
      soft_deleted_at: null,
      status: 'published',
      OR: [{ release_at: null }, { release_at: { lte: params.now } }],
      ...(params.cohortFilter !== null
        ? { cohort_id: params.cohortFilter }
        : {
            AND: [
              {
                OR: [
                  { cohort_id: null },
                  { cohort_id: { in: params.visibleCohortIds } },
                ],
              },
            ],
          }),
    };
    return this.runFeedQuery(filter, limit, params.cursor);
  }

  /**
   * Shared feed query: pinned lessons first (pinned_order ASC, NULLS LAST), then
   * non-pinned by published_at DESC, with a stable `id` tiebreak so equal-order
   * or equal-timestamp rows page deterministically (the pinned-ordering edge
   * case: a pinned lesson with a null pinned_order sorts after pinned lessons
   * that have an explicit order but still ahead of every non-pinned lesson,
   * because `pinned DESC` is the primary key of the sort). Media is joined in
   * the SAME query (no per-post loop → no N+1, Failure #1). Fetches `limit + 1`
   * to derive nextCursor; a stale/foreign cursor that does not resolve within
   * the filter yields the first page rather than throwing.
   */
  private async runFeedQuery(
    filter: Prisma.CommunityClassroomPostWhereInput,
    limit: number,
    cursor: string | undefined,
  ): Promise<Page<ClassroomPostWithMedia>> {
    let cursorClause: { cursor: { id: string }; skip: 1 } | null = null;
    if (cursor) {
      const anchor = await this.prisma.communityClassroomPost.findFirst({
        where: { ...filter, id: cursor },
        select: { id: true },
      });
      if (anchor) {
        cursorClause = { cursor: { id: anchor.id }, skip: 1 };
      }
    }

    const rows = await this.prisma.communityClassroomPost.findMany({
      where: filter,
      orderBy: [
        { pinned: 'desc' },
        { pinned_order: { sort: 'asc', nulls: 'last' } },
        { published_at: { sort: 'desc', nulls: 'last' } },
        { created_at: 'desc' },
        { id: 'desc' },
      ],
      include: { media_assets: { orderBy: { created_at: 'asc' } } },
      take: limit + 1,
      ...(cursorClause ?? {}),
    });
    return this.paginate(rows, limit);
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  /** Resolve a single media asset by id (service binds it to a post first). */
  async findMediaById(
    mediaId: string,
  ): Promise<CommunityClassroomMediaAsset | null> {
    return this.prisma.communityClassroomMediaAsset.findUnique({
      where: { id: mediaId },
    });
  }

  /**
   * Attach additional media to an existing lesson, returning the persisted rows
   * (ids needed to mint signed upload URLs). A single createMany keeps the write
   * atomic; the post is assumed already authorised + existing by the caller.
   */
  async attachMedia(params: {
    postId: string;
    workspaceId: string;
    media: ClassroomMediaSeed[];
  }): Promise<CommunityClassroomMediaAsset[]> {
    if (params.media.length === 0) return [];
    return this.prisma.$transaction(async (tx) => {
      await tx.communityClassroomMediaAsset.createMany({
        data: params.media.map((m) => ({
          post_id: params.postId,
          workspace_id: params.workspaceId,
          kind: m.kind,
          storage_key: m.storageKey,
          bytes: m.bytes === null ? null : BigInt(m.bytes),
          mime_type: m.mimeType,
          duration_sec: m.durationSec,
          width: m.width,
          height: m.height,
        })),
      });
      return tx.communityClassroomMediaAsset.findMany({
        where: {
          post_id: params.postId,
          storage_key: { in: params.media.map((m) => m.storageKey) },
        },
      });
    });
  }
}
