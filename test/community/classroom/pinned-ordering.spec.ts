/**
 * Unit tests for the v3-2 classroom feed ORDERING + pagination
 * (CommunityClassroomRepository).
 *
 * The pinned-first ordering is enforced in the DB query, so we mock
 * PrismaService and assert:
 *   - The orderBy clause is pinned DESC, then pinned_order ASC NULLS LAST, then
 *     published_at DESC NULLS LAST, with a stable created_at/id tiebreak. This
 *     is the pinned-ordering contract: pinned lessons sort ahead of non-pinned
 *     (pinned DESC primary), an explicit pinned_order sorts before a null one
 *     (NULLS LAST), and equal rows page deterministically (id tiebreak — the
 *     pinned-with-null-order edge case).
 *   - Media is joined in the SAME query (include) — no per-post media loop (no
 *     N+1).
 *   - Pagination fetches limit+1 and derives next_cursor from the overflow row;
 *     a stale/foreign cursor that does not resolve in scope yields the first
 *     page (no throw).
 *   - The student feed filter pushes the release predicate into the query
 *     (status=published AND release_at null-or-past AND soft_deleted_at null).
 */
import { CommunityClassroomRepository } from '../../../src/community/classroom/community-classroom.repository';

type PrismaMock = {
  communityClassroomPost: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
  };
};

const WS_A = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-03-01T00:00:00.000Z');

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_A,
    cohort_id: null,
    coach_id: 'c',
    title: 't',
    body_markdown: 'b',
    status: 'published',
    pinned: false,
    pinned_order: null,
    release_at: null,
    published_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    soft_deleted_at: null,
    media_assets: [],
    ...over,
  };
}

describe('CommunityClassroomRepository ordering + pagination', () => {
  let prisma: PrismaMock;
  let repo: CommunityClassroomRepository;

  beforeEach(() => {
    prisma = {
      communityClassroomPost: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    // @ts-expect-error structural PrismaService mock: only communityClassroomPost is stubbed
    repo = new CommunityClassroomRepository(prisma);
  });

  it('orders pinned-first, pinned_order ASC NULLS LAST, published_at DESC, stable tiebreak', async () => {
    await repo.listForCoach({ workspaceId: WS_A, cohortId: null });
    const args = prisma.communityClassroomPost.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([
      { pinned: 'desc' },
      { pinned_order: { sort: 'asc', nulls: 'last' } },
      { published_at: { sort: 'desc', nulls: 'last' } },
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('joins media in the same query (no per-post N+1 loop)', async () => {
    await repo.listForCoach({ workspaceId: WS_A, cohortId: null });
    const args = prisma.communityClassroomPost.findMany.mock.calls[0][0];
    expect(args.include).toEqual({
      media_assets: { orderBy: { created_at: 'asc' } },
    });
  });

  it('fetches limit+1 and derives next_cursor from the overflow row', async () => {
    prisma.communityClassroomPost.findMany.mockResolvedValue([
      row('p1'),
      row('p2'),
      row('p3'), // overflow row (limit=2)
    ]);
    const page = await repo.listForCoach({
      workspaceId: WS_A,
      cohortId: null,
      limit: 2,
    });
    expect(prisma.communityClassroomPost.findMany.mock.calls[0][0].take).toBe(3);
    expect(page.items.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(page.nextCursor).toBe('p2');
  });

  it('returns next_cursor=null when there is no overflow row', async () => {
    prisma.communityClassroomPost.findMany.mockResolvedValue([row('p1')]);
    const page = await repo.listForCoach({
      workspaceId: WS_A,
      cohortId: null,
      limit: 20,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('ignores a stale/foreign cursor (resolves to first page, no throw)', async () => {
    prisma.communityClassroomPost.findFirst.mockResolvedValue(null); // cursor not in scope
    prisma.communityClassroomPost.findMany.mockResolvedValue([row('p1')]);
    const page = await repo.listForCoach({
      workspaceId: WS_A,
      cohortId: null,
      cursor: '99999999-9999-9999-9999-999999999999',
    });
    // No cursor clause applied because the anchor did not resolve.
    const args = prisma.communityClassroomPost.findMany.mock.calls[0][0];
    expect(args.cursor).toBeUndefined();
    expect(page.items.map((p) => p.id)).toEqual(['p1']);
  });

  it('student feed pushes the release predicate INTO the query', async () => {
    await repo.listForStudent({
      workspaceId: WS_A,
      visibleCohortIds: [],
      cohortFilter: null,
      now: NOW,
    });
    const where = prisma.communityClassroomPost.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('published');
    expect(where.soft_deleted_at).toBeNull();
    expect(where.OR).toEqual([
      { release_at: null },
      { release_at: { lte: NOW } },
    ]);
  });

  it('coach feed does NOT filter by status (drafts + scheduled are visible to coach)', async () => {
    await repo.listForCoach({ workspaceId: WS_A, cohortId: null });
    const where = prisma.communityClassroomPost.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
    expect(where.soft_deleted_at).toBeNull();
  });
});
