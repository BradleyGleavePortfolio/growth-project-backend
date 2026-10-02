import type { PrismaService } from '../prisma.service';
import { bannedAmong } from './community-ban';

/**
 * Member wins (More > Community "Share a win") safety policy, App Review 1.2.
 *
 * A win is user-generated content shown to the author's teammates (the other
 * clients of the same coach). Every win other people can see must be
 * filterable, reportable and actionable, so:
 *
 * - The audience is the coach's circle only, and only when that coach runs a
 *   community workspace: that workspace's moderation queue is where a report
 *   on the win lands and where the coach (and the TGP team) act on it within
 *   24 hours. With no workspace (or no coach) there is no moderated audience,
 *   so a member sees only their own wins. There is no cross-tenant "public"
 *   feed: `visibility: 'public'` is accepted for old clients and stored as
 *   `circle`.
 * - A ban from that workspace (durable ban row, or membership `removed`)
 *   hides the member's wins from teammates, stops them posting new ones, and
 *   limits their own feed to their own wins (B-610-2).
 * - A Hide from the queue sets `hidden_at`; hidden wins never appear again.
 */

export const WIN_NOT_FOUND = {
  error: 'not_found',
  code: 'community.win.not_found',
  message: 'This win could not be found. It may have been removed. Refresh and try again.',
} as const;

export const WIN_POSTING_REMOVED = {
  error: 'forbidden',
  code: 'community.win.removed_member',
  message:
    'You cannot share wins in this community because your access was removed. If you think this is a mistake, email the safety contact in Community safety.',
} as const;

/**
 * The community workspace whose moderation queue owns a coach's wins circle:
 * the coach's oldest non-archived workspace (the same rule the Community
 * "me" and Today routes use), or null when the coach runs none.
 */
export async function winModerationWorkspaceId(
  prisma: PrismaService,
  coachId: string | null | undefined,
): Promise<string | null> {
  if (!coachId) return null;
  const ws = await prisma.communityWorkspace.findFirst({
    where: { coach_id: coachId, archived_at: null },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  return ws?.id ?? null;
}

/**
 * Users among `userIds` who were removed (banned) from the workspace: an
 * active durable ban (community_workspace_bans, B-610-2), or at least one
 * `removed` membership row there and no active one.
 */
export async function removedFromWorkspace(
  prisma: PrismaService,
  workspaceId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.communityMembership.findMany({
    where: { workspace_id: workspaceId, user_id: { in: userIds } },
    select: { user_id: true, status: true },
  });
  const removedRow = new Set<string>();
  const active = new Set<string>();
  for (const r of rows) {
    if (r.status === 'removed') removedRow.add(r.user_id);
    if (r.status === 'active') active.add(r.user_id);
  }
  const removed = await bannedAmong(prisma, workspaceId, userIds);
  for (const id of removedRow) if (!active.has(id)) removed.add(id);
  return removed;
}
