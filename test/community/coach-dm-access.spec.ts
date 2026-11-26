/**
 * COACH-DM-BE (agent 203): the workspace coach and their own current client in community direct messages.
 *
 * The DM rule (assertDmOpen, src/community/dms/community-dms.service.ts) opened a pair only when both people hold an
 * open community membership, and no writer gives the workspace coach one, so the coach got 404 on every DM route and a
 * client's DM to their own coach was refused too. Cases 1 to 17 of the job: the coach with a roster client is let in
 * (list, open, read, send, ack, react), nobody else is (another coach's student, a co-coach or assistant row, another
 * coach passing this community's id, a moved, banned or removed client, a block either way, DMs off, the platform
 * owner role, a sub-coach, self), and the list is filtered before its page is cut.
 *
 * Built on the KT-2 fixture (test/community/access/member-content-fixture.ts) and the in-memory Prisma double it
 * reuses (test/community/safety/in-memory-prisma.ts, which models app.community_can_access), with the switches on
 * ([R27]) and spies on the realtime ping and the push (the fixture's own stubs drop both). No sample message touches
 * a sensitive topic.
 */
import 'reflect-metadata';
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
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PrismaService } from '../../src/prisma.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { ExecutionContext } from '@nestjs/common';
import { incomingLinkPath, resolveAppLink } from '../utils/phone-link-routes';

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

interface Ping { people: string[]; payload: Record<string, unknown> }
interface Push { recipientId: string; deepLink?: string; otherUserId?: string; targetId: string }

interface World extends AccessWorld {
  dms: CommunityDmsService;
  ack: AckService;
  reactions: CommunityReactionsService;
  pings: Ping[];
  pushes: Push[];
  ws: { dm_enabled_default: boolean };
  otherCoach: User;
  user(role: string, name: string, coachId: string | null): User;
  row(user: User, role: string, status?: string): void;
  dm(from: User, to: User, body?: string): string;
}

async function world(): Promise<World> {
  const w = await accessWorld();
  // keyedWrite's advisory lock (message-idempotency.ts) is a no-op here, as in test/send-once.table.spec.ts.
  Object.assign(w.db, { $executeRaw: async () => 0 });
  const prisma = stub<PrismaService>(w.db);
  const access = new CommunityAccessService(prisma);
  const pings: Ping[] = [];
  const pushes: Push[] = [];
  const realtime = stub<CommunityRealtimeService>({
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async (audience: { people?: string[] }, _event: string, payload: Record<string, unknown>) => {
      pings.push({ people: audience.people ?? [], payload });
    },
  });
  const push = stub<CommunityNotificationsService>({
    pushEnabled: () => true,
    sendCommunityPush: async (p: Push) => {
      pushes.push(p);
    },
  });
  const dms = new CommunityDmsService(access, new CommunityDmsRepository(prisma), realtime, push, w.safety);
  const ack = new AckService(new AckRepository(prisma), access, stub<AnalyticsService>({ capture: () => undefined }), w.safety);
  const reactions = new CommunityReactionsService(access, new CommunityReactionsRepository(prisma), new CommunityMessagesRepository(prisma),
    new CommunityPostsRepository(prisma), realtime, w.safety);
  const ws = w.db.table('communityWorkspace').find((r) => r.id === w.wsId) as unknown as { dm_enabled_default: boolean };
  const user = (role: string, name: string, coachId: string | null) =>
    stub<User>(w.db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  const otherCoach = w.db.table('user').find((u) => u.name === 'Coach Two') as unknown as User;
  const row = (u: User, role: string, status = 'active') => {
    w.db.seed('communityMembership', {
      workspace_id: w.wsId, cohort_id: w.cohortId, user_id: u.id, status, role, dm_enabled: null,
      removed_at: status === 'removed' ? new Date() : null,
    });
  };
  const dm = (from: User, to: User, body = 'See you at the session') =>
    w.db.seed('communityMessage', {
      workspace_id: w.wsId, scope: 'dm', kind: 'text', dm_key: CommunityDmsRepository.dmKey(w.wsId, from.id, to.id),
      sender_id: from.id, recipient_user_id: to.id, body, visibility: 'active',
    }).id as string;
  return { ...w, dms, ack, reactions, pings, pushes, ws, otherCoach, user, row, dm };
}

/** The status and code a DM call is refused with. */
async function refusal(p: Promise<unknown>): Promise<[number, string | undefined]> {
  const e: unknown = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof HttpException)) throw new Error(`expected a refusal, got ${e === null ? 'success' : String(e)}`);
  return [e.getStatus(), (e.getResponse() as { code?: string }).code];
}
const NOT_FOUND: [number, string] = [404, 'community.dm.not_found'];

/** The other people of `u`'s DM list: none when the list itself answers 404 (base behaviour for the coach). */
async function listed(w: World, u: User, limit?: string): Promise<string[]> {
  try {
    return (await w.dms.listThreads(u, w.wsId, limit ? { limit } : {})).threads.map((t) => t.other_user_id);
  } catch (e) {
    if (e instanceof HttpException && e.getStatus() === 404) return [];
    throw e;
  }
}

/** open, read and send by `a` to `b` each answer `want`. */
async function closedEveryWay(w: World, a: User, b: User, want: [number, string | undefined]): Promise<void> {
  expect(await refusal(w.dms.openThread(a, w.wsId, b.id))).toEqual(want);
  expect(await refusal(w.dms.listThread(a, w.wsId, b.id, {}))).toEqual(want);
  expect(await refusal(w.dms.send(a, w.wsId, b.id, 'Checking in'))).toEqual(want);
}

describe('COACH-DM-BE part 1: the workspace coach and their own client in community DMs', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('1. the coach lists DMs with a roster client who holds an open row: one thread with that client', async () => {
    w.dm(w.viewer, w.coach, 'Thanks for the plan');
    const res = await w.dms.listThreads(w.coach, w.wsId, {});
    expect(res.threads).toHaveLength(1);
    expect(res.threads[0].other_user_id).toBe(w.viewer.id);
    expect(res.threads[0].last_message_at).not.toBeNull();
  });

  it('2. the coach opens the thread and reads its messages, both directions', async () => {
    const fromClient = w.dm(w.viewer, w.coach, 'Thanks for the plan');
    const fromCoach = w.dm(w.coach, w.viewer, 'Glad it helps');
    const open = await w.dms.openThread(w.coach, w.wsId, w.viewer.id);
    expect(open.thread.other_user_id).toBe(w.viewer.id);
    expect(open.thread.thread_id).toBe(CommunityDmsRepository.dmKey(w.wsId, w.coach.id, w.viewer.id));
    for (const [reader, other] of [[w.coach, w.viewer], [w.viewer, w.coach]] as const) {
      const ids = (await w.dms.listThread(reader, w.wsId, other.id, {})).messages.map((m) => m.id);
      expect(ids.sort()).toEqual([fromClient, fromCoach].sort());
    }
  });

  it('3. the coach sends to that client: stored once, a realtime ping to the client only, a push to the client', async () => {
    const res = await w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps');
    const key = CommunityDmsRepository.dmKey(w.wsId, w.coach.id, w.viewer.id);
    expect(w.db.table('communityMessage').filter((m) => m.dm_key === key)).toHaveLength(1);
    expect(res.message.recipient_user_id).toBe(w.viewer.id);
    expect(w.pings.map((p) => p.people)).toEqual([[w.viewer.id]]);
    expect(w.pushes.map((p) => p.recipientId)).toEqual([w.viewer.id]);
  });

  it('4. the client sends to their own coach: stored, and a push to the coach', async () => {
    const res = await w.dms.send(w.viewer, w.wsId, w.coach.id, 'Thanks for the plan');
    expect(w.db.table('communityMessage').filter((m) => m.id === res.message.id)).toHaveLength(1);
    expect(w.pings.map((p) => p.people)).toEqual([[w.coach.id]]);
    expect(w.pushes.map((p) => p.recipientId)).toEqual([w.coach.id]);
  });

  it('5. the coach acknowledges and reacts to the client\'s DM to them', async () => {
    const id = w.dm(w.viewer, w.coach, 'Thanks for the plan');
    expect((await w.ack.applyTransition(w.coach, id, 'acked')).ack.state).toBe('acked');
    const state = await w.reactions.react(w.coach, 'message', id, '\u{1F44D}');
    expect(state.target_id).toBe(id);
    expect(w.db.table('communityResponse').filter((r) => r.target_id === id && r.user_id === w.coach.id)).toHaveLength(1);
  });

  it('7. a keyed resend by the coach answers the first row, with no second ping or push (SEND-ONCE)', async () => {
    const first = await w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps', 'coach-key-1');
    const again = await w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps', 'coach-key-1');
    expect(again.message.id).toBe(first.message.id);
    const key = CommunityDmsRepository.dmKey(w.wsId, w.coach.id, w.viewer.id);
    expect(w.db.table('communityMessage').filter((m) => m.dm_key === key)).toHaveLength(1);
    expect(w.pings).toHaveLength(1);
    expect(w.pushes).toHaveLength(1);
  });

  it('8. a DM between two clients of the coach: not in the coach\'s list, not in the coach\'s thread reads, no ack or reaction', async () => {
    const between = w.dm(w.viewer, w.control, 'See you at the session');
    const own = w.dm(w.viewer, w.coach, 'Thanks for the plan');
    expect(await listed(w, w.coach)).not.toContain(w.control.id);
    for (const client of [w.viewer, w.control]) {
      const ids = (await w.dms.listThread(w.coach, w.wsId, client.id, {})).messages.map((m) => m.id);
      expect(ids).not.toContain(between);
      expect(ids).toEqual(client === w.viewer ? [own] : []);
    }
    expect(await refusal(w.ack.applyTransition(w.coach, between, 'acked'))).toEqual([404, 'community.ack.message_not_found']);
    expect(await refusal(w.reactions.react(w.coach, 'message', between, '\u{1F44D}'))).toEqual([404, 'community.reaction.target_not_found']);
  });

  // #203-E49 (203-D12, COMMUNITY-DM-RULES-BE): another coach's student who holds an active row here and a DM thread
  // with this coach is, by operator ruling R-a, a former client who keeps that thread; the co-coach and assistant rows
  // stay as before.
  it('9. a co-coach row and an assistant row: never listed, 404 both ways; another coach\'s student with a row here and a thread keeps it', async () => {
    const theirStudent = w.user('student', 'Other Client', w.otherCoach.id);
    w.row(theirStudent, 'student');
    const coCoach = w.user('coach', 'Co Coach', null);
    w.row(coCoach, 'coach');
    const assistant = w.user('sub_coach', 'Assistant', w.coach.id);
    w.row(assistant, 'assistant');
    for (const p of [theirStudent, coCoach, assistant]) {
      w.dm(p, w.coach, 'Quick question');
      w.dm(w.coach, p, 'Quick answer');
    }
    const list = await listed(w, w.coach);
    for (const p of [coCoach, assistant]) {
      expect(list).not.toContain(p.id);
      await closedEveryWay(w, w.coach, p, NOT_FOUND);
      await closedEveryWay(w, p, w.coach, NOT_FOUND);
    }
    expect(list).toContain(theirStudent.id);
    await expect(w.dms.openThread(w.coach, w.wsId, theirStudent.id)).resolves.toBeDefined();
    await expect(w.dms.openThread(theirStudent, w.wsId, w.coach.id)).resolves.toBeDefined();
  });

  it('10. another coach passing this community\'s id, with their own client holding an assistant row here: 404 everywhere', async () => {
    const theirClient = w.user('student', 'Their Client', w.otherCoach.id);
    w.row(theirClient, 'assistant');
    const id = w.dm(theirClient, w.otherCoach, 'Quick question');
    w.dm(w.otherCoach, theirClient, 'Quick answer');
    expect(await refusal(w.dms.listThreads(w.otherCoach, w.wsId, {}))).toEqual(NOT_FOUND);
    await closedEveryWay(w, w.otherCoach, theirClient, NOT_FOUND);
    await closedEveryWay(w, theirClient, w.otherCoach, NOT_FOUND);
    // this community's own client cannot write to a coach who does not run it either
    await closedEveryWay(w, w.viewer, w.otherCoach, NOT_FOUND);
    expect(await refusal(w.ack.applyTransition(w.otherCoach, id, 'acked'))).toEqual([404, 'community.ack.message_not_found']);
    expect(await refusal(w.reactions.react(w.otherCoach, 'message', id, '\u{1F44D}'))).toEqual([404, 'community.reaction.target_not_found']);
  });

  // #203-E49 (203-D12, COMMUNITY-DM-RULES-BE): the owner's newer rule. A client who moved to another coach and still
  // holds an active row here keeps the existing thread with this coach (test/community/community-dm-rules-be.spec.ts).
  it('11. a client who moved to another coach, with an active row and their thread: still listed; open, read and send 200', async () => {
    const mover = w.member('Moving Client');
    w.dm(mover, w.coach, 'Thanks for everything');
    (mover as { coach_id: string | null }).coach_id = w.otherCoach.id;
    expect(await listed(w, w.coach)).toContain(mover.id);
    for (const [a, b] of [[w.coach, mover], [mover, w.coach]] as const) {
      await expect(w.dms.openThread(a, w.wsId, b.id)).resolves.toBeDefined();
      await expect(w.dms.listThread(a, w.wsId, b.id, {})).resolves.toBeDefined();
      await expect(w.dms.send(a, w.wsId, b.id, 'Checking in')).resolves.toBeDefined();
    }
  });

  it('12. a roster client who is banned, removed, or never opened Community: open, read and send 404; banned off the list', async () => {
    const banned = w.member('Banned Client');
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: banned.id, lifted_at: null });
    const removed = w.user('student', 'Removed Client', w.coach.id);
    w.row(removed, 'student', 'removed');
    const noRow = w.user('student', 'New Client', w.coach.id);
    for (const p of [banned, removed, noRow]) {
      w.dm(p, w.coach, 'Thanks for the plan');
      await closedEveryWay(w, w.coach, p, NOT_FOUND);
      await closedEveryWay(w, p, w.coach, NOT_FOUND);
    }
    expect(await listed(w, w.coach)).not.toContain(banned.id);
  });

  it.each([
    ['the coach blocked the client', true],
    ['the client blocked the coach', false],
  ])('13. %s: dropped from both lists; open answers 403 blocked_by_you or blocked_by_them', async (_label, coachBlocks) => {
    w.dm(w.viewer, w.coach, 'Thanks for the plan');
    w.db.seed('userBlock', coachBlocks
      ? { blocker_id: w.coach.id, blocked_id: w.viewer.id }
      : { blocker_id: w.viewer.id, blocked_id: w.coach.id });
    expect(await listed(w, w.coach)).not.toContain(w.viewer.id);
    expect(await listed(w, w.viewer)).not.toContain(w.coach.id);
    const coachGets = coachBlocks ? 'community.dm.blocked_by_you' : 'community.dm.blocked_by_them';
    const clientGets = coachBlocks ? 'community.dm.blocked_by_them' : 'community.dm.blocked_by_you';
    expect(await refusal(w.dms.openThread(w.coach, w.wsId, w.viewer.id))).toEqual([403, coachGets]);
    expect(await refusal(w.dms.openThread(w.viewer, w.wsId, w.coach.id))).toEqual([403, clientGets]);
  });

  it('14a. dm_enabled_default false: the coach gets 403 community.dm.disabled on every route', async () => {
    w.ws.dm_enabled_default = false;
    const DISABLED: [number, string] = [403, 'community.dm.disabled'];
    expect(await refusal(w.dms.listThreads(w.coach, w.wsId, {}))).toEqual(DISABLED);
    await closedEveryWay(w, w.coach, w.viewer, DISABLED);
  });

  it('14b. the client\'s own dm_enabled false refuses the coach\'s send with 403', async () => {
    const m = w.db.table('communityMembership').find((r) => r.user_id === w.viewer.id) as { dm_enabled: boolean | null };
    m.dm_enabled = false;
    expect(await refusal(w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps'))).toEqual([403, 'community.dm.disabled']);
    expect(w.pushes).toHaveLength(0);
  });

  it('14c. FEATURE_COMMUNITY_DM unset: every DM route answers 503, the coach as for clients', () => {
    delete process.env.FEATURE_COMMUNITY_DM;
    try {
      const guard = new CommunityDmEnabledGuard();
      const ctx = stub<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ user: w.coach }) }) });
      let status = 0;
      try {
        guard.canActivate(ctx);
      } catch (e) {
        status = e instanceof HttpException ? e.getStatus() : -1;
      }
      expect(status).toBe(503);
    } finally {
      process.env.FEATURE_COMMUNITY_DM = 'true';
    }
  });

  it('15. client to client, the platform owner role and a sub-coach: today\'s answers', async () => {
    const sent = await w.dms.send(w.viewer, w.wsId, w.control.id, 'See you at the session');
    expect(sent.message.recipient_user_id).toBe(w.control.id);
    expect(await listed(w, w.control)).toEqual([w.viewer.id]);
    const owner = w.user('owner', 'Platform Owner', null);
    const subCoach = w.user('sub_coach', 'Sub Coach', w.coach.id);
    for (const p of [owner, subCoach]) {
      expect(await refusal(w.dms.listThreads(p, w.wsId, {}))).toEqual(NOT_FOUND);
      await closedEveryWay(w, p, w.viewer, NOT_FOUND);
      await closedEveryWay(w, w.viewer, p, NOT_FOUND);
      await closedEveryWay(w, w.coach, p, NOT_FOUND);
    }
  });

  it('16. self: 404, as today', async () => {
    await closedEveryWay(w, w.coach, w.coach, NOT_FOUND);
    await closedEveryWay(w, w.viewer, w.viewer, NOT_FOUND);
  });

  // #203-E49 (203-D12): the mover keeps their thread, so the page is the mover's thread and the roster thread.
  it('17. page: with limit=2 and the two newest threads off the roster, the older roster thread is listed', async () => {
    w.dm(w.viewer, w.coach, 'Thanks for the plan');
    const coCoach = w.user('coach', 'Co Coach', null);
    w.row(coCoach, 'coach');
    w.dm(coCoach, w.coach, 'Quick question');
    const mover = w.member('Moving Client');
    w.dm(mover, w.coach, 'Thanks for everything');
    (mover as { coach_id: string | null }).coach_id = w.otherCoach.id;
    expect(await listed(w, w.coach, '2')).toEqual([mover.id, w.viewer.id]);
  });
});

describe('COACH-DM-BE part 2: the Studio list row, no new field', () => {
  it('a coach\'s row for a roster thread carries other_user_id and last_message_at (the newest message\'s time), and nothing new', async () => {
    const w = await world();
    w.dm(w.viewer, w.coach, 'Thanks for the plan');
    const newest = w.dm(w.coach, w.viewer, 'Glad it helps');
    const at = (w.db.table('communityMessage').find((m) => m.id === newest)?.created_at as Date).toISOString();
    const { threads } = await w.dms.listThreads(w.coach, w.wsId, {});
    expect(threads).toEqual([{
      thread_id: CommunityDmsRepository.dmKey(w.wsId, w.coach.id, w.viewer.id),
      workspace_id: w.wsId,
      other_user_id: w.viewer.id,
      created_at: null,
      last_message_at: at,
      other_display_name: 'Viewer Member',
    }]);
  });
});

/**
 * The phone's read of a push link: incomingLinkPath and resolveAppLink as the phone has them (one copy,
 * test/utils/phone-link-routes.ts, which names its mobile sha and lines). The phone opens the thread with
 * CommunityDmThread {recipientId}, the other person of the reader's thread.
 */
function phoneDmTarget(url: string): { screen: string; params: { recipientId: string } } | null {
  const path = incomingLinkPath(url);
  const target = path === null ? null : resolveAppLink(path, 'student');
  return target?.screen === 'CommunityDmThread' && target.params?.recipientId
    ? { screen: target.screen, params: { recipientId: target.params.recipientId } }
    : null;
}

describe('COACH-DM-BE part 3: the DM push link is the one the phone reads', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('3 (link). the coach\'s DM push to the client carries tgp://community/dm/<coach id>, never the thread key', async () => {
    await w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps');
    expect(w.pushes.map((p) => [p.recipientId, p.deepLink])).toEqual([[w.viewer.id, `tgp://community/dm/${w.coach.id}?workspace=${w.wsId}`]]);
    expect(w.pushes[0].deepLink).not.toContain(CommunityDmsRepository.dmKey(w.wsId, w.coach.id, w.viewer.id));
  });

  it('4 (link). the client\'s DM push to their coach carries tgp://community/dm/<client id>', async () => {
    await w.dms.send(w.viewer, w.wsId, w.coach.id, 'Thanks for the plan');
    expect(w.pushes.map((p) => [p.recipientId, p.deepLink])).toEqual([[w.coach.id, `tgp://community/dm/${w.viewer.id}?workspace=${w.wsId}`]]);
  });

  it('6. a client recipient\'s link resolves through the copied phone parse to CommunityDmThread {recipientId: sender}', async () => {
    await w.dms.send(w.coach, w.wsId, w.viewer.id, 'Glad it helps');
    await w.dms.send(w.control, w.wsId, w.viewer.id, 'See you at the session');
    expect(w.pushes.map((p) => phoneDmTarget(p.deepLink ?? ''))).toEqual([
      { screen: 'CommunityDmThread', params: { recipientId: w.coach.id } },
      { screen: 'CommunityDmThread', params: { recipientId: w.control.id } },
    ]);
  });
});
