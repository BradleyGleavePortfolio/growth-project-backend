// SC-BE1 (agent 167): text replies in the space chat, live on the replayed migration chain (20270502008300):
// the real chat service with the real CommunitySafetyService; row reads and writes run as role authenticated.
// A coaches O, V and N; O and V are members of A's members-only space "mem", N is not; X is a client of
// coach B (another tenant) in B's space "bmem". Each "0" follows a control read of 1.
//  - a text reply obeys the voice reply rule: in A's coach-only Announcements a client may reply (read access
//    + a live parent in that space), never start one; a section takes neither, in the server and at the row layer;
//  - only the space reads a reply; the read names its sender (the voice name rule) and quotes its parent;
//  - a blocked member's message is never answered by the person who blocked, and reads `gone` in their quotes.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-text-replies-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'N' | 'X';
type Space = 'mem' | 'bmem' | 'ann' | 'sec';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'N', 'X']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', N: 'A', X: 'B' };
const NAME: Record<Key, string> = { A: 'Ada Stone', B: 'Ben Hale', O: 'Olive Reed', V: 'Vera Lane', N: 'Nia Park', X: 'Xan Field' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('SC-BE1: text replies in a space (one reply rule, names, quote, blocks)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const chat = new CommunityMessagesService(new CommunityAccessService(db), new CommunityMessagesRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }), stub<PlanContextService>({}),
    new CommunitySafetyService(db), stub<CommunityNotificationsService>({ pushEnabled: () => false }));
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'bmem', 'ann', 'sec'] as const);
  const parentOf = ids(['mem', 'ann', 'sec'] as const); // A's text message in each of A's spaces
  const parentAt: Record<string, Date> = {};
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const chatRows = (k: Key, msg: string) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, msg))
      .then((r) => r[0].n);
  const TEXT_ROW = `INSERT INTO "community_messages" ("id", "workspace_id", "cohort_id", "scope", "kind", "sender_id", "body",
    "parent_message_id", "parent_message_at", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, 'cohort', 'text', $4, 'row reply', $5::uuid, $6::timestamptz, now())`;
  const textRow = (k: Key, s: 'ann' | 'sec', p: 'mem' | 'ann' | 'sec' | null) =>
    as(k, (tx) => tx.$executeRawUnsafe(TEXT_ROW, randomUUID(), ws.A, space[s], id[k], p && parentOf[p], p && parentAt[p]))
      .catch((e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code));
  const sentBy = (k: Key) => prisma.communityMessage.count({ where: { sender_id: id[k], kind: 'text' } });
  const quoteOf = async (k: Key, s: Space, msg: string) =>
    (await chat.list(user(k), space[s], {})).messages.find((m) => m.id === msg)?.parent;

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`replies-${id[k]}`}, ${NAME[k]}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`replies-${run}-${c}`}, now())`;
    }
    const spaces: Array<['mem' | 'bmem', 'A' | 'B', Key[]]> = [['mem', 'A', ['O', 'V']], ['bmem', 'B', ['X']]];
    for (const [s, c, members] of spaces) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, 'members'::"CommunitySpaceVisibility", 'active', now())`, space[s], ws[c], `RLS ${s}`);
      for (const k of members) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[c], space[s], id[k]);
      }
    }
    // A's coach-only Announcements and a section, both open to all of A's clients (the C6-B1 defaults).
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "kind", "posting_policy", "visibility", "updated_at")
      VALUES (${space.ann}::uuid, ${ws.A}::uuid, 'RLS ann', 'announcement', 'coach', 'clients', now()),
             (${space.sec}::uuid, ${ws.A}::uuid, 'RLS sec', 'section', 'all', 'clients', now())`;
    for (const s of ['mem', 'ann', 'sec'] as const) {
      const m = await prisma.communityMessage.create({ data: { id: parentOf[s], workspace_id: ws.A, cohort_id: space[s],
        scope: 'cohort', sender_id: id.A, body: `Plan for ${s}` } });
      parentAt[s] = m.created_at;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security, on a table that forces it', async () => {
    expect(await as('V', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_messages'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  // [case, who, space, parent's space, server answer, row-layer insert as authenticated]: the voice table, for text.
  it.each<[string, Key, 'ann' | 'sec', 'mem' | 'ann' | 'sec' | null, number, number | string]>([
    ['a client text reply in Announcements is sent', 'O', 'ann', 'ann', 200, 1],
    ['a client top-level text in Announcements is refused', 'O', 'ann', null, 403, DENIED],
    ['a client reply whose parent is in another space is refused', 'O', 'ann', 'mem', 404, DENIED],
    ['another tenant replying in Announcements is refused', 'X', 'ann', 'ann', 404, DENIED],
    ['a client reply in a section is refused', 'O', 'sec', 'sec', 403, DENIED],
  ])('%s', async (_case, k, s, p, server, row) => {
    const before = await sentBy(k);
    expect(await status(chat.send(user(k), space[s], 'Count me in', undefined, p ? parentOf[p] : undefined))).toBe(server);
    expect(await sentBy(k)).toBe(before + (server === 200 ? 1 : 0));
    expect(await textRow(k, s, p)).toBe(row);
  });

  it('only the space reads a reply; the read names the sender and quotes the parent (the voice name rule)', async () => {
    const reply = (await chat.send(user('O'), space.mem, 'On it', undefined, parentOf.mem)).message;
    expect(reply.parent_message_id).toBe(parentOf.mem);
    expect(await chatRows('V', reply.id)).toBe(1);
    expect(await chatRows('N', reply.id)).toBe(0);
    expect(await chatRows('X', reply.id)).toBe(0);
    expect((await chat.getOne(user('V'), reply.id)).message).toMatchObject({
      sender: { id: id.O, name: 'Olive', avatar_url: null, is_coach: false },
      parent: { id: parentOf.mem, gone: false, kind: 'text', sender_name: 'Ada', snippet: 'Plan for mem', voice_duration_ms: null },
    });
    expect(await status(chat.getOne(user('N'), reply.id))).toBe(404);
    expect(await status(chat.getOne(user('X'), reply.id))).toBe(404);
    expect(await status(chat.list(user('X'), space.mem, {}))).toBe(404);
    // A space open to all of A's clients shows full names (#C6-NAMES-EVERYWHERE); N reads it there too.
    const ann = (await chat.send(user('V'), space.ann, 'Thanks', undefined, parentOf.ann)).message;
    expect((await chat.getOne(user('N'), ann.id)).message).toMatchObject({
      sender: { name: 'Vera Lane', is_coach: false },
      parent: { sender_name: 'Ada Stone', snippet: 'Plan for ann', gone: false },
    });
    expect(await status(chat.getOne(user('X'), ann.id))).toBe(404);
  });

  it('a blocked member: never answered by the person who blocked, and their message reads gone in quotes', async () => {
    const root = (await chat.send(user('O'), space.mem, 'Leg day done')).message;
    const coachReply = (await chat.send(user('A'), space.mem, 'Strong work', undefined, root.id)).message;
    expect(await quoteOf('V', 'mem', coachReply.id)).toMatchObject({ gone: false, sender_name: 'Olive', snippet: 'Leg day done' });
    await prisma.userBlock.create({ data: { blocker_id: id.V, blocked_id: id.O } });
    const before = await sentBy('V');
    expect(await status(chat.send(user('V'), space.mem, 'Nope', undefined, root.id))).toBe(404);
    expect(await sentBy('V')).toBe(before);
    expect(await quoteOf('V', 'mem', coachReply.id)).toEqual({
      id: root.id, gone: true, kind: null, sender_name: null, snippet: null, voice_duration_ms: null,
    });
    // Two-way: the blocked person cannot answer the blocker either; O still reads their own quote.
    const vRoot = (await chat.send(user('V'), space.mem, 'Rest day')).message;
    expect(await status(chat.send(user('O'), space.mem, 'Nope', undefined, vRoot.id))).toBe(404);
    expect(await quoteOf('O', 'mem', coachReply.id)).toMatchObject({ gone: false, snippet: 'Leg day done' });
  });
});
