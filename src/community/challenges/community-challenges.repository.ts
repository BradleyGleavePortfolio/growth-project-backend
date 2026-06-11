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

  async listChallenges(params: {
    workspaceId: string;
    cohortId: string | null;
    status: CommunityChallengeStatus | null;
  }): Promise<CommunityChallenge[]> {
    return this.prisma.communityChallenge.findMany({
      where: {
        workspace_id: params.workspaceId,
        archived_at: null,
        ...(params.cohortId !== null ? { cohort_id: params.cohortId } : {}),
        ...(params.status !== null ? { status: params.status } : {}),
      },
      orderBy: { created_at: 'desc' },
    });
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
   * Atomically apply a progress log in a single SQL statement so concurrent
   * writers cannot lose the higher value or double-fire completion (Finding 2).
   *
   *   - progress_value = GREATEST(progress_value, :incoming) — monotonic; a
   *     lower log never regresses the bar (design §3.4, no shame state).
   *   - completed_at = COALESCE(completed_at, <now if the NEW value reaches a
   *     positive target>) — set exactly once, never cleared.
   *
   * The CTE captures the PRE-update completed_at so RETURNING can report
   * `completion_transitioned` = true only for the single statement that flipped
   * it from NULL. The caller emits the milestone push / telemetry solely on
   * that flag, so racing target-reaching writers produce exactly one emission.
   *
   * `target` is null (or <= 0) for an open-ended challenge; in that case the
   * CASE never fires and completion stays null.
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
    const rows = await this.prisma.$queryRaw<
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
        completion_transitioned: boolean;
      }>
    >`
      WITH prior AS (
        SELECT completed_at AS prev_completed_at
        FROM community_challenge_participations
        WHERE challenge_id = ${params.challengeId}::uuid
          AND user_id = ${params.userId}::uuid
      ),
      updated AS (
        UPDATE community_challenge_participations AS p
        SET
          progress_value = GREATEST(p.progress_value, ${params.incoming}),
          last_logged_at = ${params.now},
          completed_at = COALESCE(
            p.completed_at,
            CASE
              WHEN ${targetSql}::numeric IS NOT NULL
               AND GREATEST(p.progress_value, ${params.incoming}) >= ${targetSql}::numeric
              THEN ${params.now}
              ELSE NULL
            END
          ),
          updated_at = ${params.now}
        WHERE p.challenge_id = ${params.challengeId}::uuid
          AND p.user_id = ${params.userId}::uuid
        RETURNING p.*
      )
      SELECT
        u.id,
        u.workspace_id,
        u.challenge_id,
        u.user_id,
        u.progress_value,
        u.completed_at,
        u.last_logged_at,
        u.created_at,
        u.updated_at,
        (prior.prev_completed_at IS NULL AND u.completed_at IS NOT NULL)
          AS completion_transitioned
      FROM updated AS u CROSS JOIN prior
    `;
    const row = rows[0];
    const { completion_transitioned, ...rest } = row;
    return {
      participation: rest as CommunityChallengeParticipation,
      completionTransitioned: completion_transitioned,
    };
  }

  /** Leaderboard ordering: highest progress first, earliest completion as tiebreak. */
  async listParticipationsByProgress(
    challengeId: string,
  ): Promise<CommunityChallengeParticipation[]> {
    return this.prisma.communityChallengeParticipation.findMany({
      where: { challenge_id: challengeId },
      orderBy: [{ progress_value: 'desc' }, { last_logged_at: 'asc' }],
    });
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

  async listComments(challengeId: string): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE,
        plan_context_id: challengeId,
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
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
