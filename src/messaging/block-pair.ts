import { HttpStatus } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { MESSAGING_ERRORS, messagingError } from './messaging-errors';

/**
 * #168-4 (owner rule): a block closes every conversation between the two
 * people both ways. The ids among `others` in a block with `userId`, either
 * direction. One indexed query; used by every entry point that offers
 * Message or Ask Roman for one person (plan-ended list, Home reach-outs and
 * wins, the at-risk list, Roman one-client drafts) and by every reader of a
 * coaching chat's words, previews or unread counts (FX-1141 round 2).
 */
export async function inBlockWith(
  prisma: Pick<PrismaService, 'userBlock'>,
  userId: string,
  others: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(others)].filter((id) => id && id !== userId);
  if (!userId || ids.length === 0) return new Set();
  const rows = await prisma.userBlock.findMany({
    where: {
      OR: [
        { blocker_id: userId, blocked_id: { in: ids } },
        { blocked_id: userId, blocker_id: { in: ids } },
      ],
    },
    select: { blocker_id: true, blocked_id: true },
  });
  return new Set(rows.map((r) => (r.blocker_id === userId ? r.blocked_id : r.blocker_id)));
}

/**
 * FX-1141: the one write gate for a coaching message between two people
 * (send, draft, nudge, churn draft or send, Roman notification, voice upload).
 * 403 `messaging.blocked` when they are in a block either way, before any
 * insert, provider call, push or upload URL.
 */
export async function assertPairOpen(
  prisma: Pick<PrismaService, 'userBlock'>,
  userId: string,
  otherId: string,
): Promise<void> {
  if ((await inBlockWith(prisma, userId, [otherId])).size > 0) {
    throw messagingError(HttpStatus.FORBIDDEN, MESSAGING_ERRORS.BLOCKED);
  }
}

/**
 * 10-23 "Dissapear": a closed coaching chat leaves both people's lists, so a
 * direct open (profile, old notification, deep link) learns it is closed from
 * this header on the thread GET (body stays 200 []): `blocked_by_you` when the
 * caller blocked the other person, `blocked_by_them` when they were blocked.
 */
export const CONVERSATION_CLOSED_HEADER = 'x-conversation-closed';
export type ConversationClosed = 'blocked_by_you' | 'blocked_by_them';
