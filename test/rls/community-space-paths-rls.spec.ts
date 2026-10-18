// C6-BVIS (agent 157): every path that reads, writes or reaches a community space answers to
// app.community_can_access, walked as one table. Rows run as role authenticated; server paths run the
// real services. X, Y coach; I is X's client in every space; O is X's client with no row anywhere; N has
// no coach and joined X's public space; Z is Y's client. X's spaces: pub (public), cli (clients),
// pkg (package; I holds a live purchase), mem (chosen members), arc (clients, archived). Y has ycli.
// Each person's first read is their control space (a 1), so every 0 follows a 1.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityCohortMembersRepository } from '../../src/community/cohorts/community-cohort-members.repository';
import { CommunityCohortMembersService } from '../../src/community/cohorts/community-cohort-members.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { readersNow } from '../../src/community/community-space-access';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { COMMUNITY_REACTION_EMOJI } from '../../src/community/reactions/community-emoji.allowlist';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import { CommunityReactionsService } from '../../src/community/reactions/community-reactions.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-paths-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'O' | 'N' | 'Z';
type Space = 'pub' | 'cli' | 'pkg' | 'mem' | 'arc' | 'ycli';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'O', 'N', 'Z']; // coaches first: clients reference them
const SPACES: Space[] = ['arc', 'mem', 'pkg', 'cli', 'pub', 'ycli']; // newest pinned post first
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', O: 'X', N: null, Z: 'Y' };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
const VISIBILITY: Record<Space, string> = { pub: 'public', cli: 'clients', pkg: 'package', mem: 'members', arc: 'clients', ycli: 'clients' };
// The one rule: who gets into each space.
const OPEN: Record<Space, Key[]> = {
  pub: ['X', 'I', 'N'], // the coach and whoever joined
  cli: ['X', 'I', 'O'], // every client of X, no row needed
  pkg: ['X', 'I'], // X's clients with a live purchase of a linked package
  mem: ['X', 'I'], // X's clients with an active row
  arc: ['X'], // archived: the coach only
  ycli: ['Y', 'Z'],
};
const ACTIVE_ROW: Record<Space, Key[]> = { pub: ['I', 'N'], cli: ['I'], pkg: ['I'], mem: ['I'], arc: [], ycli: ['Z'] };
// The Hall, DMs and wins open with a space that is not public (N's only space is public).
const HALL: Record<'X' | 'Y', Key[]> = { X: ['X', 'I', 'O'], Y: ['Y', 'Z'] };
const CONTROL: Record<Key, Space> = { X: 'arc', Y: 'ycli', I: 'mem', O: 'cli', N: 'pub', Z: 'ycli' };
const COMMENT = 'community_post_comment';
const sorted = (xs: string[]) => [...xs].sort();

(DB_URL ? describe : describe.skip)('every path to a community space answers to the one rule', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const foundation = new CommunityRepository(db);
  const messages = new CommunityMessagesRepository(db);
  const postsRepo = new CommunityPostsRepository(db);
  const safety = stub<CommunitySafetyService>({ assertAllowed: () => undefined, filterBlocked: async <T>(_v: string, rows: T[]) => rows,
    assertVisibleTo: async () => undefined, hiddenFromViewer: async () => null });
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const push = stub<CommunityNotificationsService>({ pushEnabled: () => false });
  const chat = new CommunityMessagesService(access, messages, realtime, stub<PlanContextService>({}), safety, push);
  const reactionsRepo = new CommunityReactionsRepository(db);
  const posts = new CommunityPostsService(access, postsRepo, messages, realtime, push, safety, reactionsRepo);
  const reactions = new CommunityReactionsService(access, reactionsRepo, messages, postsRepo, realtime, safety);
  const react = (k: Key, type: 'message' | 'post', target: string) => got(reactions.react(user(k), type, target, COMMUNITY_REACTION_EMOJI[0]));
  const members = new CommunityCohortMembersService(access, new CommunityCohortMembersRepository(db), safety);
  const moderation = new CommunityModerationService(access, new CommunityModerationRepository(db), messages, postsRepo, realtime, push,
    db, stub<VoiceUploadProvider>({}));
  const community = new CommunityService(db, foundation, safety);
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const ws = uuids(['X', 'Y'] as const);
  const space = uuids(SPACES);
  const msg = uuids(SPACES);
  const post = uuids(SPACES);
  const comment = uuids(SPACES);
  const row = uuids(SPACES); // a membership row in each space: N's in pub, X's (removed) in arc, Z's in ycli, else I's
  const hall = randomUUID();
  const run = randomUUID().slice(0, 8);
  const coachOf = (s: Space): 'X' | 'Y' => (s === 'ycli' ? 'Y' : 'X');
  const home = (k: Key): 'X' | 'Y' => (k === 'Y' || k === 'Z' ? 'Y' : 'X');
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Key] : null });
  const ids = (keys: Key[]) => sorted(keys.map((k) => id[k]));

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const count = (k: Key, table: string, rowId: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1::uuid`, rowId))
      .then((r) => r[0].n);
  // 1 when the path hands the person the space's row, 0 when it refuses (404/403) or leaves it out.
  const got = async <T>(p: Promise<T>, has: (r: T) => boolean = () => true): Promise<number> => {
    try {
      return has(await p) ? 1 : 0;
    } catch (e) {
      if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) return 0;
      throw e;
    }
  };
  const MESSAGE = `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "sender_id", "body", "plan_context_type", "plan_context_id", "updated_at")
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', $4, 'RLS message', $5::varchar, $6::uuid, now())`;

  // The paths a person takes into a space (rg in the PR body lists each one).
  const READS: Array<[string, (k: Key, s: Space) => Promise<number>, ((k: Key, s: Space) => boolean)?]> = [
    ['messages: list', (k, s) => got(chat.list(user(k), space[s], {}), (r) => r.messages.some((m) => m.id === msg[s]))],
    ['messages: get by id', (k, s) => got(chat.getOne(user(k), msg[s]))],
    ['messages: send', (k, s) => got(chat.send(user(k), space[s], 'RLS hello'))],
    ['posts: a post and its comments', (k, s) => got(posts.listComments(user(k), post[s]), (r) => r.comments.some((c) => c.id === comment[s]))],
    ['posts: the Hall list (opens with a space that is not public)', (k, s) => got(posts.list(user(k), ws[coachOf(s)], {}),
      (r) => r.posts.some((p) => p.id === post[s])), (k, s) => OPEN[s].includes(k) && HALL[coachOf(s)].includes(k)],
    ['reactions: a message', (k, s) => react(k, 'message', msg[s])],
    ['reactions: a post', (k, s) => react(k, 'post', post[s])],
    ['members: read the roster', (k, s) => got(members.list(user(k), space[s], {}))],
    ['reports: a message', (k, s) => got(moderation.report(user(k), 'message', msg[s], 'spam', undefined))],
    ['reports: a post', (k, s) => got(moderation.report(user(k), 'post', post[s], 'spam', undefined))],
    ['search, Today, classroom: the spaces pushed to the query', async (k, s) => Number((await access.listAccessibleCohortIds(ws[coachOf(s)], id[k])).includes(space[s]))],
    ['RLS: the message row', (k, s) => count(k, 'community_messages', msg[s])],
    ['RLS: a comment row', (k, s) => count(k, 'community_messages', comment[s])],
    ['RLS: the post row', (k, s) => count(k, 'community_posts', post[s])],
    ['RLS: a membership row', (k, s) => count(k, 'community_memberships', row[s])],
  ];
  // Who a space reaches without being asked.
  const AUDIENCES: Array<[string, (s: Space) => Promise<string[]>, (s: Space) => string[]]> = [
    ['realtime: who is pinged', (s) => readersNow(db, ws[coachOf(s)], space[s]), (s) => ids(OPEN[s])],
    ['members: who the roster lists', async (s) => (await members.list(user(coachOf(s)), space[s], {})).members.map((m) => m.user_id),
      (s) => ids(OPEN[s])],
    ['members: the count', async (s) => [String(await foundation.cohortMemberCount({ id: space[s], workspace_id: ws[coachOf(s)] }))],
      (s) => [String(OPEN[s].length)]],
    ['push: who a message reaches (an active row; B3 widens it)', async (s) =>
      (await messages.listCohortPushRecipients({ workspaceId: ws[coachOf(s)], cohortId: space[s], senderId: id[coachOf(s)] })).map((r) => r.user_id),
    (s) => ids(OPEN[s].filter((k) => ACTIVE_ROW[s].includes(k)))],
  ];

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`space-paths-${id[k]}`}, 'RLS person', ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`space-paths-${run}-${c}`}, now())`;
    }
    for (const [i, s] of SPACES.entries()) {
      const [w, by] = [ws[coachOf(s)], id[coachOf(s)]];
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "archived_at", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", $5::"CommunityCohortStatus", $6::timestamp, now())`,
      space[s], w, `RLS ${s}`, VISIBILITY[s], s === 'arc' ? 'archived' : 'active', s === 'arc' ? new Date() : null);
      await prisma.$executeRawUnsafe(MESSAGE, msg[s], w, space[s], by, null, null);
      await prisma.$executeRaw`INSERT INTO "community_posts" ("id", "workspace_id", "cohort_id", "author_id", "scope", "pinned_at", "updated_at")
        VALUES (${post[s]}::uuid, ${w}::uuid, ${space[s]}::uuid, ${by}, 'cohort', now() - make_interval(mins => ${i}::int), now())`;
      await prisma.$executeRawUnsafe(MESSAGE, comment[s], w, space[s], by, COMMENT, post[s]);
      const [holder, role, status] = s === 'pub' ? ['N', 'student', 'active'] : s === 'arc' ? ['X', 'coach', 'removed'] : s === 'ycli' ? ['Z', 'student', 'active'] : ['I', 'student', 'active'];
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"CommunityMembershipRole", $6::"CommunityMembershipStatus", now())`,
      row[s], w, space[s], id[holder as Key], role, status);
    }
    await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
      VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${space.pub}::uuid, ${id.I}, 'student', 'active', now())`;
    await prisma.$executeRaw`INSERT INTO "community_posts" ("id", "workspace_id", "author_id", "scope", "updated_at")
      VALUES (${hall}::uuid, ${ws.X}::uuid, ${id.X}, 'hall', now())`;
    const pkg = `pkg-${run}`;
    await prisma.$executeRaw`INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at") VALUES (${pkg}, ${id.X}, 'RLS package', 1000, now())`;
    await prisma.$executeRaw`INSERT INTO "community_cohort_packages" ("cohort_id", "package_id") VALUES (${space.pkg}::uuid, ${pkg})`;
    await prisma.$executeRaw`INSERT INTO "ClientPurchase" ("id", "client_user_id", "coach_user_id", "package_id", "amount_cents", "stripe_checkout_session_id",
        "idempotency_key", "status", "entitlement_active", "updated_at")
      VALUES (${`cp-${run}`}, ${id.I}, ${id.X}, ${pkg}, 1000, ${`cp-${run}`}, ${`cp-${run}`}, 'active', true, now())`;
    await prisma.communityWin.create({ data: { user_id: id.I, coach_id: id.X, title: 'RLS win', description: 'RLS win' } });
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it.each(READS)('%s', async (_path, take, opens = (k: Key, s: Space) => OPEN[s].includes(k)) => {
    for (const k of PEOPLE) {
      expect({ who: k, control: await count(k, 'community_messages', msg[CONTROL[k]]) }).toEqual({ who: k, control: 1 });
      const order = [CONTROL[k], ...SPACES.filter((s) => s !== CONTROL[k])];
      const seen: Record<string, number> = {};
      for (const s of order) seen[s] = await take(k, s);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map((s) => [s, Number(opens(k, s))])) });
    }
  });

  it.each(AUDIENCES)('%s', async (_path, reach, want) => {
    for (const s of SPACES) expect({ space: s, reach: sorted(await reach(s)) }).toEqual({ space: s, reach: want(s) });
  });

  it('Today: the pinned post is the newest of the spaces the person may enter', async () => {
    for (const k of PEOPLE) {
      const today = await foundation.findTodayContent(ws[home(k)], id[k], new Date());
      const first = SPACES.find((s) => coachOf(s) === home(k) && OPEN[s].includes(k));
      expect({ who: k, pinned: today.pinnedPost?.id ?? null }).toEqual({ who: k, pinned: first ? post[first] : null });
    }
  });

  // X's only row is the removed one of the archived space: archiving removes rows, not people, so X keeps the wins.
  it('the Hall and wins open with a space that is not public; a public member and other tenants get none', async () => {
    for (const k of PEOPLE) {
      expect({ who: k, control: await count(k, 'community_messages', msg[CONTROL[k]]) }).toEqual({ who: k, control: 1 });
      const n = Number(HALL.X.includes(k));
      expect({
        who: k,
        hall: await got(posts.listComments(user(k), hall)),
        report: await got(moderation.report(user(k), 'post', hall, 'spam', undefined)),
        react: await react(k, 'post', hall),
        wins: (await community.getFeed(id[k])).filter((w) => w.user_id === id.I).length,
        workspace: Number(await access.canAccessWorkspace(ws.X, user(k))),
      }).toEqual({ who: k, hall: n, report: n, react: n, wins: n, workspace: n });
    }
  });
});
