/**
 * COMMUNITYMOVE (owner 4, "RLS for everything!"): the row layer under the
 * community after a client changes coach, on the replayed migration chain.
 * A direct table read as the API role `authenticated`, with
 * app.current_user_id naming one person. Client M moves from coach X to
 * coach Y: M reads none of X's community (posts, other members, workspace,
 * cohort), X reads none of M's memberships, and M reads Y's community once
 * GET /community/me has joined them. P (stayed with X), Q and coach Z (another
 * community) are unaffected. Every 0 has a control read of 1 before the move,
 * so a zero means the rule refused the row, not that it is missing.
 * The server read of the same move: test/community/community-foundation.e2e.spec.ts case 17.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-move-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Table = 'community_posts' | 'community_memberships' | 'community_workspaces' | 'community_cohorts';

(DB_URL ? describe : describe.skip)("COMMUNITYMOVE row layer: a moved client leaves the old coach's community", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Coaches X (old), Y (new), Z (another).
  // Clients: M moves X -> Y, P stays with X, R is Y's, Q is Z's, S moved before the fix.
  const [x, y, z, m, p, r, q, s] = Array.from({ length: 8 }, () => randomUUID());
  const ws: Record<string, string> = {};
  const cohort: Record<string, string> = {};
  const post: Record<string, string> = {};
  const member: Record<string, string> = {};

  /** Rows with this id in `table` that `who` sees as the API role `authenticated`. */
  const seen = (table: Table, rowId: string, who: string): Promise<number> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1::uuid`,
        rowId,
      );
      return n;
    });
  const join = async (key: string, userId: string, coachKey: string) => {
    const row = await prisma.communityMembership.create({
      data: { workspace_id: ws[coachKey], cohort_id: cohort[coachKey], user_id: userId, joined_at: new Date() },
    });
    member[key] = row.id;
  };
  const hallPost = async (key: string, coachKey: string, authorId: string) => {
    const row = await prisma.communityPost.create({
      data: { workspace_id: ws[coachKey], author_id: authorId, scope: 'hall', title: 'RLS post', body: 'RLS body' },
    });
    post[key] = row.id;
  };

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [x, 'coach', null], [y, 'coach', null], [z, 'coach', null],
      [m, 'student', x], [p, 'student', x], [r, 'student', y], [q, 'student', z], [s, 'student', x],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    for (const [key, coachId] of [['x', x], ['y', y], ['z', z]] as const) {
      const w = await prisma.communityWorkspace.create({ data: { coach_id: coachId, name: 'Community', slug: `move-rls-${coachId}` } });
      ws[key] = w.id;
      cohort[key] = (await prisma.communityCohort.create({ data: { workspace_id: w.id, name: 'All members' } })).id;
    }
    await join('mX', m, 'x');
    await join('pX', p, 'x');
    await join('sX', s, 'x');
    await join('rY', r, 'y');
    await join('qZ', q, 'z');
    await hallPost('x', 'x', x);
    await hallPost('mInX', 'x', m);
    await hallPost('y', 'y', y);
    await hallPost('z', 'z', z);
  });
  afterAll(() => prisma.$disconnect());

  it("before the move: M reads X's community and X reads M's membership (the controls)", async () => {
    expect(await seen('community_posts', post.x, m)).toBe(1);
    expect(await seen('community_memberships', member.pX, m)).toBe(1);
    expect(await seen('community_workspaces', ws.x, m)).toBe(1);
    expect(await seen('community_cohorts', cohort.x, m)).toBe(1);
    expect(await seen('community_memberships', member.mX, x)).toBe(1);
    expect(await seen('community_posts', post.y, m)).toBe(0);
  });

  describe('after M moves from coach X to coach Y', () => {
    beforeAll(() => prisma.user.update({ where: { id: m }, data: { coach_id: y } }));

    it('the move ends M\'s membership in X (kept, not deleted) and keeps M\'s own post', async () => {
      const row = await prisma.communityMembership.findUnique({ where: { id: member.mX } });
      expect(row?.status).toBe('removed');
      expect(row?.removed_at).not.toBeNull();
      expect(await prisma.communityPost.count({ where: { id: post.mInX } })).toBe(1);
    });

    it("M reads none of X's posts, members, workspace or cohort", async () => {
      expect(await seen('community_posts', post.x, m)).toBe(0);
      expect(await seen('community_posts', post.mInX, m)).toBe(0);
      expect(await seen('community_memberships', member.pX, m)).toBe(0);
      expect(await seen('community_workspaces', ws.x, m)).toBe(0);
      expect(await seen('community_cohorts', cohort.x, m)).toBe(0);
    });

    it("the former coach X reads none of M's memberships", async () => {
      expect(await seen('community_memberships', member.mX, x)).toBe(0);
    });

    it("once GET /community/me joins M to Y's community, M reads Y's post and members", async () => {
      await join('mY', m, 'y');
      expect(await seen('community_posts', post.y, m)).toBe(1);
      expect(await seen('community_memberships', member.rY, m)).toBe(1);
      expect(await seen('community_memberships', member.mY, y)).toBe(1);
      expect(await seen('community_memberships', member.mX, y)).toBe(0);
    });

    it('P, who stayed, and coach Z with client Q are unaffected', async () => {
      expect(await seen('community_posts', post.x, p)).toBe(1);
      expect(await seen('community_posts', post.mInX, p)).toBe(1);
      expect(await seen('community_memberships', member.pX, p)).toBe(1);
      expect(await seen('community_memberships', member.pX, x)).toBe(1);
      expect(await seen('community_posts', post.z, q)).toBe(1);
      expect(await seen('community_memberships', member.qZ, z)).toBe(1);
      expect(await seen('community_memberships', member.mX, z)).toBe(0);
      expect(await seen('community_memberships', member.mY, z)).toBe(0);
      expect(await seen('community_posts', post.x, q)).toBe(0);
    });
  });

  describe('a client who moved before the fix (a membership left open)', () => {
    beforeAll(async () => {
      await prisma.user.update({ where: { id: s }, data: { coach_id: y } });
      // Re-open the row the way production holds it today: active in X's community.
      await prisma.communityMembership.update({ where: { id: member.sX }, data: { status: 'active', removed_at: null } });
    });

    it("the former coach already reads none of it; the migration's close rule then shuts S out of X", async () => {
      expect(await seen('community_posts', post.x, s)).toBe(1);
      expect(await seen('community_memberships', member.sX, x)).toBe(0);
      const close = (id: string) =>
        prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT app.close_community_memberships_left_by_move($1) AS n`, id);
      expect(await close(s)).toEqual([{ n: 1 }]);
      expect(await seen('community_posts', post.x, s)).toBe(0);
      expect(await close(s)).toEqual([{ n: 0 }]);
      expect(await close(p)).toEqual([{ n: 0 }]);
      expect(await seen('community_posts', post.x, p)).toBe(1);
    });
  });
});
