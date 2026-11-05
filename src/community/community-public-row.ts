import type { PrismaService } from '../prisma.service';

/**
 * Rule D (owner, 10-26; decision #178-2 op 1; SoT A6.0-178), the poster's own coach: a public space's row by a
 * coach's current client reaches that coach too, who is not on the space's team. One row-scoped grant, read
 * only: that client's rows in that space, never the space, another author's rows or a write, and never while
 * the coach is banned from the space's community. The where-fragments below are the one definition the API
 * uses (the inbox's own-coach arm, the ack, the post read); the row layer's twin is
 * app.community_public_row_of_my_client (20270502009800), the report queue's is
 * CommunityModerationRepository.listForRuleDReader.
 */
type RowDb = Pick<PrismaService, 'communityCohort' | 'communityMembership' | 'user' | '$queryRaw'>;

/** The space side: public. The ban on the reader is asked by unbannedSpaces, never by a relation filter here. */
export const PUBLIC_SPACE = { visibility: 'public' as const };

/**
 * The spaces among `spaces` whose community does not ban `viewerId`. Asked through
 * app.community_author_unbanned (SECURITY DEFINER, 20270502008900): community_workspace_bans has no read grant
 * for a signed-in role, so a relation filter on it fails under row security (42501).
 */
export async function unbannedSpaces(
  db: Pick<PrismaService, '$queryRaw'>,
  viewerId: string,
  spaces: Array<{ id: string; workspace_id: string }>,
): Promise<string[]> {
  if (spaces.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT t."id"::text AS "id"
    FROM unnest(${spaces.map((c) => c.id)}::uuid[], ${spaces.map((c) => c.workspace_id)}::uuid[]) AS t("id", "w")
    WHERE app.community_author_unbanned(t."w", ${viewerId})`;
  return rows.map((r) => r.id);
}

/** The author side: the reading coach's current client. */
export const clientOf = (viewerId: string) => ({ coach_id: viewerId, role: 'student' as const });

/** True when `authorId`'s row in the space reaches `viewerId` as the poster's own coach. */
export async function isPublicRowOfMyClient(db: RowDb, cohortId: string, viewerId: string, authorId: string): Promise<boolean> {
  if (authorId === viewerId) return false;
  const [space, client] = await Promise.all([
    db.communityCohort.findFirst({ where: { id: cohortId, ...PUBLIC_SPACE }, select: { id: true, workspace_id: true } }),
    db.user.count({ where: { id: authorId, ...clientOf(viewerId) } }),
  ]);
  return !!space && client > 0 && (await unbannedSpaces(db, viewerId, [space])).length > 0;
}

/** Rule D, the owner's team: an active coach or assistant membership in the space (the inbox's team arm). */
export async function isSpaceTeam(db: RowDb, cohortId: string, viewerId: string): Promise<boolean> {
  const team = await db.communityMembership.count({
    where: { cohort_id: cohortId, user_id: viewerId, status: 'active', role: { in: ['coach', 'assistant'] } },
  });
  return team > 0;
}

/** The people among `ids` who are `viewerId`'s current clients. */
export async function clientsAmong(db: RowDb, viewerId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.user.findMany({ where: { id: { in: ids }, ...clientOf(viewerId) }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
