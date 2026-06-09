import { Injectable } from '@nestjs/common';
import type { CommunityPost } from '@prisma/client';
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

  async findById(postId: string): Promise<CommunityPost | null> {
    return this.prisma.communityPost.findUnique({ where: { id: postId } });
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

  async update(
    postId: string,
    data: { title?: string; body?: string },
  ): Promise<CommunityPost> {
    return this.prisma.communityPost.update({
      where: { id: postId },
      data,
    });
  }

  async softDelete(postId: string): Promise<CommunityPost> {
    return this.prisma.communityPost.update({
      where: { id: postId },
      data: { deleted_at: new Date(), visibility: 'hidden' },
    });
  }
}
