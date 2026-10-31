// src/common/count-rule.ts
//
// COUNT-DELETED-BE (owner ruling "Counts: approved", 10-30): the one count rule.
// A message, post, comment or reaction that a person may not read never adds 1 to
// any count (badge, ring, tile, digest number, Coach Brief total, reaction count)
// and never shows in a preview. Every count and preview of a coaching chat, and
// every reaction count, takes its rows through this file:
//
//   removed   COUNTED_MESSAGE: deleted_at null. MessageActionsService.delete keeps
//             the row (body and voice_url cleared, deleted_at set) so the thread
//             can say "message deleted"; a count or preview must still skip it.
//   block     countedClients / countedThreadsOf: a client in a block with the
//             viewer either way adds nothing (the block-pair rule the thread uses).
//   departed  countedClients keeps only the roster the caller passes;
//             countedThreadsOf keeps only threads whose client is this coach's now.
//   ban       coaching chat: n/a, a community ban does not reach the one-to-one
//             chat. Reactions: countedReactions applies the community rule (block
//             either way, banned author, author who left the space) at the place
//             of the item reacted to.
import type { CommunityResponse, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import type { CommunitySafetyService } from '../community/safety/community-safety.service';
import type { RowPlace } from '../community/community-space-access';
import { inBlockWith, notInBlockWith } from '../messaging/block-pair';

/** The removed part of the rule: a deleted message counts nowhere and is no preview. */
export const COUNTED_MESSAGE = { deleted_at: null } as const satisfies Prisma.CoachMessageWhereInput;

/** The roster a coaching-chat count may read: `roster` minus every client in a block with `viewerId` either way. */
export async function countedClients(
  prisma: Pick<PrismaService, 'userBlock'>,
  viewerId: string,
  roster: readonly string[],
): Promise<string[]> {
  const blocked = await inBlockWith(prisma, viewerId, roster);
  return roster.filter((id) => !blocked.has(id));
}

/**
 * One-query form for a coach's own threads: messages in `coachId`'s threads whose
 * client is this coach's now (departed), in no block with the coach either way,
 * and not deleted.
 */
export function countedThreadsOf(coachId: string): Prisma.CoachMessageWhereInput {
  return { coach_id: coachId, ...COUNTED_MESSAGE, client: { coach_id: coachId, ...notInBlockWith(coachId) } };
}

/** Reactions `viewerId` may count: the community rule at the place (community, space) of the item reacted to. */
export function countedReactions<T extends Pick<CommunityResponse, 'user_id'>>(
  safety: Pick<CommunitySafetyService, 'filterBlocked'>,
  viewerId: string,
  rows: T[],
  placeOf: (row: T) => RowPlace,
): Promise<T[]> {
  return safety.filterBlocked(viewerId, rows, (r) => r.user_id, placeOf);
}
