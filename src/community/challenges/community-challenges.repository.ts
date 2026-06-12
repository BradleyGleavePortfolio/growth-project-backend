import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityChallenge,
  CommunityChallengeParticipation,
  CommunityChallengeStatus,
  CommunityMessage,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * A single page of a cursor-paginated read (D-040). `items` is at most `limit`
 * rows; `nextCursor` is the id of the last item when a further page exists
 * (the repository fetched `limit + 1` rows and saw the overflow row), else
 * null. The service maps this directly onto the `{ items, next_cursor }` API
 * contract — `next_cursor` is therefore always an id the caller can replay as
 * `cursor` to fetch the following page.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Clamp a repository limit defensively. The DTO already enforces 1..50, but the
 * repository is the last line before the database, so an internal caller that
 * bypasses the DTO still cannot trigger an unbounded or absurd `take`. A
 * missing limit falls back to the shared default page size.
 */
function clampLimit(limit: number | undefined): number {
  const n = limit ?? PAGE_DEFAULT_LIMIT;
  if (!Number.isFinite(n)) return PAGE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PAGE_MAX_LIMIT, Math.trunc(n)));
}

const PAGE_DEFAULT_LIMIT = 20;
const PAGE_MAX_LIMIT = 50;

/**
 * Data access for community challenges.
 *
 * Tenant scoping follows the v1-2 doctrine (community.repository.ts): the app
 * connects as the Supabase service_role (BYPASSRLS), so isolation is enforced
 * HERE in explicit query filters, never assumed from Postgres RLS. Every method
 * takes an already-authorised workspace / cohort / challenge id resolved by the
 * service layer.
 *
 * No schema is introduced (R69). The CommunityChallenge and
 * CommunityChallengeParticipation models already exist on main. Two challenge
 * sub-surfaces have no dedicated model, so each REUSES the existing
 * CommunityMessage model with a distinct plan_context_type discriminator:
 *   - challenge encouragement comments → CHALLENGE_COMMENT_CONTEXT_TYPE
 *   - per-participant leaderboard opt-in flag → CHALLENGE_OPTIN_CONTEXT_TYPE
 * Both are scope='cohort' rows carrying a non-null plan_context_type, so the
 * cohort chat feed (which lists only plan_context_type=null rows — see
 * community-messages.repository.ts) never surfaces them.
 *
 * community_messages has a COMPOSITE primary key [id, created_at] (range
 * partitioning), so single-row reads use findFirst({ where: { id } }) and
 * mutations resolve the partition key first, then write by the composite unique.
 */
@Injectable()
export class CommunityChallengesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Challenge definitions ──────────────────────────────────────────────────

  async createChallenge(params: {
    workspaceId: string;
    cohortId: string | null;
    createdById: string;
    title: string;
    description: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
    metricKey: string | null;
    targetValue: number | null;
    unit: string | null;
    leaderboardEnabled: boolean;
  }): Promise<CommunityChallenge> {
    return this.prisma.communityChallenge.create({
      data: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        created_by_id: params.createdById,
        title: params.title,
        description: params.description,
        status: 'active',
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        metric_key: params.metricKey,
        target_value:
          params.targetValue === null
            ? null
            : new Prisma.Decimal(params.targetValue),
        unit: params.unit,
        leaderboard_enabled: params.leaderboardEnabled,
      },
    });
  }

  async findChallengeById(
    challengeId: string,
  ): Promise<CommunityChallenge | null> {
    return this.prisma.communityChallenge.findUnique({
      where: { id: challengeId },
    });
  }

  /**
   * Cursor-paginated challenge list (D-040). Fetches `limit + 1` rows so the
   * presence of an overflow row reveals whether a further page exists without a
   * second COUNT query; the overflow row is dropped and its predecessor's id
   * becomes `nextCursor`. `cursor` (when present) is the id of the last item of
   * the previous page; `skip: 1` excludes that anchor row from this page.
   */
  async listChallenges(params: {
    workspaceId: string;
    cohortId: string | null;
    status: CommunityChallengeStatus | null;
    limit?: number;
    cursor?: string;
  }): Promise<Page<CommunityChallenge>> {
    const limit = clampLimit(params.limit);
    const rows = await this.prisma.communityChallenge.findMany({
      where: {
        workspace_id: params.workspaceId,
        archived_at: null,
        ...(params.cohortId !== null ? { cohort_id: params.cohortId } : {}),
        ...(params.status !== null ? { status: params.status } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });
    return this.paginate(rows, limit);
  }

  /**
   * Slice a `limit + 1` fetch down to one page and derive the cursor. When the
   * extra row is present a further page exists, so the overflow row is dropped
   * and the last KEPT row's id is the cursor; otherwise this is the final page
   * and the cursor is null. Shared by every id-keyed paginated read here.
   */
  private paginate<T extends { id: string }>(
    rows: T[],
    limit: number,
  ): Page<T> {
    if (rows.length > limit) {
      const items = rows.slice(0, limit);
      return { items, nextCursor: items[items.length - 1].id };
    }
    return { items: rows, nextCursor: null };
  }

  async updateChallenge(
    challengeId: string,
    data: Prisma.CommunityChallengeUpdateInput,
  ): Promise<CommunityChallenge> {
    return this.prisma.communityChallenge.update({
      where: { id: challengeId },
      data,
    });
  }

  async archiveChallenge(challengeId: string): Promise<CommunityChallenge> {
    return this.prisma.communityChallenge.update({
      where: { id: challengeId },
      data: { status: 'archived', archived_at: new Date() },
    });
  }

  // ── Participation ───────────────────────────────────────────────────────────

  async findParticipation(
    challengeId: string,
    userId: string,
  ): Promise<CommunityChallengeParticipation | null> {
    return this.prisma.communityChallengeParticipation.findUnique({
      where: { challenge_id_user_id: { challenge_id: challengeId, user_id: userId } },
    });
  }

  async createParticipation(params: {
    workspaceId: string;
    challengeId: string;
    userId: string;
  }): Promise<CommunityChallengeParticipation> {
    return this.prisma.communityChallengeParticipation.create({
      data: {
        workspace_id: params.workspaceId,
        challenge_id: params.challengeId,
        user_id: params.userId,
      },
    });
  }

  async updateParticipation(
    challengeId: string,
    userId: string,
    data: Prisma.CommunityChallengeParticipationUpdateInput,
  ): Promise<CommunityChallengeParticipation> {
    return this.prisma.communityChallengeParticipation.update({
      where: { challenge_id_user_id: { challenge_id: challengeId, user_id: userId } },
      data,
    });
  }

  /**
   * Apply a progress log so concurrent writers cannot lose the higher value or
   * double-fire completion (Finding 2).
   *
   * Done in two writes against the same row:
   *   1. Progress write — progress_value = GREATEST(progress_value, :incoming),
   *      monotonic; a lower log never regresses the bar (design §3.4, no shame
   *      state). last_logged_at / updated_at advance too. This write is always
   *      idempotent-safe and carries no completion side effect.
   *   2. Completion claim — a SEPARATE conditional statement
   *      `UPDATE ... SET completed_at = :now WHERE id = :id AND completed_at IS
   *      NULL AND progress_value >= target RETURNING id`. Exactly one statement
   *      can match `completed_at IS NULL`: the loser waits on the row lock, then
   *      re-evaluates its WHERE against the already-completed row, matches zero
   *      rows, and returns no row. `completion_transitioned` is therefore
   *      derived from the row version THIS call wrote — true iff the claim
   *      returned a row. The caller emits the milestone push / telemetry solely
   *      on that flag, so racing target-reaching writers produce exactly one
   *      emission.
   *
   * `target` is null (or <= 0) for an open-ended challenge; the completion claim
   * is skipped entirely in that case and completion stays null.
   */
  async applyProgressAtomically(params: {
    challengeId: string;
    userId: string;
    incoming: Prisma.Decimal;
    target: Prisma.Decimal | null;
    now: Date;
  }): Promise<{
    participation: CommunityChallengeParticipation;
    completionTransitioned: boolean;
  }> {
    const hasTarget = params.target !== null && params.target.greaterThan(0);
    const targetSql = hasTarget
      ? (params.target as Prisma.Decimal).toString()
      : null;

    // Write 1 — monotonic progress. GREATEST keeps the higher of the stored and
    // incoming value so concurrent writers never regress the bar; this write
    // never touches completed_at and so has no completion side effect.
    const progressRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspace_id: string;
        challenge_id: string;
        user_id: string;
        progress_value: Prisma.Decimal;
        completed_at: Date | null;
        last_logged_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >`
      UPDATE community_challenge_participations AS p
      SET
        progress_value = GREATEST(p.progress_value, ${params.incoming}),
        last_logged_at = ${params.now},
        updated_at = ${params.now}
      WHERE p.challenge_id = ${params.challengeId}::uuid
        AND p.user_id = ${params.userId}::uuid
      RETURNING
        p.id,
        p.workspace_id,
        p.challenge_id,
        p.user_id,
        p.progress_value,
        p.completed_at,
        p.last_logged_at,
        p.created_at,
        p.updated_at
    `;
    const progressRow = progressRows[0];

    // Write 2 — completion claim. A SEPARATE conditional statement that only the
    // single transitioning writer can match: `completed_at IS NULL` plus the
    // now-persisted progress reaching a positive target. A concurrent loser
    // waits on the row lock, re-evaluates against the already-completed row,
    // matches zero rows, and RETURNS NOTHING. The transition flag is therefore
    // derived from the row version THIS call actually wrote — true iff the claim
    // returned a row — never from an unlocked pre-update snapshot.
    let completionRow: { completed_at: Date | null } | undefined;
    if (targetSql !== null) {
      const claimedRows = await this.prisma.$queryRaw<
        Array<{ id: string; completed_at: Date | null }>
      >`
        UPDATE community_challenge_participations AS p
        SET completed_at = ${params.now}
        WHERE p.challenge_id = ${params.challengeId}::uuid
          AND p.user_id = ${params.userId}::uuid
          AND p.completed_at IS NULL
          AND p.progress_value >= ${targetSql}::numeric
        RETURNING p.id, p.completed_at
      `;
      completionRow = claimedRows[0];
    }
    const completionTransitioned = completionRow !== undefined;

    return {
      participation: {
        ...progressRow,
        // Reflect the timestamp this call claimed; otherwise keep whatever the
        // progress write read (already-set for a prior completion, or null).
        completed_at: completionTransitioned
          ? (completionRow as { completed_at: Date | null }).completed_at
          : progressRow.completed_at,
      } as CommunityChallengeParticipation,
      completionTransitioned,
    };
  }

  /**
   * Leaderboard ordering: highest progress first, earliest completion as
   * tiebreak. Cursor-paginated (D-040): fetches `limit + 1` rows ordered by
   * (progress_value desc, last_logged_at asc) with a stable `id` tiebreak so
   * the cursor is deterministic across equal-progress rows. `cursor` is the id
   * of the previous page's last participation; `skip: 1` drops that anchor.
   * `nextCursor` is the last kept participation id when an overflow row exists.
   */
  async listParticipationsByProgress(params: {
    challengeId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<CommunityChallengeParticipation>> {
    const limit = clampLimit(params.limit);
    const rows = await this.prisma.communityChallengeParticipation.findMany({
      where: { challenge_id: params.challengeId },
      orderBy: [
        { progress_value: 'desc' },
        { last_logged_at: 'asc' },
        { id: 'asc' },
      ],
      take: limit + 1,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });
    return this.paginate(rows, limit);
  }

  // ── Leaderboard opt-in (CommunityMessage sentinel) ──────────────────────────

  async findOptIn(
    challengeId: string,
    userId: string,
  ): Promise<CommunityMessage | null> {
    return this.prisma.communityMessage.findFirst({
      where: {
        plan_context_type: CHALLENGE_OPTIN_CONTEXT_TYPE,
        plan_context_id: challengeId,
        sender_id: userId,
        deleted_at: null,
      },
    });
  }

  async setOptIn(params: {
    workspaceId: string;
    cohortId: string | null;
    challengeId: string;
    userId: string;
  }): Promise<void> {
    const existing = await this.findOptIn(params.challengeId, params.userId);
    if (existing) return;
    await this.prisma.communityMessage.create({
      data: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        scope: 'cohort',
        kind: 'system',
        sender_id: params.userId,
        visibility: 'active',
        plan_context_type: CHALLENGE_OPTIN_CONTEXT_TYPE,
        plan_context_id: params.challengeId,
      },
    });
  }

  async clearOptIn(challengeId: string, userId: string): Promise<void> {
    const rows = await this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: CHALLENGE_OPTIN_CONTEXT_TYPE,
        plan_context_id: challengeId,
        sender_id: userId,
        deleted_at: null,
      },
      select: { id: true, created_at: true },
    });
    for (const row of rows) {
      await this.prisma.communityMessage.update({
        where: { id_created_at: { id: row.id, created_at: row.created_at } },
        data: { deleted_at: new Date(), visibility: 'hidden' },
      });
    }
  }

  /** Set of user ids who have personally opted into a challenge's leaderboard. */
  async listOptedInUserIds(challengeId: string): Promise<Set<string>> {
    const rows = await this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: CHALLENGE_OPTIN_CONTEXT_TYPE,
        plan_context_id: challengeId,
        deleted_at: null,
      },
      select: { sender_id: true },
    });
    return new Set(rows.map((r) => r.sender_id));
  }

  // ── Comments (CommunityMessage with challenge discriminator) ────────────────

  async createComment(params: {
    workspaceId: string;
    cohortId: string | null;
    senderId: string;
    challengeId: string;
    body: string;
  }): Promise<CommunityMessage> {
    return this.prisma.communityMessage.create({
      data: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        scope: 'cohort',
        kind: 'text',
        sender_id: params.senderId,
        body: params.body,
        visibility: 'active',
        plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE,
        plan_context_id: params.challengeId,
      },
    });
  }

  /**
   * Cursor-paginated challenge comments (D-040). community_messages has a
   * COMPOSITE primary key [id, created_at] (range partitioning), so Prisma's
   * `cursor` cannot key on the bare id: it needs the `id_created_at` compound
   * selector. The public cursor token is just the comment id, so when a cursor
   * is supplied we first resolve that row's created_at (findFirst by id, any
   * partition) and use it to build the compound cursor. A cursor that no longer
   * resolves (deleted/foreign id) yields the FIRST page rather than throwing,
   * so a stale client cursor degrades gracefully instead of erroring. Fetches
   * `limit + 1` to derive nextCursor the same way as the other reads.
   */
  async listComments(params: {
    challengeId: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<CommunityMessage>> {
    const limit = clampLimit(params.limit);

    let cursorClause: {
      cursor: Prisma.CommunityMessageWhereUniqueInput;
      skip: number;
    } | null = null;
    if (params.cursor) {
      const anchor = await this.prisma.communityMessage.findFirst({
        where: { id: params.cursor },
        select: { id: true, created_at: true },
      });
      if (anchor) {
        cursorClause = {
          cursor: {
            id_created_at: { id: anchor.id, created_at: anchor.created_at },
          },
          skip: 1,
        };
      }
    }

    const rows = await this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE,
        plan_context_id: params.challengeId,
        deleted_at: null,
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorClause ?? {}),
    });
    return this.paginate(rows, limit);
  }

  /**
   * Resolve a single CommunityMessage row by id (any discriminator) so the
   * service can bind a reported commentId to its challenge before delegating to
   * moderation (Finding 5). community_messages has a composite PK [id,
   * created_at], so this uses findFirst({ where: { id } }).
   */
  async findCommentById(commentId: string): Promise<CommunityMessage | null> {
    return this.prisma.communityMessage.findFirst({
      where: { id: commentId },
    });
  }
}

/**
 * Discriminator written to community_messages.plan_context_type so a challenge
 * encouragement comment is distinguishable from a cohort chat message and a
 * post comment. plan_context_id holds the parent challenge id. Reusing the
 * existing CommunityMessage model avoids a schema change (R69) while storing the
 * full comment body in the 4000-char `body` column (no truncation).
 */
export const CHALLENGE_COMMENT_CONTEXT_TYPE = 'community_challenge_comment';

/**
 * Discriminator for the per-participant leaderboard opt-in sentinel. Presence of
 * a non-deleted row (sender_id = participant, plan_context_id = challenge) means
 * the participant has personally consented to appear on the leaderboard. Opt-out
 * soft-deletes the row. Stored on CommunityMessage because the existing
 * participation model has no opt-in column and R69 forbids adding one.
 */
export const CHALLENGE_OPTIN_CONTEXT_TYPE = 'community_challenge_optin';
