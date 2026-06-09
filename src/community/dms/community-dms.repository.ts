import { Injectable } from '@nestjs/common';
import type { CommunityMessage } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for 1:1 direct messages (CommunityMessage rows, scope='dm').
 *
 * A DM thread is identified by a deterministic `dm_key`: the two participant
 * user ids sorted and joined, scoped by workspace. Sorting makes the key
 * symmetric (A→B and B→A land in the same thread) without a separate thread
 * table. Tenant isolation is application-layer (service_role/BYPASSRLS): every
 * query is bounded by the workspace id the service already authorised.
 *
 * community_messages has a COMPOSITE primary key [id, created_at]; single-row
 * reads use findFirst and mutations resolve created_at then use id_created_at.
 */
@Injectable()
export class CommunityDmsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Deterministic, symmetric thread key for a workspace + participant pair. */
  static dmKey(workspaceId: string, a: string, b: string): string {
    const [lo, hi] = [a, b].sort();
    return `${workspaceId}:${lo}:${hi}`;
  }

  async createDm(params: {
    workspaceId: string;
    dmKey: string;
    senderId: string;
    recipientId: string;
    body: string;
  }): Promise<CommunityMessage> {
    return this.prisma.communityMessage.create({
      data: {
        workspace_id: params.workspaceId,
        scope: 'dm',
        kind: 'text',
        dm_key: params.dmKey,
        sender_id: params.senderId,
        recipient_user_id: params.recipientId,
        body: params.body,
        visibility: 'active',
      },
    });
  }

  async findById(messageId: string): Promise<CommunityMessage | null> {
    return this.prisma.communityMessage.findFirst({ where: { id: messageId } });
  }

  /**
   * Messages in a DM thread newest-first, cursor-paginated by created_at.
   * Soft-deleted rows are excluded.
   */
  async listThread(params: {
    dmKey: string;
    before: Date | null;
    limit: number;
  }): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        dm_key: params.dmKey,
        scope: 'dm',
        deleted_at: null,
        ...(params.before ? { created_at: { lt: params.before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: params.limit,
    });
  }

  /**
   * All DM threads the user participates in within a workspace, represented by
   * their most recent message. Returns one row per dm_key (the latest message),
   * newest thread first.
   */
  async listThreadsForUser(params: {
    workspaceId: string;
    userId: string;
    limit: number;
  }): Promise<CommunityMessage[]> {
    const rows = await this.prisma.communityMessage.findMany({
      where: {
        workspace_id: params.workspaceId,
        scope: 'dm',
        deleted_at: null,
        OR: [
          { sender_id: params.userId },
          { recipient_user_id: params.userId },
        ],
      },
      orderBy: { created_at: 'desc' },
    });
    const seen = new Set<string>();
    const latest: CommunityMessage[] = [];
    for (const r of rows) {
      const key = r.dm_key ?? r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(r);
      if (latest.length >= params.limit) break;
    }
    return latest;
  }
}
