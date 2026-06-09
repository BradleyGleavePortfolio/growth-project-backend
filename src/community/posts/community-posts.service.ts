import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityMessage, CommunityPost, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityPostsRepository } from './community-posts.repository';
import { CommunityMessagesRepository } from '../messages/community-messages.repository';
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

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

const POST_NOT_FOUND = {
  error: 'not_found',
  code: 'community.post.not_found',
} as const;

/**
 * Lab posts (longer-form, coach-authored) and their comments.
 *
 * clientPostsEnabled: the brief's contract is "client may create a post only if
 * workspace.clientPostsEnabled === true". That column does NOT exist on
 * CommunityWorkspace in the v1-1 schema (verified by grep; see the builder
 * report's deviation list). Adding it would violate R69 (no schema mutation in
 * v1-3). The secure, launch-ready default is therefore COACH-ONLY post
 * creation: a client POST returns 403. This matches required test case 3
 * (client create → 403) exactly. When the column lands in a future schema PR,
 * canCreatePost() is the single place to relax this gate.
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
  ) {}

  private postView(p: CommunityPost): CommunityPostView {
    return {
      id: p.id,
      workspace_id: p.workspace_id,
      cohort_id: p.cohort_id,
      author_user_id: p.author_id,
      title: p.title,
      body: p.deleted_at ? null : p.body,
      scope: p.scope,
      type: p.type,
      pinned: p.pinned_at !== null,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
      deleted: p.deleted_at !== null,
    };
  }

  private commentView(m: CommunityMessage): CommunityCommentView {
    return {
      id: m.id,
      post_id: m.plan_context_id ?? '',
      author_user_id: m.sender_id,
      body: m.body ?? '',
      created_at: m.created_at.toISOString(),
    };
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

  /** Coach (or owner) may author posts; clients may not (clientPostsEnabled). */
  private async canCreatePost(
    workspaceId: string,
    user: User,
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    return this.access.isWorkspaceCoach(workspaceId, user.id);
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
    const created = await this.posts.create({
      workspaceId,
      authorId: user.id,
      title: input.title,
      body: input.body,
    });
    return CommunityPostResponseSchema.parse({ post: this.postView(created) });
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
    const next =
      rows.length === limit ? rows[rows.length - 1].created_at.toISOString() : null;
    return CommunityPostListResponseSchema.parse({
      posts: rows.map((p) => this.postView(p)),
      next_before: next,
    });
  }

  /** Resolve a readable post for the caller, or throw 404. */
  private async readablePost(
    user: User,
    postId: string,
  ): Promise<CommunityPost> {
    const post = await this.posts.findById(postId);
    if (!post || post.deleted_at) throw new NotFoundException(POST_NOT_FOUND);
    if (!(await this.access.canAccessWorkspace(post.workspace_id, user))) {
      throw new NotFoundException(POST_NOT_FOUND);
    }
    return post;
  }

  async getOne(user: User, postId: string): Promise<CommunityPostResponse> {
    const post = await this.readablePost(user, postId);
    return CommunityPostResponseSchema.parse({ post: this.postView(post) });
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
    const updated = await this.posts.update(postId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    return CommunityPostResponseSchema.parse({ post: this.postView(updated) });
  }

  async remove(user: User, postId: string): Promise<CommunityPostResponse> {
    const post = await this.readablePost(user, postId);
    const isAuthor = post.author_id === user.id;
    const isModerator =
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(post.workspace_id, user.id));
    if (!isAuthor && !isModerator) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.post.not_author',
      });
    }
    const deleted = await this.posts.softDelete(postId);
    return CommunityPostResponseSchema.parse({ post: this.postView(deleted) });
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(
    user: User,
    postId: string,
    body: string,
  ): Promise<CommunityCommentResponse> {
    const post = await this.readablePost(user, postId);
    // Any active workspace member (client or coach) may comment.
    const created = await this.messages.createComment({
      workspaceId: post.workspace_id,
      cohortId: post.cohort_id,
      senderId: user.id,
      postId: post.id,
      body,
    });
    return CommunityCommentResponseSchema.parse({
      comment: this.commentView(created),
    });
  }

  async listComments(
    user: User,
    postId: string,
  ): Promise<CommunityCommentListResponse> {
    const post = await this.readablePost(user, postId);
    const rows = await this.messages.listComments(post.id);
    return CommunityCommentListResponseSchema.parse({
      comments: rows.map((m) => this.commentView(m)),
    });
  }
}
