/**
 * Sol B-2 (FR-1138): a space push that waited in the outbox (quiet hours, the burst cap, a retry) is planned
 * again for its reader at the moment of sending, with the reads messageStored and readers() make at enqueue
 * (community-space-push.service.ts): the space switch is still on (Sol C2, FR-1138R5: switching it off drops what
 * waited), the message is still a chat message of the space by the same sender, the message still reads in the
 * space (Sol B1, FR-1138R5: rowsByAuthorsWhoStay, the rule of GET .../messages/:id and the unread count, so a sender
 * moved to another coach or banned has left it, except in a public space or with a helper row), the reader may
 * still read the space (app.community_can_access, so no ban), neither blocks the other (owner 10-22: hide ALL
 * messaging), and planSpacePush still gives this reader the same kind under their setting now. A row without the
 * source ids is not sent. Kept apart from that service so the push worker does not import it (it imports
 * NotificationsService, which imports the worker).
 */
import type { PrismaService } from '../../prisma.service';
import { canEnterSpace, rowsByAuthorsWhoStay } from '../community-space-access';
import { notifySettingOf, spaceUnreadCounts } from '../space-reads/community-space-reads.service';
import { planSpacePush, spacePushOn, type SpacePushContext } from './space-push-policy';

export type SpacePushDropReason =
  | 'switched-off'
  | 'no-source'
  | 'message-gone'
  | 'sender-left'
  | 'no-access'
  | 'blocked'
  | 'not-planned';

/** Why this space push must not go to `userId` now, or null when it still would be planned. */
export async function spacePushDropReason(
  prisma: PrismaService,
  userId: string,
  p: SpacePushContext,
  now: Date,
): Promise<SpacePushDropReason | null> {
  if (!spacePushOn()) return 'switched-off';
  const senderId = p.senderId;
  if (!p.messageId || !senderId) return 'no-source';
  const m = await prisma.communityMessage.findFirst({
    where: { id: p.messageId, sender_id: senderId, cohort_id: p.cohortId, scope: 'cohort', plan_context_type: null, deleted_at: null },
    select: { workspace_id: true, parent_message_id: true, high_alert: true },
  });
  if (!m) return 'message-gone';
  const [parent, stays, open, blocks, row, cohort] = await Promise.all([
    m.parent_message_id
      ? prisma.communityMessage.findFirst({
          where: { id: m.parent_message_id, cohort_id: p.cohortId, scope: 'cohort', deleted_at: null },
          select: { sender_id: true },
        })
      : null,
    rowsByAuthorsWhoStay(prisma, userId, [p.cohortId], () => senderId, (c) => [m.workspace_id, c]),
    canEnterSpace(prisma, p.cohortId, userId),
    prisma.userBlock.count({
      where: { OR: [{ blocker_id: senderId, blocked_id: userId }, { blocker_id: userId, blocked_id: senderId }] },
    }),
    prisma.communitySpaceRead.findFirst({
      where: { cohort_id: p.cohortId, user_id: userId },
      select: { notify_mode: true, silenced_until: true },
    }),
    prisma.communityCohort.findUnique({ where: { id: p.cohortId }, select: { kind: true } }),
  ]);
  if (stays.length === 0) return 'sender-left';
  if (!open || !cohort) return 'no-access';
  if (blocks > 0) return 'blocked';
  const { effective_mode } = notifySettingOf(cohort, row, now);
  const unread =
    p.kind === 'unread' && effective_mode === 'all'
      ? ((await spaceUnreadCounts(prisma, userId, [p.cohortId])).get(p.cohortId) ?? 0)
      : 0;
  const [again] = planSpacePush(
    { senderId, repliedToId: parent?.sender_id ?? null, highAlert: m.high_alert },
    [{ userId, effectiveMode: effective_mode, unread }],
  );
  return again?.kind === p.kind ? null : 'not-planned';
}
