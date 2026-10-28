// LEAVE-MUTE-BE (agent 176; owner D2, #170-1): leave a space, join again, mute or leave a thread, and who left
// a space, live on the replayed migration chain (20270502009600). The real routes (controller + service +
// CommunitySafetyService), the real space list and GET /community/me; row reads and writes run as role
// authenticated. Each "0" or refusal follows a control of 1.
// Coach A: members-only chat "mem" (clients O, V, P), Announcements "ann", a section heading "sec" and a chat
// "open" for all of A's clients; N is A's client outside "mem". Coach B: space "bmem" with client X.
// FR-1168 (fix round 1): member_count leaves out who left (LO-1168 B1); undo keeps what came while muted or
// left read (LS-1168 B1); undo by a removed first message's id (B2); a reply of your own follows a left thread
// (B3, text, photo and voice through their real repositories); "{name} left" rows survive a rejoin (B4).
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityCohortMembersRepository } from '../../src/community/cohorts/community-cohort-members.repository';
import { CommunityCohortMembersService } from '../../src/community/cohorts/community-cohort-members.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunityLeaveMuteController } from '../../src/community/leave-mute/community-leave-mute.controller';
import { CommunityLeaveMuteService } from '../../src/community/leave-mute/community-leave-mute.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
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
  // FR-1168R2 B2: the real realtime service (its audience is decided on this database); only the Supabase
  // client is a fake that records each private-topic send. Every broadcast is awaited through `pings`.
  const sent: { topic: string; event: string; payload: unknown }[] = [];
  const client = {
    channel: (topic: string) => ({
      httpSend: async (event: string, payload: unknown) => {
        sent.push({ topic, event, payload });
        return { success: true };
      },
    }),
    removeChannel: async () => 'ok',
  };
  const realtime = new CommunityRealtimeService(stub<SupabaseService>({ getClient: () => client }), stub<AnalyticsService>({ capture: () => undefined }), db);
  const pings: Promise<void>[] = [];
  const broadcast = realtime.broadcastCommunityEvent.bind(realtime);
  jest.spyOn(realtime, 'broadcastCommunityEvent').mockImplementation((...args) => {
    const p = broadcast(...args);
    pings.push(p);
    return p;
  });
  const heard = async () => {
    await Promise.all(pings.splice(0));
    return sent.splice(0);
  };
  const routes = new CommunityLeaveMuteController(new CommunityLeaveMuteService(db, new CommunityAccessService(db), safety, realtime));
  const community = new CommunityService(db, new CommunityRepository(db), safety);
  const cohortMembers = new CommunityCohortMembersService(new CommunityAccessService(db), new CommunityCohortMembersRepository(db), safety);
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
  // LO-1168 B1: the space's member count on the list, the space itself and the Today card.
  const members = async (k: Key) => [
    (await list(k)).find((c) => c.id === space.mem)?.member_count,
    (await community.getCohort(user(k), space.mem)).member_count,
    (await community.getToday(user(k))).cohort?.member_count,
  ];
  // FR-1168R2 B1: who the space's member list (GET .../members) shows to k.
  const roster = async (k: Key) => (await cohortMembers.list(user(k), space.mem, {})).members.map((m) => m.user_id).sort();
  const stateOf = async (k: Key, root: string) =>
    (await routes.threads(req(k), space.mem)).threads.find((t) => t.thread_message_id === root)?.state ?? 'none';
  const leftOf = async (k: Key, who: Key) => (await routes.left(req(k), space.mem)).left.filter((l) => l.user_id === id[who]);
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
    expect(await members('V')).toEqual([4, 4, 4]); // control: A, O, V and P
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
    expect(await members('V')).toEqual([3, 3, 3]); // LO-1168 B1 (owner R7): the member count drops by one
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
    expect(await members('V')).toEqual([4, 4, 4]); // LO-1168 B1: and they count again
    expect(await leftOf('V', 'O')).toHaveLength(1); // LS-1168 B4: the "{name} left" line stays after they join again
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
    expect(await unread('O', 'mem')).toBe(base); // LS-1168 B1: what came while muted or left stays read
    await reply('V', root);
    expect(await unread('O', 'mem')).toBe(base + 1); // following again, a new reply counts
  });

  it('LS-1168 B1 (owner R2): unmute keeps the muted-time replies read, in the list and the tab; later ones count', async () => {
    const root = await say('A', 'mem');
    const other = await say('A', 'mem');
    await routes.mute(req('O'), space.mem, root);
    const base = (await unread('O', 'mem')) ?? 0;
    const badge = await tab('O');
    await reply('V', root); // came while muted
    expect(await unread('O', 'mem')).toBe(base);
    await reply('V', other); // control: an unread reply in another thread
    expect(await unread('O', 'mem')).toBe(base + 1);
    expect(await tab('O')).toBe(badge + 1);
    await routes.unmute(req('O'), space.mem, root);
    expect(await stateOf('O', root)).toBe('none'); // the phone sees an ordinary thread again
    expect(await unread('O', 'mem')).toBe(base + 1); // the muted-time reply stays read; the other one still counts
    expect(await tab('O')).toBe(badge + 1);
    await reply('V', root); // after unmute
    expect(await unread('O', 'mem')).toBe(base + 2);
    expect(await tab('O')).toBe(badge + 2);
    expect((await routes.mute(req('O'), space.mem, root)).state).toBe('muted'); // muting again works as before
    expect(await unread('O', 'mem')).toBe(base + 1);
  });

  it('LS-1168 B2: after the first message is removed (or its author blocked), undo by the id from GET /threads still works', async () => {
    const gone = await say('V', 'mem');
    const hidden = await say('V', 'mem');
    await routes.mute(req('O'), space.mem, gone);
    await routes.leaveThread(req('O'), space.mem, hidden);
    await prisma.communityMessage.updateMany({ where: { id: gone }, data: { deleted_at: new Date() } });
    expect(await stateOf('O', gone)).toBe('muted'); // control: still listed for the phone
    expect(await status(routes.mute(req('O'), space.mem, gone))).toBe(404); // a new state still needs the live message
    expect(await status(routes.unmute(req('V'), space.mem, gone))).toBe(404); // someone without that row: as before
    expect(await status(routes.unmute(req('O'), space.mem, randomUUID()))).toBe(404);
    expect(await status(routes.unmute(req('O'), space.mem, gone))).toBe(200);
    expect(await stateOf('O', gone)).toBe('none');
    await prisma.userBlock.create({ data: { blocker_id: id.O, blocked_id: id.V } });
    expect(await status(routes.follow(req('O'), space.mem, hidden))).toBe(200); // LO-1168 C7: a blocked author too
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.O, blocked_id: id.V } });
    expect(await stateOf('O', hidden)).toBe('none');
  });

  it('LS-1168 B3: a reply of your own (text, photo, voice) follows a left thread again; a mute stays; a failed send changes nothing', async () => {
    const messages = new CommunityMessagesRepository(db);
    const notes = new CommunityVoiceRepository(db);
    const leftThread = async () => {
      const root = await say('V', 'mem');
      await routes.leaveThread(req('O'), space.mem, root);
      const r = await prisma.communityMessage.findFirstOrThrow({ where: { id: root }, select: { created_at: true } });
      return { id: root, at: r.created_at };
    };
    const text = (parent: { id: string; at: Date }) =>
      messages.createCohortMessage({ workspaceId: ws.A, cohortId: space.mem, senderId: id.O, body: 'back', parent });
    const photo = (parent: { id: string; at: Date }, publish: () => Promise<void> = async () => undefined) =>
      messages.createImageMessage({ workspaceId: ws.A, cohortId: space.mem, senderId: id.O, body: '', parent, publish,
        image: { key: `${id.O}/leave-${randomUUID()}.jpg`, width: 10, height: 10, sizeBytes: 100 } });
    const t = await leftThread();
    expect(await stateOf('O', t.id)).toBe('left'); // control
    await reply('V', t.id);
    expect(await stateOf('O', t.id)).toBe('left'); // someone else's reply changes nothing
    await text(t);
    expect(await stateOf('O', t.id)).toBe('none');
    const p = await leftThread();
    await photo(p);
    expect(await stateOf('O', p.id)).toBe('none');
    const v = await leftThread();
    await notes.createVoiceNote({ workspaceId: ws.A, cohortId: space.mem, conversationId: null, authorId: id.O,
      storageKey: `${id.O}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`, durationMs: 1000, bytes: 1000,
      mimeType: 'audio/mp4', waveformPeaks: null, parent: v, answersClients: false });
    expect(await stateOf('O', v.id)).toBe('none');
    const f = await leftThread();
    await expect(photo(f, async () => { throw new Error('copy failed'); })).rejects.toThrow('copy failed');
    expect(await stateOf('O', f.id)).toBe('left'); // the send rolled back, and so did the follow
    const m = await say('V', 'mem');
    await routes.mute(req('O'), space.mem, m);
    const mr = await prisma.communityMessage.findFirstOrThrow({ where: { id: m }, select: { created_at: true } });
    await text({ id: m, at: mr.created_at });
    expect(await stateOf('O', m)).toBe('muted'); // an ordinary mute stays (owner R3)
    const before = (await unread('O', 'mem')) ?? 0;
    await reply('V', t.id);
    expect(await unread('O', 'mem')).toBe(before + 1); // the followed thread counts its new replies
  });

  it('LS-1168 B4: each leave is its own "{name} left" row, kept when they join again; the newest 200, oldest first', async () => {
    const first = await leftOf('V', 'O');
    expect(first).toHaveLength(1); // control
    const again = await routes.leave(req('O'), space.mem);
    expect(await leftOf('V', 'O')).toEqual([...first, { user_id: id.O, name: 'Olive', left_at: again.left_at }]);
    expect(await leftOf('A', 'O')).toHaveLength(2);
    await routes.join(req('O'), space.mem);
    expect(await leftOf('V', 'O')).toHaveLength(2);
    expect((await list('O')).map((c) => c.id)).toContain(space.mem); // control: O is back in the space
    await prisma.communitySpaceDeparture.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({ cohort_id: space.mem, user_id: id.N, left_at: new Date(Date.UTC(2020, 0, 1, 0, i)) })),
    });
    const rows = (await routes.left(req('V'), space.mem)).left;
    expect(rows).toHaveLength(200); // LO-1168 C2: the newest 200
    expect(rows.map((r) => r.left_at)).toEqual([...rows.map((r) => r.left_at)].sort());
    expect(rows[rows.length - 1]).toEqual({ user_id: id.O, name: 'Olive', left_at: again.left_at }); // the newest is kept
    expect(rows.map((r) => r.left_at)).not.toContain(new Date(Date.UTC(2020, 0, 1, 0, 0)).toISOString()); // the oldest is not
    await prisma.communitySpaceDeparture.deleteMany({ where: { user_id: id.N } });
  });

  it('FR-1168R2 B1: the member list leaves out a person who left, for the coach and the members; they are back when they join', async () => {
    const all = [id.A, id.O, id.V].sort(); // the coach, O and V (P lost access in D2e)
    expect(await roster('A')).toEqual(all); // control
    await routes.leave(req('O'), space.mem);
    try {
      const without = [id.A, id.V].sort();
      expect(await roster('A')).toEqual(without); // the coach's list
      expect(await roster('V')).toEqual(without); // a member's list
      expect(await roster('O')).toEqual(without); // O still reads the space (Spaces you left) and is not in its list
      expect(await members('V')).toEqual([2, 2, 2]); // the list and member_count agree
    } finally {
      await routes.join(req('O'), space.mem); // O is back for the later cases even when a check above fails
    }
    expect(await roster('A')).toEqual(all);
    expect(await members('V')).toEqual([3, 3, 3]);
  });

  it('FR-1168R2 B2: a leave pings at once everyone who reads the space (ids only), so an open chat shows the line; join pings too', async () => {
    const flag = process.env.FEATURE_COMMUNITY_REALTIME;
    process.env.FEATURE_COMMUNITY_REALTIME = 'true';
    try {
      await heard(); // nothing left over from earlier cases
      const readers = [id.A, id.O, id.V].map((u) => `community:user:${u}`).sort(); // O still reads the space
      await routes.leave(req('O'), space.mem);
      const left = await heard();
      expect(left.map((s) => s.topic).sort()).toEqual(readers); // not N (no access), not X (another coach)
      for (const s of left) {
        expect(s.event).toBe('community.membership.changed');
        expect(s.payload).toEqual({ wsId: ws.A, cohortId: space.mem, userId: id.O, change: 'left' }); // ids only, no name
      }
      const line = (await routes.left(req('V'), space.mem)).left;
      expect(line[line.length - 1]).toMatchObject({ user_id: id.O, name: 'Olive' }); // what the phone reads on the ping
      await routes.leave(req('O'), space.mem); // already out: no new line, no ping
      expect(await heard()).toEqual([]);
      await routes.join(req('O'), space.mem);
      const back = await heard();
      expect(back.map((s) => s.topic).sort()).toEqual(readers);
      for (const s of back) expect(s.payload).toEqual({ wsId: ws.A, cohortId: space.mem, userId: id.O, change: 'joined' });
      await routes.join(req('O'), space.mem); // already in: no ping
      expect(await heard()).toEqual([]);
      expect(await code(routes.leave(req('V'), space.ann))).toBe('community.space.cannot_leave'); // a refused leave pings nobody
      expect(await heard()).toEqual([]);
    } finally {
      if (flag === undefined) delete process.env.FEATURE_COMMUNITY_REALTIME;
      else process.env.FEATURE_COMMUNITY_REALTIME = flag;
      await routes.join(req('O'), space.mem); // O is back for the later cases even when a check above fails
    }
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

  it('row security on departure rows: forced; a person reads and adds only their own, for a space they read; nobody changes one', async () => {
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_space_departures'::regclass`).toEqual([{ on: true, forced: true }]);
    const count = (k: Key, owner: Key) => as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM "community_space_departures" WHERE "user_id" = $1`, id[owner])).then((r) => r[0].n);
    expect(await count('O', 'O')).toBeGreaterThanOrEqual(2); // control
    expect(await count('V', 'O')).toBe(0);
    const add = (k: Key, owner: Key, s: Space) => as(k, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "community_space_departures" ("cohort_id", "user_id", "left_at") VALUES ($1::uuid, $2, now())`,
      space[s], id[owner])).catch(pgCode);
    expect(await add('N', 'N', 'open')).toBe(1); // control
    expect(await add('V', 'O', 'mem')).toBe(DENIED); // not for someone else
    expect(await add('N', 'N', 'mem')).toBe(DENIED); // not for a space they cannot read
    expect(await as('O', (tx) => tx.$executeRawUnsafe(
      `UPDATE "community_space_departures" SET "left_at" = now() WHERE "user_id" = $1`, id.O))).toBe(0);
    expect(await as('O', (tx) => tx.$executeRawUnsafe(`DELETE FROM "community_space_departures" WHERE "user_id" = $1`, id.O))).toBe(0);
    expect(await count('O', 'O')).toBeGreaterThanOrEqual(2);
  });

  it('a state outside muted, left and followed is refused by the table', async () => {
    expect(await addPref('O', 'O', 'mem')).toBe(1); // control (muted)
    const followed = prisma.$executeRawUnsafe(
      `INSERT INTO "community_thread_prefs" ("user_id", "thread_message_id", "cohort_id", "state") VALUES ($1, $2::uuid, $3::uuid, 'followed')`,
      id.O, randomUUID(), space.mem).catch(pgCode);
    expect(await followed).toBe(1);
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "community_thread_prefs" ("user_id", "thread_message_id", "cohort_id", "state") VALUES ($1, $2::uuid, $3::uuid, 'gone')`,
      id.O, randomUUID(), space.mem).catch(pgCode);
    expect(await bad).toBe('23514');
  });
});
