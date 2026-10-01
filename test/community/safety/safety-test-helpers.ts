import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../../src/prisma.service';

function stub<T>(v: unknown): T {
  return v as T;
}

/**
 * A real CommunitySafetyService over an in-memory block list. Used by unit
 * specs that construct community services directly: the content filter runs
 * for real and `blocks` lists [blocker, blocked] pairs.
 */
export function safetyWithBlocks(blocks: Array<[string, string]> = []): CommunitySafetyService {
  const prisma = {
    userBlock: {
      findMany: async (args: { where: { blocker_id: string } }) =>
        blocks.filter(([a]) => a === args.where.blocker_id).map(([, b]) => ({ blocked_id: b })),
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
