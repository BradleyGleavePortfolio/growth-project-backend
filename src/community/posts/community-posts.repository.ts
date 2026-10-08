import { Injectable } from '@nestjs/common';
import type { CommunityPost, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for Lab posts.
 *
 * Tenant scoping is application-layer (v1-2 doctrine): every list is bounded by
 * the workspace id the service already authorised. Soft-deleted and hidden rows
 * are excluded from reads.
 */
@Injectable()
export class CommunityPostsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    workspaceId: string;
    authorId: string;
    title: string;
    body: string;
  }): Promise<CommunityPost> {
    return this.prisma.communityPost.create({
      data: {
        workspace_id: params.workspaceId,
        author_id: params.authorId,
        scope: 'hall',
        type: 'text',
        title: params.title,
        body: params.body,
        visibility: 'active',
      },
    });
  }

  /** `tx`: run inside the caller's transaction (moderation act, B-610-13). */
  async findById(postId: string, tx?: Prisma.TransactionClient): Promise<CommunityPost | null> {
    return (tx ?? this.prisma).communityPost.findUnique({ where: { id: postId } });
  }

  /**
   * Workspace posts, pinned-first then newest-first, cursor-paginated by
   * created_at. Excludes soft-deleted/hidden rows.
   */
  async listByWorkspace(params: {
    workspaceId: string;
    before: Date | null;
    limit: number;
  }): Promise<CommunityPost[]> {
    return this.prisma.communityPost.findMany({
      where: {
        workspace_id: params.workspaceId,
        visibility: 'active',
        deleted_at: null,
        ...(params.before ? { created_at: { lt: params.before } } : {}),
      },
      orderBy: [{ pinned_at: 'desc' }, { created_at: 'desc' }],
      take: params.limit,
    });
  }

  /**
   * Stored names of the given users, keyed by id. The service reduces each to
   * a first name before anything leaves the API (member privacy).
   */
  async namesByUserId(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  async update(postId: string, data: { title?: string; body?: string }): Promise<CommunityPost> {
    return this.prisma.communityPost.update({
      where: { id: postId },
      data,
    });
  }

  async softDelete(postId: string, tx?: Prisma.TransactionClient): Promise<CommunityPost> {
    return (tx ?? this.prisma).communityPost.update({
      where: { id: postId },
      data: { deleted_at: new Date(), visibility: 'hidden' },
    });
  }
}
