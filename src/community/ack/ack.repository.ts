import { Injectable } from '@nestjs/common';
import type { CommunityMessage, Role } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/** The three ack timestamp columns this repo may stamp. */
export type AckColumn =
  | 'coach_seen_at'
  | 'coach_acked_at'
  | 'coach_replied_at';

/**
 * Result of an atomic conditional stamp: `advanced` is true ONLY when the
 * guarded UPDATE moved exactly one row (the column was NULL and is now set);
 * `message` is always the current row (post-stamp on advance, or the existing
 * row on a concurrent-loser no-op). The service emits telemetry only when
 * `advanced` is true.
 */
export interface StampResult {
  advanced: boolean;
  message: CommunityMessage;
}

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
   * The sender's platform role for a message, or null when the message (or its
   * sender) cannot be resolved. Used by the service to enforce that only a
   * CLIENT-authored message is ackable (coach/owner/system-authored messages
   * are ineligible). Mirrors the `sender.role` predicate the messages repo
   * uses in `markCohortClientMessagesReplied`.
   */
  async findSenderRole(messageId: string): Promise<Role | null> {
    const row = await this.prisma.communityMessage.findFirst({
      where: { id: messageId },
      select: { sender: { select: { role: true } } },
    });
    return row?.sender?.role ?? null;
  }

  /**
   * Atomically stamp a single ack timestamp column to `at`, but ONLY if that
   * column is still NULL. The `{ [column]: null }` predicate makes the write a
   * compare-and-set: under two concurrent callers exactly one UPDATE matches a
   * row (count === 1, `advanced: true`) and the other matches zero rows
   * (count === 0, `advanced: false`), so the state machine can never
   * double-stamp or double-emit telemetry. Addressed by the composite key
   * [id, created_at] so the range-partitioned table resolves a single row.
   *
   * On a zero-row (concurrent-loser) write we refetch and return the existing
   * row so the caller surfaces an idempotent no-op envelope.
   */
  async stampAck(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
    column: AckColumn,
    at: Date,
  ): Promise<StampResult> {
    const { count } = await this.prisma.communityMessage.updateMany({
      where: {
        id: message.id,
        created_at: message.created_at,
        [column]: null,
      },
      data: { [column]: at },
    });
    const refreshed = await this.prisma.communityMessage.findFirst({
      where: {
        id: message.id,
        created_at: message.created_at,
      },
    });
    // The row was authorised moments ago; a vanished row here can only mean a
    // concurrent hard-delete, which we surface as an idempotent no-op against
    // the handle the service already holds rather than throwing.
    return {
      advanced: count === 1,
      message: refreshed ?? ({ ...message } as CommunityMessage),
    };
  }
}
