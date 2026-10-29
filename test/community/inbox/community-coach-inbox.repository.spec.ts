// C6-MOVED-PRIVILEGED-READS (owner: history follows the client; a former coach loses every read of a moved
// client). The coach inbox merges two streams that are each bounded by a limit, so the rows of a client who
// moved away must be left out IN the query: a filter after the limit would drop rows from the page. The
// rule is the database's (app.community_author_stays, asked once by authorsWhoLeft); the live proof is in
// test/rls/community-moved-client-rls.spec.ts. Owner rule D (SPACE-OWNER-ALERTS): a coach also gets their own
// clients' rows in other coaches' public spaces, in the same one query (test/rls/community-coach-inbox-voice-rls.spec.ts).
import { CommunityCoachInboxRepository } from '../../../src/community/inbox/community-coach-inbox.repository';
import type { PrismaService } from '../../../src/prisma.service';
import { stub } from '../../utils/trial-fakes';

const SPACE = '11111111-1111-4111-8111-111111111111';
const MOVED = 'moved-client';
const PUB = '22222222-2222-4222-8222-222222222222';

function world(left: Array<{ s: string; a: string }>, theirs: string[] = [], banned: string[] = []) {
  const asked: unknown[][] = [];
  const banChecks: unknown[][] = [];
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // unbannedSpaces (the own-coach arm's ban check): the spaces in `banned` are in a community that banned the coach.
      if (strings.join('?').includes('AS t("id", "w")')) {
        banChecks.push(values);
        return (values[0] as string[]).filter((id) => !banned.includes(id)).map((id) => ({ id }));
      }
      asked.push([strings.join('?'), ...values]);
      return left;
    }),
    communityMessage: { findMany: jest.fn().mockResolvedValue([]) },
    communityPost: { findMany: jest.fn().mockResolvedValue([]) },
    communityCohort: { findMany: jest.fn().mockResolvedValue(theirs.map((id) => ({ id, workspace_id: 'w-1' }))) },
  };
  return { prisma, asked, banChecks, repo: new CommunityCoachInboxRepository(stub<PrismaService>(prisma)) };
}

describe('CommunityCoachInboxRepository: a moved client leaves the former coach\'s inbox', () => {
  it('leaves the moved client\'s chat out in the query, so the limit counts only rows that stay', async () => {
    const { prisma, asked, repo } = world([{ s: SPACE, a: MOVED }]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null, viewerId: 'coach-1' });
    expect(asked).toHaveLength(1);
    expect(String(asked[0][0])).toContain('app.community_author_stays');
    // #168-4: the same one query also leaves out banned authors and anyone in a block with the reading coach.
    expect(String(asked[0][0])).toContain('app.community_author_unbanned');
    expect(String(asked[0][0])).toContain('app.users_in_block');
    expect(asked[0].slice(1)).toEqual([[SPACE], [SPACE], 'coach-1']);
    const args = prisma.communityMessage.findMany.mock.calls[0][0];
    expect(args.where.NOT).toEqual([{ cohort_id: SPACE, sender_id: MOVED }]);
    expect(args.where.AND).toEqual([{ OR: [{ cohort_id: { in: [SPACE] } }] }, {}]);
    expect(args.take).toBe(2);
  });

  it('rule D: the coach\'s own clients\' rows in another coach\'s public space, in the same query, under the same rules', async () => {
    const { prisma, asked, repo } = world([{ s: PUB, a: MOVED }], [PUB]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null, viewerId: 'coach-1', withVoice: true });
    await repo.unansweredPosts({ cohortIds: [], limit: 2, after: null, viewerId: 'coach-1' });
    expect(prisma.communityCohort.findMany.mock.calls[0][0].where).toEqual({ id: { notIn: [SPACE] }, visibility: 'public',
      memberships: { some: { user: { coach_id: 'coach-1', role: 'student' } } } });
    expect(asked.map((a) => a.slice(1))).toEqual([[[SPACE, PUB], [SPACE, PUB], 'coach-1'], [[PUB], [PUB], 'coach-1']]);
    const chat = prisma.communityMessage.findMany.mock.calls[0][0].where;
    expect(chat.AND[0].OR).toEqual([{ cohort_id: { in: [SPACE] } },
      { cohort_id: { in: [PUB] }, sender: { coach_id: 'coach-1', role: 'student' } }]);
    expect(chat.NOT).toEqual([{ cohort_id: PUB, sender_id: MOVED }]);
    expect(chat).not.toHaveProperty('kind'); // voice notes too: no split by kind
    const posts = prisma.communityPost.findMany.mock.calls[0][0].where;
    expect(posts.AND[0].OR).toEqual([{ cohort_id: { in: [] } },
      { cohort_id: { in: [PUB] }, author: { coach_id: 'coach-1', role: 'student' } }]);
  });

  it('B4 (FR-1173, LS-INBOX2): the own-coach arm leaves out public spaces whose community banned the reading coach', async () => {
    // The ban is asked through app.community_author_unbanned (SECURITY DEFINER): community_workspace_bans has no
    // read grant under row security, so a relation filter on it fails there (42501).
    const { prisma, banChecks, repo } = world([], [PUB], [PUB]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null, viewerId: 'coach-1' });
    expect(prisma.communityCohort.findMany.mock.calls[0][0].where).not.toHaveProperty('workspace');
    expect(banChecks).toEqual([[[PUB], ['w-1'], 'coach-1']]);
    const chat = prisma.communityMessage.findMany.mock.calls[0][0].where;
    expect(chat.AND[0].OR).toEqual([{ cohort_id: { in: [SPACE] } }]);
  });

  it('B3 (FR-1173, LS-INBOX2; rule D (d)): an acknowledged message is no longer open, for any coach or the AI triage', async () => {
    const { prisma, repo } = world([]);
    await repo.unansweredMessages({ cohortIds: [SPACE], limit: 2, after: null, viewerId: 'coach-1' });
    const where = prisma.communityMessage.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ coach_replied_at: null, coach_acked_at: null });
    expect(where).not.toHaveProperty('coach_seen_at'); // seen is not an acknowledgement
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
