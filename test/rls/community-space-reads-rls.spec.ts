// SC-BE2 (agent 168): the space chat read line and unread count, live on the replayed migration chain
// (20270502008400). The real routes (controller + service + CommunitySafetyService) and the real space list;
// row reads and writes run as role authenticated. Each "0" or refusal follows a control of 1.
// Coach A: members-only space "mem" (clients O, V, Z), coach-only "ann" open to all of A's clients, "big";
// N is A's client outside "mem"; Z gets banned from A's community. Coach B: space "bmem" with client X.
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

type Key = 'A' | 'B' | 'O' | 'V' | 'Z' | 'N' | 'X';
type Space = 'mem' | 'ann' | 'big' | 'bmem';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'Z', 'N', 'X'];
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', Z: 'A', N: 'A', X: 'B' };
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
  const space = ids(['mem', 'ann', 'big', 'bmem'] as const);
  const run = randomUUID().slice(0, 8);
  const t0 = Date.now() - 3_600_000;
  let tick = 0;
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const req = (k: Key) => stub<Parameters<CommunitySpaceReadsController['getRead']>[0]>({ user: user(k) });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
  const say = async (k: Key, s: Space, body = 'hi') =>
    (await prisma.communityMessage.create({ data: { workspace_id: s === 'bmem' ? ws.B : ws.A, cohort_id: space[s], scope: 'cohort',
      sender_id: id[k], body, created_at: new Date(t0 + 1000 * ++tick) } })).id;
  const unread = async (k: Key, s: Space) =>
    (await community.getCohorts(user(k))).cohorts.find((c) => c.id === space[s])?.unread_count;
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const readRows = (k: Key, owner: Key) => as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM "community_space_reads" WHERE "user_id" = $1`, id[owner])).then((r) => r[0].n);
  const writeRow = (k: Key, s: Space) => as(k, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "community_space_reads" ("user_id", "cohort_id") VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING`, id[k], space[s]))
    .catch((e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code));

  beforeAll(async () => {
    process.env.FEATURE_COMMUNITY_SPACE_CHAT = 'true';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`reads-${id[k]}`}, ${`Reads ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`reads-${run}-${c}`}, now())`;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "posting_policy", "visibility", "updated_at")
      VALUES (${space.mem}::uuid, ${ws.A}::uuid, 'RLS mem', 'all', 'members', now()),
             (${space.ann}::uuid, ${ws.A}::uuid, 'RLS ann', 'coach', 'clients', now()),
             (${space.big}::uuid, ${ws.A}::uuid, 'RLS big', 'all', 'clients', now()),
             (${space.bmem}::uuid, ${ws.B}::uuid, 'RLS bmem', 'all', 'members', now())`;
    for (const [s, w, k] of [['mem', 'A', 'O'], ['mem', 'A', 'V'], ['mem', 'A', 'Z'], ['bmem', 'B', 'X']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[w], space[s], id[k]);
    }
  });
  afterAll(async () => {
    delete process.env.FEATURE_COMMUNITY_SPACE_CHAT;
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security, on a table that forces it', async () => {
    expect(await as('O', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_space_reads'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  it('routes: a member, the coach and an open-space client read; a non-member, another tenant and a ban get 403', async () => {
    expect(await routes.getRead(req('O'), space.mem)).toEqual({ last_read_at: null, last_read_message_id: null });
    expect(await status(routes.getRead(req('A'), space.mem))).toBe(200);
    expect(await status(routes.getRead(req('N'), space.ann))).toBe(200); // control: N reads A's open space
    expect(await status(routes.getRead(req('N'), space.mem))).toBe(403);
    expect(await status(routes.getRead(req('X'), space.mem))).toBe(403);
    expect(await status(routes.markRead(req('X'), space.mem, { message_id: await say('O', 'mem') }))).toBe(403);
    expect(await status(routes.getRead(req('B'), space.mem))).toBe(403);
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
    await say('O', 'mem');
    expect(await unread('O', 'mem')).toBe(0); // own
    const fromV = await say('V', 'mem');
    await say('Z', 'mem');
    expect(await unread('O', 'mem')).toBe(2); // control: V and Z count
    await prisma.userBlock.create({ data: { blocker_id: id.O, blocked_id: id.V } });
    expect(await unread('O', 'mem')).toBe(1); // O blocks V
    expect(await status(routes.markRead(req('O'), space.mem, { message_id: fromV }))).toBe(404);
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.Z } });
    expect(await unread('O', 'mem')).toBe(0); // Z banned
    expect(await status(routes.getRead(req('Z'), space.mem))).toBe(403); // a ban closes the routes too
    const last = await say('A', 'mem');
    expect(await unread('O', 'mem')).toBe(1);
    await routes.markRead(req('O'), space.mem, { message_id: last });
    expect(await unread('O', 'mem')).toBe(0);
    expect(await unread('X', 'bmem')).toBe(0);
    expect((await community.getCohorts(user('X'))).cohorts.map((c) => c.id)).not.toContain(space.mem);
  });

  it('unread_count stops at 99; with the switch off the list has none and the routes answer 404', async () => {
    await prisma.communityMessage.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ workspace_id: ws.A,
      cohort_id: space.big, scope: 'cohort', sender_id: id.A, body: `n${i}`, created_at: new Date(t0 + 1000 * ++tick) })) });
    expect(await unread('N', 'big')).toBe(99);
    process.env.FEATURE_COMMUNITY_SPACE_CHAT = 'false';
    try {
      expect(await unread('N', 'big')).toBeUndefined();
      expect(await status(routes.getRead(req('O'), space.mem))).toBe(404);
    } finally {
      process.env.FEATURE_COMMUNITY_SPACE_CHAT = 'true';
    }
  });

  it('row security: own rows only; a row only for a space the writer can read now', async () => {
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
  });
});
