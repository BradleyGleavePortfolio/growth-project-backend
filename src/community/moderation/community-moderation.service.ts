import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CommunityModerationAction,
  CommunityModerationStatus,
  CommunityModerationTargetType,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
import { CommunityMessagesRepository } from '../messages/community-messages.repository';
import { CommunityPostsRepository } from '../posts/community-posts.repository';
import { CommunityModerationRepository } from './community-moderation.repository';
import {
  CommunityModerationItemListResponse,
  CommunityModerationItemListResponseSchema,
  CommunityModerationItemResponse,
  CommunityModerationItemResponseSchema,
  CommunityModerationItemView,
  ModerationActionKind,
  ReportTargetType,
} from '../dto/community-moderation.dto';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.moderation.not_found',
} as const;

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.moderation.not_moderator',
} as const;

interface ResolvedReportTarget {
  workspaceId: string;
  targetType: CommunityModerationTargetType;
  targetId: string;
}

/**
 * Report → review → action moderation.
 *
 * Availability: moderation carries ONLY the master CommunityFeatureFlagGuard, never
 * the message/post/DM write kill switches. When those flags are off (a content
 * freeze) coaches must STILL be able to triage and action the existing queue —
 * pausing writes must not also pause safety tooling. This is enforced at the
 * controller (guard stack) and is a hard requirement of the brief.
 *
 * Reporting: any active workspace member may file a report on a message, post,
 * or comment. Acting on an item (hide/warn/ban/dismiss) is coach/owner only.
 *
 * DEVIATION (report): the brief lists `comment` as a report target, but
 * CommunityModerationTargetType has no `comment` member. Comments are stored as
 * CommunityMessage rows (see CommunityPostsService), so a `comment` report is
 * persisted with target_type=`message`, which is faithful to where the row
 * actually lives. The API DTO still accepts `comment` for client clarity.
 */
@Injectable()
export class CommunityModerationService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly moderation: CommunityModerationRepository,
    private readonly messagesRepo: CommunityMessagesRepository,
    private readonly postsRepo: CommunityPostsRepository,
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
  ) {}

  private itemView(
    a: CommunityModerationAction,
  ): CommunityModerationItemView {
    return {
      id: a.id,
      workspace_id: a.workspace_id,
      target_type: a.target_type,
      target_id: a.target_id,
      reported_by_user_id: a.reported_by_id,
      actor_user_id: a.actor_id,
      status: a.status,
      reason: a.reason,
      notes: a.notes,
      action: a.action,
      created_at: a.created_at.toISOString(),
      resolved_at: a.resolved_at?.toISOString() ?? null,
    };
  }

  private parsePage(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private parseStatus(
    status: string | undefined,
  ): CommunityModerationStatus | null {
    if (
      status === 'open' ||
      status === 'reviewed' ||
      status === 'actioned' ||
      status === 'dismissed'
    ) {
      return status;
    }
    return null;
  }

  /**
   * Resolve + authorise a report target, or throw 404. The reporter must be able
   * to read the target's workspace (cross-tenant non-leak posture). Maps the
   * API `comment` type onto a CommunityMessage row + the schema `message` type.
   */
  private async resolveReportTarget(
    user: User,
    apiType: ReportTargetType,
    targetId: string,
  ): Promise<ResolvedReportTarget> {
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
      };
    }

    // message OR comment — both are CommunityMessage rows.
    const msg = await this.messagesRepo.findById(targetId);
    if (!msg || msg.deleted_at) throw new NotFoundException(NOT_FOUND);
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
      targetType: 'message',
      targetId: msg.id,
    };
  }

  async report(
    user: User,
    apiType: ReportTargetType,
    targetId: string,
    reason: string,
    notes: string | undefined,
  ): Promise<CommunityModerationItemResponse> {
    const t = await this.resolveReportTarget(user, apiType, targetId);
    const created = await this.moderation.createReport({
      workspaceId: t.workspaceId,
      targetType: t.targetType,
      targetId: t.targetId,
      reportedById: user.id,
      reason,
      notes: notes ?? null,
    });
    return CommunityModerationItemResponseSchema.parse({
      item: this.itemView(created),
    });
  }

  /** Coach (workspace owner) or platform owner may triage a queue. */
  private async assertModerator(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    const isModerator =
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id));
    if (!isModerator) throw new ForbiddenException(FORBIDDEN);
  }

  async listQueue(
    user: User,
    workspaceId: string,
    query: { status?: string; limit?: string },
  ): Promise<CommunityModerationItemListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    await this.assertModerator(workspaceId, user);
    const rows = await this.moderation.listForWorkspace({
      workspaceId,
      status: this.parseStatus(query.status),
      limit: this.parsePage(query.limit),
    });
    return CommunityModerationItemListResponseSchema.parse({
      items: rows.map((r) => this.itemView(r)),
    });
  }

  /**
   * Act on a queued item. `dismiss` closes it with no enforcement; hide/warn/ban
   * record the enforcement and mark it actioned. `hide` additionally soft-hides
   * the underlying content so the action has a real effect, not just an audit
   * note.
   */
  async act(
    user: User,
    itemId: string,
    action: ModerationActionKind,
    notes: string | undefined,
  ): Promise<CommunityModerationItemResponse> {
    const item = await this.moderation.findById(itemId);
    if (!item) throw new NotFoundException(NOT_FOUND);
    await this.assertModerator(item.workspace_id, user);

    if (action === 'hide') {
      await this.hideTarget(item.target_type, item.target_id);
    }

    const status: CommunityModerationStatus =
      action === 'dismiss' ? 'dismissed' : 'actioned';
    const resolved = await this.moderation.resolve({
      itemId: item.id,
      actorId: user.id,
      status,
      action,
      notes: notes ?? null,
    });
    // v1-4 post-action tail — best-effort realtime ping on the moderation
    // channel (IDs + enum action only, NEVER the moderation reason/notes,
    // #24/#36). Mobile moderators refetch the queue via authenticated REST.
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.moderation(resolved.workspace_id),
      COMMUNITY_BROADCAST_EVENTS.moderationActionCreated,
      {
        actionId: resolved.id,
        wsId: resolved.workspace_id,
        targetType: resolved.target_type,
        targetId: resolved.target_id,
        action: resolved.action ?? action,
      },
      { distinctId: user.id, channelKind: 'moderation' },
    );
    // Notify the affected member (the content owner) when a real enforcement
    // landed (not a dismiss). Fire-and-forget; gated behind
    // FEATURE_COMMUNITY_PUSH inside the service.
    if (action !== 'dismiss') {
      const ownerId = await this.contentOwnerId(
        resolved.target_type,
        resolved.target_id,
      );
      if (ownerId) {
        void this.communityPush.sendCommunityPush({
          recipientId: ownerId,
          kind: NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
          targetType: resolved.target_type,
          targetId: resolved.target_id,
          deepLink: 'tgp://community/moderation',
        });
      }
    }
    return CommunityModerationItemResponseSchema.parse({
      item: this.itemView(resolved),
    });
  }

  /**
   * Resolve the owning user of a moderated target (post author or message
   * sender) so we can notify them. Returns null when unresolvable — the push
   * is simply skipped (best-effort, never throws).
   */
  private async contentOwnerId(
    targetType: CommunityModerationTargetType,
    targetId: string,
  ): Promise<string | null> {
    if (targetType === 'post') {
      const post = await this.postsRepo.findById(targetId);
      return post?.author_id ?? null;
    }
    if (targetType === 'message') {
      const msg = await this.messagesRepo.findById(targetId);
      return msg?.sender_id ?? null;
    }
    return null;
  }

  /** Soft-hide the content a moderation action targets, where applicable. */
  private async hideTarget(
    targetType: CommunityModerationTargetType,
    targetId: string,
  ): Promise<void> {
    if (targetType === 'post') {
      const post = await this.postsRepo.findById(targetId);
      if (post && !post.deleted_at) await this.postsRepo.softDelete(post.id);
      return;
    }
    if (targetType === 'message') {
      const msg = await this.messagesRepo.findById(targetId);
      if (msg && !msg.deleted_at) {
        await this.messagesRepo.softDelete({
          id: msg.id,
          created_at: msg.created_at,
        });
      }
    }
  }
}
