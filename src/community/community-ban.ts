import type { PrismaService } from '../prisma.service';

/**
 * Durable community bans (B-610-2), stored in community_workspace_bans.
 *
 * A Ban from the moderation queue writes one row per (workspace, member) and
 * also marks every membership there `removed`. The row is what makes the ban
 * authoritative everywhere, independent of cohorts:
 *  - CommunityAccessService denies a banned member every workspace/cohort
 *    read and write (Hall, cohorts, DMs, voice, challenges, events).
 *  - The default-cohort bootstrap in GET /community/me never admits them,
 *    even after the coach creates, archives or re-orders cohorts.
 *  - The member wins feed shows a banned viewer only their own wins, hides a
 *    banned author's wins from teammates, and refuses new wins.
 * Only an explicit reinstatement by the workspace coach (adding the member to
 * a cohort, community-cohort-members.service) lifts it (lifted_at).
 */

type BanDb = Pick<PrismaService, 'communityWorkspaceBan'>;

export async function isBannedFromWorkspace(
  prisma: BanDb,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.communityWorkspaceBan.findFirst({
    where: { workspace_id: workspaceId, user_id: userId, lifted_at: null },
    select: { id: true },
  });
  return row !== null;
}

/** Users among `userIds` with an active ban in the workspace. */
export async function bannedAmong(
  prisma: BanDb,
  workspaceId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.communityWorkspaceBan.findMany({
    where: { workspace_id: workspaceId, user_id: { in: userIds }, lifted_at: null },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

/**
 * #168-4: a ban hides everything the banned person wrote in that community
 * from everyone else. Drops rows whose author holds an active ban in the
 * row's workspace; the viewer's own rows stay. One query for the whole page.
 */
export async function withoutBannedAuthors<T>(
  prisma: BanDb,
  viewerId: string,
  rows: T[],
  authorOf: (row: T) => string | null | undefined,
  workspaceOf: (row: T) => string,
): Promise<T[]> {
  const others = rows.filter((r) => { const a = authorOf(r); return !!a && a !== viewerId; });
  if (others.length === 0) return rows;
  const bans = await prisma.communityWorkspaceBan.findMany({
    where: {
      workspace_id: { in: [...new Set(others.map(workspaceOf))] },
      user_id: { in: [...new Set(others.map((r) => authorOf(r) as string))] },
      lifted_at: null,
    },
    select: { workspace_id: true, user_id: true },
  });
  if (bans.length === 0) return rows;
  const banned = new Set(bans.map((b) => `${b.workspace_id}:${b.user_id}`));
  return rows.filter((r) => {
    const a = authorOf(r);
    return !a || a === viewerId || !banned.has(`${workspaceOf(r)}:${a}`);
  });
}

export async function recordWorkspaceBan(
  prisma: BanDb,
  input: {
    workspaceId: string;
    userId: string;
    bannedById: string;
    moderationActionId: string | null;
    at: Date;
  },
): Promise<void> {
  await prisma.communityWorkspaceBan.upsert({
    where: {
      workspace_id_user_id: { workspace_id: input.workspaceId, user_id: input.userId },
    },
    create: {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      banned_by_id: input.bannedById,
      moderation_action_id: input.moderationActionId,
      created_at: input.at,
    },
    update: {
      banned_by_id: input.bannedById,
      moderation_action_id: input.moderationActionId,
      created_at: input.at,
      lifted_at: null,
      lifted_by_id: null,
    },
  });
}

/** Explicit reinstatement: lift an active ban (no-op when none). */
export async function liftWorkspaceBan(
  prisma: BanDb,
  input: { workspaceId: string; userId: string; liftedById: string; at: Date },
): Promise<boolean> {
  const res = await prisma.communityWorkspaceBan.updateMany({
    where: { workspace_id: input.workspaceId, user_id: input.userId, lifted_at: null },
    data: { lifted_at: input.at, lifted_by_id: input.liftedById },
  });
  return res.count > 0;
}
