// C6-NAMES-ALL (agent 158), owner ruling "#C6-NAMES-EVERYWHERE - op 1": in a space open to all of a coach's
// clients, posts, comments, wins and the leaderboard show members' full names, as its roster does
// (#C6-MEMBER-NAMES); every other space keeps first names, and no name goes wider than the space's members.
// Live, on the replayed migration chain: the real services (gated by app.community_can_access); row reads
// run as role authenticated. X, Y coach; I and O are X's clients (in cli by the rule with no row; active
// rows in mem, I also in pub); R is X's client removed from cli (an active row in mem keeps the Hall and
// wins open); N has no coach and Z is Y's client: both have active rows in X's cli and a post left in X's
// Hall. X's spaces: cli (clients), mem (chosen members), pub (public); Y's: ycli (clients). Each person's
// first read is their control read, so every refusal follows a read that worked.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import {
  COMMENT_CONTEXT_TYPE,
  CommunityMessagesRepository,
} from '../../src/community/messages/community-messages.repository';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-names-everywhere-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'O' | 'R' | 'N' | 'Z';
type Coach = 'X' | 'Y';
type Space = 'cli' | 'mem' | 'pub' | 'ycli';
type Place = Space | 'hall';
type Names = Record<string, string> | null; // what a read shows, by key; null when it answers 404
const PEOPLE: Key[] = ['X', 'Y', 'I', 'O', 'R', 'N', 'Z']; // coaches first: clients reference them
const SPACES: Space[] = ['cli', 'mem', 'pub', 'ycli'];
const COACH: Record<Key, Coach | null> = { X: null, Y: null, I: 'X', O: 'X', R: 'X', N: null, Z: 'Y' };
const NAME: Record<Key, string> = { X: 'Xena Coach', Y: 'Yuri Coach', I: 'Ivy Stone', O: 'Oscar Reed', R: 'Rae Quinn',
  N: 'Nia Brook', Z: 'Zed Hart' };
const ON_LEADERBOARD: Key[] = ['O', 'R', 'Z'];
const VISIBILITY: Record<Space, string> = { cli: 'clients', mem: 'members', pub: 'public', ycli: 'clients' };
const ROWS: Record<Space, Array<[Key, 'active' | 'removed']>> = {
  cli: [['R', 'removed'], ['N', 'active'], ['Z', 'active']],
  mem: [['I', 'active'], ['O', 'active'], ['R', 'active']],
  pub: [['I', 'active'], ['N', 'active']],
  ycli: [['Z', 'active']],
};
// The one rule: who gets into each space (and so who its roster lists); the Hall opens with a space that
// is not public. A removed row, no coach and another coach's client stay out of cli, rows or not.
const IN: Record<Space, Key[]> = { cli: ['X', 'I', 'O'], mem: ['X', 'I', 'O', 'R'], pub: ['X', 'I', 'N'], ycli: ['Y', 'Z'] };
const HALL: Record<Coach, Key[]> = { X: ['X', 'I', 'O', 'R'], Y: ['Y', 'Z'] };
const CLIENTS_SPACE: Record<Coach, Space> = { X: 'cli', Y: 'ycli' };
// Posts [author, where, whose community]; comments [author, post]; wins [author, coach_id].
const POSTS: Record<string, [Key, Place, Coach]> = { hX: ['X', 'hall', 'X'], hO: ['O', 'hall', 'X'], hR: ['R', 'hall', 'X'],
  hN: ['N', 'hall', 'X'], hZ: ['Z', 'hall', 'X'], cO: ['O', 'cli', 'X'], mO: ['O', 'mem', 'X'], pI: ['I', 'pub', 'X'],
  yZ: ['Z', 'hall', 'Y'] };
const COMMENTS: Record<string, [Key, string]> = { kO: ['O', 'hX'], kR: ['R', 'hX'], kX: ['X', 'cO'], kI: ['I', 'mO'], kZ: ['Z', 'yZ'] };
const WINS: Record<string, [Key, Coach]> = { wI: ['I', 'X'], wO: ['O', 'X'], wR: ['R', 'X'], vZ: ['Z', 'Y'] };
const ROLE = (k: Key) => (k === 'X' || k === 'Y' ? 'coach' : 'student');
// The ruling: k sees p's full name only when both are in the space open to all of the coach's clients that
// the place asks (a space itself; the Hall, wins and the leaderboard ask the community's), else the first.
const shown = (k: Key, p: Key, place: Place, c: Coach) => {
  const s = place === 'hall' ? CLIENTS_SPACE[c] : place;
  return VISIBILITY[s] === 'clients' && IN[s].includes(k) && IN[s].includes(p) ? NAME[p] : NAME[p].split(' ')[0];
};
const opens = (k: Key, place: Place, c: Coach) => (place === 'hall' ? HALL[c] : IN[place]).includes(k);
const pick = <T>(rows: Record<string, T>, keep: (r: T) => boolean, name: (r: T) => string) =>
  Object.fromEntries(Object.entries(rows).filter(([, r]) => keep(r)).map(([key, r]) => [key, name(r)]));
const hall = (k: Key, c: Coach): Names => (HALL[c].includes(k)
  ? pick(POSTS, ([, place, pc]) => pc === c && opens(k, place, c), ([a, place]) => shown(k, a, place, c)) : null);
const thread = (k: Key, post: string): Names => {
  const [, place, c] = POSTS[post];
  return opens(k, place, c) ? pick(COMMENTS, ([, on]) => on === post, ([a]) => shown(k, a, place, c)) : null;
};
// Wins: the coach's circle; with no coach, the person's own.
const wins = (k: Key): Names => pick(WINS, ([a, c]) => (COACH[k] ? c === COACH[k] : a === k), ([a, c]) => shown(k, a, 'hall', c));
const board = (k: Key): Names => {
  const c = COACH[k];
  return c ? pick(Object.fromEntries(PEOPLE.map((p) => [p, p] as const)), (p) => COACH[p] === c && (p === k || ON_LEADERBOARD.includes(p)),
    (p) => shown(k, p, 'hall', c)) : {};
};
const CONTROL: Record<Key, string> = { X: 'the Hall of X', Y: 'the Hall of Y', I: 'the Hall of X', O: 'the Hall of X',
  R: 'the Hall of X', N: 'a post of a public space', Z: 'the Hall of Y' };

(DB_URL ? describe : describe.skip)('#C6-NAMES-EVERYWHERE: full names on posts, comments, wins and the leaderboard', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = stub<CommunitySafetyService>({ assertAllowed: () => undefined, filterBlocked: async <T>(_v: string, rows: T[]) => rows,
    assertVisibleTo: async () => undefined, hiddenFromViewer: async () => null });
  const posts = new CommunityPostsService(new CommunityAccessService(db), new CommunityPostsRepository(db), new CommunityMessagesRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }),
    stub<CommunityNotificationsService>({ pushEnabled: () => false }), safety, new CommunityReactionsRepository(db));
  const community = new CommunityService(db, new CommunityRepository(db), safety);
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids([...PEOPLE, ...Object.keys(POSTS), ...Object.keys(COMMENTS), ...Object.keys(WINS)]);
  const KEY = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
  const sub = uuids(PEOPLE);
  const ws = uuids(['X', 'Y'] as const);
  const space = uuids(SPACES);
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Coach] : null });
  const where = (place: Place) => (place === 'hall' ? null : space[place]);

  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  // The names a read hands the person, by key (an id this spec did not make shows as "undefined").
  const read = async <T>(p: Promise<T>, rows: (r: T) => string[][]): Promise<Names> => {
    try {
      return Object.fromEntries(rows(await p).map(([rowId, name]) => [String(KEY[rowId]), name]));
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  };
  const comments = (post: string): [string, (k: Key) => Promise<Names>, (k: Key) => Names] => [`the comments on ${post}`,
    (k) => read(posts.listComments(user(k), id[post]), (r) => r.comments.map((c) => [c.id, c.author_name])), (k) => thread(k, post)];
  // Every changed read; wins and the leaderboard are client routes (@Roles('student')).
  const READS: Array<[string, (k: Key) => Promise<Names>, (k: Key) => Names, boolean?]> = [
    ['the Hall of X', (k) => read(posts.list(user(k), ws.X, {}), (r) => r.posts.map((p) => [p.id, p.author_name])), (k) => hall(k, 'X')],
    ['the Hall of Y', (k) => read(posts.list(user(k), ws.Y, {}), (r) => r.posts.map((p) => [p.id, p.author_name])), (k) => hall(k, 'Y')],
    ['a post of a public space', (k) => read(posts.getOne(user(k), id.pI), (r) => [[r.post.id, r.post.author_name]]),
      (k) => (opens(k, 'pub', 'X') ? { pI: shown(k, 'I', 'pub', 'X') } : null)],
    comments('hX'), comments('cO'), comments('mO'), comments('yZ'),
    ['wins', (k) => read(community.getFeed(id[k]), (r) => r.map((w) => [w.id, w.display_name])), wins, true],
    ['the leaderboard', (k) => read(community.getLeaderboard(id[k]), (r) => r.map((e) => [e.user_id, e.name])), board, true],
  ];

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id", "show_on_leaderboard")
        VALUES (${id[k]}, ${sub[k]}, ${`names-all-${id[k]}`}, ${NAME[k]}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Coach] : null},
          ${ON_LEADERBOARD.includes(k)})`;
    }
    for (const c of ['X', 'Y'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`names-all-${run}-${c}`}, now())`;
    }
    for (const s of SPACES) {
      const w = s === 'ycli' ? ws.Y : ws.X;
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], w, `RLS ${s}`, VISIBILITY[s]);
      for (const [k, status] of ROWS[s]) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', $5::"CommunityMembershipStatus", now())`, randomUUID(), w, space[s], id[k], status);
      }
    }
    for (const [key, [a, place, c]] of Object.entries(POSTS)) {
      await prisma.communityPost.create({ data: { id: id[key], workspace_id: ws[c], cohort_id: where(place), author_id: id[a],
        scope: place === 'hall' ? 'hall' : 'cohort', title: 'RLS post' } });
    }
    for (const [key, [a, on]] of Object.entries(COMMENTS)) {
      const [, place, c] = POSTS[on];
      await prisma.communityMessage.create({ data: { id: id[key], workspace_id: ws[c], cohort_id: where(place), scope: 'cohort',
        sender_id: id[a], body: 'RLS comment', plan_context_type: COMMENT_CONTEXT_TYPE, plan_context_id: id[on] } });
    }
    for (const [key, [a, c]] of Object.entries(WINS)) {
      await prisma.communityWin.create({ data: { id: id[key], user_id: id[a], coach_id: id[c], title: 'RLS win', description: 'RLS win' } });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on tables that force it', async () => {
    expect(await as('I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    const tables = ['CommunityWin', 'User', 'community_cohorts', 'community_memberships', 'community_messages', 'community_posts'];
    const forced = await prisma.$queryRaw<{ t: string }[]>`SELECT c."relname" AS "t" FROM pg_class c JOIN pg_namespace n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relname" = ANY(${tables}) AND c."relrowsecurity" AND c."relforcerowsecurity"`;
    expect(forced.map((r) => r.t).sort()).toEqual([...tables].sort());
  });

  it('every person reads every name as the ruling says (control read first)', async () => {
    for (const k of PEOPLE) {
      const mine = READS.filter(([, , , clientOnly]) => !clientOnly || ROLE(k) === 'student');
      const order = [...mine.filter(([path]) => path === CONTROL[k]), ...mine.filter(([path]) => path !== CONTROL[k])];
      expect({ who: k, control: order[0][0], opens: order[0][2](k) !== null }).toEqual({ who: k, control: CONTROL[k], opens: true });
      const seen: Record<string, Names> = {};
      for (const [path, take] of order) seen[path] = await take(k);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map(([path, , want]) => [path, want(k)])) });
    }
  });

  it('the row layer still gives a client their own name and their coach\'s, nobody else\'s', async () => {
    const reads = (k: Key, of: Key) =>
      as(k, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "User" WHERE "id" = ${id[of]}`).then((r) => r[0].n);
    for (const k of ['I', 'O', 'R', 'N', 'Z'] as const) {
      const order = [k, ...PEOPLE.filter((p) => p !== k)]; // their own row first: the control read of 1
      const seen: Record<string, number> = {};
      for (const p of order) seen[p] = await reads(k, p);
      expect({ who: k, seen }).toEqual({ who: k, seen: Object.fromEntries(order.map((p) => [p, Number(p === k || p === COACH[k])])) });
    }
  });
});
