// ACK-VISIBILITY-GUARD (LS-1134D on b#1134): the three ack writes (POST /community/ack/:messageId/seen | acked |
// replied) pass the same visibility gate the coach's read of that message passes
// (CommunitySafetyService.assertVisibleTo with the row's place, as CommunityMessagesService.getOne calls it).
// Live, on the replayed migration chain, through the real AckService, AckRepository, CommunityAccessService and
// CommunitySafetyService. A and B coach. In A's clients space S: O (stays), X (A blocked X), V (V blocked A), Y
// (banned from A's community), M (moves to B), R (stamped, then banned, then the ban is lifted). In A's public
// space P: M. M also has a DM with A. A hidden message answers the same 404 as an absent one and nothing is
// stamped; each refusal follows its control (a 200 before, or a 200 once the block or ban is gone).
// FR-1174 (LS-1174 B1): the full read rule per kind. A (a coach member of S; DMs on by default) has DMs with M and
// D; O and R have one of their own. A DM passes the DM reader's rule (in it, both still members, DMs on for both);
// post comments, challenge comments and the leaderboard sentinel are never acked; W is the platform owner; the
// bulk replied stamps (a coach's text, a coach's space voice note) touch only rows the coach can read.
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { AckRepository } from '../../src/community/ack/ack.repository';
import { type AckActor, AckService } from '../../src/community/ack/ack.service';
import { CHALLENGE_COMMENT_CONTEXT_TYPE, CHALLENGE_OPTIN_CONTEXT_TYPE } from '../../src/community/challenges/community-challenges.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityDmsRepository } from '../../src/community/dms/community-dms.repository';
import { COMMENT_CONTEXT_TYPE, CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityVoiceRepository } from '../../src/community/voice/community-voice.repository';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-ack-visibility-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'W' | 'O' | 'X' | 'V' | 'Y' | 'M' | 'R' | 'D';
const PEOPLE: Key[] = ['A', 'B', 'W', 'O', 'X', 'V', 'Y', 'M', 'R', 'D']; // coaches first: clients reference them
const CLIENTS: Key[] = ['O', 'X', 'V', 'Y', 'M', 'R', 'D'];
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : k === 'W' ? 'owner' : 'student');
const ROUTES = ['seen', 'acked', 'replied'] as const;
type Route = (typeof ROUTES)[number];

(DB_URL ? describe : describe.skip)('ACK-VISIBILITY-GUARD: an ack write passes the coach\'s read gate', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const ack = new AckService(new AckRepository(db), new CommunityAccessService(db),
    stub<AnalyticsService>({ capture: jest.fn() }), new CommunitySafetyService(db));
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const ws = { A: randomUUID(), B: randomUUID() };
  const space = { S: randomUUID(), P: randomUUID() };
  const run = randomUUID().slice(0, 8);
  const row: Record<string, string> = {};
  const coachA: AckActor = { id: id.A, role: 'coach' };
  const ownerW: AckActor = { id: id.W, role: 'owner' };
  const mark = (key: string, to: Route, who = coachA) => ack.applyTransition(who, row[key], to);
  const refusal = (messageId: string, to: Route, who = coachA) =>
    ack.applyTransition(who, messageId, to).then(() => 'stamped', (e) => e);
  const NONE = { coach_seen_at: null, coach_acked_at: null, coach_replied_at: null };
  const dmKey = (a: Key, b: Key) => CommunityDmsRepository.dmKey(ws.A, id[a], id[b]);
  const say = async (k: Key, data: Partial<Prisma.CommunityMessageUncheckedCreateInput> = {}) =>
    (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.S, scope: 'cohort',
      sender_id: id[k], body: `words of ${k}`, ...data } })).id;
  const memberD = (data: Prisma.CommunityMembershipUpdateManyMutationInput) =>
    prisma.communityMembership.updateMany({ where: { workspace_id: ws.A, user_id: id.D }, data });
  // community_messages is keyed (id, created_at) (partitioned), so the id alone is a findFirst.
  const stamps = (key: string) => prisma.communityMessage.findFirstOrThrow({ where: { id: row[key] },
    select: { coach_seen_at: true, coach_acked_at: true, coach_replied_at: true } });
  const as = <T>(k: Key, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      return query(tx);
    });
  const reads = (k: Key, key: string) => as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM "community_messages" WHERE "id"::text = $1`, row[key])).then((r) => r[0].n);
  let absent: object;

  // Every hidden message, on every route: a 404 whose body is the absent message's body.
  const expectRefused = async (key: string, routes: readonly Route[] = ROUTES, who = coachA) => {
    const seen: string[] = [];
    for (const to of routes) {
      const e = await refusal(row[key], to, who);
      seen.push(`${key} ${to} ${e instanceof NotFoundException ? `${e.getStatus()} ${JSON.stringify(e.getResponse())}` : String(e)}`);
    }
    expect(seen).toEqual(routes.map((to) => `${key} ${to} 404 ${JSON.stringify(absent)}`));
  };

  beforeAll(async () => {
    for (const k of PEOPLE) {
      const coach = ROLE(k) === 'student' ? id.A : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`ack-visibility-${id[k]}`}, ${`RLS person ${k}`}, ${ROLE(k)}::"Role", ${coach})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "dm_enabled_default", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`ack-visibility-${run}-${c}`}, true, now())`;
    }
    for (const [s, visibility] of [['S', 'clients'], ['P', 'public']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], ws.A, `RLS space ${s}`, visibility);
    }
    for (const [k, s] of [...CLIENTS.map((k) => [k, 'S'] as const), ['M', 'P'] as const, ['A', 'S'] as const]) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::"CommunityMembershipRole", 'active', now())`, randomUUID(), ws.A, space[s], id[k],
      k === 'A' ? 'coach' : 'student');
    }
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.X } });
    await prisma.userBlock.create({ data: { blocker_id: id.V, blocked_id: id.A } });
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.Y, banned_by_id: id.A } });
    for (const k of CLIENTS) {
      row[`m${k}`] = (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.S, scope: 'cohort',
        sender_id: id[k], body: `words of ${k}` } })).id;
    }
    row.pM = (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.P, scope: 'cohort',
      sender_id: id.M, body: 'public words of M' } })).id;
    for (const [key, from, to] of [['dM', 'M', 'A'], ['dD', 'D', 'A'], ['dOR', 'O', 'R']] as const) {
      row[key] = await say(from, { cohort_id: null, scope: 'dm', dm_key: dmKey(from, to), recipient_user_id: id[to] });
    }
    row.cP = await say('O', { plan_context_type: COMMENT_CONTEXT_TYPE, plan_context_id: randomUUID() });
    row.cC = await say('O', { plan_context_type: CHALLENGE_COMMENT_CONTEXT_TYPE, plan_context_id: randomUUID() });
    row.cL = await say('O', { plan_context_type: CHALLENGE_OPTIN_CONTEXT_TYPE, plan_context_id: randomUUID() });
    row.wO = await say('O');
    absent = (await refusal(randomUUID(), 'seen')).getResponse();
  });
  afterAll(() => prisma.$disconnect());

  it('the absent answer is the ack not-found body', () => {
    expect(absent).toEqual({ error: 'not_found', code: 'community.ack.message_not_found' });
  });

  it('normal: the coach marks a staying client\'s message seen, acked, replied; each stamps its column', async () => {
    expect((await mark('mO', 'seen')).ack.state).toBe('seen');
    expect((await mark('mO', 'acked')).ack.state).toBe('acked');
    expect((await mark('mO', 'replied')).ack.state).toBe('replied');
    const s = await stamps('mO');
    expect([s.coach_seen_at, s.coach_acked_at, s.coach_replied_at].every((d) => d instanceof Date)).toBe(true);
  });

  it('a block either way (A blocked X; V blocked A) and a ban (Y): every route answers the absent 404, nothing stamped', async () => {
    for (const key of ['mX', 'mV', 'mY']) {
      await expectRefused(key);
      expect(await stamps(key)).toEqual({ coach_seen_at: null, coach_acked_at: null, coach_replied_at: null });
    }
  });

  it('a client who moves away: Hall-side words (private space, DM) refused, even a retry on a stamp; public-space words stay ackable', async () => {
    expect((await mark('mM', 'seen')).ack.state).toBe('seen'); // control, before the move
    expect((await mark('dM', 'seen')).ack.state).toBe('seen');
    const before = await stamps('mM');
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.B} WHERE "id" = ${id.M}`;
    await expectRefused('mM'); // 'seen' here is the idempotent retry: no timestamp comes back
    await expectRefused('dM');
    expect(await stamps('mM')).toEqual(before);
    expect((await mark('pM', 'acked')).ack.state).toBe('acked');
  });

  it('the row layer agrees: A reads exactly the messages the ack routes accept', async () => {
    const seen: string[] = [];
    for (const key of ['mO', 'pM', 'mX', 'mV', 'mY', 'mM']) seen.push(`${key} ${await reads('A', key)}`);
    expect(seen).toEqual(['mO 1', 'pM 1', 'mX 0', 'mV 0', 'mY 0', 'mM 0']);
  });

  it('stamped, then banned: the retry hands back no timestamps and the next step is refused; lifting the ban restores it', async () => {
    expect((await mark('mR', 'seen')).ack.state).toBe('seen');
    expect((await mark('mR', 'acked')).ack.state).toBe('acked');
    const before = await stamps('mR');
    await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws.A, user_id: id.R, banned_by_id: id.A } });
    await expectRefused('mR');
    expect(await stamps('mR')).toEqual(before);
    await prisma.communityWorkspaceBan.updateMany({ where: { workspace_id: ws.A, user_id: id.R }, data: { lifted_at: new Date() } });
    expect((await mark('mR', 'replied')).ack.state).toBe('replied');
  });

  it('a DM between two other people (O and R): every route 404s for the coach and the owner, nothing stamped', async () => {
    await expectRefused('dOR');
    await expectRefused('dOR', ROUTES, ownerW);
    expect(await stamps('dOR')).toEqual(NONE);
  });

  it('A\'s DM with D: DMs off for D, DMs off by default, D removed — each refused, even a retry; each control restores', async () => {
    expect((await mark('dD', 'seen')).ack.state).toBe('seen'); // control: the DM reader's rule passes
    const before = await stamps('dD');
    await memberD({ dm_enabled: false });
    await expectRefused('dD');
    await memberD({ dm_enabled: null });
    await prisma.communityWorkspace.update({ where: { id: ws.A }, data: { dm_enabled_default: false } });
    await expectRefused('dD');
    await prisma.communityWorkspace.update({ where: { id: ws.A }, data: { dm_enabled_default: true } });
    await memberD({ status: 'removed' });
    await expectRefused('dD');
    expect(await stamps('dD')).toEqual(before);
    await memberD({ status: 'active' });
    expect((await mark('dD', 'acked')).ack.state).toBe('acked');
  });

  it('post comments, challenge comments and the leaderboard sentinel are never acked: 404 for coach and owner', async () => {
    for (const key of ['cP', 'cC', 'cL']) {
      await expectRefused(key);
      await expectRefused(key, ROUTES, ownerW);
      expect(await stamps(key)).toEqual(NONE);
    }
  });

  it('the owner acks a plain space row and is refused on a DM they are not in', async () => {
    expect((await mark('wO', 'seen', ownerW)).ack.state).toBe('seen');
    await expectRefused('dD', ['replied'], ownerW);
  });

  it('bulk replied stamps (a coach text, a coach space voice note) skip every author the coach cannot read', async () => {
    const open = async () => Object.fromEntries(await Promise.all((['O', 'X', 'V', 'Y', 'M'] as const).map(async (k) => [k, await say(k)])));
    const replied = async (ids: Record<string, string>) => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, mid]) =>
      [k, (await prisma.communityMessage.findFirstOrThrow({ where: { id: mid } })).coach_replied_at !== null])));
    const hidden = { X: false, V: false, Y: false, M: false };
    const text = await open();
    await new CommunityMessagesRepository(db).markCohortClientMessagesReplied({ cohortId: space.S, repliedAt: new Date(), viewerId: id.A });
    expect(await replied(text)).toEqual({ O: true, ...hidden });
    const voice = await open();
    await new CommunityVoiceRepository(db).createVoiceNote({ workspaceId: ws.A, cohortId: space.S, conversationId: null, authorId: id.A,
      storageKey: `${id.A}/1700000000000-${randomUUID().replace(/-/g, '').slice(0, 16)}.m4a`, durationMs: 3000, bytes: 1000,
      mimeType: 'audio/mp4', waveformPeaks: null, parent: null, answersClients: true });
    expect(await replied(voice)).toEqual({ O: true, ...hidden });
    for (const key of ['mX', 'mV', 'mY']) expect(await stamps(key)).toEqual(NONE);
  });

  it('the refusals were the gate: once the blocks and the ban are gone, A acks X, V and Y', async () => {
    await prisma.userBlock.deleteMany({ where: { OR: [{ blocker_id: id.A, blocked_id: id.X }, { blocker_id: id.V, blocked_id: id.A }] } });
    await prisma.communityWorkspaceBan.updateMany({ where: { workspace_id: ws.A, user_id: id.Y }, data: { lifted_at: new Date() } });
    for (const key of ['mX', 'mV', 'mY']) expect((await mark(key, 'seen')).ack.state).toBe('seen');
  });
});
