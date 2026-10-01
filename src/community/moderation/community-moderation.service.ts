import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
import { PrismaService } from '../../prisma.service';
import { assertDmParticipantIfDm } from '../safety/community-safety.service';
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

export interface FlaggedItemView {
  id: string;
  workspace_id: string;
  target_type: 'post' | 'message';
  target_id: string;
  content: string;
  author_user_id: string | null;
  author_name: string;
  cohort_name: string | null;
  reason: string;
  notes: string | null;
  created_at: string;
}

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
    private readonly prisma: PrismaService,
  ) {}

  private itemView(a: CommunityModerationAction): CommunityModerationItemView {
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

  private parseStatus(status: string | undefined): CommunityModerationStatus | null {
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
    // A DM can be reported only by one of its two participants, so a third
    // member cannot pull someone else's DM into the coach's queue by id.
    assertDmParticipantIfDm(msg, user.id, NOT_FOUND);
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
  private async assertModerator(workspaceId: string, user: User): Promise<void> {
    const isModerator =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(workspaceId, user.id));
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
    if (action === 'ban') {
      // A ban removes the content AND the author's access to the workspace
      // (every cohort membership -> removed). The access service only admits
      // `active` memberships, so the author can no longer read or write in the
      // Hall, any cohort, DMs, voice or challenges of this workspace.
      // banAuthor runs first: it rejects banning the workspace coach / a
      // platform owner BEFORE anything is written, so a refused ban never
      // leaves the content half-actioned.
      await this.banAuthor(item.workspace_id, item.target_type, item.target_id);
      await this.hideTarget(item.target_type, item.target_id);
    }

    const status: CommunityModerationStatus = action === 'dismiss' ? 'dismissed' : 'actioned';
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
      const ownerId = await this.contentOwnerId(resolved.target_type, resolved.target_id);
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

  /**
   * Remove the content owner's memberships in the workspace. Never bans the
   * workspace coach or a platform owner (they are not members in that sense
   * and a ban must not lock a space out of its own moderator).
   */
  private async banAuthor(
    workspaceId: string,
    targetType: CommunityModerationTargetType,
    targetId: string,
  ): Promise<void> {
    const ownerId = await this.contentOwnerId(targetType, targetId);
    if (!ownerId) return;
    if (await this.access.isWorkspaceCoach(workspaceId, ownerId)) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.moderation.cannot_ban_coach',
      });
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { role: true },
    });
    if (owner?.role === 'owner') {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.moderation.cannot_ban_coach',
      });
    }
    await this.prisma.communityMembership.updateMany({
      where: { workspace_id: workspaceId, user_id: ownerId },
      data: { status: 'removed', removed_at: new Date() },
    });
  }

  /**
   * GET /community/moderation/flagged — the coach's review queue across every
   * workspace they own (platform owner: every workspace), open reports only,
   * oldest first, enriched with the reported content, its author and cohort
   * so the mobile reviewer can decide without another round trip. Content of
   * already-removed targets is shown as "Removed".
   */
  async listFlagged(user: User, query: { limit?: string }): Promise<{ items: FlaggedItemView[] }> {
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException(FORBIDDEN);
    }
    const workspaceFilter = user.role === 'owner' ? {} : { workspace: { coach_id: user.id } };
    const rows = await this.prisma.communityModerationAction.findMany({
      where: {
        status: 'open',
        target_type: { in: ['post', 'message'] },
        ...workspaceFilter,
      },
      orderBy: { created_at: 'asc' },
      take: this.parsePage(query.limit),
    });
    if (rows.length === 0) return { items: [] };
    const postIds = rows.filter((r) => r.target_type === 'post').map((r) => r.target_id);
    const msgIds = rows.filter((r) => r.target_type === 'message').map((r) => r.target_id);
    const [posts, msgs] = await Promise.all([
      this.prisma.communityPost.findMany({
        where: { id: { in: postIds } },
        select: {
          id: true,
          title: true,
          body: true,
          author_id: true,
          cohort_id: true,
          deleted_at: true,
        },
      }),
      this.prisma.communityMessage.findMany({
        where: { id: { in: msgIds } },
        select: {
          id: true,
          body: true,
          sender_id: true,
          cohort_id: true,
          deleted_at: true,
        },
      }),
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const msgById = new Map(msgs.map((m) => [m.id, m]));
    const authorIds = new Set<string>();
    const cohortIds = new Set<string>();
    for (const p of posts) {
      authorIds.add(p.author_id);
      if (p.cohort_id) cohortIds.add(p.cohort_id);
    }
    for (const m of msgs) {
      authorIds.add(m.sender_id);
      if (m.cohort_id) cohortIds.add(m.cohort_id);
    }
    const [users, cohorts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...authorIds] } },
        select: { id: true, name: true },
      }),
      this.prisma.communityCohort.findMany({
        where: { id: { in: [...cohortIds] } },
        select: { id: true, name: true },
      }),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const cohortById = new Map(cohorts.map((c) => [c.id, c.name]));

    const items: FlaggedItemView[] = rows.map((r) => {
      let content = 'Removed';
      let authorId: string | null = null;
      let cohortId: string | null = null;
      if (r.target_type === 'post') {
        const p = postById.get(r.target_id);
        if (p) {
          authorId = p.author_id;
          cohortId = p.cohort_id;
          if (!p.deleted_at) {
            content = [p.title, p.body].filter((x): x is string => !!x).join('\n\n');
          }
        }
      } else {
        const m = msgById.get(r.target_id);
        if (m) {
          authorId = m.sender_id;
          cohortId = m.cohort_id;
          if (!m.deleted_at) content = m.body ?? '';
        }
      }
      return {
        id: r.id,
        workspace_id: r.workspace_id,
        target_type: r.target_type === 'post' ? 'post' : 'message',
        target_id: r.target_id,
        content,
        author_user_id: authorId,
        author_name: (authorId && nameById.get(authorId)) || 'Member',
        cohort_name: cohortId ? (cohortById.get(cohortId) ?? null) : null,
        reason: r.reason,
        notes: r.notes,
        created_at: r.created_at.toISOString(),
      };
    });
    return { items };
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
