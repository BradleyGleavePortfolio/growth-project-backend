import { Injectable } from '@nestjs/common';
import type { CommunityPost, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { storeRemovalNotice } from '../safety/community-moderation-notices';
import { clientsAmong, isPublicRowOfMyClient } from '../community-public-row';

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

  /** Rule D (FR-1173): is the viewer the post author's own coach in this public space (community-public-row.ts)? */
  isPublicRowOfMyClient(cohortId: string, viewerId: string, authorId: string): Promise<boolean> {
    return isPublicRowOfMyClient(this.prisma, cohortId, viewerId, authorId);
  }

  /** Rule D (FR-1173): the people among `ids` who are the viewer's current clients. */
  clientsAmong(viewerId: string, ids: string[]): Promise<Set<string>> {
    return clientsAmong(this.prisma, viewerId, ids);
  }

  /**
   * Workspace posts, pinned-first then newest-first, cursor-paginated by
   * created_at. Excludes soft-deleted/hidden rows; `withRemoved` (FR-1165R3)
   * keeps a coach's removals for their placeholders.
   */
  async listByWorkspace(params: {
    workspaceId: string;
    before: Date | null;
    limit: number;
    withRemoved?: boolean;
  }): Promise<CommunityPost[]> {
    const live = { visibility: 'active', deleted_at: null };
    return this.prisma.communityPost.findMany({
      where: {
        workspace_id: params.workspaceId,
        ...(params.withRemoved ? { OR: [live, { removed_by_user_id: { not: null } }] } : live),
        ...(params.before ? { created_at: { lt: params.before } } : {}),
      },
      orderBy: [{ pinned_at: 'desc' }, { created_at: 'desc' }],
      take: params.limit,
    });
  }

  /**
   * Stored names of the given users, keyed by id. The service reduces each to
   * a first name, or a full name where fullNamesFor allows, before anything
   * leaves the API (member privacy).
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

  /**
   * FR-1165R3: a coach's removal of someone else's post. Keeps who removed
   * it, erases the words and the pin, and tells the author once (unless the
   * caller does, `tellAuthor` false: the queue's act()). Only a live post is
   * written, so a repeat or a race writes and tells nothing. LS-1165R4 B1: the
   * same transaction takes its search copy out of search and erases its words.
   */
  async removeByCoach(
    post: Pick<CommunityPost, 'id' | 'author_id'>,
    removerId: string,
    tx?: Prisma.TransactionClient,
    tellAuthor = true,
  ): Promise<CommunityPost> {
    const run = async (t: Prisma.TransactionClient) => {
      const hit = await t.communityPost.updateMany({
        where: { id: post.id, deleted_at: null },
        data: { deleted_at: new Date(), visibility: 'hidden', removed_by_user_id: removerId, title: null, body: null, pinned_at: null },
      });
      if (hit.count > 0) {
        await t.communitySearchEntry.updateMany({ where: { kind: 'post', targetId: post.id }, data: { softDeletedAt: new Date(), excerpt: '' } });
      }
      if (hit.count > 0 && tellAuthor) {
        await storeRemovalNotice(t, { recipientId: post.author_id, targetType: 'post', targetId: post.id });
      }
      const row = await t.communityPost.findUnique({ where: { id: post.id } });
      if (!row) throw new Error('community post vanished during removal');
      return row;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }
}
