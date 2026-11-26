import { Injectable } from '@nestjs/common';
import type { CommunityMessage, Prisma } from '@prisma/client';
import { keyedWrite } from '../messages/message-idempotency';
import { clientsAmong } from '../community-public-row';
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

  async createDm(params: NewDm): Promise<CommunityMessage> {
    return this.prisma.communityMessage.create({ data: dmData(params) });
  }

  /** SEND-ONCE-SERVER: a DM under an Idempotency-Key, by the space chat's rule (keyedWrite): the first row with
   *  the keyed id (`replayed`), else a new one with it. */
  async createKeyedDm(id: string, params: NewDm): Promise<{ row: CommunityMessage; replayed: boolean }> {
    return this.prisma.$transaction((tx) =>
      keyedWrite(tx, id, () => tx.communityMessage.findFirst({ where: { id } }), () =>
        tx.communityMessage.create({ data: { ...dmData(params), id } })));
  }

  /** COACH-DM-BE (rule D's roster rule, community-public-row.ts): the people among `ids` who are the viewer's current clients. */
  clientsAmong(viewerId: string, ids: string[]): Promise<Set<string>> {
    return clientsAmong(this.prisma, viewerId, ids);
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
    /** COACH-DM-BE, COMMUNITY-DM-RULES-BE: when given, keep only threads whose other person it returns (the workspace
     *  coach's current clients and kept former clients; a former client's coach), asked once over every other person. */
    keep?: (others: string[]) => Promise<Set<string>>;
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
    // Asked of every row before the page is cut, so threads off the roster never shorten page one (KT-10).
    const other = (r: CommunityMessage) => (r.sender_id === params.userId ? r.recipient_user_id : r.sender_id) ?? '';
    const roster = params.keep ? await params.keep([...new Set(rows.map(other))]) : null;
    const seen = new Set<string>();
    const latest: CommunityMessage[] = [];
    for (const r of rows) {
      const key = r.dm_key ?? r.id;
      if (seen.has(key) || (roster && !roster.has(other(r)))) continue;
      seen.add(key);
      latest.push(r);
      if (latest.length >= params.limit) break;
    }
    return latest;
  }
}

type NewDm = { workspaceId: string; dmKey: string; senderId: string; recipientId: string; body: string };

function dmData(params: NewDm) {
  return {
    workspace_id: params.workspaceId,
    scope: 'dm',
    kind: 'text',
    dm_key: params.dmKey,
    sender_id: params.senderId,
    recipient_user_id: params.recipientId,
    body: params.body,
    visibility: 'active',
  } satisfies Prisma.CommunityMessageUncheckedCreateInput;
}
