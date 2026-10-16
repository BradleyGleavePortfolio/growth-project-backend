// C10RT: community realtime is private per person. A listener joins a topic only when it is their own:
// Realtime authorization runs the realtime.messages policies as the joining role with the topic in
// realtime.topic, as `listen` does here. Who gets a ping is app.community_can_access at send time
// (CommunityRealtimeService, the real SQL). X, Y coach; I and M are X's clients with a row in X's
// members space S; N has no coach and joined X's public space P; Z is Y's client. Every 0 follows a 1.
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { COMMUNITY_BROADCAST_EVENTS } from '../../src/community/community-events';
import { CommunityRealtimeService, type CommunityAudience } from '../../src/community/realtime/community-realtime.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PrismaService } from '../../src/prisma.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-realtime-private-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'X' | 'Y' | 'I' | 'M' | 'N' | 'Z';
type Listener = Key | 'anon' | 'nobody';
const PEOPLE: Key[] = ['X', 'Y', 'I', 'M', 'N', 'Z']; // coaches first: clients reference them
const COACH: Record<Key, Key | null> = { X: null, Y: null, I: 'X', M: 'X', N: null, Z: 'Y' };
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('community realtime: own private topic only, readers decided at send time', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const uuids = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = uuids(PEOPLE);
  const sub = uuids(PEOPLE);
  const ws = uuids(['X', 'Y'] as const);
  const space = uuids(['S', 'P'] as const);
  const run = randomUUID().slice(0, 8);
  const topic = (k: Key) => `community:user:${id[k]}`;
  const prevFlag = process.env.FEATURE_COMMUNITY_REALTIME;

  // Runs `query` as the listener's role and session, with the joining topic set.
  const as = <T>(who: Listener, topicOf: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who === 'anon' ? 'anon' : 'authenticated'}`);
      const claims = who === 'anon' ? { role: 'anon' } : { sub: who === 'nobody' ? randomUUID() : sub[who], role: 'authenticated' };
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify(claims));
      await tx.$executeRawUnsafe(`SELECT set_config('realtime.topic', $1, true)`, topic(topicOf));
      return query(tx);
    });
  const listen = (who: Listener, topicOf: Key, extension: string) =>
    as(who, topicOf, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM realtime.messages WHERE "topic" = $1 AND "extension" = $2`, topic(topicOf), extension))
      .then((r) => r[0].n);

  // The real broadcaster with a Realtime client that records each send.
  const sent: { topic: string; private: unknown }[] = [];
  const client = {
    channel: (name: string, opts: { config: { private?: boolean } }) => ({
      httpSend: async () => {
        sent.push({ topic: name, private: opts.config.private });
        return { success: true };
      },
    }),
    removeChannel: async () => 'ok',
  };
  const realtime = new CommunityRealtimeService(
    stub<SupabaseService>({ getClient: () => client }),
    stub<AnalyticsService>({ capture: () => undefined }),
    stub<PrismaService>(prisma),
  );
  const hears = async (audience: CommunityAudience): Promise<string[]> => {
    sent.length = 0;
    await realtime.broadcastCommunityEvent(audience, COMMUNITY_BROADCAST_EVENTS.messageCreated,
      { id: randomUUID(), cohortId: space.S, authorId: id.X, createdAt: new Date().toISOString() },
      { distinctId: id.X, channelKind: 'cohort' });
    return sent.map((s) => `${PEOPLE.find((k) => topic(k) === s.topic) ?? s.topic}${s.private === true ? '' : ' (not private)'}`).sort();
  };

  beforeAll(async () => {
    process.env.FEATURE_COMMUNITY_REALTIME = 'true';
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`realtime-${id[k]}`}, 'RLS person', ${k === 'X' || k === 'Y' ? 'coach' : 'student'}::"Role",
                ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['X', 'Y'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`realtime-${run}-${c}`}, now())`;
    }
    await prisma.$executeRaw`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at")
      VALUES (${space.S}::uuid, ${ws.X}::uuid, 'RLS S', 'members', now()), (${space.P}::uuid, ${ws.X}::uuid, 'RLS P', 'public', now())`;
    for (const [k, s] of [['I', 'S'], ['M', 'S'], ['N', 'P']] as const) {
      await prisma.$executeRaw`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${space[s]}::uuid, ${id[k]}, 'student', 'active', now())`;
    }
    for (const k of PEOPLE) {
      for (const extension of ['broadcast', 'presence']) {
        await prisma.$executeRaw`INSERT INTO realtime.messages ("topic", "extension") VALUES (${topic(k)}, ${extension})`;
      }
    }
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.FEATURE_COMMUNITY_REALTIME;
    else process.env.FEATURE_COMMUNITY_REALTIME = prevFlag;
    await prisma.$disconnect();
  });

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('I', 'I', (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('a signed-in person joins their own topic and no other; signed-out readers get nothing', async () => {
    const joins: [string, Listener, Key, string, number][] = [
      ['I, own topic', 'I', 'I', 'broadcast', 1],
      ['I, M\'s topic', 'I', 'M', 'broadcast', 0],
      ['M, own topic', 'M', 'M', 'broadcast', 1],
      ['X, own topic', 'X', 'X', 'broadcast', 1],
      ['X (their coach), I\'s topic', 'X', 'I', 'broadcast', 0],
      ['Z, own topic', 'Z', 'Z', 'broadcast', 1],
      ['Z (another coach\'s client), I\'s topic', 'Z', 'I', 'broadcast', 0],
      ['signed out, I\'s topic', 'anon', 'I', 'broadcast', 0],
      ['a session that is nobody, I\'s topic', 'nobody', 'I', 'broadcast', 0],
      ['I, own topic, presence', 'I', 'I', 'presence', 0],
    ];
    for (const [label, who, topicOf, extension, n] of joins) {
      expect({ label, n: await listen(who, topicOf, extension) }).toEqual({ label, n });
    }
  });

  it('nobody but the server sends, not even on their own topic', async () => {
    expect(await listen('I', 'I', 'broadcast')).toBe(1);
    const sendOwn = as('I', 'I', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO realtime.messages ("topic", "extension") VALUES ($1, 'broadcast')`, topic('I')));
    const err = await sendOwn.then(() => null, (e: { code?: string; meta?: { code?: string } }) => e);
    expect(String(err?.code === 'P2010' ? err.meta?.code : err?.code)).toBe(DENIED);
  });

  it('each ping reaches exactly who may read it now, on private topics; removal, a move and a ban take effect at once', async () => {
    const S = { workspaceId: ws.X, cohortId: space.S };
    const P = { workspaceId: ws.X, cohortId: space.P };
    const HALL = { workspaceId: ws.X, cohortId: null };
    const steps: [string, (() => Promise<unknown>) | null, CommunityAudience, string[]][] = [
      ['named people (a DM recipient, a participant) and nobody else', null, { people: [id.Y, id.Z] }, ['Y', 'Z']],
      ['space S: the coach and its members', null, S, ['I', 'M', 'X']],
      ['the Hall: the coach and whoever a space that is not public opens to', null, HALL, ['I', 'M', 'X']],
      ['public space P: the coach and who joined, coachless included', null, P, ['N', 'X']],
      ['moderation: the workspace coach', null, { coachOf: ws.X }, ['X']],
      ['M moves to coach Y: out of S at once', () => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.Y} WHERE "id" = ${id.M}`, S, ['I', 'X']],
      ['... and out of the Hall', null, HALL, ['I', 'X']],
      ['I is removed from S', () => prisma.$executeRaw`UPDATE "community_memberships" SET "status" = 'removed' WHERE "user_id" = ${id.I}`, S, ['X']],
      ['N is banned from the workspace', () => prisma.$executeRaw`INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id")
        VALUES (${randomUUID()}::uuid, ${ws.X}::uuid, ${id.N})`, P, ['X']],
    ];
    for (const [label, change, audience, people] of steps) {
      if (change) await change();
      expect({ label, hears: await hears(audience) }).toEqual({ label, hears: people });
    }
  });
});
