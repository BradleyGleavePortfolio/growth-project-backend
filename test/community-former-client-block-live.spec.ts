/**
 * FIX-1251-FORMER-BLOCK (b#1251, LS-1251R1 C1; owner 203-D51 option 1, #203-E99 "former can block"), on Postgres:
 * coach K and a former client X keep their DM thread (203-D12, app.community_dm_former_client). X blocks K through
 * CommunitySafetyService.block (POST /community/blocks) and the block is written (a); K's next send is refused 403
 * community.dm.blocked_by_them with no row, no ping and no push, a held push is dropped, X is told it is her block,
 * and the thread is gone from both lists (b); X unblocks and the thread opens both ways, K's next send pushes once (c);
 * a current client A blocking K is still refused 403 community.block.workspace_coach with today's words (e).
 * Disposable postgres:15 from test/ls-1197-live-fixture.ts; the services run on the app's own connection.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { CommunityDmsService } from '../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';
import { heldPushDropReason } from '../src/notifications/push/held-push-source';

jest.setTimeout(600_000);

type Key = 'K' | 'L' | 'A' | 'X';
const PEOPLE: Key[] = ['K', 'L', 'A', 'X'];
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', A: 'student', X: 'student' };
const stub = <T>(v: unknown): T => v as T;

describe('FIX-1251-FORMER-BLOCK (live): a former client blocks the old coach; a current client still cannot', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let safety: CommunitySafetyService;
  let dms: CommunityDmsService;
  const pushes: Array<{ recipientId: string; deepLink?: string }> = [];
  const pings: unknown[] = [];
  const id = Object.fromEntries(PEOPLE.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const ws = randomUUID();
  const space = randomUUID();
  const u = (k: Key) => stub<User>({ id: id[k], role: ROLE[k] });
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const say = (from: Key, to: Key) =>
    su(`INSERT INTO "community_messages" ("id", "workspace_id", "scope", "dm_key", "recipient_user_id", "sender_id", "body", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'dm', $3, $4, $5, 'See you at the session', now())`, randomUUID(), ws, CommunityDmsRepository.dmKey(ws, id[from], id[to]), id[to], id[from]);
  /** '200', or the status and code the call is refused with. */
  const outcome = (q: Promise<unknown>) => q.then(() => '200', (e: unknown) => {
    if (!(e instanceof HttpException)) throw e;
    return `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
  });
  const others = async (k: Key) => (await dms.listThreads(u(k), ws, {})).threads.map((t) => t.other_user_id);
  const dmRows = () => prisma.communityMessage.count({ where: { workspace_id: ws, scope: 'dm' } });
  const blockRows = () => prisma.userBlock.count({ where: { blocker_id: id.X, blocked_id: id.K } });
  const BY_YOU = '403 community.dm.blocked_by_you';
  const BY_THEM = '403 community.dm.blocked_by_them';

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    for (const k of PEOPLE) {
      await su(`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'class user', $4::"Role", $5)`,
        id[k], randomUUID(), `fix1251fb-${id[k]}`, ROLE[k], ROLE[k] === 'student' ? id.K : null);
    }
    await su(`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'class workspace', $3, now())`, ws, id.K, `fix1251fb-${run}`);
    await su(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'class space', 'members'::"CommunitySpaceVisibility", now())`, space, ws);
    for (const k of ['A', 'X'] as const) {
      await su(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`, randomUUID(), ws, space, id[k]);
    }
    await say('X', 'K');
    await say('K', 'X');
    await say('A', 'K');
    // X moves to coach L and keeps an active row in K's community and the thread: the 203-D12 pair.
    await su(`UPDATE "User" SET "coach_id" = $1 WHERE "id" = $2`, id.L, id.X);
    const access = new CommunityAccessService(db.db);
    safety = new CommunitySafetyService(db.db);
    const realtime = {
      channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
      cohortShard: () => 0,
      broadcastCommunityEvent: async (...args: unknown[]) => {
        pings.push(args);
      },
    };
    const push = { pushEnabled: () => true, sendCommunityPush: async (q: { recipientId: string; deepLink?: string }) => {
      pushes.push(q);
    } };
    dms = new CommunityDmsService(access, new CommunityDmsRepository(db.db), stub(realtime), stub(push), safety);
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('control: the kept thread is open both ways and in both lists', async () => {
    expect({
      KX: await outcome(dms.openThread(u('K'), ws, id.X)), XK: await outcome(dms.openThread(u('X'), ws, id.K)),
      Klists: (await others('K')).includes(id.X), Xlists: await others('X'),
    }).toEqual({ KX: '200', XK: '200', Klists: true, Xlists: [id.K] });
  });

  it('a. X blocks K: { blocked_user_id: K, blocked: true }, one row', async () => {
    await expect(safety.block(u('X'), id.K)).resolves.toEqual({ blocked_user_id: id.K, blocked: true });
    await expect(safety.block(u('X'), id.K)).resolves.toEqual({ blocked_user_id: id.K, blocked: true });
    expect(await blockRows()).toBe(1);
  });

  it('b. after the block: K\'s send refused with no row, ping or push; a held push dropped; X told it is hers; gone from both lists', async () => {
    const [rows, sent, pinged] = [await dmRows(), pushes.length, pings.length];
    expect({
      KsendX: await outcome(dms.send(u('K'), ws, id.X, 'Glad it helps')),
      KopenX: await outcome(dms.openThread(u('K'), ws, id.X)),
      KreadX: await outcome(dms.listThread(u('K'), ws, id.X, {})),
      XopenK: await outcome(dms.openThread(u('X'), ws, id.K)),
      XsendK: await outcome(dms.send(u('X'), ws, id.K, 'Thanks')),
      XreadK: await outcome(dms.listThread(u('X'), ws, id.K, {})),
    }).toEqual({ KsendX: BY_THEM, KopenX: BY_THEM, KreadX: BY_THEM, XopenK: BY_YOU, XsendK: BY_YOU, XreadK: BY_YOU });
    expect([await dmRows(), pushes.length, pings.length]).toEqual([rows, sent, pinged]);
    const held = (to: Key, from: Key) => heldPushDropReason(db.db, id[to], { otherUserId: id[from], community: { workspaceId: ws } }, new Date());
    expect([await held('X', 'K'), await held('K', 'X')]).toEqual(['blocked', 'blocked']);
    expect({ Klists: (await others('K')).includes(id.X), Xlists: await others('X') }).toEqual({ Klists: false, Xlists: [] });
  });

  it('c. X unblocks: open both ways again, K\'s next send pushes once', async () => {
    await expect(safety.unblock(u('X'), id.K)).resolves.toEqual({ blocked_user_id: id.K, blocked: false });
    expect(await blockRows()).toBe(0);
    const sent = pushes.length;
    expect(await outcome(dms.send(u('K'), ws, id.X, 'Glad it helps'))).toBe('200');
    expect(pushes.slice(sent).map((q) => [q.recipientId, q.deepLink])).toEqual([[id.X, `tgp://community/dm/${id.K}?workspace=${ws}`]]);
    expect({ XsendK: await outcome(dms.send(u('X'), ws, id.K, 'Thanks')), Klists: (await others('K')).includes(id.X), Xlists: await others('X') })
      .toEqual({ XsendK: '200', Klists: true, Xlists: [id.K] });
  });

  it('e. A (K\'s current client) blocks K: 403 community.block.workspace_coach with today\'s words, no row', async () => {
    const e: unknown = await safety.block(u('A'), id.K).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect([(e as HttpException).getStatus(), (e as HttpException).getResponse()]).toEqual([403, {
      error: 'forbidden',
      code: 'community.block.workspace_coach',
      message: 'You cannot block your coach. You can report a message or post, or email the safety contact in Community safety.',
    }]);
    expect(await prisma.userBlock.count({ where: { blocker_id: id.A, blocked_id: id.K } })).toBe(0);
  });
});
