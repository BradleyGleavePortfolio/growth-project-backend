import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CommunityResponse,
  CommunityResponseTargetType,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityMessagesRepository } from '../messages/community-messages.repository';
import { CommunityPostsRepository } from '../posts/community-posts.repository';
import { COMMENT_CONTEXT_TYPE } from '../messages/community-messages.repository';
import { CommunityReactionsRepository } from './community-reactions.repository';
import {
  CommunityReactionState,
  CommunityReactionStateSchema,
} from '../dto/community-reaction.dto';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.reaction.target_not_found',
} as const;

// API-facing target type. `comment` reactions point at a CommunityMessage row
// (comments are stored as messages); they are persisted with the schema's
// `comment` CommunityResponseTargetType member, which exists for exactly this.
type ApiTargetType = 'message' | 'post' | 'comment';

interface ResolvedTarget {
  workspaceId: string;
  targetType: CommunityResponseTargetType;
  targetId: string;
  targetCreatedAt: Date | null;
}

/**
 * Emoji reactions on messages, posts, and comments.
 *
 * The reactor must be able to read the target's cohort/workspace, else 404
 * (same cross-tenant non-leak posture as the rest of v1-3). Idempotency lives
 * in the repository's upsert/deleteMany; this service returns the post-mutation
 * aggregated reaction state so the client can render counts without a second
 * round trip.
 */
@Injectable()
export class CommunityReactionsService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly reactions: CommunityReactionsRepository,
    private readonly messagesRepo: CommunityMessagesRepository,
    private readonly postsRepo: CommunityPostsRepository,
  ) {}

  /** Resolve + authorise a reaction target, or throw 404. */
  private async resolveTarget(
    user: User,
    apiType: ApiTargetType,
    targetId: string,
  ): Promise<ResolvedTarget> {
    if (apiType === 'post') {
      const post = await this.postsRepo.findById(targetId);
      if (!post || post.deleted_at) throw new NotFoundException(NOT_FOUND);
      if (!(await this.access.canAccessWorkspace(post.workspace_id, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
      return {
        workspaceId: post.workspace_id,
        targetType: 'post',
        targetId: post.id,
        targetCreatedAt: post.created_at,
      };
    }

    // message OR comment — both are CommunityMessage rows.
    const msg = await this.messagesRepo.findById(targetId);
    if (!msg || msg.deleted_at) throw new NotFoundException(NOT_FOUND);
    const isComment = msg.plan_context_type === COMMENT_CONTEXT_TYPE;
    if (apiType === 'comment' && !isComment) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (apiType === 'message' && isComment) {
      throw new NotFoundException(NOT_FOUND);
    }

    // Authorise via the owning cohort (cohort messages + comments are scoped to
    // a cohort) or, when no cohort, the workspace.
    if (msg.cohort_id) {
      const cohort = await this.access.findCohort(msg.cohort_id);
      if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
    } else if (!(await this.access.canAccessWorkspace(msg.workspace_id, user))) {
      throw new NotFoundException(NOT_FOUND);
    }

    return {
      workspaceId: msg.workspace_id,
      targetType: isComment ? 'comment' : 'message',
      targetId: msg.id,
      targetCreatedAt: msg.created_at,
    };
  }

  private summarise(
    apiType: ApiTargetType,
    targetId: string,
    rows: CommunityResponse[],
    userId: string,
  ): CommunityReactionState {
    const byEmoji = new Map<string, { count: number; mine: boolean }>();
    for (const r of rows) {
      const entry = byEmoji.get(r.response_kind) ?? { count: 0, mine: false };
      entry.count += 1;
      if (r.user_id === userId) entry.mine = true;
      byEmoji.set(r.response_kind, entry);
    }
    return CommunityReactionStateSchema.parse({
      target_type: apiType,
      target_id: targetId,
      reactions: [...byEmoji.entries()].map(([emoji, e]) => ({
        emoji,
        count: e.count,
        reacted_by_me: e.mine,
      })),
    });
  }

  async react(
    user: User,
    apiType: ApiTargetType,
    targetId: string,
    emoji: string,
  ): Promise<CommunityReactionState> {
    const t = await this.resolveTarget(user, apiType, targetId);
    await this.reactions.addReaction({
      workspaceId: t.workspaceId,
      targetType: t.targetType,
      targetId: t.targetId,
      targetCreatedAt: t.targetCreatedAt,
      userId: user.id,
      emoji,
    });
    const rows = await this.reactions.listForTarget(t.targetType, t.targetId);
    return this.summarise(apiType, t.targetId, rows, user.id);
  }

  async unreact(
    user: User,
    apiType: ApiTargetType,
    targetId: string,
    emoji: string,
  ): Promise<CommunityReactionState> {
    const t = await this.resolveTarget(user, apiType, targetId);
    await this.reactions.removeReaction({
      targetType: t.targetType,
      targetId: t.targetId,
      userId: user.id,
      emoji,
    });
    const rows = await this.reactions.listForTarget(t.targetType, t.targetId);
    return this.summarise(apiType, t.targetId, rows, user.id);
  }
}
