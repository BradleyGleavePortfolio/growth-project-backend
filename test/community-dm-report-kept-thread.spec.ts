/**
 * FIX-1251R1 (b#1251, LS-1251R1 B1): the report of a DM message, one table for the class. Coach K and a former client X
 * keep their thread (203-D12, app.community_dm_former_client); each reports the other's message there, as K and a
 * current client A do, and the report reaches K's queue. Nobody else gets in: a third person, a pair with no row, a
 * banned former client, another pair's thread. A block leaves the report open for both pairs (it is the safety control
 * a block sits beside; at 7f566a59 a current pair reports through a block too).
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts; the services run on the app's own connection.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';
import { CommunityMessagesRepository } from '../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../src/community/posts/community-posts.repository';
import { CommunityModerationService } from '../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../src/community/moderation/community-moderation.repository';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'A' | 'B' | 'X' | 'T' | 'Z';
const PEOPLE: Key[] = ['K', 'L', 'A', 'B', 'X', 'T', 'Z'];
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', B: 'student', X: 'student', T: 'student', Z: 'student' };
// d<from><to>: the DM `from` wrote to `to`.
const MESSAGES = ['dXK', 'dKX', 'dAK', 'dKA', 'dTK', 'dKT', 'dZK', 'dKZ', 'dAB'] as const;
type Msg = (typeof MESSAGES)[number];
const stub = <T>(v: unknown): T => v as T;

describe('FIX-1251R1: a report of a DM message, the kept thread and today\'s pairs', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let moderation: CommunityModerationService;
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const msg = Object.fromEntries(MESSAGES.map((m) => [m, randomUUID()])) as Record<Msg, string>;
  const run = randomUUID().slice(0, 8);
  const ws = randomUUID();
  const space = randomUUID();
  const u = (k: Key) => stub<User>({ id: id[k], role: ROLE[k] });
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const say = (m: Msg) => {
    const from = m[1] as Key;
    const to = m[2] as Key;
    return su(`INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'See you at the session', now())`, msg[m], ws, CommunityDmsRepository.dmKey(ws, id[from], id[to]), id[to], id[from]);
  };
  /** '200', or the status and code the call is refused with. */
  const outcome = (q: Promise<unknown>) => q.then(() => '200', (e: unknown) => {
    if (!(e instanceof HttpException)) throw e;
    return `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
  });
  const report = (who: Key, m: Msg) => outcome(moderation.report(u(who), 'message', msg[m], 'spam', undefined));
  const NF = '404 community.moderation.not_found';

  // [reporter, message, without a block, with the reporter blocking the author]
  const TABLE: Array<[Key, Msg, string, string]> = [
    ['K', 'dXK', '200', '200'], // 203-D12: the coach reports the former client's message in their kept thread (B1)
    ['X', 'dKX', '200', '200'], // 203-D12: the former client reports the coach's (B1)
    ['K', 'dAK', '200', '200'], // today: the coach and a current client
    ['A', 'dKA', '200', '200'], // today
    ['K', 'dTK', NF, NF], // a former client with no row in K's community: the thread is closed
    ['T', 'dKT', NF, NF],
    ['K', 'dZK', NF, NF], // a former client banned from K's community
    ['Z', 'dKZ', NF, NF],
    ['L', 'dXK', NF, NF], // a third person, another coach
    ['A', 'dXK', NF, NF], // a third person, a current client
    ['X', 'dAB', NF, NF], // another pair's thread, by the former client
    ['K', 'dAB', NF, NF], // another pair's thread, by the coach (today: participants only)
  ];

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of PEOPLE) {
      await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', $4::"Role", $5)`,
        id[k], randomUUID(), `fix1251r1-${id[k]}`, ROLE[k], ROLE[k] === 'student' ? id.K : null);
    }
    await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'class workspace', $3, now())`, ws, id.K, `fix1251r1-${run}`);
    await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'class space', 'members'::"CommunitySpaceVisibility", now())`, space, ws);
    for (const k of ['A', 'B', 'X', 'Z'] as const) {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`, randomUUID(), ws, space, id[k]);
    }
    for (const m of MESSAGES) await say(m);
    // X, T and Z move to coach L. X and Z keep an active row in K's community; T holds none; Z is then banned there.
    for (const k of ['X', 'T', 'Z'] as const) await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id[k]);
    await su(`INSERT INTO "community_workspace_bans" ("id", "workspace_id", "user_id", "banned_by_id") VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), ws, id.Z, id.K);
    const quiet = { channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined };
    const push = { pushEnabled: () => true, sendCommunityPush: async () => undefined };
    moderation = new CommunityModerationService(new CommunityAccessService(db.db), new CommunityModerationRepository(db.db), new CommunityMessagesRepository(db.db),
      new CommunityPostsRepository(db.db), stub(quiet), stub(push), db.db, stub({}));
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('each reporter and message answers as the table says, without a block', async () => {
    const got: string[] = [];
    for (const [who, m] of TABLE) got.push(`${who} on ${m}: ${await report(who, m)}`);
    expect(got).toEqual(TABLE.map(([who, m, want]) => `${who} on ${m}: ${want}`));
  });

  it('the kept thread\'s reports reach the coach\'s queue', async () => {
    const queue = await moderation.listQueue(u('K'), ws, {});
    const targets = queue.items.map((i) => i.target_id);
    expect({ KonX: targets.includes(msg.dXK), XonK: targets.includes(msg.dKX), third: targets.filter((t) => t === msg.dAB).length })
      .toEqual({ KonX: true, XonK: true, third: 0 });
  });

  it('with the reporter blocking the author, each answers as the table says (a block never closes the report)', async () => {
    for (const [who, m] of TABLE) {
      const author = m[1] as Key;
      if (author !== who) await prisma.userBlock.upsert({ where: { UserBlock_pair_key: { blocker_id: id[who], blocked_id: id[author] } }, create: { blocker_id: id[who], blocked_id: id[author] }, update: {} });
    }
    const got: string[] = [];
    for (const [who, m] of TABLE) got.push(`${who} on ${m}: ${await report(who, m)}`);
    expect(got).toEqual(TABLE.map(([who, m, , want]) => `${who} on ${m}: ${want}`));
  });
});
