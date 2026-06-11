import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommunityMessage } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import type { PlanContextTag } from '../plan-context/plan-context.dto';

/**
 * Data access for cohort messages and post-comments.
 *
 * Tenant scoping follows the v1-2 doctrine (community.repository.ts): the app
 * connects as the Supabase service_role (BYPASSRLS), so isolation is enforced
 * HERE in explicit query filters, never assumed from Postgres RLS. Every read
 * is bounded by cohort/workspace membership at the service layer; the methods
 * below take the already-authorised cohort/workspace id.
 *
 * community_messages has a COMPOSITE primary key [id, created_at] (Postgres
 * range partitioning). Prisma cannot findUnique/update/delete by `id` alone, so
 * single-row reads use findFirst({ where: { id } }) and mutations resolve the
 * partition key (created_at) first, then update by the composite unique.
 */
@Injectable()
export class CommunityMessagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createCohortMessage(params: {
    workspaceId: string;
    cohortId: string;
    senderId: string;
    body: string;
    // v2-1: a validated plan-context tag to persist into plan_context_payload
    // (JsonB). Null/undefined writes a SQL NULL — the common, untagged case and
    // the only case when FEATURE_COMMUNITY_PLAN_TAGS is off (tag dropped on send).
    planContext?: PlanContextTag | null;
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
        plan_context_payload:
          params.planContext == null
            ? Prisma.JsonNull
            : (params.planContext as unknown as Prisma.InputJsonValue),
      },
    });
  }

  /**
   * Clear the "unanswered" flag on a cohort's outstanding client messages.
   *
   * Producer for the coach-inbox message arm (community-coach-inbox.repository
   * `unansweredMessages` reads `coach_replied_at IS NULL`). Called when a coach
   * sends a cohort message: every prior non-deleted, non-comment CLIENT message
   * in that cohort that is still open is stamped `coach_replied_at = now`, so it
   * drops out of the inbox. Bounded to client (non coach/owner) senders so the
   * coach's own messages are never flagged. Returns the count updated.
   */
  async markCohortClientMessagesReplied(params: {
    cohortId: string;
    repliedAt: Date;
  }): Promise<number> {
    const { count } = await this.prisma.communityMessage.updateMany({
      where: {
        cohort_id: params.cohortId,
        scope: 'cohort',
        deleted_at: null,
        plan_context_type: null,
        coach_replied_at: null,
        sender: { role: { notIn: ['coach', 'owner'] } },
      },
      data: { coach_replied_at: params.repliedAt },
    });
    return count;
  }

  /** A single message by id (any scope), or null. */
  async findById(messageId: string): Promise<CommunityMessage | null> {
    return this.prisma.communityMessage.findFirst({
      where: { id: messageId },
    });
  }

  /**
   * Cohort messages newest-first, cursor-paginated by created_at. `before` is an
   * ISO timestamp; rows strictly older than it are returned. Soft-deleted rows
   * are excluded.
   *
   * Post-comments are stored as CommunityMessage rows (scope='cohort', same
   * cohort_id) tagged with plan_context_type=COMMENT_CONTEXT_TYPE. They must NOT
   * appear in the cohort chat feed, so this list is bounded to rows with a null
   * discriminator. The community module is the only writer of plan_context_type
   * on cohort-scope messages (verified by grep), so `null` is the tightest
   * correct exclusion — a plain cohort message never sets it.
   */
  async listCohortMessages(params: {
    cohortId: string;
    before: Date | null;
    limit: number;
  }): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        cohort_id: params.cohortId,
        scope: 'cohort',
        deleted_at: null,
        plan_context_type: null,
        ...(params.before ? { created_at: { lt: params.before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: params.limit,
    });
  }

  async updateBody(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
    body: string,
  ): Promise<CommunityMessage> {
    return this.prisma.communityMessage.update({
      where: {
        id_created_at: { id: message.id, created_at: message.created_at },
      },
      data: { body },
    });
  }

  async softDelete(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
  ): Promise<CommunityMessage> {
    return this.prisma.communityMessage.update({
      where: {
        id_created_at: { id: message.id, created_at: message.created_at },
      },
      data: { deleted_at: new Date(), visibility: 'hidden' },
    });
  }

  // ── Post comments (stored as CommunityMessage; see service docblock) ───────

  async createComment(params: {
    workspaceId: string;
    cohortId: string | null;
    senderId: string;
    postId: string;
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
        plan_context_type: COMMENT_CONTEXT_TYPE,
        plan_context_id: params.postId,
      },
    });
  }

  async listComments(postId: string): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: COMMENT_CONTEXT_TYPE,
        plan_context_id: postId,
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
  }
}

/**
 * Discriminator written to community_messages.plan_context_type so a post
 * comment is distinguishable from a plain cohort message. plan_context_id holds
 * the parent post id. Reusing these existing columns avoids a schema change
 * (R69) while storing the full comment body honestly in the 4000-char `body`
 * column (no truncation).
 */
export const COMMENT_CONTEXT_TYPE = 'community_post_comment';
