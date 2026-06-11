import { Injectable } from '@nestjs/common';
import type { CommunityMessage } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for coach ack signals.
 *
 * Reads/writes ONLY the pre-existing `coach_seen_at` / `coach_acked_at` /
 * `coach_replied_at` columns on community_messages (shipped in migration
 * 20261212000000_community_v1_1_schema — R69: zero schema mutation here). The
 * table has a COMPOSITE primary key [id, created_at] (Postgres range
 * partitioning), so single-row reads use findFirst({ where: { id } }) and the
 * stamp update resolves the partition key (created_at) via the composite
 * unique `id_created_at` — exactly the pattern in CommunityMessagesRepository.
 *
 * Tenant scoping follows the v1-2 doctrine: the app connects as service_role
 * (BYPASSRLS), so authorization is enforced in the SERVICE before any method
 * here runs. This repo trusts the already-authorised message handle.
 */
@Injectable()
export class AckRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A single message by id (any scope), or null. */
  async findById(messageId: string): Promise<CommunityMessage | null> {
    return this.prisma.communityMessage.findFirst({
      where: { id: messageId },
    });
  }

  /**
   * Stamp a single ack timestamp column to `at`, addressing the row by its
   * composite key. The column is chosen by the caller (the service, which has
   * already validated the transition is legal and not a no-op). Returns the
   * updated row so the service can project the new ack envelope.
   */
  async stampAck(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
    column: 'coach_seen_at' | 'coach_acked_at' | 'coach_replied_at',
    at: Date,
  ): Promise<CommunityMessage> {
    return this.prisma.communityMessage.update({
      where: {
        id_created_at: { id: message.id, created_at: message.created_at },
      },
      data: { [column]: at },
    });
  }
}
