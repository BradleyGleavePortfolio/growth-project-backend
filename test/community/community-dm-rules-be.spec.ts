/**
 * COMMUNITY-DM-RULES-BE (agent 203; owner #203-E49: "DECISIONS #203-D11 – Op 1" and "DECISIONS #203-D12 – allow maya
 * to still message the client and the client to message them"; operator rulings R-a to R-i), the API half:
 *   D11  direct messages are on by default in every community (the stored default the schema and the migration give);
 *   D12  the workspace's coach K and a former client X (X's coach is no longer K) keep messaging in their existing DM
 *        thread while X is still in the community (an active row in a space that is not public, not archived and active,
 *        app.community_can_access but its roster test, no ban) and neither has blocked the other; nobody else opens.
 * Every DM path: open, send, read the thread, both lists (before the page cut), react and unreact, reaction counts, the
 * coach's acknowledgement, the DM push and its queued recheck. Every refusal keeps today's status and code.
 *
 * Built on the KT-2 fixture (test/community/access/member-content-fixture.ts) and the in-memory Prisma double, which
 * models app.community_dm_former_client as it models the other SQL rules (test/community/safety/in-memory-prisma.ts),
 * as test/community/coach-dm-access.spec.ts does, with the switches on ([R27]) and spies on the realtime ping and the
 * push. The double applies no column default, so D11-1's API half seeds the default prisma/schema.prisma and the
 * migrations give (read from those files); the live half runs on Postgres (test/community-dm-rules-be-rls.spec.ts).
 * World: coach K owns W with spaces S (members), P (public), C3 (clients, no rows) and Pk (package); coach L. A and B are
 * K's clients in S. X has a row in S and a thread with K, then X's coach becomes L; Y as X with no thread; Z as X with
 * its row removed; V as X and banned in W; U as X whose only row is in P; Q as X whose only row is in Pk (no purchase);
 * T has no row and a seeded thread. No sample message touches a sensitive topic; each change inside a case is undone in
 * a finally or is made on that case's own fresh world.
 */
import 'reflect-metadata';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { HttpException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { accessWorld, type AccessWorld } from './access/member-content-fixture';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityDmsService } from '../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../src/community/dms/community-dms.repository';
import { AckService } from '../../src/community/ack/ack.service';
import { AckRepository } from '../../src/community/ack/ack.repository';
import { CommunityReactionsService } from '../../src/community/reactions/community-reactions.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityDmEnabledGuard } from '../../src/community/community-write-flag.guard';
import { CLIENT_LINKS, SESSION_LINKS, pushStillCurrent } from '../../src/notifications/current-coach-inbox';
import { heldPushDropReason } from '../../src/notifications/push/held-push-source';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PrismaService } from '../../src/prisma.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { ExecutionContext } from '@nestjs/common';

const SWITCHES = ['FEATURE_COMMUNITY_DM', 'FEATURE_COMMUNITY_API', 'FEATURE_COMMUNITY_PUSH'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of SWITCHES) {
    saved[k] = process.env[k];
    process.env[k] = 'true';
  }
});
afterAll(() => {
  for (const k of SWITCHES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const stub = <T>(v: unknown): T => v as T;
const ROOT = join(__dirname, '..', '..');
const LIKE = '\u{1F44D}';

interface Push { recipientId: string; deepLink?: string; otherUserId?: string; workspaceId?: string; targetId: string }

type Key = 'K' | 'L' | 'A' | 'B' | 'X' | 'Y' | 'Z' | 'V' | 'U' | 'Q' | 'T';

interface World extends AccessWorld {
  access: CommunityAccessService;
  dmsvc: CommunityDmsService;
  ack: AckService;
  reactions: CommunityReactionsService;
  pushes: Push[];
  ws: { dm_enabled_default: boolean };
  p: Record<Key, User>;
  space: { S: string; P: string; C3: string; Pk: string };
  /** The messages of each thread with K: kx (X to K), xk (K to X), and so on for Y to T. */
  msg: Record<string, string>;
  user(role: string, name: string, coachId: string | null): User;
  row(u: User, cohortId: string, role?: string, status?: string): void;
  dm(from: User, to: User, body?: string): string;
}

async function world(): Promise<World> {
  const w = await accessWorld();
  // keyedWrite's advisory lock (message-idempotency.ts) is a no-op here, as in test/send-once.table.spec.ts.
  Object.assign(w.db, { $executeRaw: async () => 0 });
  const prisma = stub<PrismaService>(w.db);
  const access = new CommunityAccessService(prisma);
  const pushes: Push[] = [];
  const realtime = stub<CommunityRealtimeService>({
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async () => undefined,
  });
  const push = stub<CommunityNotificationsService>({
    pushEnabled: () => true,
    sendCommunityPush: async (p: Push) => {
      pushes.push(p);
    },
  });
  const dmsvc = new CommunityDmsService(access, new CommunityDmsRepository(prisma), realtime, push, w.safety);
  const ack = new AckService(new AckRepository(prisma), access, stub<AnalyticsService>({ capture: () => undefined }), w.safety);
  const reactions = new CommunityReactionsService(access, new CommunityReactionsRepository(prisma), new CommunityMessagesRepository(prisma),
    new CommunityPostsRepository(prisma), realtime, w.safety);
  const ws = w.db.table('communityWorkspace').find((r) => r.id === w.wsId) as unknown as { dm_enabled_default: boolean };
  const user = (role: string, name: string, coachId: string | null) =>
    stub<User>(w.db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  const row = (u: User, cohortId: string, role = 'student', status = 'active') => {
    w.db.seed('communityMembership', {
      workspace_id: w.wsId, cohort_id: cohortId, user_id: u.id, status, role, dm_enabled: null,
      removed_at: status === 'removed' ? new Date() : null,
    });
  };
  const dm = (from: User, to: User, body = 'See you at the session') =>
    w.db.seed('communityMessage', {
      workspace_id: w.wsId, scope: 'dm', kind: 'text', dm_key: CommunityDmsRepository.dmKey(w.wsId, from.id, to.id),
      sender_id: from.id, recipient_user_id: to.id, body, visibility: 'active',
    }).id as string;
  const cohort = (name: string, visibility: string) =>
    w.db.seed('communityCohort', { workspace_id: w.wsId, name, visibility, status: 'active', archived_at: null }).id as string;
  const space = { S: w.cohortId, P: cohort('Open room', 'public'), C3: cohort('Clients room', 'clients'), Pk: cohort('Plan room', 'package') };
  const L = w.db.table('user').find((u) => u.name === 'Coach Two') as unknown as User;
  const K = w.coach;
  const p = { K, L, A: w.viewer, B: w.control } as Record<Key, User>;
  const msg: Record<string, string> = {};
  // Each former client: a row where the case says, a thread with K where the case says, then their coach becomes L.
  const former: Array<[Key, string | null, boolean]> = [
    ['X', space.S, true], ['Y', space.S, false], ['Z', space.S, true], ['V', space.S, true],
    ['U', space.P, true], ['Q', space.Pk, true], ['T', null, true],
  ];
  for (const [k, where, thread] of former) {
    const u = user('student', `Former ${k}`, K.id);
    if (where) row(u, where);
    if (thread) {
      msg[`${k.toLowerCase()}k`] = dm(u, K, 'Thanks for the plan');
      msg[`k${k.toLowerCase()}`] = dm(K, u, 'Glad it helps');
    }
    p[k] = u;
  }
  const z = w.db.table('communityMembership').find((m) => m.user_id === p.Z.id) as { status: string; removed_at: Date | null };
  z.status = 'removed';
  z.removed_at = new Date();
  w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: p.V.id, lifted_at: null });
  for (const [k] of former) (p[k] as { coach_id: string | null }).coach_id = L.id;
  return { ...w, access, dmsvc, ack, reactions, pushes, ws, p, space, msg, user, row, dm };
}

/** The status and code a call is refused with. */
async function refusal(p: Promise<unknown>): Promise<[number, string | undefined]> {
  const e: unknown = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof HttpException)) throw new Error(`expected a refusal, got ${e === null ? 'success' : String(e)}`);
  return [e.getStatus(), (e.getResponse() as { code?: string }).code];
}
const NOT_FOUND: [number, string] = [404, 'community.dm.not_found'];
const DISABLED: [number, string] = [403, 'community.dm.disabled'];
const REACT_404: [number, string] = [404, 'community.reaction.target_not_found'];
const ACK_404: [number, string] = [404, 'community.ack.message_not_found'];

/** The other people of `u`'s DM list, or 'refused <status>' when the list itself is refused. */
async function listed(w: World, u: User, limit?: string): Promise<string[] | string> {
  try {
    return (await w.dmsvc.listThreads(u, w.wsId, limit ? { limit } : {})).threads.map((t) => t.other_user_id);
  } catch (e) {
    if (e instanceof HttpException) return `refused ${e.getStatus()}`;
    throw e;
  }
}

/** open, read and send by `a` to `b` each answer `want`. */
async function closedEveryWay(w: World, a: User, b: User, want: [number, string | undefined]): Promise<void> {
  expect(await refusal(w.dmsvc.openThread(a, w.wsId, b.id))).toEqual(want);
  expect(await refusal(w.dmsvc.listThread(a, w.wsId, b.id, {}))).toEqual(want);
  expect(await refusal(w.dmsvc.send(a, w.wsId, b.id, 'Checking in'))).toEqual(want);
}

/** open, read and send by `a` to `b` each answer 200; the send is stored once. */
async function openEveryWay(w: World, a: User, b: User): Promise<void> {
  const key = CommunityDmsRepository.dmKey(w.wsId, a.id, b.id);
  expect((await w.dmsvc.openThread(a, w.wsId, b.id)).thread.thread_id).toBe(key);
  expect((await w.dmsvc.listThread(a, w.wsId, b.id, {})).messages.length).toBeGreaterThan(0);
  const sent = await w.dmsvc.send(a, w.wsId, b.id, 'Checking in');
  expect(w.db.table('communityMessage').filter((m) => m.id === sent.message.id && m.dm_key === key)).toHaveLength(1);
}

/** The default prisma/schema.prisma gives community_workspaces.dm_enabled_default, and the newest migration that sets it. */
function storedDefaults(): { schema: boolean; migration: boolean } {
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const block = /model CommunityWorkspace \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
  const s = /dm_enabled_default\s+Boolean\s+@default\((true|false)\)/.exec(block)?.[1];
  const dir = join(ROOT, 'prisma', 'migrations');
  let m: string | undefined;
  for (const name of readdirSync(dir).filter((n) => /^\d{14}_/.test(n)).sort()) {
    let sql = '';
    try {
      sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8').replace(/^--.*$/gm, '');
    } catch {
      continue;
    }
    const set = [...sql.matchAll(/"dm_enabled_default"\s+(?:SET\s+DEFAULT|BOOLEAN\s+NOT\s+NULL\s+DEFAULT)\s+(true|false)/gi)];
    if (set.length) m = set[set.length - 1][1].toLowerCase();
  }
  return { schema: s === 'true', migration: m === 'true' };
}

describe('COMMUNITY-DM-RULES-BE D11: direct messages on by default (203-D11 op 1)', () => {
  it('D11-1 (API half). A new community with the stored default the schema and the migrations give: open, send, read and list 200 for K and A', async () => {
    const d = storedDefaults();
    expect(d).toEqual({ schema: true, migration: true });
    const w = await world();
    w.ws.dm_enabled_default = d.schema;
    w.dm(w.p.A, w.p.K, 'Thanks for the plan');
    await openEveryWay(w, w.p.K, w.p.A);
    await openEveryWay(w, w.p.A, w.p.K);
    expect(await listed(w, w.p.K)).toContain(w.p.A.id);
    expect(await listed(w, w.p.A)).toContain(w.p.K.id);
  });

  it('D11-2. Set false by hand: 403 community.dm.disabled on every route (the D12 pair too); A\'s own false: K\'s send 403; switch unset: 503', async () => {
    const w = await world();
    w.ws.dm_enabled_default = false;
    expect(await refusal(w.dmsvc.listThreads(w.p.K, w.wsId, {}))).toEqual(DISABLED);
    await closedEveryWay(w, w.p.K, w.p.A, DISABLED);
    await closedEveryWay(w, w.p.K, w.p.X, DISABLED);
    await closedEveryWay(w, w.p.X, w.p.K, DISABLED);
    w.ws.dm_enabled_default = true;
    const a = w.db.table('communityMembership').find((r) => r.user_id === w.p.A.id) as { dm_enabled: boolean | null };
    a.dm_enabled = false;
    expect(await refusal(w.dmsvc.send(w.p.K, w.wsId, w.p.A.id, 'Glad it helps'))).toEqual(DISABLED);
    delete process.env.FEATURE_COMMUNITY_DM;
    try {
      const ctx = stub<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ user: w.p.K }) }) });
      let status = 0;
      try {
        new CommunityDmEnabledGuard().canActivate(ctx);
      } catch (e) {
        status = e instanceof HttpException ? e.getStatus() : -1;
      }
      expect(status).toBe(503);
    } finally {
      process.env.FEATURE_COMMUNITY_DM = 'true';
    }
  });
});

describe('COMMUNITY-DM-RULES-BE D12: the coach and a former client keep their thread (203-D12)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('D12-1. K and X, every API path: open, send both ways, read both ways', async () => {
    await openEveryWay(w, w.p.K, w.p.X);
    await openEveryWay(w, w.p.X, w.p.K);
    const ids = (await w.dmsvc.listThread(w.p.K, w.wsId, w.p.X.id, {})).messages.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([w.msg.xk, w.msg.kx]));
  });

  it('D12-1 (lists). X\'s list holds only the K thread; K\'s list keeps X before the page cut (limit=2, two newer threads off the rule)', async () => {
    const dXA = w.dm(w.p.X, w.p.A, 'See you at the session');
    expect(dXA).toBeTruthy();
    expect(await listed(w, w.p.X)).toEqual([w.p.K.id]);
    const own = w.dm(w.p.A, w.p.K, 'Thanks for the plan');
    expect(own).toBeTruthy();
    w.dm(w.p.X, w.p.K, 'One more thing');
    const coCoach = w.user('coach', 'Co Coach', null);
    w.row(coCoach, w.space.S, 'coach');
    w.dm(coCoach, w.p.K, 'Quick question');
    w.dm(w.p.Y, w.p.K, 'Quick question');
    expect(await listed(w, w.p.K, '2')).toEqual([w.p.X.id, w.p.A.id]);
  });

  it('D12-1 (react, counts, ack). Each reacts on the other\'s message and unreacts; both counts; K acknowledges X\'s message', async () => {
    const byK = await w.reactions.react(w.p.K, 'message', w.msg.xk, LIKE);
    expect(byK.reactions.map((r) => r.count)).toEqual([1]);
    const byX = await w.reactions.react(w.p.X, 'message', w.msg.xk, LIKE);
    expect(byX.reactions.map((r) => r.count)).toEqual([2]);
    expect((await w.reactions.react(w.p.X, 'message', w.msg.kx, LIKE)).reactions.map((r) => r.count)).toEqual([1]);
    expect((await w.reactions.unreact(w.p.K, 'message', w.msg.xk, LIKE)).reactions.map((r) => r.count)).toEqual([1]);
    expect((await w.reactions.unreact(w.p.X, 'message', w.msg.kx, LIKE)).reactions).toEqual([]);
    expect((await w.ack.applyTransition(w.p.K, w.msg.xk, 'acked')).ack.state).toBe('acked');
  });

  it.each(['Y', 'Z', 'V', 'U', 'Q', 'T'] as const)('D12-3. %s (no thread, removed, banned, public only, lapsed package, no row): closed on every path', async (k) => {
    const them = w.p[k];
    await closedEveryWay(w, w.p.K, them, NOT_FOUND);
    await closedEveryWay(w, them, w.p.K, NOT_FOUND);
    expect(await listed(w, w.p.K)).not.toContain(them.id);
    expect(await listed(w, them)).toBe('refused 404');
    const theirs = w.msg[`${k.toLowerCase()}k`];
    if (theirs) {
      expect(await refusal(w.reactions.react(w.p.K, 'message', theirs, LIKE))).toEqual(REACT_404);
      expect(await refusal(w.reactions.react(them, 'message', w.msg[`k${k.toLowerCase()}`], LIKE))).toEqual(REACT_404);
      expect(await refusal(w.ack.applyTransition(w.p.K, theirs, 'acked'))).toEqual(ACK_404);
    }
  });

  it('D12-3 (ban lifted). V with the ban lifted: open again', async () => {
    const ban = w.db.table('communityWorkspaceBan').find((b) => b.user_id === w.p.V.id) as { lifted_at: Date | null };
    ban.lifted_at = new Date();
    await openEveryWay(w, w.p.K, w.p.V);
    await openEveryWay(w, w.p.V, w.p.K);
  });

  it.each([
    ['K blocked X', true],
    ['X blocked K', false],
  ])('D12-4. %s: 403 blocked_by_you / blocked_by_them, dropped from both lists, react 404; lifted, open again', async (_l, kBlocks) => {
    const [blocker, blocked] = kBlocks ? [w.p.K, w.p.X] : [w.p.X, w.p.K];
    const block = w.db.seed('userBlock', { blocker_id: blocker.id, blocked_id: blocked.id });
    try {
      const kGets = kBlocks ? 'community.dm.blocked_by_you' : 'community.dm.blocked_by_them';
      const xGets = kBlocks ? 'community.dm.blocked_by_them' : 'community.dm.blocked_by_you';
      expect(await refusal(w.dmsvc.openThread(w.p.K, w.wsId, w.p.X.id))).toEqual([403, kGets]);
      expect(await refusal(w.dmsvc.send(w.p.K, w.wsId, w.p.X.id, 'Checking in'))).toEqual([403, kGets]);
      expect(await refusal(w.dmsvc.openThread(w.p.X, w.wsId, w.p.K.id))).toEqual([403, xGets]);
      expect(await refusal(w.dmsvc.send(w.p.X, w.wsId, w.p.K.id, 'Checking in'))).toEqual([403, xGets]);
      expect(await listed(w, w.p.K)).not.toContain(w.p.X.id);
      const xList = await listed(w, w.p.X);
      expect(Array.isArray(xList) ? xList : []).not.toContain(w.p.K.id);
      expect(await refusal(w.reactions.react(w.p.K, 'message', w.msg.xk, LIKE))).toEqual(REACT_404);
      expect(await refusal(w.reactions.react(w.p.X, 'message', w.msg.kx, LIKE))).toEqual(REACT_404);
    } finally {
      w.db.tables.userBlock = w.db.table('userBlock').filter((b) => b !== block);
    }
    await openEveryWay(w, w.p.K, w.p.X);
    expect(await listed(w, w.p.K)).toContain(w.p.X.id);
  });

  it('D12-5. X back on K\'s roster: today\'s arm, one thread listed once; X\'s own dm_enabled false: 403 both ways', async () => {
    (w.p.X as { coach_id: string | null }).coach_id = w.p.K.id;
    await openEveryWay(w, w.p.K, w.p.X);
    expect((await listed(w, w.p.K) as string[]).filter((id) => id === w.p.X.id)).toHaveLength(1);
    (w.p.X as { coach_id: string | null }).coach_id = w.p.L.id;
    const x = w.db.table('communityMembership').find((r) => r.user_id === w.p.X.id) as { dm_enabled: boolean | null };
    x.dm_enabled = false;
    expect(await refusal(w.dmsvc.send(w.p.K, w.wsId, w.p.X.id, 'Glad it helps'))).toEqual(DISABLED);
    expect(await refusal(w.dmsvc.send(w.p.X, w.wsId, w.p.K.id, 'Thanks'))).toEqual(DISABLED);
    expect(await refusal(w.dmsvc.listThreads(w.p.X, w.wsId, {}))).toEqual(DISABLED);
    expect(w.pushes).toHaveLength(0);
  });

  it('D12-5 (several rows). X with a second active row whose own dm_enabled is false: off for X wherever that row is', async () => {
    const other = w.db.seed('communityCohort', { workspace_id: w.wsId, name: 'Second room', visibility: 'members', status: 'active', archived_at: null });
    w.db.seed('communityMembership', { workspace_id: w.wsId, cohort_id: other.id, user_id: w.p.X.id, status: 'active', role: 'student', dm_enabled: false });
    expect(await refusal(w.dmsvc.send(w.p.K, w.wsId, w.p.X.id, 'Glad it helps'))).toEqual(DISABLED);
  });

  it('D12-6. Nothing else opens: K reads none of X\'s space or Hall rows; L, A and B, a co-coach, the owner and a sub-coach as today', async () => {
    const inS = w.db.seed('communityMessage', {
      workspace_id: w.wsId, cohort_id: w.space.S, scope: 'cohort', kind: 'text', sender_id: w.p.X.id, body: 'Week one done', visibility: 'active',
    }).id as string;
    const hall = w.db.seed('communityPost', {
      workspace_id: w.wsId, cohort_id: null, author_id: w.p.X.id, scope: 'hall', title: 'Hello', body: 'Week one done',
    }).id as string;
    const msgs = (await w.messages.list(w.p.K, w.space.S, {})).messages.map((m: { id: string }) => m.id);
    expect(msgs).not.toContain(inS);
    expect(await refusal(w.messages.getOne(w.p.K, inS))).toEqual([404, expect.any(String)]);
    const posts = stub<{ posts: Array<{ id: string }> }>(await w.posts.list(w.p.K, w.wsId, {})).posts.map((x) => x.id);
    expect(posts).not.toContain(hall);
    // L (X's new coach) in W, and K to X in another community: 404
    await closedEveryWay(w, w.p.L, w.p.X, NOT_FOUND);
    await closedEveryWay(w, w.p.X, w.p.L, NOT_FOUND);
    // two clients: dAB closes when B's coach changes (R-h)
    w.dm(w.p.A, w.p.B, 'See you at the session');
    await openEveryWay(w, w.p.A, w.p.B);
    (w.p.B as { coach_id: string | null }).coach_id = w.p.L.id;
    try {
      await closedEveryWay(w, w.p.A, w.p.B, NOT_FOUND);
      await closedEveryWay(w, w.p.B, w.p.A, NOT_FOUND);
    } finally {
      (w.p.B as { coach_id: string | null }).coach_id = w.p.K.id;
    }
    // a co-coach row, an assistant row (another coach), the platform owner and a sub-coach, each with a thread: 404
    const coCoach = w.user('coach', 'Co Coach', null);
    w.row(coCoach, w.space.S, 'coach');
    const assistant = w.user('coach', 'Helper Coach', null);
    w.row(assistant, w.space.S, 'assistant');
    const owner = w.user('owner', 'Platform Owner', null);
    const subCoach = w.user('sub_coach', 'Sub Coach', w.p.K.id);
    for (const q of [coCoach, assistant, owner, subCoach]) {
      w.dm(q, w.p.K, 'Quick question');
      w.dm(w.p.K, q, 'Quick answer');
      await closedEveryWay(w, w.p.K, q, NOT_FOUND);
      await closedEveryWay(w, q, w.p.K, NOT_FOUND);
      expect(await listed(w, w.p.K)).not.toContain(q.id);
    }
    expect(await listed(w, owner)).toBe('refused 404');
    expect(await listed(w, w.p.L)).toBe('refused 404');
  });

  it('D12-7. Push: each way a COMMUNITY_DM_RECEIVED push with tgp://community/dm/<sender>; a held one stops on a block or a ban; the coach inbox keeps the link', async () => {
    await w.dmsvc.send(w.p.K, w.wsId, w.p.X.id, 'Glad it helps');
    await w.dmsvc.send(w.p.X, w.wsId, w.p.K.id, 'Thanks for the plan');
    expect(w.pushes.map((q) => [q.recipientId, q.deepLink, q.otherUserId, q.workspaceId])).toEqual([
      [w.p.X.id, `tgp://community/dm/${w.p.K.id}`, w.p.K.id, w.wsId],
      [w.p.K.id, `tgp://community/dm/${w.p.X.id}`, w.p.X.id, w.wsId],
    ]);
    const db = stub<PrismaService>(w.db);
    const held = (to: User, from: User) => heldPushDropReason(db, to.id, { otherUserId: from.id, community: { workspaceId: w.wsId } }, new Date());
    expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual([null, null]);
    const block = w.db.seed('userBlock', { blocker_id: w.p.X.id, blocked_id: w.p.K.id });
    expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual(['blocked', 'blocked']);
    w.db.tables.userBlock = w.db.table('userBlock').filter((b) => b !== block);
    const ban = w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: w.p.X.id, lifted_at: null });
    expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual(['banned', 'banned']);
    w.db.tables.communityWorkspaceBan = w.db.table('communityWorkspaceBan').filter((b) => b !== ban);
    // The coach's inbox and queued-push rule (owner 137-8): a community DM link names no client, so it stays.
    const link = `tgp://community/dm/${w.p.X.id}`;
    expect([...CLIENT_LINKS, ...SESSION_LINKS].some((p) => link.startsWith(p))).toBe(false);
    expect(await pushStillCurrent(db, w.p.K.id, { deepLink: link })).toBe(true);
  });
});

/**
 * F2 (the double's half): app.community_dm_former_client answered by the double over the same pairs and states the live
 * spec asks the SQL function (test/community-dm-rules-be-rls.spec.ts, PAIRS there: the same table).
 */
const PAIRS: Array<[string, Key, Key, boolean]> = [
  ['K and X (a former client with a row and a thread)', 'K', 'X', true],
  ['X and K (the coach must come first)', 'X', 'K', false],
  ['K and Y (no thread)', 'K', 'Y', false],
  ['K and Z (row removed)', 'K', 'Z', false],
  ['K and V (banned)', 'K', 'V', false],
  ['K and U (only a public row)', 'K', 'U', false],
  ['K and Q (only a lapsed package row)', 'K', 'Q', false],
  ['K and T (no row)', 'K', 'T', false],
  ['K and A (a current client: today\'s arm, not this one)', 'K', 'A', false],
  ['L and X (X\'s new coach does not run W)', 'L', 'X', false],
  ['A and B (two clients)', 'A', 'B', false],
  ['K and K', 'K', 'K', false],
];

/** CommunityAccessService.formerClientsIn, the API's one ask of app.community_dm_former_client; missing before the fix. */
type FormerClientsIn = (workspaceId: string, pairs: ReadonlyArray<readonly [string, string]>) => Promise<Set<string>>;
function formerClientsIn(w: World, pairs: ReadonlyArray<readonly [string, string]>): Promise<Set<string>> {
  const fn = stub<{ formerClientsIn?: FormerClientsIn }>(w.access).formerClientsIn;
  if (!fn) throw new Error('CommunityAccessService.formerClientsIn is missing');
  return fn.call(w.access, w.wsId, pairs);
}

describe('COMMUNITY-DM-RULES-BE F2 (double): the pair table', () => {
  it('the double answers every pair as the SQL function does', async () => {
    const w = await world();
    const got: Record<string, boolean> = {};
    for (const [label, c, k] of PAIRS) {
      got[label] = (await formerClientsIn(w, [[w.p[c].id, w.p[k].id]])).has(w.p[k].id);
    }
    expect(got).toEqual(Object.fromEntries(PAIRS.map(([label, , , want]) => [label, want])));
  });
});
