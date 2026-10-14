import type { PrismaService } from '../prisma.service';

/**
 * COMMUNITYMOVE, owner 137-8: "when a client moves, the old coach loses
 * everything at once, and the history stays with the client". The ids of the
 * clients who have left `coachId` (as their coach, or as the head of their
 * coach's team) and still hold a membership row, ended or not, in a community
 * `coachId` owns. The rule is app.community_author_moved (migration
 * 20270502002000), the same function the row policies use, so the server and
 * RLS agree. Nothing is deleted: callers hide these people's rows.
 */
export async function clientsWhoLeftCoach(
  prisma: PrismaService,
  coachId: string,
): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>`
    SELECT DISTINCT m."user_id" FROM public."community_memberships" m
      JOIN public."community_workspaces" w ON w."id" = m."workspace_id"
     WHERE w."coach_id" = ${coachId}
       AND app.community_author_moved(m."user_id", w."id")`;
  return new Set(rows.map((r) => r.user_id));
}
