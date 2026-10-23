import type { PrismaService } from '../prisma.service';

/**
 * #168-4 (owner rule): a block closes every conversation between the two
 * people both ways. The ids among `others` in a block with `userId`, either
 * direction. One indexed query; used by every entry point that offers
 * Message or Ask Roman for one person (plan-ended list, Home reach-outs and
 * wins, the at-risk list, Roman one-client drafts).
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
