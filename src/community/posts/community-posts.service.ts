import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityMessage, CommunityPost, CommunityResponse, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { memberFirstName } from '../member-display-name';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
import { CommunityPostsRepository } from './community-posts.repository';
import { CommunityMessagesRepository } from '../messages/community-messages.repository';
import { CommunityReactionsRepository } from '../reactions/community-reactions.repository';
import { CommunityReactionSummary, summariseReactions } from '../dto/community-reaction.dto';
import {
  CommunityCommentListResponse,
  CommunityCommentListResponseSchema,
  CommunityCommentResponse,
  CommunityCommentResponseSchema,
  CommunityCommentView,
  CommunityPostListResponse,
  CommunityPostListResponseSchema,
  CommunityPostResponse,
  CommunityPostResponseSchema,
  CommunityPostView,
} from '../dto/community-post.dto';
import { CommunitySafetyService } from '../safety/community-safety.service';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

const POST_NOT_FOUND = {
  error: 'not_found',
  code: 'community.post.not_found',
} as const;

/** Author first name and visible reactions for one post or reply. */
interface ViewExtras {
  authorName: string;
  reactions: CommunityReactionSummary[];
}
type ExtrasFor = (targetId: string, authorId: string) => ViewExtras;

/**
 * Lab posts (longer-form, coach-authored) and their comments.
 *
 * Member posts: there is no per-workspace clientPostsEnabled column, so every
 * active, unbanned member may create a post (B-E2E-1, agent 123 F6; this was
 * coach-only, which dead-ended the client Hall composer). When a coach toggle
 * lands in a future schema PR, canCreatePost() is the single place to gate it;
 * the 403 community.post.client_posts_disabled body stays for that toggle.
 *
 * Comments: stored as CommunityMessage rows tagged with the parent post id (the
 * v1-1 CommunityResponse model has only a 32-char response_kind column and
 * cannot hold a comment body — see the report's deviation list). Any active
 * workspace member may comment (the "client comment permission" test).
 */
@Injectable()
export class CommunityPostsService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly posts: CommunityPostsRepository,
    private readonly messages: CommunityMessagesRepository,
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
    private readonly safety: CommunitySafetyService,
    private readonly reactions: CommunityReactionsRepository,
  ) {}

  private postView(p: CommunityPost, extras: ViewExtras): CommunityPostView {
    return {
      id: p.id,
      workspace_id: p.workspace_id,
      cohort_id: p.cohort_id,
      author_user_id: p.author_id,
      author_name: extras.authorName,
      title: p.title,
      body: p.deleted_at ? null : p.body,
      scope: p.scope,
      type: p.type,
      pinned: p.pinned_at !== null,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
      deleted: p.deleted_at !== null,
      reactions: extras.reactions,
    };
  }

  private commentView(m: CommunityMessage, extras: ViewExtras): CommunityCommentView {
    return {
      id: m.id,
      post_id: m.plan_context_id ?? '',
      author_user_id: m.sender_id,
      author_name: extras.authorName,
      body: m.body ?? '',
      created_at: m.created_at.toISOString(),
      reactions: extras.reactions,
    };
  }

  /**
   * What the app shows with each post or reply (FW-COMM-128 U1/U2): the
   * author's FIRST name only (owner default 10-07, the same rule as wins), and
   * the reactions the viewer may see in the reaction endpoints' own shape, so
   * counts and the viewer's own reaction match before and after a tap. Two
   * batched reads per page, never one per row.
   */
  private async viewExtras(
    viewer: User,
    targetType: 'post' | 'comment',
    items: Array<{ id: string; authorId: string }>,
  ): Promise<ExtrasFor> {
    const [names, rows] = await Promise.all([
      this.posts.namesByUserId(items.map((i) => i.authorId)),
      this.reactions.listForTargets(
        targetType,
        items.map((i) => i.id),
      ),
    ]);
    // Two-way block: reactions by anyone in a block relation with the viewer
    // are not counted (as in CommunityReactionsService.visibleReactions).
    const visible = await this.safety.filterBlocked(viewer.id, rows, (r) => r.user_id);
    const byTarget = new Map<string, CommunityResponse[]>();
    for (const r of visible) {
      const forTarget = byTarget.get(r.target_id);
      if (forTarget) forTarget.push(r);
      else byTarget.set(r.target_id, [r]);
    }
    return (targetId, authorId) => ({
      authorName: memberFirstName(names.get(authorId)),
      reactions: summariseReactions(byTarget.get(targetId) ?? [], viewer.id),
    });
  }

  private async postViews(viewer: User, rows: CommunityPost[]): Promise<CommunityPostView[]> {
    const extras = await this.viewExtras(
      viewer,
      'post',
      rows.map((p) => ({ id: p.id, authorId: p.author_id })),
    );
    return rows.map((p) => this.postView(p, extras(p.id, p.author_id)));
  }

  private async postResponse(viewer: User, post: CommunityPost): Promise<CommunityPostResponse> {
    return CommunityPostResponseSchema.parse({ post: (await this.postViews(viewer, [post]))[0] });
  }

  private async commentViews(
    viewer: User,
    rows: CommunityMessage[],
  ): Promise<CommunityCommentView[]> {
    const extras = await this.viewExtras(
      viewer,
      'comment',
      rows.map((m) => ({ id: m.id, authorId: m.sender_id })),
    );
    return rows.map((m) => this.commentView(m, extras(m.id, m.sender_id)));
  }

  private parsePage(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private parseBefore(before: string | undefined): Date | null {
    if (!before) return null;
    const d = new Date(before);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * The owner, the workspace coach and any active, unbanned member may author
   * posts (B-E2E-1: the Hall's "Be the first to post" is a member action). The
   * content filter, report and block apply to every post as they do to comments.
   */
  private async canCreatePost(workspaceId: string, user: User): Promise<boolean> {
    if (user.role === 'owner') return true;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return true;
    return (await this.access.membershipInWorkspace(workspaceId, user.id)) !== null;
  }

  async create(
    user: User,
    workspaceId: string,
    input: { title: string; body: string },
  ): Promise<CommunityPostResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    // Non-members can't see the workspace exists (404); members who aren't
    // permitted to author get an explicit 403.
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    if (!(await this.canCreatePost(workspaceId, user))) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.post.client_posts_disabled',
      });
    }
    // Apple 1.2: objectionable-content filter before publication.
    this.safety.assertAllowed(input.title, input.body);
    const created = await this.posts.create({
      workspaceId,
      authorId: user.id,
      title: input.title,
      body: input.body,
    });
    // v1-4 post-write tail — best-effort realtime ping (IDs only, #24/#36).
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.workspace(created.workspace_id),
      COMMUNITY_BROADCAST_EVENTS.postCreated,
      {
        id: created.id,
        workspaceId: created.workspace_id,
        authorId: created.author_id,
        createdAt: created.created_at.toISOString(),
      },
      { distinctId: created.author_id, channelKind: 'workspace' },
    );
    return this.postResponse(user, created);
  }

  async list(
    user: User,
    workspaceId: string,
    query: { before?: string; limit?: string },
  ): Promise<CommunityPostListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    const limit = this.parsePage(query.limit);
    const rows = await this.posts.listByWorkspace({
      workspaceId,
      before: this.parseBefore(query.before),
      limit,
    });
    const next = rows.length === limit ? rows[rows.length - 1].created_at.toISOString() : null;
    // Block filter after the cursor is taken from the unfiltered page.
    const visible = await this.safety.filterBlocked(user.id, rows, (p) => p.author_id);
    return CommunityPostListResponseSchema.parse({
      posts: await this.postViews(user, visible),
      next_before: next,
    });
  }

  /** Resolve a readable post for the caller, or throw 404. */
  private async readablePost(user: User, postId: string): Promise<CommunityPost> {
    const post = await this.posts.findById(postId);
    if (!post || post.deleted_at) throw new NotFoundException(POST_NOT_FOUND);
    if (!(await this.access.canAccessWorkspace(post.workspace_id, user))) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    return post;
  }

  /**
   * A readable post that is also not hidden by a block in either direction
   * (404, same body). Used by every read of a single post and its thread;
   * edit/remove stay on readablePost (author-only / coach paths).
   */
  private async visiblePost(user: User, postId: string): Promise<CommunityPost> {
    const post = await this.readablePost(user, postId);
    await this.safety.assertVisibleTo(user.id, post.author_id, POST_NOT_FOUND);
    return post;
  }

  async getOne(user: User, postId: string): Promise<CommunityPostResponse> {
    const post = await this.visiblePost(user, postId);
    return this.postResponse(user, post);
  }

  async edit(
    user: User,
    postId: string,
    input: { title?: string; body?: string },
  ): Promise<CommunityPostResponse> {
    const post = await this.readablePost(user, postId);
    if (post.author_id !== user.id) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.post.not_author',
      });
    }
    this.safety.assertAllowed(input.title, input.body);
    const updated = await this.posts.update(postId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.workspace(updated.workspace_id),
      COMMUNITY_BROADCAST_EVENTS.postUpdated,
      {
        id: updated.id,
        workspaceId: updated.workspace_id,
        updatedAt: updated.updated_at.toISOString(),
      },
      { distinctId: updated.author_id, channelKind: 'workspace' },
    );
    return this.postResponse(user, updated);
  }

  async remove(user: User, postId: string): Promise<CommunityPostResponse> {
    const post = await this.readablePost(user, postId);
    const isAuthor = post.author_id === user.id;
    const isModerator =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(post.workspace_id, user.id));
    if (!isAuthor && !isModerator) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.post.not_author',
      });
    }
    const deleted = await this.posts.softDelete(postId);
    return this.postResponse(user, deleted);
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(user: User, postId: string, body: string): Promise<CommunityCommentResponse> {
    // A blocked pair can neither see nor reply to each other's posts, so the
    // reply push below can never reach the other side of a block.
    const post = await this.visiblePost(user, postId);
    // Any active workspace member (client or coach) may comment.
    this.safety.assertAllowed(body);
    const created = await this.messages.createComment({
      workspaceId: post.workspace_id,
      cohortId: post.cohort_id,
      senderId: user.id,
      postId: post.id,
      body,
    });
    // v1-4 post-write tail — realtime reaction-feed ping on the workspace hall
    // (a comment is a CommunityMessage; the post author refetches via REST).
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.workspace(post.workspace_id),
      COMMUNITY_BROADCAST_EVENTS.messageCreated,
      {
        id: created.id,
        cohortId: created.cohort_id ?? post.id,
        authorId: created.sender_id,
        createdAt: created.created_at.toISOString(),
      },
      { distinctId: created.sender_id, channelKind: 'workspace' },
    );
    // Push the post author (not the commenter) that their post got a reply.
    // Fire-and-forget; gated behind FEATURE_COMMUNITY_PUSH inside the service.
    if (post.author_id !== user.id) {
      void this.communityPush.sendCommunityPush({
        recipientId: post.author_id,
        kind: NotificationKind.COMMUNITY_POST_REPLIED,
        targetType: 'post',
        targetId: post.id,
        deepLink: `tgp://community/posts/${post.id}`,
      });
    }
    return CommunityCommentResponseSchema.parse({
      comment: (await this.commentViews(user, [created]))[0],
    });
  }

  async listComments(user: User, postId: string): Promise<CommunityCommentListResponse> {
    const post = await this.visiblePost(user, postId);
    const rows = await this.messages.listComments(post.id);
    const visible = await this.safety.filterBlocked(user.id, rows, (m) => m.sender_id);
    return CommunityCommentListResponseSchema.parse({
      comments: await this.commentViews(user, visible),
    });
  }
}
