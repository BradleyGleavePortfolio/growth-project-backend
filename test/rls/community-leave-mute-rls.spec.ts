// LEAVE-MUTE-BE (agent 176; owner D2, #170-1): leave a space, join again, mute or leave a thread, and who left
// a space, live on the replayed migration chain (20270502009600). The real routes (controller + service +
// CommunitySafetyService), the real space list and GET /community/me; row reads and writes run as role
// authenticated. Each "0" or refusal follows a control of 1.
// Coach A: members-only chat "mem" (clients O, V, P), Announcements "ann", a section heading "sec" and a chat
// "open" for all of A's clients; N is A's client outside "mem". Coach B: space "bmem" with client X.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityLeaveMuteController } from '../../src/community/leave-mute/community-leave-mute.controller';
import { CommunityLeaveMuteService } from '../../src/community/leave-mute/community-leave-mute.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-leave-mute-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'P' | 'N' | 'X';
type Space = 'mem' | 'ann' | 'sec' | 'open' | 'bmem';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'P', 'N', 'X'];
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', P: 'A', N: 'A', X: 'B' };
const NAME: Record<Key, string> = { A: 'Ada Coach', B: 'Bo Coach', O: 'Olive Stone', V: 'Vera Moss', P: 'Pia Lund', N: 'Nell Hart', X: 'Xan Pike' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('LEAVE-MUTE-BE: leave a space, mute or leave a thread (routes, list, unread, row security)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = new CommunitySafetyService(db);
  const routes = new CommunityLeaveMuteController(new CommunityLeaveMuteService(db, new CommunityAccessService(db), safety));
  const community = new CommunityService(db, new CommunityRepository(db), safety);
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'ann', 'sec', 'open', 'bmem'] as const);
  const run = randomUUID().slice(0, 8);
  const t0 = Date.now() + 60_000; // messages come after everyone in beforeAll joined (#168-15)
  let tick = 0;
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const req = (k: Key) => stub<Parameters<CommunityLeaveMuteController['leave']>[0]>({ user: user(k) });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
  const code = (p: Promise<unknown>) =>
    p.then(() => 'ok', (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code ?? 'error');
  const say = async (k: Key, s: Space, extra: Partial<Prisma.CommunityMessageUncheckedCreateInput> = {}) =>
    (await prisma.communityMessage.create({ data: { workspace_id: s === 'bmem' ? ws.B : ws.A, cohort_id: space[s], scope: 'cohort',
      sender_id: id[k], body: 'hi', created_at: new Date(t0 + 1000 * ++tick), ...extra } })).id;
  const reply = async (k: Key, root: string) => {
    const r = await prisma.communityMessage.findFirstOrThrow({ where: { id: root }, select: { created_at: true } });
    return say(k, 'mem', { parent_message_id: root, parent_message_at: r.created_at });
  };
  const list = async (k: Key, includeLeft = false) => (await community.getCohorts(user(k), includeLeft)).cohorts;
  const unread = async (k: Key, s: Space) => (await list(k)).find((c) => c.id === space[s])?.unread_count;
  const tab = async (k: Key) => (await community.getMe(user(k))).unread.cohort_messages;
  const addUser = (k: Key) => prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
    VALUES (${id[k]}, ${sub[k]}, ${`leave-${id[k]}`}, ${NAME[k]}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const pgCode = (e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code);
  const prefRows = (k: Key, owner: Key) => as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM "community_thread_prefs" WHERE "user_id" = $1`, id[owner])).then((r) => r[0].n);
  const addPref = (k: Key, owner: Key, s: Space) => as(k, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "community_thread_prefs" ("user_id", "thread_message_id", "cohort_id", "state") VALUES ($1, $2::uuid, $3::uuid, 'muted')`,
    id[owner], randomUUID(), space[s])).catch(pgCode);

  beforeAll(async () => {
    process.env.FEATURE_COMMUNITY_API = 'true'; // GET /community/me answers with the switch on
    for (const k of PEOPLE) await addUser(k);
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`leave-${run}-${c}`}, now())`;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "kind", "posting_policy", "visibility", "updated_at")
      VALUES (${space.mem}::uuid, ${ws.A}::uuid, 'RLS mem', 'chat', 'all', 'members', now()),
             (${space.ann}::uuid, ${ws.A}::uuid, 'RLS ann', 'announcement', 'coach', 'clients', now()),
             (${space.sec}::uuid, ${ws.A}::uuid, 'RLS sec', 'section', 'coach', 'clients', now()),
             (${space.open}::uuid, ${ws.A}::uuid, 'RLS open', 'chat', 'all', 'clients', now()),
             (${space.bmem}::uuid, ${ws.B}::uuid, 'RLS bmem', 'chat', 'all', 'members', now())`;
    for (const [s, w, k] of [['mem', 'A', 'O'], ['mem', 'A', 'V'], ['mem', 'A', 'P'], ['bmem', 'B', 'X']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[w], space[s], id[k]);
    }
  });
  afterAll(async () => {
    delete process.env.FEATURE_COMMUNITY_API;
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security, on a new table that forces it', async () => {
    expect(await as('O', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_thread_prefs'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  it('D2c, D2f: a member leaves a chat; Announcements, a section heading and the coach own space answer 409', async () => {
    expect(await status(routes.leave(req('N'), space.open))).toBe(200); // control: a client leaves an open chat
    expect(await code(routes.leave(req('N'), space.ann))).toBe('community.space.cannot_leave');
    expect(await code(routes.leave(req('N'), space.sec))).toBe('community.space.cannot_leave');
    expect(await code(routes.leave(req('A'), space.mem))).toBe('community.space.cannot_leave');
    expect(await code(routes.leave(req('A'), space.open))).toBe('community.space.cannot_leave');
    expect(await status(routes.leave(req('A'), space.ann))).toBe(409);
    expect(await status(routes.leave(req('N'), space.mem))).toBe(404); // a space they cannot read answers like an unknown one
    expect(await status(routes.leave(req('X'), space.mem))).toBe(404);
    expect(await status(routes.leave(req('B'), space.mem))).toBe(404);
    expect(await status(routes.leave(req('O'), randomUUID()))).toBe(404);
    expect(await status(routes.join(req('N'), space.open))).toBe(200);
  });

  it('a left space drops out of the list, the unread counts and the tab badge; include_left marks it', async () => {
    await say('V', 'mem');
    expect(await unread('O', 'mem')).toBe(1); // control
    const badge = await tab('O');
    expect(badge).toBeGreaterThanOrEqual(1);
    expect((await list('O', true)).every((c) => 'left_at' in c && c.left_at === null)).toBe(true); // control: in every space
    const out = await routes.leave(req('O'), space.mem);
    expect(out).toEqual({ cohort_id: space.mem, left_at: expect.any(String) });
    expect(await routes.leave(req('O'), space.mem)).toEqual(out); // leaving twice keeps the first time
    expect((await list('O')).map((c) => c.id)).not.toContain(space.mem);
    expect((await list('O')).map((c) => c.id)).toContain(space.open); // control: the rest stay
    expect((await list('O'))[0]).not.toHaveProperty('left_at'); // the plain list keeps its shape
    const marked = await list('O', true);
    expect(marked.find((c) => c.id === space.mem)).toMatchObject({ left_at: out.left_at, unread_count: 0 });
    expect(marked.find((c) => c.id === space.open)).toMatchObject({ left_at: null });
    await say('V', 'mem');
    expect(await tab('O')).toBe(badge - 1); // nothing from a left space counts
    expect((await list('V')).map((c) => c.id)).toContain(space.mem); // O's leave is O's alone
  });

  it('D2d: everyone who reads the space sees who left, minus blocked people; a non-reader gets 404', async () => {
    const seen = await routes.left(req('V'), space.mem);
    expect(seen).toEqual({ cohort_id: space.mem, left: [{ user_id: id.O, name: 'Olive', left_at: expect.any(String) }] });
    expect((await routes.left(req('A'), space.mem)).left.map((l) => l.user_id)).toEqual([id.O]);
    await prisma.userBlock.create({ data: { blocker_id: id.P, blocked_id: id.O } });
    expect((await routes.left(req('P'), space.mem)).left).toEqual([]);
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.P, blocked_id: id.O } });
    expect((await routes.left(req('P'), space.mem)).left).toHaveLength(1); // control
    expect(await status(routes.left(req('N'), space.mem))).toBe(404);
    expect(await status(routes.left(req('X'), space.mem))).toBe(404);
  });

  it('D2e: they join again on their own while access stands; the count starts when they join', async () => {
    const back = await routes.join(req('O'), space.mem);
    expect(back).toEqual({ cohort_id: space.mem, left_at: null });
    expect((await list('O')).map((c) => c.id)).toContain(space.mem);
    expect(await unread('O', 'mem')).toBe(0); // what came while away does not pile up
    expect((await routes.left(req('V'), space.mem)).left).toEqual([]);
    await say('V', 'mem');
    expect(await unread('O', 'mem')).toBe(1);
    expect(await status(routes.leave(req('P'), space.mem))).toBe(200);
    await prisma.communityMembership.deleteMany({ where: { cohort_id: space.mem, user_id: id.P } });
    expect(await status(routes.join(req('P'), space.mem))).toBe(404); // the coach took the access away
    expect((await list('P', true)).map((c) => c.id)).not.toContain(space.mem);
    expect(await status(routes.join(req('X'), space.mem))).toBe(404);
  });

  it('D2b: mute or leave a thread; its replies stop counting; a reply id resolves to its first message', async () => {
    const root = await say('A', 'mem');
    const r1 = await reply('V', root);
    const base = (await unread('O', 'mem')) ?? 0;
    await reply('V', root);
    expect(await unread('O', 'mem')).toBe(base + 1); // control: a reply counts
    const muted = await routes.mute(req('O'), space.mem, r1);
    expect(muted).toEqual({ thread_message_id: root, state: 'muted', since: expect.any(String) });
    expect(await unread('O', 'mem')).toBe(base - 1); // its two replies count nowhere; the first message still does
    await reply('V', root);
    expect(await unread('O', 'mem')).toBe(base - 1);
    await say('V', 'mem');
    expect(await unread('O', 'mem')).toBe(base); // control: a new first message still counts
    const left = await routes.leaveThread(req('O'), space.mem, root);
    expect(left).toMatchObject({ thread_message_id: root, state: 'left' });
    expect(await routes.threads(req('O'), space.mem)).toEqual({ cohort_id: space.mem, threads: [left] });
    expect(await routes.threads(req('V'), space.mem)).toEqual({ cohort_id: space.mem, threads: [] }); // O's alone
    await routes.unmute(req('O'), space.mem, root); // undoes only a mute
    expect((await routes.threads(req('O'), space.mem)).threads).toEqual([left]);
    await routes.follow(req('O'), space.mem, root);
    expect((await routes.threads(req('O'), space.mem)).threads).toEqual([]);
    expect(await unread('O', 'mem')).toBe(base + 3); // following again, the replies count again
  });

  it('a thread is a chat message of that space the caller can see; anything else answers 404', async () => {
    const root = await say('V', 'mem');
    expect(await status(routes.mute(req('O'), space.mem, root))).toBe(200); // control
    expect(await code(routes.mute(req('O'), space.mem, await say('A', 'open')))).toBe('community.message.not_found');
    expect(await status(routes.mute(req('O'), space.mem, randomUUID()))).toBe(404);
    expect(await status(routes.mute(req('O'), space.mem, await say('V', 'mem', { plan_context_type: 'community_post_comment' })))).toBe(404);
    expect(await status(routes.mute(req('O'), space.mem, await say('V', 'mem', { deleted_at: new Date() })))).toBe(404);
    await prisma.userBlock.create({ data: { blocker_id: id.O, blocked_id: id.V } });
    expect(await status(routes.mute(req('O'), space.mem, await say('V', 'mem')))).toBe(404);
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.O, blocked_id: id.V } });
    expect(await code(routes.mute(req('N'), space.mem, root))).toBe('community.cohort.not_found');
    expect(await status(routes.threads(req('X'), space.mem))).toBe(404);
  });

  it('row security: a person reads and writes only their own thread rows, and writes only for a space they read', async () => {
    expect(await prefRows('O', 'O')).toBeGreaterThanOrEqual(1); // control
    expect(await prefRows('V', 'O')).toBe(0);
    expect(await addPref('O', 'O', 'mem')).toBe(1); // control
    expect(await addPref('V', 'O', 'mem')).toBe(DENIED); // not for someone else
    expect(await addPref('N', 'N', 'open')).toBe(1); // control
    expect(await addPref('N', 'N', 'mem')).toBe(DENIED); // not for a space they cannot read
    expect(await addPref('X', 'X', 'open')).toBe(DENIED); // nor another coach's
    const touch = (k: Key, owner: Key) => as(k, (tx) => tx.$executeRawUnsafe(
      `UPDATE "community_thread_prefs" SET "state" = 'left' WHERE "user_id" = $1`, id[owner]));
    expect(await touch('V', 'O')).toBe(0);
    expect(await touch('O', 'O')).toBeGreaterThanOrEqual(1); // control
    const drop = (k: Key, owner: Key) => as(k, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM "community_thread_prefs" WHERE "user_id" = $1`, id[owner]));
    expect(await drop('V', 'O')).toBe(0);
    expect(await drop('N', 'N')).toBe(1); // control: N's row in "open"
    expect(await as('O', (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM "community_space_reads" WHERE "user_id" = $1 AND "left_at" IS NULL`, id.O)).then((r) => r[0].n))
      .toBeGreaterThanOrEqual(1); // the left mark sits on the b#1137 row and its own policies
  });

  it('a state outside muted and left is refused by the table', async () => {
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "community_thread_prefs" ("user_id", "thread_message_id", "cohort_id", "state") VALUES ($1, $2::uuid, $3::uuid, 'gone')`,
      id.O, randomUUID(), space.mem).catch(pgCode);
    expect(await bad).toBe('23514');
  });
});
