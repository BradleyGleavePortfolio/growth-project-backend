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
type RowDb = Pick<PrismaService, 'communityCohort' | 'communityMembership' | 'user'>;

/** The space side: public, and the reading coach not banned from its community. */
export const publicSpaceFor = (viewerId: string) => ({
  visibility: 'public' as const,
  workspace: { bans: { none: { user_id: viewerId, lifted_at: null } } },
});

/** The author side: the reading coach's current client. */
export const clientOf = (viewerId: string) => ({ coach_id: viewerId, role: 'student' as const });

/** True when `authorId`'s row in the space reaches `viewerId` as the poster's own coach. */
export async function isPublicRowOfMyClient(db: RowDb, cohortId: string, viewerId: string, authorId: string): Promise<boolean> {
  if (authorId === viewerId) return false;
  const [space, client] = await Promise.all([
    db.communityCohort.count({ where: { id: cohortId, ...publicSpaceFor(viewerId) } }),
    db.user.count({ where: { id: authorId, ...clientOf(viewerId) } }),
  ]);
  return space > 0 && client > 0;
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
