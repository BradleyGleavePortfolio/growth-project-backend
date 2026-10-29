import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { everyoneInBlockWith } from '../messaging/block-pair';
import { PrismaService } from '../prisma.service';

// The churn nudge's inbox row kind (churn-intervention.service.ts NUDGE_PUSH_KIND).
const COACH_NUDGE_KIND = 'coach_nudge';
// A message notice links its chat, and the chat id is the client
// (message-received.emitter.ts; messaging.service.ts threadId: clientId).
const MESSAGE_LINK = 'tgp://messages/';

/**
 * B-LONOTIFY3-1 / B-LSNOTIFY3-3 (owner #169-5 "Dissapear"; block contract
 * b#1141 issuecomment 6354139283): while the reader and someone are in a
 * block, either way, the reader's notifications that name that person leave
 * the inbox: not listed, counted (every badge reads the same count), opened
 * or marked. Nothing is deleted, so unblock brings them back as they were,
 * still unread. A row names the other person when it is
 *   - their churn nudge to this client (payload.coach_id);
 *   - a notice they approved from an AI draft (send-notification
 *     materialiser, payload.approvedByCoachId);
 *   - a message notice for the chat with them: on the coach's side
 *     tgp://messages/<their id> (the chat is the client); on the client's
 *     side, when they are the client's coach, tgp://messages/<the reader's
 *     own id> (the same chat, messaging.service.ts notifyNewMessage and the
 *     broadcast dispatcher both use threadId: clientId).
 * No new row of these kinds can be written during a block (assertPairOpen
 * on every send path), so this read rule is the whole of it.
 *
 * The two payload kinds are found first and left out by id (one row per
 * nudge or approved notice): a NOT over a JSON path is SQL NULL for a row
 * without that key and would drop every such row too. Message links are
 * left out in the query itself, keeping rows with no link explicitly (NULL
 * again). NotificationsService.inboxWhere adds these under AND to the move
 * rule (current-coach-inbox.ts), so list, unread count, badge, mark read and
 * mark all read all apply it.
 */
@Injectable()
export class InboxBlockRule {
  constructor(private readonly prisma: PrismaService) {}

  /** The extra inbox conditions for the reader; none when they are in no block. */
  async where(userId: string): Promise<Prisma.NotificationWhereInput[]> {
    const closed = await everyoneInBlockWith(this.prisma, userId);
    if (closed.length === 0) return [];
    const reader = await this.prisma.user.findUnique({ where: { id: userId }, select: { coach_id: true } });
    const chats = reader?.coach_id && closed.includes(reader.coach_id) ? [...closed, userId] : closed;
    const named = await this.prisma.notification.findMany({
      where: {
        user_id: userId,
        OR: closed.flatMap((id): Prisma.NotificationWhereInput[] => [
          { kind: COACH_NUDGE_KIND, payload: { path: ['coach_id'], equals: id } },
          { payload: { path: ['approvedByCoachId'], equals: id } },
        ]),
      },
      select: { id: true },
    });
    return [
      {
        OR: [
          { deep_link: null },
          {
            deep_link: { notIn: chats.map((id) => MESSAGE_LINK + id) },
            NOT: chats.map((id) => ({ deep_link: { startsWith: `${MESSAGE_LINK}${id}/` } })),
          },
        ],
      },
      ...(named.length ? [{ id: { notIn: named.map((r) => r.id) } }] : []),
    ];
  }
}
