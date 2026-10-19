import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../../src/prisma.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

/**
 * A real CommunitySafetyService over an in-memory block list. Used by unit
 * specs that construct community services directly: the content filter runs
 * for real and `blocks` lists [blocker, blocked] pairs. Filtering is two-way.
 * C6-WINS-MOVE: `world` holds the people, workspaces, spaces and memberships
 * app.community_author_stays reads, and InMemoryPrisma answers it by the SQL
 * function's rule. An empty world answers as Postgres does for people it does
 * not know: every author stays.
 */
export function safetyWithBlocks(
  blocks: Array<[string, string]> = [],
  world = new InMemoryPrisma(),
): CommunitySafetyService {
  const prisma = {
    $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) => world.$queryRaw(sql, ...values),
    userBlock: {
      // Two-way lookup (hiddenFromViewer): OR over blocker_id / blocked_id.
      findMany: async (args: {
        where: { OR: Array<{ blocker_id?: string; blocked_id?: string }> };
      }) =>
        blocks
          .filter(([a, b]) =>
            args.where.OR.some(
              (c) =>
                (c.blocker_id === undefined || c.blocker_id === a) &&
                (c.blocked_id === undefined || c.blocked_id === b),
            ),
          )
          .map(([a, b]) => ({ blocker_id: a, blocked_id: b })),
      findFirst: async (args: {
        where: { OR: Array<{ blocker_id: string; blocked_id: string }> };
      }) =>
        args.where.OR.some((c) => blocks.some(([a, b]) => a === c.blocker_id && b === c.blocked_id))
          ? { id: 'block' }
          : null,
    },
  };
  return new CommunitySafetyService(stub<PrismaService>(prisma));
}
