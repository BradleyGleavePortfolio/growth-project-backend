// C6-MOVED-PRIVILEGED-READS (owner: history follows the client; a former coach loses every read of a moved
// client). The coach inbox merges two streams that are each bounded by a limit, so the rows of a client who
// moved away must be left out IN the query: a filter after the limit would drop rows from the page. The
// rule is the database's (app.community_author_stays, asked once by authorsWhoLeft); the live proof is in
// test/rls/community-moved-client-rls.spec.ts.
import { CommunityCoachInboxRepository } from '../../../src/community/inbox/community-coach-inbox.repository';
import type { PrismaService } from '../../../src/prisma.service';
import { stub } from '../../utils/trial-fakes';

const SPACE = '11111111-1111-4111-8111-111111111111';
const MOVED = 'moved-client';

function world(left: Array<{ s: string; a: string }>) {
  const asked: unknown[][] = [];
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.push([strings.join('?'), ...values]);
      return left;
    }),
    communityMessage: { findMany: jest.fn().mockResolvedValue([]) },
    communityPost: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, asked, repo: new CommunityCoachInboxRepository(stub<PrismaService>(prisma)) };
}

describe('CommunityCoachInboxRepository: a moved client leaves the former coach\'s inbox', () => {
  it('leaves the moved client\'s chat out in the query, so the limit counts only rows that stay', async () => {
    const { prisma, asked, repo } = world([{ s: SPACE, a: MOVED }]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null, viewerId: 'coach-1' });
    expect(asked).toHaveLength(1);
    expect(String(asked[0][0])).toContain('app.community_author_stays');
    // #168-4: the same one query also leaves out banned authors and anyone in a block with the reading coach.
    expect(String(asked[0][0])).toContain('app.community_author_unbanned');
    expect(String(asked[0][0])).toContain('"UserBlock"');
    expect(asked[0].slice(1)).toEqual([[SPACE], [SPACE], 'coach-1', 'coach-1']);
    const args = prisma.communityMessage.findMany.mock.calls[0][0];
    expect(args.where.NOT).toEqual([{ cohort_id: SPACE, sender_id: MOVED }]);
    expect(args.where.cohort_id).toEqual({ in: [SPACE] });
    expect(args.take).toBe(2);
  });

  it('leaves the moved client\'s posts out in the query', async () => {
    const { prisma, repo } = world([{ s: SPACE, a: MOVED }]);
    await repo.unansweredPosts({ cohortIds: [SPACE], limit: 2, after: null });
    const args = prisma.communityPost.findMany.mock.calls[0][0];
    expect(args.where.NOT).toEqual([{ cohort_id: SPACE, author_id: MOVED }]);
    expect(args.take).toBe(2);
  });

  it('adds no condition when nobody left, and asks nothing for no spaces', async () => {
    const { prisma, asked, repo } = world([]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null });
    await repo.unansweredPosts({ cohortIds: [SPACE], limit: 2, after: null });
    expect(prisma.communityMessage.findMany.mock.calls[0][0].where).not.toHaveProperty('NOT');
    expect(prisma.communityPost.findMany.mock.calls[0][0].where).not.toHaveProperty('NOT');
    expect(await repo.unansweredMessages({ cohortIds: [], limit: 2, after: null })).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});
