/**
 * COMMUNITYMOVE (owner 137-8: "when a client moves, the old coach loses
 * everything at once, and the history stays with the client"; "RLS for
 * everything!"): the row layer under the community after a client changes
 * coach, on the replayed migration chain. Reads and writes run as the API role
 * `authenticated`, with app.current_user_id naming one person. Client M moves
 * from coach X to coach Y: M reads none of X's community, and X reads and
 * writes none of M's rows (posts, comments, cohort messages, memberships),
 * even through a membership X writes for themselves (the shared-cohort peer
 * arm) or a writable role label. P (stayed with X) still reads M's history;
 * Y, team head H, a genuine assistant A, coach Z and client Q are unaffected.
 * Every 0 has a read of 1 by the same reader before the move, and every
 * refused write a permitted one beside it.
 * The server reads of the same move: test/community/community-posts.e2e.spec.ts
 * case 10 and community-messages.e2e.spec.ts case 11.
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

type Table =
  | 'community_posts'
  | 'community_messages'
  | 'community_memberships'
  | 'community_workspaces'
  | 'community_cohorts';
const RLS_REFUSED = /row-level security/;

(DB_URL ? describe : describe.skip)("COMMUNITYMOVE row layer: a moved client leaves the old coach's community", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Coaches X (old), Y (new), Z (another),
  // H (team head) with sub-coach T, and A (an assistant, nobody's client).
  // Clients: M moves X -> Y, P stays with X, R is Y's, Q is Z's, S moved before
  // the fix, C is T's (so in H's team).
  const [x, y, z, h, t, a, m, p, r, q, s, c] = Array.from({ length: 12 }, () => randomUUID());
  const ws: Record<string, string> = {};
  const cohort: Record<string, string> = {};
  const post: Record<string, string> = {};
  const msg: Record<string, string> = {};
  const member: Record<string, string> = {};

  /** Runs `run` as the API role `authenticated` with app.current_user_id = who. */
  const runAs = <T>(who: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      return run(tx);
    });
  /** Rows with this id in `table` that `who` sees. */
  const seen = (table: Table, rowId: string, who: string): Promise<number> =>
    runAs(who, async (tx) => {
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1::uuid`,
        rowId,
      );
      return n;
    });
  /** `who` adds `userId` to a cohort with a role label; the new row id, or a row-policy refusal. */
  const addMember = (who: string, cohortKey: string, userId: string, role: string): Promise<string> =>
    runAs(who, async (tx) => {
      const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO public."community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::"CommunityMembershipRole", 'active', now()) RETURNING "id"::text`,
        ws[cohortKey.slice(0, 1)], cohort[cohortKey], userId, role,
      );
      return row.id;
    });
  /** Rows `who` changes with an UPDATE on `table` by id (0 when the policy hides the row). */
  const update = (who: string, table: Table, set: string, rowId: string): Promise<number> =>
    runAs(who, (tx) => tx.$executeRawUnsafe(`UPDATE public."${table}" SET ${set} WHERE "id" = $1::uuid`, rowId));
  const join = async (key: string, userId: string, cohortKey: string, role: 'student' | 'assistant' = 'student') => {
    const row = await prisma.communityMembership.create({
      data: { workspace_id: ws[cohortKey.slice(0, 1)], cohort_id: cohort[cohortKey], user_id: userId, role, joined_at: new Date() },
    });
    member[key] = row.id;
  };
  const hallPost = async (key: string, coachKey: string, authorId: string) => {
    const row = await prisma.communityPost.create({
      data: { workspace_id: ws[coachKey], author_id: authorId, scope: 'hall', title: 'RLS post', body: 'RLS body' },
    });
    post[key] = row.id;
  };
  const cohortMessage = async (key: string, senderId: string, commentOn?: string) => {
    const row = await prisma.communityMessage.create({
      data: {
        workspace_id: ws.x, cohort_id: cohort.x, scope: 'cohort', sender_id: senderId, body: 'RLS message',
        ...(commentOn ? { plan_context_type: 'community_post_comment', plan_context_id: commentOn } : {}),
      },
    });
    msg[key] = row.id;
  };

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [x, 'coach', null], [y, 'coach', null], [z, 'coach', null], [h, 'coach', null], [t, 'coach', null], [a, 'coach', null],
      [m, 'student', x], [p, 'student', x], [r, 'student', y], [q, 'student', z], [s, 'student', x], [c, 'student', t],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: t } });
    for (const [key, coachId] of [['x', x], ['y', y], ['z', z], ['h', h]] as const) {
      const w = await prisma.communityWorkspace.create({ data: { coach_id: coachId, name: 'Community', slug: `move-rls-${coachId}` } });
      ws[key] = w.id;
      for (const k of key === 'x' ? ['x', 'x2', 'x3'] : [key]) {
        cohort[k] = (await prisma.communityCohort.create({ data: { workspace_id: w.id, name: `Space ${k}` } })).id;
      }
    }
    await join('mX', m, 'x');
    // The label the server's co_coach assign writes, on a client's row.
    await join('mX2', m, 'x2', 'assistant');
    await join('pX', p, 'x');
    await join('sX', s, 'x');
    await join('rY', r, 'y');
    await join('qZ', q, 'z');
    await hallPost('x', 'x', x);
    await hallPost('mInX', 'x', m);
    await hallPost('pInX', 'x', p);
    await hallPost('y', 'y', y);
    await hallPost('z', 'z', z);
    await cohortMessage('mChat', m);
    await cohortMessage('mComment', m, post.x);
  });
  afterAll(() => prisma.$disconnect());

  it("before the move: M reads X's community and X reads M's rows (the controls)", async () => {
    // X joins their own space as coach (permitted), which also opens the shared-cohort peer arm.
    member.xX = await addMember(x, 'x', x, 'coach');
    expect(await seen('community_memberships', member.xX, x)).toBe(1);
    expect(await seen('community_posts', post.x, m)).toBe(1);
    expect(await seen('community_posts', post.mInX, m)).toBe(1);
    expect(await seen('community_memberships', member.pX, m)).toBe(1);
    expect(await seen('community_workspaces', ws.x, m)).toBe(1);
    expect(await seen('community_cohorts', cohort.x, m)).toBe(1);
    expect(await seen('community_cohorts', cohort.x2, m)).toBe(1);
    for (const [table, id] of [
      ['community_memberships', member.mX], ['community_memberships', member.mX2], ['community_memberships', member.sX],
      ['community_posts', post.mInX], ['community_messages', msg.mChat], ['community_messages', msg.mComment],
    ] as const) {
      expect(await seen(table, id, x)).toBe(1);
    }
    expect(await update(x, 'community_posts', `"title" = 'Pinned'`, post.pInX)).toBe(1);
    expect(await seen('community_posts', post.y, m)).toBe(0);
  });

  describe('after M moves from coach X to coach Y', () => {
    beforeAll(() => prisma.user.update({ where: { id: m }, data: { coach_id: y } }));

    it("the move ends every membership of M's in X, whatever its role label, and keeps M's rows", async () => {
      for (const id of [member.mX, member.mX2]) {
        const row = await prisma.communityMembership.findUnique({ where: { id } });
        expect(row?.status).toBe('removed');
        expect(row?.removed_at).not.toBeNull();
      }
      expect(await prisma.communityPost.count({ where: { id: post.mInX } })).toBe(1);
      expect(await prisma.communityMessage.count({ where: { id: { in: [msg.mChat, msg.mComment] } } })).toBe(2);
    });

    it("M reads none of X's posts, members, workspace or spaces", async () => {
      expect(await seen('community_posts', post.x, m)).toBe(0);
      expect(await seen('community_posts', post.mInX, m)).toBe(0);
      expect(await seen('community_memberships', member.pX, m)).toBe(0);
      expect(await seen('community_workspaces', ws.x, m)).toBe(0);
      expect(await seen('community_cohorts', cohort.x, m)).toBe(0);
      expect(await seen('community_cohorts', cohort.x2, m)).toBe(0);
    });

    it("the former coach X reads none of M's posts, comments, messages or memberships, even as a cohort member", async () => {
      for (const [table, id] of [
        ['community_memberships', member.mX], ['community_memberships', member.mX2],
        ['community_posts', post.mInX], ['community_messages', msg.mChat], ['community_messages', msg.mComment],
      ] as const) {
        expect(await seen(table, id, x)).toBe(0);
      }
      expect(await seen('community_memberships', member.xX, x)).toBe(1);
    });

    it('the former coach X cannot write M back in, by any role label, nor touch M\'s rows', async () => {
      await expect(addMember(x, 'x3', m, 'assistant')).rejects.toThrow(RLS_REFUSED);
      await expect(addMember(x, 'x3', m, 'student')).rejects.toThrow(RLS_REFUSED);
      await expect(addMember(x, 'x3', q, 'coach')).rejects.toThrow(RLS_REFUSED);
      expect(await update(x, 'community_memberships', `"status" = 'active'`, member.mX2)).toBe(0);
      expect(await update(x, 'community_posts', `"title" = 'Pinned'`, post.mInX)).toBe(0);
      // Permitted beside them: a genuine assistant (nobody's client) and X's own client.
      const assistant = await addMember(x, 'x3', a, 'assistant');
      expect(await seen('community_memberships', assistant, x)).toBe(1);
      expect(await seen('community_memberships', await addMember(x, 'x3', p, 'student'), x)).toBe(1);
    });

    it("P, who stayed, still reads M's history; X still reads P's", async () => {
      expect(await seen('community_posts', post.mInX, p)).toBe(1);
      expect(await seen('community_messages', msg.mChat, p)).toBe(1);
      expect(await seen('community_messages', msg.mComment, p)).toBe(1);
      expect(await seen('community_posts', post.x, p)).toBe(1);
      expect(await seen('community_memberships', member.pX, p)).toBe(1);
      expect(await seen('community_posts', post.pInX, x)).toBe(1);
      expect(await seen('community_memberships', member.pX, x)).toBe(1);
    });

    it("once GET /community/me joins M to Y's community, M reads it and Y reads and writes M's row", async () => {
      await join('mY', m, 'y');
      expect(await seen('community_posts', post.y, m)).toBe(1);
      expect(await seen('community_memberships', member.rY, m)).toBe(1);
      expect(await seen('community_memberships', member.mY, y)).toBe(1);
      expect(await update(y, 'community_memberships', `"notify_level" = 'all'`, member.mY)).toBe(1);
      expect(await seen('community_memberships', member.mX, y)).toBe(0);
    });

    it('team head H keeps a sub-coach\'s client; coach Z with client Q is unaffected', async () => {
      const cH = await addMember(h, 'h', c, 'student');
      expect(await seen('community_memberships', cH, h)).toBe(1);
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
