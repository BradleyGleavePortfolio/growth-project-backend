// FX-IDEM (agent 169): Idempotency-Key on the space chat send, live on the replayed migration chain: the real chat
// service on real Postgres (the advisory lock, the partitioned community_messages table); row reads run as role
// authenticated. A coaches O and V (members of A's members-only space "mem") and N (A's client, not a member); X is
// a client of coach B (another tenant) in B's space "bmem". Each "0" follows a control read of 1.
//  - a resend with the same key returns the first message, also when the sends race, also for a reply;
//  - a keyed message takes replies like any other;
//  - the same key with other words is refused and writes nothing;
//  - a key is one author's in one space: anyone else's send with it is their own message, and never reads back
//    another person's message; another tenant gets the same 404 as without a key.
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
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
  throw new Error('community-message-idempotency: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'V' | 'N' | 'X';
const PEOPLE: Key[] = ['A', 'B', 'O', 'V', 'N', 'X']; // coaches first: clients reference them
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', V: 'A', N: 'A', X: 'B' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('FX-IDEM: one message per Idempotency-Key, per author, per space', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const chat = new CommunityMessagesService(new CommunityAccessService(db), new CommunityMessagesRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }), stub<PlanContextService>({}),
    new CommunitySafetyService(db), stub<CommunityNotificationsService>({ pushEnabled: () => false }));
  const ids = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = ids(PEOPLE);
  const sub = ids(PEOPLE);
  const ws = ids(['A', 'B'] as const);
  const space = ids(['mem', 'bmem'] as const);
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as 'A' | 'B'] : null });
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
  const send = (k: Key, s: 'mem' | 'bmem', body: string, key?: string, parent?: string) =>
    chat.send(user(k), space[s], body, undefined, parent, key).then((r) => r.message);
  const sentBy = (k: Key) => prisma.communityMessage.count({ where: { sender_id: id[k] } });
  const reads = (k: Key, msg: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id" = $1::uuid`, msg);
      return r[0].n;
    });

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`idem-${id[k]}`}, ${`Idem ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`idem-${run}-${c}`}, now())`;
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
  });
  afterAll(() => prisma.$disconnect());

  it('reads run as a role that does not bypass row security, on a table that forces it', async () => {
    const roles = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      return tx.$queryRaw<{ b: boolean }[]>`SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`;
    });
    expect(roles).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_messages'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  it('a resend with the same key returns the first message and writes one row', async () => {
    const key = randomUUID();
    const before = await sentBy('O');
    const first = await send('O', 'mem', 'Leg day done', key);
    expect(await send('O', 'mem', 'Leg day done', key)).toEqual(first);
    expect(await sentBy('O')).toBe(before + 1);
  });

  it('three sends racing under one key write one row and all answer with it', async () => {
    const key = randomUUID();
    const before = await sentBy('V');
    const sent = await Promise.all([1, 2, 3].map(() => send('V', 'mem', 'Hit a new best', key)));
    expect(new Set(sent.map((m) => m.id)).size).toBe(1);
    expect(await sentBy('V')).toBe(before + 1);
  });

  it('a reply resent with its key returns the same reply', async () => {
    const root = await send('A', 'mem', 'Plan for the week');
    const key = randomUUID();
    const reply = await send('O', 'mem', 'On it', key, root.id);
    expect(reply.parent_message_id).toBe(root.id);
    expect((await send('O', 'mem', 'On it', key, root.id)).id).toBe(reply.id);
    // The same key on a different message (top level now) is refused, never answered with the reply.
    expect(await status(send('O', 'mem', 'On it', key))).toBe(409);
  });

  it('a message sent with a key takes replies like any other (its id is a version 4 UUID)', async () => {
    const root = await send('A', 'mem', 'Week 3 plan is up', randomUUID());
    expect(root.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const reply = await send('O', 'mem', 'Thanks coach', randomUUID(), root.id);
    expect(reply.parent_message_id).toBe(root.id);
  });

  it('the same key with other words is refused (409) and writes nothing', async () => {
    const key = randomUUID();
    await send('O', 'mem', 'Leg day done', key);
    const before = await sentBy('O');
    expect(await status(send('O', 'mem', 'Rest day', key))).toBe(409);
    expect(await sentBy('O')).toBe(before);
  });

  it("a key is one author's in one space: no one else ever reads back another person's message through it", async () => {
    const key = randomUUID();
    const mine = await send('O', 'mem', 'Leg day done', key);
    // Same space, another member, the same key: her own new message.
    const hers = await send('V', 'mem', 'Leg day done', key);
    expect(hers.id).not.toBe(mine.id);
    expect(hers.sender_user_id).toBe(id.V);
    // Row layer: the space reads O's message (control 1), a non-member and another tenant read 0.
    expect(await reads('V', mine.id)).toBe(1);
    expect(await reads('N', mine.id)).toBe(0);
    expect(await reads('X', mine.id)).toBe(0);
    // Another tenant sending into A's space with O's key: the same 404 as with no key, and nothing written.
    const xBefore = await sentBy('X');
    expect(await status(send('X', 'mem', 'Leg day done', key))).toBe(404);
    expect(await sentBy('X')).toBe(xBefore);
    // In X's own space the key is X's own: a new message, never O's.
    const xs = await send('X', 'bmem', 'Leg day done', key);
    expect([mine.id, hers.id]).not.toContain(xs.id);
    expect(await reads('X', xs.id)).toBe(1);
    expect(await reads('O', xs.id)).toBe(0);
  });

  it('with no key every send is a new message, as before', async () => {
    const before = await sentBy('A');
    const one = await send('A', 'mem', 'Morning all');
    const two = await send('A', 'mem', 'Morning all');
    expect(two.id).not.toBe(one.id);
    expect(await sentBy('A')).toBe(before + 2);
  });
});
