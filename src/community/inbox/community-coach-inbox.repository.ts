import { Injectable } from '@nestjs/common';
import type {
  CommunityMessage,
  CommunityPost,
  User,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { authorsWhoLeft } from '../community-space-access';

/**
 * Data access for the coach inbox aggregator.
 *
 * Tenant scoping follows the v1-2 doctrine: the app connects as service_role
 * (BYPASSRLS), so the SERVICE bounds every read to cohorts the caller actually
 * coaches (resolved here from workspace ownership + coach/assistant
 * memberships). Postgres RLS remains as defence-in-depth. No method here trusts
 * a request-supplied id for authorization.
 *
 * C6-MOVED-PRIVILEGED-READS (owner: history follows the client): a client who
 * moved to another coach left these cohorts, so their rows are left out IN the
 * query (authorsWhoLeft asks app.community_author_stays, the rule the row
 * policies use). Each stream is limit-bounded, so a later filter would drop rows.
 */
export type MessageWithSender = CommunityMessage & {
  sender: Pick<User, 'id' | 'name' | 'role'>;
};

export type PostWithAuthor = CommunityPost & {
  author: Pick<User, 'id' | 'name' | 'role'>;
};

@Injectable()
export class CommunityCoachInboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cohort ids the caller coaches: every cohort in a workspace they OWN, plus
   * every cohort where they hold an active coach/assistant membership. De-duped.
   */
  async coachedCohortIds(userId: string): Promise<string[]> {
    const [ownedCohorts, coachMemberships] = await Promise.all([
      this.prisma.communityCohort.findMany({
        where: { workspace: { coach_id: userId } },
        select: { id: true },
      }),
      this.prisma.communityMembership.findMany({
        where: {
          user_id: userId,
          status: 'active',
          role: { in: ['coach', 'assistant'] },
        },
        select: { cohort_id: true },
      }),
    ]);
    const ids = new Set<string>();
    for (const c of ownedCohorts) ids.add(c.id);
    for (const m of coachMemberships) ids.add(m.cohort_id);
    return [...ids];
  }

  /**
   * Unanswered client messages across the given cohorts, oldest-first.
   *
   * "Unanswered" = a cohort-scope, non-deleted, non-comment message whose sender
   * is NOT a coach/assistant (a client) and which carries no coach reply
   * (coach_replied_at IS NULL). Ordered (created_at ASC, id ASC) — a stable FIFO
   * triage order with a deterministic tiebreak. Fetches `limit` rows; the caller
   * derives next_cursor.
   */
  async unansweredMessages(params: {
    cohortIds: string[];
    limit: number;
    after: { createdAt: Date; id: string } | null;
  }): Promise<MessageWithSender[]> {
    const { cohortIds, limit, after } = params;
    if (cohortIds.length === 0) return [];
    const left = await authorsWhoLeft(this.prisma, cohortIds);
    return this.prisma.communityMessage.findMany({
      where: {
        ...(left.length > 0 ? { NOT: left.map(([s, a]) => ({ cohort_id: s, sender_id: a })) } : {}),
        cohort_id: { in: cohortIds },
        scope: 'cohort',
        deleted_at: null,
        plan_context_type: null,
        coach_replied_at: null,
        sender: { role: { notIn: ['coach', 'owner'] } },
        ...(after
          ? {
              OR: [
                { created_at: { gt: after.createdAt } },
                { created_at: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { sender: { select: { id: true, name: true, role: true } } },
    });
  }

  /**
   * Unanswered client posts across the given cohorts, oldest-first.
   *
   * "Unanswered" = a cohort-scope, non-deleted post authored by a client (not a
   * coach/owner) that has NO coach-authored comment. Comments are stored as
   * CommunityMessage rows tagged plan_context_id = post.id (see
   * CommunityMessagesRepository.COMMENT_CONTEXT_TYPE). We fetch candidate posts
   * then filter those with a coach comment in a second bounded query.
   */
  async unansweredPosts(params: {
    cohortIds: string[];
    limit: number;
    after: { createdAt: Date; id: string } | null;
  }): Promise<PostWithAuthor[]> {
    const { cohortIds, limit, after } = params;
    if (cohortIds.length === 0) return [];
    const left = await authorsWhoLeft(this.prisma, cohortIds);
    const candidates = await this.prisma.communityPost.findMany({
      where: {
        ...(left.length > 0 ? { NOT: left.map(([s, a]) => ({ cohort_id: s, author_id: a })) } : {}),
        cohort_id: { in: cohortIds },
        scope: 'cohort',
        deleted_at: null,
        author: { role: { notIn: ['coach', 'owner'] } },
        ...(after
          ? {
              OR: [
                { created_at: { gt: after.createdAt } },
                { created_at: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
      include: { author: { select: { id: true, name: true, role: true } } },
    });
    if (candidates.length === 0) return [];

    // Which of these posts already has a coach-authored comment? A single
    // bounded query over the comment rows, joined to sender role.
    const answered = await this.prisma.communityMessage.findMany({
      where: {
        plan_context_id: { in: candidates.map((p) => p.id) },
        deleted_at: null,
        sender: { role: { in: ['coach', 'owner'] } },
      },
      select: { plan_context_id: true },
    });
    const answeredPostIds = new Set(
      answered.map((m) => m.plan_context_id).filter((v): v is string => !!v),
    );
    return candidates.filter((p) => !answeredPostIds.has(p.id));
  }
}
