// SC-BE2 (agent 168; fix round 2 FX-1137, agent 169): the space chat read line, unread counts and the
// Community tab badge, live on the replayed migration chain (20270502009300). The real routes (controller +
// service + CommunitySafetyService), the real space list and GET /community/me; row reads and writes run as
// role authenticated. Each "0" or refusal follows a control of 1.
// Coach A: members-only space "mem" (clients O, V, Z), Announcements "ann" and a coach-only chat "big", both
// open to all of A's clients, and "late"; N is A's client outside "mem"; Z gets banned from A's community; L
// joins A late, then moves to B. Coach B: space "bmem" with client X.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityService } from '../../src/community/community.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunitySpaceReadsController } from '../../src/community/space-reads/community-space-reads.controller';
import { CommunitySpaceReadsService } from '../../src/community/space-reads/community-space-reads.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-space-reads-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'Z' | 'N' | 'X' | 'L';
type Space = 'mem' | 'ann' | 'big' | 'bmem' | 'late';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'Z', 'N', 'X', 'L'];
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', Z: 'A', N: 'A', X: 'B', L: 'A' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('SC-BE2: space read line and unread count (routes, list, row security)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = new CommunitySafetyService(db);
  const routes = new CommunitySpaceReadsController(new CommunitySpaceReadsService(db, new CommunityAccessService(db), safety));
  const community = new CommunityService(db, new CommunityRepository(db), safety);
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'ann', 'big', 'bmem', 'late'] as const);
  const run = randomUUID().slice(0, 8);
  const t0 = Date.now() + 60_000; // messages come after everyone in beforeAll joined (#168-15)
  let tick = 0;
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const req = (k: Key) => stub<Parameters<CommunitySpaceReadsController['getRead']>[0]>({ user: user(k) });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
  const say = async (k: Key, s: Space, body = 'hi') =>
    (await prisma.communityMessage.create({ data: { workspace_id: s === 'bmem' ? ws.B : ws.A, cohort_id: space[s], scope: 'cohort',
      sender_id: id[k], body, created_at: new Date(t0 + 1000 * ++tick) } })).id;
  const unread = async (k: Key, s: Space) =>
    (await community.getCohorts(user(k))).cohorts.find((c) => c.id === space[s])?.unread_count;
  const addUser = (k: Key) => prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
    VALUES (${id[k]}, ${sub[k]}, ${`reads-${id[k]}`}, ${`Reads ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const readRows = (k: Key, owner: Key) => as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM "community_space_reads" WHERE "user_id" = $1 AND "cohort_id" = $2::uuid`,
    id[owner], space.mem)).then((r) => r[0].n);
  const writeRow = (k: Key, s: Space) => as(k, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "community_space_reads" ("user_id", "cohort_id") VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING`, id[k], space[s]))
    .catch((e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code));

  beforeAll(async () => {
    process.env.FEATURE_COMMUNITY_API = 'true'; // GET /community/me answers with the switch on
    for (const k of PEOPLE) if (k !== 'L') await addUser(k);
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`reads-${run}-${c}`}, now())`;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "kind", "posting_policy", "visibility", "updated_at")
      VALUES (${space.mem}::uuid, ${ws.A}::uuid, 'RLS mem', 'chat', 'all', 'members', now()),
             (${space.ann}::uuid, ${ws.A}::uuid, 'RLS ann', 'announcement', 'coach', 'clients', now()),
             (${space.big}::uuid, ${ws.A}::uuid, 'RLS big', 'chat', 'coach', 'clients', now()),
             (${space.late}::uuid, ${ws.A}::uuid, 'RLS late', 'chat', 'all', 'clients', now()),
             (${space.bmem}::uuid, ${ws.B}::uuid, 'RLS bmem', 'chat', 'all', 'members', now())`;
    for (const [s, w, k] of [['mem', 'A', 'O'], ['mem', 'A', 'V'], ['mem', 'A', 'Z'], ['bmem', 'B', 'X']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[w], space[s], id[k]);
    }
  });
  afterAll(async () => {
    delete process.env.FEATURE_COMMUNITY_API;
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security, on a table that forces it', async () => {
    expect(await as('O', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_space_reads'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  it('routes: a member, the coach and an open-space client read; a non-member, another tenant and a ban get 404', async () => {
    expect(await routes.getRead(req('O'), space.mem)).toEqual({ last_read_at: expect.any(String), last_read_message_id: null });
    expect(await status(routes.getRead(req('A'), space.mem))).toBe(200);
    expect(await status(routes.getRead(req('N'), space.ann))).toBe(200); // control: N reads A's open space
    expect(await status(routes.getRead(req('N'), space.mem))).toBe(404); // a space they cannot read answers like an unknown one
    expect(await status(routes.getRead(req('X'), space.mem))).toBe(404);
    expect(await status(routes.markRead(req('X'), space.mem, { message_id: await say('O', 'mem') }))).toBe(404);
    expect(await status(routes.getRead(req('B'), space.mem))).toBe(404);
    expect(await status(routes.getRead(req('O'), randomUUID()))).toBe(404);
    expect(await status(routes.getRead(req('Z'), space.mem))).toBe(200); // control before the ban
  });

  it('the read line only moves forward, only to a message of that space the reader can see', async () => {
    const [m1, m2, m3] = [await say('V', 'mem'), await say('A', 'mem'), await say('V', 'mem')];
    const at = await routes.markRead(req('O'), space.mem, { message_id: m2 });
    expect(at.last_read_message_id).toBe(m2);
    expect(await routes.markRead(req('O'), space.mem, { message_id: m1 })).toEqual(at); // never backwards
    expect((await routes.markRead(req('O'), space.mem, { message_id: m3 })).last_read_message_id).toBe(m3);
    expect(await status(routes.markRead(req('O'), space.mem, { message_id: await say('A', 'ann') }))).toBe(404);
    expect(await status(routes.markRead(req('O'), space.mem, { message_id: randomUUID() }))).toBe(404);
    expect((await routes.getRead(req('V'), space.mem)).last_read_message_id).toBeNull(); // O's line is O's alone
  });

  it('unread_count leaves out own messages, blocked people both ways and a banned author, and drops on read', async () => {
    expect(await unread('O', 'mem')).toBe(0);
    const fromO = await say('O', 'mem');
    expect(await unread('O', 'mem')).toBe(0); // own
    const fromV = await say('V', 'mem');
    const fromA = await say('A', 'mem'); // a message O has not read yet, before Z's
    const fromZ = await say('Z', 'mem');
    expect(await unread('O', 'mem')).toBe(3); // control: V, A and Z count
    const vSees = await unread('V', 'mem'); // control: counts O's two messages
    await prisma.userBlock.create({ data: { blocker_id: id.O, blocked_id: id.V } });
    expect(await unread('O', 'mem')).toBe(2); // O blocks V
    expect(await unread('V', 'mem')).toBe((vSees ?? 0) - 2); // the other way: V stops counting O's two
    expect(await status(routes.markRead(req('O'), space.mem, { message_id: fromV }))).toBe(404);
    expect(await status(routes.markRead(req('V'), space.mem, { message_id: fromA }))).toBe(200); // control: V moves a line
    expect(await status(routes.markRead(req('V'), space.mem, { message_id: fromO }))).toBe(404); // the other way too
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.Z } });
    expect(await unread('O', 'mem')).toBe(1); // Z banned: only A's message is left
    const line = await routes.getRead(req('O'), space.mem);
    expect(await status(routes.markRead(req('O'), space.mem, { message_id: fromZ }))).toBe(404); // Z's later message
    expect(await routes.getRead(req('O'), space.mem)).toEqual(line); // cannot move the read line (LS-1137 B1)
    expect(await unread('O', 'mem')).toBe(1); // nor clear A's message
    expect(await status(routes.getRead(req('Z'), space.mem))).toBe(404); // a ban closes the routes too
    const last = await say('A', 'mem');
    expect(await unread('O', 'mem')).toBe(2);
    await routes.markRead(req('O'), space.mem, { message_id: last });
    expect(await unread('O', 'mem')).toBe(0);
    expect(await unread('X', 'bmem')).toBe(0);
    expect((await community.getCohorts(user('X'))).cohorts.map((c) => c.id)).not.toContain(space.mem);
  });

  it('unread_count stops at 99', async () => {
    await prisma.communityMessage.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ workspace_id: ws.A,
      cohort_id: space.big, scope: 'cohort', sender_id: id.A, body: `n${i}`, created_at: new Date(t0 + 1000 * ++tick) })) });
    expect(await unread('N', 'big')).toBe(99);
  });

  it('#168-15: before the first open, the count and the read line start when the person joined', async () => {
    const early = await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.late,
      scope: 'cohort', sender_id: id.A, body: 'before L', created_at: new Date() } });
    await addUser('L'); // joins coach A now
    expect(await unread('O', 'late')).toBe(1); // control: O, a client since beforeAll, counts it
    expect(await unread('L', 'late')).toBe(0); // L joined after it
    await say('A', 'late');
    expect(await unread('L', 'late')).toBe(1);
    const line = await routes.getRead(req('L'), space.late);
    expect(line.last_read_message_id).toBeNull();
    expect(Date.parse(line.last_read_at ?? '')).toBeGreaterThanOrEqual(early.created_at.getTime()); // the join time
    await say('L', 'late');
    expect(await unread('O', 'late')).toBe(3); // control: L's message counts while L stays
    await prisma.user.update({ where: { id: id.L }, data: { coach_id: id.B } });
    expect(await unread('O', 'late')).toBe(2); // L moved to coach B: their words leave the count (C6-WINS-MOVE)
  });

  it('#168-16: the Community tab badge adds up the list, clears with the read line, leaves out Mute all', async () => {
    const tab = async () => (await community.getMe(user('O'))).unread.cohort_messages;
    const rows = async () => (await community.getCohorts(user('O'))).cohorts.reduce((n, c) => n + (c.unread_count ?? 0), 0);
    const fresh = await say('A', 'mem');
    await say('V', 'mem'); // O blocks V: no change anywhere
    const start = await tab();
    expect(start).toBe(await rows()); // the badge is the sum of the space rows
    expect(start).toBeGreaterThanOrEqual(1 + 99); // mem's new message and big's 99+
    await routes.markRead(req('O'), space.mem, { message_id: fresh });
    expect(await tab()).toBe(start - 1); // the read line the phone moves clears it
    await routes.setMode(req('O'), space.big, { mode: 'mute_all' });
    expect(await unread('O', 'big')).toBe(99); // Mute all keeps the row's own count
    expect(await tab()).toBe(start - 1 - 99); // and adds nothing to the tab
    await routes.setMode(req('O'), space.big, { mode: 'mute_low' });
    expect(await tab()).toBe(start - 1);
  });

  it('notifications: defaults by space, a chosen mode, a silence that ends, and the same access rule', async () => {
    const at = (k: Key, s: Space) => routes.getNotify(req(k), space[s]);
    expect(await at('N', 'ann')).toEqual({ mode: 'all', default_mode: 'all', effective_mode: 'all', silenced_until: null });
    expect(await at('O', 'mem')).toEqual({ mode: 'mute_low', default_mode: 'mute_low', effective_mode: 'mute_low', silenced_until: null });
    expect(await at('N', 'big')).toMatchObject({ default_mode: 'mute_low' }); // a coach-only chat is not Announcements
    await prisma.communityCohort.update({ where: { id: space.ann }, data: { posting_policy: 'all' } });
    expect(await at('N', 'ann')).toMatchObject({ mode: 'all', default_mode: 'all' }); // who may post does not change it
    await prisma.communityCohort.update({ where: { id: space.ann }, data: { posting_policy: 'coach' } });
    expect((await routes.setMode(req('O'), space.mem, { mode: 'all' })).effective_mode).toBe('all');
    const quiet = await routes.silence(req('O'), space.mem, { hours: 8 });
    expect([quiet.mode, quiet.effective_mode]).toEqual(['all', 'mute_all']);
    expect(Date.parse(quiet.silenced_until ?? '') - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
    await prisma.communitySpaceRead.update({ where: { user_id_cohort_id: { user_id: id.O, cohort_id: space.mem } },
      data: { silenced_until: new Date(Date.now() - 1000) } });
    expect(await at('O', 'mem')).toMatchObject({ mode: 'all', effective_mode: 'all', silenced_until: null }); // ended
    await routes.silence(req('O'), space.mem, { hours: 1 });
    expect((await routes.unsilence(req('O'), space.mem)).effective_mode).toBe('all');
    expect((await routes.getRead(req('O'), space.mem)).last_read_message_id).not.toBeNull(); // the read line stays
    expect(await at('V', 'mem')).toMatchObject({ mode: 'mute_low' }); // O's choice is O's alone
    expect(await status(at('N', 'mem'))).toBe(404);
    expect(await status(routes.setMode(req('X'), space.mem, { mode: 'mute_all' }))).toBe(404);
    expect(await status(routes.silence(req('B'), space.mem, { hours: 24 }))).toBe(404);
  });

  it('row security: own rows only; a row only for a space the writer can read now', async () => {
    const own = (k: Key, s: Space, sql: string) => as(k, (tx) => tx.$executeRawUnsafe(
      `${sql} WHERE "user_id" = $1 AND "cohort_id" = $2::uuid`, id[k], space[s]));
    const touch = 'UPDATE "community_space_reads" SET "updated_at" = now()';
    const drop = 'DELETE FROM "community_space_reads"';
    expect(await readRows('O', 'O')).toBe(1); // control: O reads O's row
    expect(await readRows('V', 'O')).toBe(0);
    expect(await readRows('X', 'O')).toBe(0);
    expect(await writeRow('X', 'bmem')).toBe(1); // control: X writes for B's space
    expect(await writeRow('X', 'mem')).toBe(DENIED); // another tenant
    expect(await writeRow('N', 'big')).toBe(1); // control: N writes for A's open space
    expect(await writeRow('N', 'mem')).toBe(DENIED); // not a member
    expect(await writeRow('Z', 'mem')).toBe(DENIED); // banned
    const moved = await as('V', (tx) => tx.$executeRawUnsafe(
      `UPDATE "community_space_reads" SET "last_read_at" = now() WHERE "user_id" = $1`, id.O));
    expect(moved).toBe(0);
    expect(await own('N', 'big', touch)).toBe(1); // control: N changes and deletes N's own row
    expect(await own('N', 'big', drop)).toBe(1);
    await prisma.communitySpaceRead.create({ data: { user_id: id.Z, cohort_id: space.mem } }); // the server kept Z's row
    expect(await readRows('Z', 'Z')).toBe(1); // Z, banned, still reads their own row
    expect(await own('Z', 'mem', touch)).toBe(0); // but cannot change it (LS-1137 C1)
    expect(await own('Z', 'mem', drop)).toBe(0); // or delete it
    expect(await prisma.communitySpaceRead.count({ where: { user_id: id.Z, cohort_id: space.mem } })).toBe(1);
  });
});
