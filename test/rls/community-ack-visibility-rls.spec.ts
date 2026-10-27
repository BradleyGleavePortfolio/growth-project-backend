// ACK-VISIBILITY-GUARD (LS-1134D on b#1134): the three ack writes (POST /community/ack/:messageId/seen | acked |
// replied) pass the same visibility gate the coach's read of that message passes
// (CommunitySafetyService.assertVisibleTo with the row's place, as CommunityMessagesService.getOne calls it).
// Live, on the replayed migration chain, through the real AckService, AckRepository, CommunityAccessService and
// CommunitySafetyService. A and B coach. In A's clients space S: O (stays), X (A blocked X), V (V blocked A), Y
// (banned from A's community), M (moves to B), R (stamped, then banned, then the ban is lifted). In A's public
// space P: M. M also has a DM with A. A hidden message answers the same 404 as an absent one and nothing is
// stamped; each refusal follows its control (a 200 before, or a 200 once the block or ban is gone).
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { AckRepository } from '../../src/community/ack/ack.repository';
import { type AckActor, AckService } from '../../src/community/ack/ack.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-ack-visibility-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'O' | 'X' | 'V' | 'Y' | 'M' | 'R';
const PEOPLE: Key[] = ['A', 'B', 'O', 'X', 'V', 'Y', 'M', 'R']; // coaches first: clients reference them
const CLIENTS: Key[] = ['O', 'X', 'V', 'Y', 'M', 'R'];
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');
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
  const mark = (key: string, to: Route) => ack.applyTransition(coachA, row[key], to);
  const refusal = (messageId: string, to: Route) =>
    ack.applyTransition(coachA, messageId, to).then(() => 'stamped', (e) => e);
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
  const expectRefused = async (key: string, routes: readonly Route[] = ROUTES) => {
    const seen: string[] = [];
    for (const to of routes) {
      const e = await refusal(row[key], to);
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
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`ack-visibility-${run}-${c}`}, now())`;
    }
    for (const [s, visibility] of [['S', 'clients'], ['P', 'public']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3, $4::"CommunitySpaceVisibility", 'active', now())`, space[s], ws.A, `RLS space ${s}`, visibility);
    }
    for (const [k, s] of [...CLIENTS.map((k) => [k, 'S'] as const), ['M', 'P'] as const]) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws.A, space[s], id[k]);
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
    row.dM = (await prisma.communityMessage.create({ data: { workspace_id: ws.A, scope: 'dm', dm_key: `ack-visibility-${run}`,
      recipient_user_id: id.A, sender_id: id.M, body: 'DM from M' } })).id;
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

  it('the refusals were the gate: once the blocks and the ban are gone, A acks X, V and Y', async () => {
    await prisma.userBlock.deleteMany({ where: { OR: [{ blocker_id: id.A, blocked_id: id.X }, { blocker_id: id.V, blocked_id: id.A }] } });
    await prisma.communityWorkspaceBan.updateMany({ where: { workspace_id: ws.A, user_id: id.Y }, data: { lifted_at: new Date() } });
    for (const key of ['mX', 'mV', 'mY']) expect((await mark(key, 'seen')).ack.state).toBe('seen');
  });
});
