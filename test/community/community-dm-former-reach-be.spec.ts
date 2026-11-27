/**
 * COMMUNITY-DM-FORMER-REACH-BE (agent 203; the server half of COMMUNITY-DM-FORMER-REACH, V1_PRS_LEFT.md:860, stacked on
 * b#1251 COMMUNITY-DM-RULES-BE, owner #203-E49 "DECISIONS #203-D12 – allow maya to still message the client and the
 * client to message them"): a client who left a coach's roster finds their kept DM thread with that coach.
 *   A  GET /community/me names each community W where the caller keeps such a thread with its coach
 *      (former_coach_dms: [{ workspace_id, coach_user_id }], sorted by workspace_id), exactly when the caller's own
 *      GET /community/workspaces/W/dms answers 200 through the former-client arm with the coach's thread (EQ).
 *   B  every DM push link names its community: tgp://community/dm/<sender id>?workspace=<that thread's workspace>.
 *   C  each row of the workspace coach's own DM list carries the other person's stored name (other_display_name,
 *      trimmed, null when blank); null on every other caller's rows and in POST .../dms.
 * Every other field of every response and push is as at b#1251's head 09a99e06 (A8, the guard cases, B2, B3, C3).
 *   D  DM-FORMER-COACH-BE (owner #ALM-E12, "cap at JUST the 1st most recent prior coach"; OPERATOR RULING 7209184240):
 *      former_coach_dms holds at most one item: the community of the coach the caller moved away from last, of every
 *      coach she has left (the newest ClientPurchase.moved_away_at on her plans from that coach, else her newest row in
 *      a non-public space there, whatever its status), named (coach_display_name: his stored name, trimmed, null when
 *      blank), and only when his thread is kept (A's rule, his community not archived, his deletion not finalized).
 *      When it is not kept, nothing: never an older coach (the D5 class table, each case with a live older coach).
 *
 * The world is b#1251's (test/community/community-dm-rules-be.spec.ts), copied here, not imported: the KT-2 fixture
 * (test/community/access/member-content-fixture.ts) on the in-memory Prisma double, which models
 * app.community_dm_former_client as it models the other SQL rules (test/community/safety/in-memory-prisma.ts), with
 * the switches on ([R27]). Coach K owns W with spaces S (members), P (public), C3 (clients, no rows) and Pk
 * (package); coach L owns W2 (space S2); coach K2 owns W3 (space S3). A and B are K's clients in S. X has a row in S
 * and a thread with K, then X's coach becomes L; Y as X with no thread; Z as X with its row removed; V as X and
 * banned in W; U as X whose only row is in P; Q as X whose only row is in Pk (no purchase); T has no row and a seeded
 * thread. extras() adds a co-coach row, an assistant row, the platform owner, a sub-coach and X2 (a former client of
 * K with an assistant row in W and an older open row in W2), each with a thread with K. getMe's tab badge is one SQL
 * count this store does not model; nothing is unread here (as community-ugc-round2.spec.ts). No sample message
 * touches a sensitive topic; every block, ban, move, removal or setting a case makes is undone in a finally, on that
 * case's own fresh world.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';
import { accessWorld, type AccessWorld } from './access/member-content-fixture';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityService } from '../../src/community/community.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { CommunityDmsService } from '../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../src/community/dms/community-dms.repository';
import { CommunityDmEnabledGuard } from '../../src/community/community-write-flag.guard';
import { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import {
  COMMUNITY_PUSH_BODIES,
  COMMUNITY_PUSH_DEFAULTS,
  COMMUNITY_PUSH_TITLES,
} from '../../src/community/notifications/community-notifications.types';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { CLIENT_LINKS, SESSION_LINKS, pushStillCurrent } from '../../src/notifications/current-coach-inbox';
import { InboxBlockRule } from '../../src/notifications/inbox-block-rule';
import { heldPushDropReason } from '../../src/notifications/push/held-push-source';
import { incomingLinkPath, resolveAppLink } from '../utils/phone-link-routes';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import type { Row } from './safety/in-memory-prisma';

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

type Key = 'K' | 'L' | 'K2' | 'A' | 'B' | 'X' | 'Y' | 'Z' | 'V' | 'U' | 'Q' | 'T';
type Extra = 'CC' | 'AS' | 'O' | 'SC' | 'X2';

/** One stored notification row and one device push, as the real CommunityNotificationsService hands them on. */
interface StoredRow { user_id: string; kind: string; body: string; channel: string; deep_link?: string; payload: unknown }
interface Sent { userId: string; title: string; body: string; data: Record<string, unknown>; opts: Record<string, unknown> }

interface World extends AccessWorld {
  access: CommunityAccessService;
  dmsvc: CommunityDmsService;
  me: CommunityService;
  rows: StoredRow[];
  outbox: Sent[];
  ws: Row;
  p: Record<Key, User>;
  space: { S: string; P: string; C3: string; Pk: string };
  w2: { id: string; space: string };
  w3: { id: string; space: string };
  user(role: string, name: string, coachId: string | null): User;
  row(u: User, cohortId: string, role?: string, joinedAt?: Date): Row;
  dm(from: User, to: User, workspaceId?: string, body?: string): string;
  extras(): Record<Extra, User>;
  /** Owned communities seeded for the coach-role extras (getMe makes one otherwise, which this store cannot). */
  own: Map<string, string>;
}

async function world(): Promise<World> {
  const w = await accessWorld();
  // keyedWrite's advisory lock (message-idempotency.ts) is a no-op here, as in test/send-once.table.spec.ts.
  Object.assign(w.db, { $executeRaw: async () => 0 });
  const raw = w.db.$queryRaw.bind(w.db);
  Object.assign(w.db, {
    $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) =>
      q.join('').includes('community_space_reads') ? Promise.resolve([]) : raw(q, ...v),
  });
  const prisma = stub<PrismaService>(w.db);
  const access = new CommunityAccessService(prisma);
  const rows: StoredRow[] = [];
  const outbox: Sent[] = [];
  const notifications = stub<NotificationsService>({
    channelGate: async () => 'on',
    createNotification: async (r: StoredRow) => {
      rows.push(r);
      return { id: randomUUID(), ...r };
    },
    pushToUser: async (userId: string, title: string, body: string, data: Record<string, unknown>, _x: unknown, opts: Record<string, unknown>) => {
      outbox.push({ userId, title, body, data, opts });
      return { delivered: true, code: 'delivered' };
    },
  });
  const push = new CommunityNotificationsService(notifications, prisma, stub<AnalyticsService>({ capture: () => undefined }));
  const realtime = stub<CommunityRealtimeService>({
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async () => undefined,
  });
  const dmsvc = new CommunityDmsService(access, new CommunityDmsRepository(prisma), realtime, push, w.safety);
  const me = new CommunityService(prisma, new CommunityRepository(prisma), w.safety, access);
  const ws = w.db.table('communityWorkspace').find((r) => r.id === w.wsId) as Row;
  // S is the community's first space (findDefaultCohortForCoach), a members space as the double reads it unset.
  Object.assign(w.db.table('communityCohort').find((c) => c.id === w.cohortId) as Row,
    { visibility: 'members', status: 'active', archived_at: null, sort_order: 0 });
  const user = (role: string, name: string, coachId: string | null) =>
    stub<User>(w.db.seed('user', { role, name, deleted_at: null, coach_id: coachId, expo_push_token: 'ExponentPushToken[reach]' }));
  const workspaceOf = (cohortId: string) => (w.db.table('communityCohort').find((c) => c.id === cohortId) as Row).workspace_id as string;
  const row = (u: User, cohortId: string, role = 'student', joinedAt?: Date) =>
    w.db.seed('communityMembership', {
      workspace_id: workspaceOf(cohortId), cohort_id: cohortId, user_id: u.id, status: 'active', role, dm_enabled: null,
      removed_at: null, ...(joinedAt ? { joined_at: joinedAt } : {}),
    });
  const dm = (from: User, to: User, workspaceId = w.wsId, body = 'See you at the session') =>
    w.db.seed('communityMessage', {
      workspace_id: workspaceId, scope: 'dm', kind: 'text', dm_key: CommunityDmsRepository.dmKey(workspaceId, from.id, to.id),
      sender_id: from.id, recipient_user_id: to.id, body, visibility: 'active',
    }).id as string;
  const cohort = (workspaceId: string, name: string, visibility: string) =>
    w.db.seed('communityCohort', { workspace_id: workspaceId, name, visibility, status: 'active', archived_at: null, sort_order: 0 }).id as string;
  const community = (coach: User, name: string) => {
    const id = w.db.seed('communityWorkspace', { coach_id: coach.id, name, dm_enabled_default: true, archived_at: null }).id as string;
    return { id, space: cohort(id, `${name} room`, 'clients') };
  };
  const space = {
    S: w.cohortId,
    P: w.db.seed('communityCohort', { workspace_id: w.wsId, name: 'Open room', visibility: 'public', status: 'active', archived_at: null }).id as string,
    C3: w.db.seed('communityCohort', { workspace_id: w.wsId, name: 'Clients room', visibility: 'clients', status: 'active', archived_at: null }).id as string,
    Pk: w.db.seed('communityCohort', { workspace_id: w.wsId, name: 'Plan room', visibility: 'package', status: 'active', archived_at: null }).id as string,
  };
  const L = w.db.table('user').find((u) => u.name === 'Coach Two') as unknown as User;
  const K2 = user('coach', 'Coach Three', null);
  const w2 = community(L, 'Second');
  const w3 = community(K2, 'Third');
  const K = w.coach;
  for (const u of [K, L, w.viewer, w.control]) Object.assign(u, { expo_push_token: 'ExponentPushToken[reach]' });
  const p = { K, L, K2, A: w.viewer, B: w.control } as Record<Key, User>;
  // Each former client: a row where the case says, a thread with K where the case says, then their coach becomes L.
  const former: Array<[Key, string | null, boolean]> = [
    ['X', space.S, true], ['Y', space.S, false], ['Z', space.S, true], ['V', space.S, true],
    ['U', space.P, true], ['Q', space.Pk, true], ['T', null, true],
  ];
  for (const [k, where, thread] of former) {
    const u = user('student', `Former ${k}`, K.id);
    if (where) row(u, where);
    if (thread) {
      dm(u, K, w.wsId, 'Thanks for the plan');
      dm(K, u, w.wsId, 'Glad it helps');
    }
    p[k] = u;
  }
  const z = w.db.table('communityMembership').find((m) => m.user_id === p.Z.id) as Row;
  Object.assign(z, { status: 'removed', removed_at: new Date() });
  w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: p.V.id, lifted_at: null });
  for (const [k] of former) Object.assign(p[k], { coach_id: L.id });
  const own = new Map<string, string>();
  const extras = (): Record<Extra, User> => {
    const CC = user('coach', 'Co Coach', null);
    row(CC, space.S, 'coach');
    own.set(CC.id, community(CC, 'Co').id);
    const AS = user('coach', 'Helper Coach', null);
    row(AS, space.S, 'assistant');
    own.set(AS.id, community(AS, 'Helper').id);
    const O = user('owner', 'Platform Owner', null);
    const SC = user('sub_coach', 'Sub Coach', K.id);
    // X2: K's former client (coach L) whose row in W has a role the space rule opens without the roster, and whose
    // older open row is in W2, so /me names W2 and X2's GET W/dms answers through the member arm.
    const X2 = user('student', 'Former Two', K.id);
    row(X2, w2.space, 'student', new Date(Date.UTC(2026, 0, 1)));
    row(X2, space.S, 'assistant', new Date(Date.UTC(2026, 1, 1)));
    for (const q of [CC, AS, O, SC, X2]) {
      dm(q, K, w.wsId, 'Quick question');
      dm(K, q, w.wsId, 'Quick answer');
    }
    Object.assign(X2, { coach_id: L.id });
    return { CC, AS, O, SC, X2 };
  };
  return { ...w, access, dmsvc, me, rows, outbox, ws, p, space, w2, w3, user, row, dm, extras, own };
}

/** A caller's GET /community/workspaces/:id/dms: the other people of its rows, or 'refused <status> <code>'. */
async function listed(w: World, u: User, workspaceId = w.wsId, limit?: string): Promise<string[] | string> {
  try {
    return (await w.dmsvc.listThreads(u, workspaceId, limit ? { limit } : {})).threads.map((t) => t.other_user_id);
  } catch (e) {
    if (e instanceof HttpException) return `refused ${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
    throw e;
  }
}
const NOT_FOUND = 'refused 404 community.dm.not_found';
const DISABLED = 'refused 403 community.dm.disabled';

/** GET /community/me's former_coach_dms; at 09a99e06 the field does not exist (undefined). */
async function formerDms(w: World, u: User): Promise<unknown> {
  return stub<Record<string, unknown>>(await w.me.getMe(u)).former_coach_dms;
}
const entry = (workspaceId: string, coach: User, name: string | null = coach.name) =>
  ({ workspace_id: workspaceId, coach_user_id: coach.id, coach_display_name: name });

/** True when the caller reads `workspaceId`'s DM list through the former-client arm: neither a member nor its coach. */
async function throughFormerArm(w: World, u: User, workspaceId: string): Promise<boolean> {
  const ws = w.db.table('communityWorkspace').find((r) => r.id === workspaceId) as Row;
  return ws.coach_id !== u.id && (await w.access.membershipInWorkspace(workspaceId, u.id)) === null;
}

/**
 * The states of the class table: the caller, what the case changes (undone in a finally) and, as at 09a99e06, the
 * caller's GET W/dms answer; `me` is whether W is in the caller's former_coach_dms after this job.
 */
interface State {
  label: string;
  who: Key | Extra;
  set?: (w: World, x: Record<Extra, User>) => () => void;
  list: (w: World, x: Record<Extra, User>) => string[] | string;
  me: boolean;
}
const coachOnly = (w: World) => [w.p.K.id];
const setField = (target: Row | User, fields: Record<string, unknown>) => {
  const was = Object.fromEntries(Object.keys(fields).map((k) => [k, stub<Record<string, unknown>>(target)[k]]));
  Object.assign(target, fields);
  return () => {
    Object.assign(target, was);
  };
};
const block = (w: World, blocker: User, blocked: User) => {
  const b = w.db.seed('userBlock', { blocker_id: blocker.id, blocked_id: blocked.id });
  return () => {
    w.db.tables.userBlock = w.db.table('userBlock').filter((r) => r !== b);
  };
};
const membershipOf = (w: World, u: User) => w.db.table('communityMembership').find((r) => r.user_id === u.id) as Row;
const banOf = (w: World, u: User) => w.db.table('communityWorkspaceBan').find((b) => b.user_id === u.id) as Row;

const STATES: State[] = [
  { label: 'A1 X, a former client (coach L) with a row in S and a thread with K', who: 'X', list: coachOnly, me: true },
  { label: 'A1 X with no coach (coach_id null)', who: 'X', set: (w) => setField(w.p.X, { coach_id: null }), list: coachOnly, me: true },
  { label: 'A3 Y, no thread', who: 'Y', list: () => NOT_FOUND, me: false },
  { label: 'A3 Z, row removed', who: 'Z', list: () => NOT_FOUND, me: false },
  { label: 'A3 V, banned in W', who: 'V', list: () => NOT_FOUND, me: false },
  { label: 'A3 V, the ban lifted', who: 'V', set: (w) => setField(banOf(w, w.p.V), { lifted_at: new Date() }), list: coachOnly, me: true },
  { label: 'A3 U, only a public-space row', who: 'U', list: () => NOT_FOUND, me: false },
  { label: 'A3 Q, only a lapsed package row', who: 'Q', list: () => NOT_FOUND, me: false },
  { label: 'A3 T, no row and a seeded thread', who: 'T', list: () => NOT_FOUND, me: false },
  { label: 'A4 X, K blocked X', who: 'X', set: (w) => block(w, w.p.K, w.p.X), list: () => [], me: false },
  { label: 'A4 X, X blocked K', who: 'X', set: (w) => block(w, w.p.X, w.p.K), list: () => [], me: false },
  { label: 'A4 X, a block lifted', who: 'X', set: (w) => { block(w, w.p.K, w.p.X)(); return () => undefined; }, list: coachOnly, me: true },
  { label: 'A5 X, X\'s own dm_enabled false', who: 'X', set: (w) => setField(membershipOf(w, w.p.X), { dm_enabled: false }), list: () => DISABLED, me: false },
  { label: 'A5 X, W set false by hand', who: 'X', set: (w) => setField(w.ws, { dm_enabled_default: false }), list: () => DISABLED, me: false },
  { label: 'A6 X back on K\'s roster', who: 'X', set: (w) => setField(w.p.X, { coach_id: w.p.K.id }), list: coachOnly, me: false },
  // K's list: the kept former clients X and X2 (X2's thread is the newer), as b#1251 keeps them before the cut.
  { label: 'A6 K, the coach', who: 'K', list: (w, x) => [x.X2.id, w.p.X.id], me: false },
  { label: 'A6 A, a current client', who: 'A', list: () => [], me: false },
  { label: 'A6 L, another coach', who: 'L', list: () => NOT_FOUND, me: false },
  { label: 'A6 a co-coach row in S', who: 'CC', list: coachOnly, me: false },
  { label: 'A6 an assistant row in S', who: 'AS', list: coachOnly, me: false },
  { label: 'A6 the platform owner', who: 'O', list: () => NOT_FOUND, me: false },
  { label: 'A6 a sub-coach', who: 'SC', list: () => NOT_FOUND, me: false },
  { label: 'A6 X2, an assistant row in W (the member arm) and an older open row in W2', who: 'X2', list: coachOnly, me: false },
];

const person = (w: World, x: Record<Extra, User>, k: Key | Extra): User => (k in x ? x[k as Extra] : w.p[k as Key]);

describe('COMMUNITY-DM-FORMER-REACH-BE A: GET /community/me names the community of a kept thread with its old coach', () => {
  let w: World;
  let x: Record<Extra, User>;
  beforeEach(async () => {
    w = await world();
    x = w.extras();
  });

  it.each(STATES)('$label (guard): the caller\'s GET W/dms answers as at 09a99e06', async (s) => {
    const u = person(w, x, s.who);
    const undo = s.set?.(w, x);
    try {
      expect(await listed(w, u)).toEqual(s.list(w, x));
    } finally {
      undo?.();
    }
  });

  it.each(STATES)('$label: former_coach_dms', async (s) => {
    const u = person(w, x, s.who);
    const undo = s.set?.(w, x);
    try {
      expect(await formerDms(w, u)).toEqual(s.me ? [entry(w.wsId, w.p.K)] : []);
    } finally {
      undo?.();
    }
  });

  it('EQ. W is in former_coach_dms exactly when the caller\'s GET W/dms answers 200 through the former-client arm with K\'s thread', async () => {
    const got: Record<string, [boolean, boolean]> = {};
    for (const s of STATES) {
      // Each state on its own fresh world, as the $label rows: on one shared world an earlier state's /me makes X's
      // row in L's community (the bootstrap), so L would be the coach X left last once a later state clears her coach.
      w = await world();
      x = w.extras();
      const u = person(w, x, s.who);
      const undo = s.set?.(w, x);
      try {
        const viaFormer = await throughFormerArm(w, u, w.wsId);
        const answer = await listed(w, u);
        const open = viaFormer && Array.isArray(answer) && answer.includes(w.p.K.id);
        const dms = await formerDms(w, u);
        const named = Array.isArray(dms) && dms.some((d: { workspace_id?: string; coach_user_id?: string }) =>
          d.workspace_id === w.wsId && d.coach_user_id === w.p.K.id);
        got[s.label] = [named, open];
      } finally {
        undo?.();
      }
    }
    expect(got).toEqual(Object.fromEntries(STATES.map((s) => [s.label, [s.me, s.me]])));
  });

  it('A1. X: /me\'s workspace_id is W2 (the bootstrap, as at 09a99e06), former_coach_dms names W and K, X\'s GET W/dms is that thread; then with no coach: workspace_id null and none (she left L last: the bootstrap\'s row in W2, no thread with L; OPERATOR RULING 7209184240)', async () => {
    expect(await listed(w, w.p.X)).toEqual([w.p.K.id]);
    const mine = await w.me.getMe(w.p.X);
    expect(mine.workspace_id).toBe(w.w2.id);
    expect(stub<Record<string, unknown>>(mine).former_coach_dms).toEqual([entry(w.wsId, w.p.K)]);
    const undo = setField(w.p.X, { coach_id: null });
    try {
      const none = await w.me.getMe(w.p.X);
      expect([none.workspace_id, stub<Record<string, unknown>>(none).former_coach_dms]).toEqual([null, []]);
      expect(await listed(w, w.p.X)).toEqual([w.p.K.id]);
    } finally {
      undo();
    }
  });

  it('A2 (guard). FEATURE_COMMUNITY_DM unset: the DM routes answer 503 as today', () => {
    delete process.env.FEATURE_COMMUNITY_DM;
    try {
      const ctx = stub<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ user: w.p.X }) }) });
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

  it('A2. FEATURE_COMMUNITY_DM unset (or not exactly "true"): []; the community flag disabled: [] with feature_flag_state disabled', async () => {
    for (const off of [undefined, 'TRUE', '1']) {
      if (off === undefined) delete process.env.FEATURE_COMMUNITY_DM;
      else process.env.FEATURE_COMMUNITY_DM = off;
      try {
        const mine = stub<Record<string, unknown>>(await w.me.getMe(w.p.X));
        expect([off, mine.former_coach_dms, stub<{ community_dm: boolean }>(mine.flags).community_dm]).toEqual([off, [], false]);
      } finally {
        process.env.FEATURE_COMMUNITY_DM = 'true';
      }
    }
    process.env.FEATURE_COMMUNITY_API = 'false';
    try {
      const mine = stub<Record<string, unknown>>(await w.me.getMe(w.p.X));
      expect([mine.feature_flag_state, mine.former_coach_dms]).toEqual(['disabled', []]);
    } finally {
      process.env.FEATURE_COMMUNITY_API = 'true';
    }
  });

  it('A7. X with kept threads with K in W and K2 in W3: only one (DM-FORMER-COACH-BE), W3, her newer row', async () => {
    w.row(w.p.X, w.w3.space);
    w.dm(w.p.X, w.p.K2, w.w3.id, 'Thanks for the plan');
    expect([await listed(w, w.p.X), await listed(w, w.p.X, w.w3.id)]).toEqual([[w.p.K.id], [w.p.K2.id]]);
    expect(await formerDms(w, w.p.X)).toEqual([entry(w.w3.id, w.p.K2)]);
  });

  it('A8 (guard). Every other /me value of every caller in this world is as at 09a99e06, field by field', async () => {
    const flags = {
      community_api: true,
      community_dm: true,
      community_realtime: process.env.FEATURE_COMMUNITY_REALTIME === 'true',
      community_push: true,
      community_telemetry: process.env.FEATURE_COMMUNITY_TELEMETRY === 'true',
    };
    const S2 = w.w2.space;
    // [caller, /me's workspace, the space of the row getMe shows (null: none), the API role]
    const callers: Array<[Key | Extra, string | null, string | null, 'client' | 'coach' | 'owner']> = [
      ['K', w.wsId, null, 'coach'], ['L', w.w2.id, null, 'coach'], ['K2', w.w3.id, null, 'coach'],
      ['A', w.wsId, w.space.S, 'client'], ['B', w.wsId, w.space.S, 'client'],
      ['X', w.w2.id, S2, 'client'], ['Y', w.w2.id, S2, 'client'], ['Z', w.w2.id, S2, 'client'], ['V', w.w2.id, S2, 'client'],
      ['U', w.w2.id, S2, 'client'], ['Q', w.w2.id, S2, 'client'], ['T', w.w2.id, S2, 'client'],
      ['CC', w.own.get(x.CC.id) ?? '', w.space.S, 'coach'], ['AS', w.own.get(x.AS.id) ?? '', w.space.S, 'coach'],
      ['O', null, null, 'owner'], ['SC', w.wsId, w.space.S, 'client'], ['X2', w.w2.id, S2, 'client'],
    ];
    for (const [k, wsId, spaceId, role] of callers) {
      const u = person(w, x, k);
      const { former_coach_dms: _ignored, ...rest } = stub<Record<string, unknown>>(await w.me.getMe(u));
      const m = spaceId ? (w.db.table('communityMembership').find((r) => r.user_id === u.id && r.cohort_id === spaceId) as Row) : null;
      const home = w.db.table('communityWorkspace').find((r) => r.id === wsId);
      expect([k, rest]).toEqual([k, {
        feature_flag_state: 'enabled',
        workspace_id: wsId,
        membership: m ? {
          id: m.id,
          role,
          notify_level: 'digest',
          dm_enabled_effective: (m.dm_enabled as boolean | null) ?? (home?.dm_enabled_default as boolean | undefined) ?? false,
          last_read_message_at: null,
          joined_at: ((m.joined_at ?? m.created_at) as Date).toISOString(),
        } : null,
        unread: { cohort_messages: 0, dm_messages: 0, mentions: 0 },
        flags,
      }]);
    }
  });
});

/** DM-FORMER-COACH-BE: the first of a month in 2026. */
const day = (month: number) => new Date(Date.UTC(2026, month, 1));
/** X (K's former client, a row in S and a thread with K) also keeps a thread with K2 in W3 (a row in S3); X's rows in S
 *  and S3 joined on the given days. */
const twoKept = (w: World, inW: number, inW3: number) => {
  Object.assign(membershipOf(w, w.p.X), { joined_at: day(inW) });
  w.row(w.p.X, w.w3.space, 'student', day(inW3));
  w.dm(w.p.X, w.p.K2, w.w3.id, 'Thanks for the plan');
};
/** One of X's plans from `coach`, stamped moved_away_at as trg_user_coach_move_marks_plans stamps it (null: never). */
const bought = (w: World, coach: User, movedAwayAt: Date | null) =>
  w.db.seed('clientPurchase', { client_user_id: w.p.X.id, coach_user_id: coach.id, moved_away_at: movedAwayAt });
/** X's rows in a community. */
const rowsIn = (w: World, workspaceId: string) =>
  w.db.table('communityMembership').filter((m) => m.user_id === w.p.X.id && m.workspace_id === workspaceId);
/** A space of `workspaceId` with the given visibility. */
const spaceIn = (w: World, workspaceId: string, visibility: string) =>
  w.db.seed('communityCohort', { workspace_id: workspaceId, name: `${visibility} room`, visibility, status: 'active', archived_at: null, sort_order: 1 }).id as string;
/** X keeps a thread with K in W (her S row joined day 0) and K2, whom she left later, is her newer former coach in W3,
 *  as twoKept(w, 0, 2) but with X's W3 row in `cohortId` (S3 by default) and a thread only when `thread`. */
const newerK2 = (w: World, cohortId = w.w3.space, thread = true, role = 'student') => {
  Object.assign(membershipOf(w, w.p.X), { joined_at: day(0) });
  w.row(w.p.X, cohortId, role, day(2));
  if (thread) w.dm(w.p.X, w.p.K2, w.w3.id, 'Thanks for the plan');
  return w.p.X;
};
/** LS-DMFC-1's C1 probe: a coach's account deletion as it finalizes (account-deletion.service.ts and its manifest): the
 *  tombstone name, deleted_at, his community archived, the DM rows both ways soft-deleted, his clients detached. */
const purge = (w: World, c: User, wsId: string) => {
  const now = new Date();
  Object.assign(c, { name: 'Deleted user', deleted_at: now, archived_at: now, coach_id: null });
  Object.assign(w.db.table('communityWorkspace').find((r) => r.id === wsId) as Row, { name: 'Archived community', archived_at: now });
  for (const m of w.db.table('communityMessage')) {
    if (m.sender_id === c.id || m.recipient_user_id === c.id) Object.assign(m, { body: null, visibility: 'removed', deleted_at: now });
  }
  for (const u of w.db.table('user')) if (u.coach_id === c.id) Object.assign(u, { coach_id: null });
};
/** A third former coach K3 ('Coach Four') with his community W4 and space S4. */
const fourth = (w: World) => {
  const K3 = w.user('coach', 'Coach Four', null);
  const id = w.db.seed('communityWorkspace', { coach_id: K3.id, name: 'Fourth', dm_enabled_default: true, archived_at: null }).id as string;
  return { K3, id, space: spaceIn(w, id, 'clients') };
};
const coachNamed = (w: World, name: string) => w.db.table('user').find((u) => u.name === name) as unknown as User;
const communityOf = (w: World, coach: User) => (w.db.table('communityWorkspace').find((r) => r.coach_id === coach.id) as Row).id as string;
/** Three former coaches: K in W (day 0), K2 in W3 (day 2) and K3 in W4 (`inW4`), a thread with each. */
const threeKept = (w: World, inW4: number) => {
  twoKept(w, 0, 2);
  const k3 = fourth(w);
  w.row(w.p.X, k3.space, 'student', day(inW4));
  w.dm(w.p.X, k3.K3, k3.id, 'Thanks for the plan');
  return w.p.X;
};

interface Capped {
  label: string;
  /** Sets the case up on its own fresh world and returns the caller. */
  caller: (w: World, x: Record<Extra, User>) => User;
  want: (w: World) => unknown[];
  /** D5: the older former coaches whose thread stays kept in this case ([community, coach]): her GET of that
   *  community's DMs lists him through the former-client arm, yet former_coach_dms is empty. */
  kept?: (w: World) => Array<[string, User]>;
}
const inW = (w: World) => [entry(w.wsId, w.p.K)];
const inW3 = (w: World) => [entry(w.w3.id, w.p.K2)];
const keptK = (w: World): Array<[string, User]> => [[w.wsId, w.p.K]];
const CAPPED: Capped[] = [
  { label: 'D1 one former coach (X, K in W): that one, named', caller: (w) => w.p.X, want: inW },
  { label: 'D1 the same with no coach now (coach_id null)', caller: (w) => Object.assign(w.p.X, { coach_id: null }), want: inW },
  { label: 'D2 two former coaches, no plans: the community she joined last (W3)', caller: (w) => { twoKept(w, 0, 2); return w.p.X; }, want: inW3 },
  { label: 'D2 the same, the other order (W)', caller: (w) => { twoKept(w, 4, 2); return w.p.X; }, want: inW },
  {
    label: 'D3 move stamps: she left K after K2, though her W3 row is newer (W)',
    caller: (w) => { twoKept(w, 0, 2); bought(w, w.p.K, day(6)); bought(w, w.p.K2, day(3)); return w.p.X; },
    want: inW,
  },
  {
    label: 'D3 a stamp on K older than her W3 row (W3)',
    caller: (w) => { twoKept(w, 0, 2); bought(w, w.p.K, day(1)); return w.p.X; },
    want: inW3,
  },
  {
    label: 'D3 K, then K2, then back to K with a new plan from K and away: that plan\'s stamp, the newest (W); without a new plan or a new add the order is wrong (C, a coach-history table, v1.1)',
    caller: (w) => { twoKept(w, 0, 2); bought(w, w.p.K, day(1)); bought(w, w.p.K2, day(3)); bought(w, w.p.K, day(5)); return w.p.X; },
    want: inW,
  },
  {
    label: 'D3 a plan never stamped (moved_away_at null) does not count (W3)',
    caller: (w) => { twoKept(w, 0, 2); bought(w, w.p.K, null); return w.p.X; },
    want: inW3,
  },
  {
    label: 'D4 the same time: the lower workspace_id',
    caller: (w) => { twoKept(w, 2, 2); return w.p.X; },
    want: (w) => (w.wsId < w.w3.id ? inW(w) : inW3(w)),
  },
  // D5, OPERATOR RULING 7209184240: the one place is K2's (she left him after K); when K2's thread is not kept, for any
  // reason, nothing, though K's thread in W is kept (D5. checks that every row's W thread is still open).
  { label: 'D5 X blocked K2 (203-D51): none, not K', caller: (w) => { twoKept(w, 0, 2); block(w, w.p.X, w.p.K2); return w.p.X; }, want: () => [], kept: keptK },
  { label: 'D5 K2 blocked X: none, not K', caller: (w) => { twoKept(w, 0, 2); block(w, w.p.K2, w.p.X); return w.p.X; }, want: () => [], kept: keptK },
  {
    label: 'D5 X banned in W3 (the ban row): none, not K',
    caller: (w) => { twoKept(w, 0, 2); w.db.seed('communityWorkspaceBan', { workspace_id: w.w3.id, user_id: w.p.X.id, lifted_at: null }); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 X banned in W3 as banAuthor writes it (the ban row, her W3 rows removed): none, not K',
    caller: (w) => {
      twoKept(w, 0, 2);
      w.db.seed('communityWorkspaceBan', { workspace_id: w.w3.id, user_id: w.p.X.id, lifted_at: null });
      for (const m of rowsIn(w, w.w3.id)) Object.assign(m, { status: 'removed', removed_at: day(3) });
      return w.p.X;
    },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 she left K2\'s community (her W3 row removed, the coach\'s Remove): none, not K',
    caller: (w) => { twoKept(w, 0, 2); for (const m of rowsIn(w, w.w3.id)) Object.assign(m, { status: 'removed', removed_at: day(3) }); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 K2 archived her space (the space archived, her row removed, as archive() writes it): none, not K',
    caller: (w) => {
      twoKept(w, 0, 2);
      Object.assign(w.db.table('communityCohort').find((c) => c.id === w.w3.space) as Row, { status: 'archived', archived_at: day(3) });
      for (const m of rowsIn(w, w.w3.id)) Object.assign(m, { status: 'removed', removed_at: day(3) });
      return w.p.X;
    },
    want: () => [], kept: keptK,
  },
  { label: 'D5 no thread with K2 (a row in S3, no message): none, not K', caller: (w) => newerK2(w, w.w3.space, false), want: () => [], kept: keptK },
  {
    label: 'D5 her DMs off in W3 (her own dm_enabled false): none, not K',
    caller: (w) => { newerK2(w); for (const m of rowsIn(w, w.w3.id)) Object.assign(m, { dm_enabled: false }); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 her DMs off in W3 (W3\'s default off, her own setting unset): none, not K',
    caller: (w) => { newerK2(w); Object.assign(w.db.table('communityWorkspace').find((r) => r.id === w.w3.id) as Row, { dm_enabled_default: false }); return w.p.X; },
    want: () => [], kept: keptK,
  },
  { label: 'D5 her only W3 row in a package space with no live plan: none, not K', caller: (w) => newerK2(w, spaceIn(w, w.w3.id, 'package')), want: () => [], kept: keptK },
  {
    label: 'D5 her W3 row opens the member arm (an assistant row): W3 is not a former-client place, none, not K',
    caller: (w) => newerK2(w, w.w3.space, true, 'assistant'),
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 K2 deleted his account (finalized, LS-DMFC-1 C1 probe): none, not K, never "Deleted user"',
    caller: (w) => { twoKept(w, 0, 2); purge(w, w.p.K2, w.w3.id); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 the probe\'s own order (LS-DMFC-1 P2): K, whom she left last, deleted his account; K2 older and kept: none, not K2',
    caller: (w) => { twoKept(w, 4, 2); purge(w, w.p.K, w.wsId); return w.p.X; },
    want: () => [], kept: (w) => [[w.w3.id, w.p.K2]],
  },
  {
    label: 'D5 K2\'s community archived (archived_at set, nothing else): none, not K',
    caller: (w) => { twoKept(w, 0, 2); Object.assign(w.db.table('communityWorkspace').find((r) => r.id === w.w3.id) as Row, { archived_at: day(3) }); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 her plan from K2 stamped last and her only W3 row in a public space: none, not K',
    caller: (w) => { newerK2(w, spaceIn(w, w.w3.id, 'public')); bought(w, w.p.K2, day(6)); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 her plan from K4 stamped last, a coach with no community: none, not K',
    caller: (w) => { Object.assign(membershipOf(w, w.p.X), { joined_at: day(0) }); bought(w, w.user('coach', 'Coach Five', null), day(6)); return w.p.X; },
    want: () => [], kept: keptK,
  },
  {
    label: 'D5 she left L last (no coach now; her row in L\'s community W2 is newer, no thread with L): none, not K',
    caller: (w) => {
      Object.assign(membershipOf(w, w.p.X), { joined_at: day(0) });
      w.row(w.p.X, w.w2.space, 'student', day(3));
      return Object.assign(w.p.X, { coach_id: null });
    },
    want: () => [], kept: keptK,
  },
  // Boundaries of the class: K2 is not a coach she has left, or his deletion is not final yet.
  { label: 'D5 K2 is her coach again: not a former coach, so K (W)', caller: (w) => { twoKept(w, 0, 2); return Object.assign(w.p.X, { coach_id: w.p.K2.id }); }, want: inW },
  {
    label: 'D5 K2 asked to delete his account, still in the grace period (deleted_at unset): K2 (W3)',
    caller: (w) => { twoKept(w, 0, 2); Object.assign(w.p.K2, { deletion_requested_at: day(5), deletion_confirmed_at: day(5), deletion_scheduled_at: day(8) }); return w.p.X; },
    want: inW3,
  },
  {
    label: 'D5 her only W3 row in a public space and no plan from K2: a public row never dated a coach, so K (W)',
    caller: (w) => newerK2(w, spaceIn(w, w.w3.id, 'public')),
    want: inW,
  },
  { label: 'D6 a blocked pair, the only one (X blocked K): none', caller: (w) => { block(w, w.p.X, w.p.K); return w.p.X; }, want: () => [] },
  { label: 'D6 a blocked pair, the only one (K blocked X): none', caller: (w) => { block(w, w.p.K, w.p.X); return w.p.X; }, want: () => [] },
  { label: 'D6 a banned client (V): none', caller: (w) => w.p.V, want: () => [] },
  { label: 'D6 no former coach (A, K\'s current client): none', caller: (w) => w.p.A, want: () => [] },
  {
    label: 'D6 another coach\'s client (L\'s, a row in W2, a message to K, no row in W): none',
    caller: (w) => {
      const n = w.user('student', 'Other Client', w.p.L.id);
      w.row(n, w.w2.space);
      w.dm(n, w.p.K, w.wsId, 'Hello there');
      return n;
    },
    want: () => [],
  },
  { label: 'D6 the platform owner (a thread with K): none', caller: (w, x) => x.O, want: () => [] },
  { label: 'D6 K, the coach: none', caller: (w) => w.p.K, want: () => [] },
  {
    label: 'D6 a coach who left: K, her only former coach, deleted his account (LS-DMFC-1 P1): none, never "Deleted user"',
    caller: (w) => { purge(w, w.p.K, w.wsId); return w.p.X; },
    want: () => [],
  },
  { label: 'D9 three former coaches by her rows (W, W3, then W4): the newest, K3 (W4)', caller: (w) => threeKept(w, 4), want: (w) => [entry(communityOf(w, coachNamed(w, 'Coach Four')), coachNamed(w, 'Coach Four'))] },
  { label: 'D9 three former coaches, K3\'s row the oldest: K2 (W3)', caller: (w) => threeKept(w, 1), want: inW3 },
  {
    label: 'D9 three former coaches, her plan from K stamped last: K (W)',
    caller: (w) => { threeKept(w, 4); bought(w, w.p.K, day(6)); return w.p.X; },
    want: inW,
  },
  {
    label: 'D9 three former coaches, the newest (K3) blocked: none, not K2 or K',
    caller: (w) => { threeKept(w, 4); block(w, w.p.X, coachNamed(w, 'Coach Four')); return w.p.X; },
    want: () => [], kept: (w) => [[w.wsId, w.p.K], [w.w3.id, w.p.K2]],
  },
  { label: 'D7 K\'s stored name padded: trimmed', caller: (w) => { Object.assign(w.p.K, { name: '  Coach One  ' }); return w.p.X; }, want: (w) => [entry(w.wsId, w.p.K, 'Coach One')] },
  { label: 'D7 K\'s stored name blank: null', caller: (w) => { Object.assign(w.p.K, { name: '   ' }); return w.p.X; }, want: (w) => [entry(w.wsId, w.p.K, null)] },
  { label: 'D7 K\'s stored name empty: null', caller: (w) => { Object.assign(w.p.K, { name: '' }); return w.p.X; }, want: (w) => [entry(w.wsId, w.p.K, null)] },
];

/** FIX-DMFC-1 (OPERATOR NOTE 7209460757): the reads this PR adds to GET /community/me (lastLeft's). */
const NEW_READS = ['clientPurchase.findMany', 'communityWorkspace.findMany'];
/** A caller's former_coach_dms and every delegate read (model.method) that GET /community/me made for it, through a
 *  CommunityService over a recording view of the same store. */
async function meReads(w: World, u: User): Promise<{ dms: unknown; reads: string[] }> {
  const reads: string[] = [];
  const db = new Proxy(w.db, {
    get: (t, prop: string) => {
      const v = Reflect.get(t, prop) as unknown;
      if (typeof v === 'function') return (v as (...a: unknown[]) => unknown).bind(t);
      if (prop.startsWith('$') || prop === 'tables' || typeof v !== 'object' || v === null) return v;
      return new Proxy(v as Record<string, unknown>, {
        get: (d, m: string) => {
          const f = Reflect.get(d, m) as unknown;
          return typeof f !== 'function' ? f : (...a: unknown[]) => {
            reads.push(`${prop}.${m}`);
            return (f as (...x: unknown[]) => unknown)(...a);
          };
        },
      });
    },
  });
  const p = stub<PrismaService>(db);
  const me = new CommunityService(p, new CommunityRepository(p), w.safety, new CommunityAccessService(p));
  return { dms: stub<Record<string, unknown>>(await me.getMe(u)).former_coach_dms, reads };
}
/** D10, the rule's floor (R-a: a thread is kept only where she holds an active row in a space that is not public): with
 *  no such place in a community of a coach she has left, /me lists nothing and reads neither her plans nor a community
 *  list, as before this PR (B-E2E-1's world: test/community/community-me-auto-provision.spec.ts); with one, it does. */
const FLOOR: Array<{ label: string; caller: (w: World) => User; want: (w: World) => unknown[]; reads: string[] }> = [
  { label: 'D10 A, K\'s current client (her only place is her coach\'s): none, no new read', caller: (w) => w.p.A, want: () => [], reads: [] },
  {
    label: 'D10 a client with no coach and no row, a stamped plan from K: none, no new read',
    caller: (w) => {
      const n = w.user('student', 'New Client', null);
      w.db.seed('clientPurchase', { client_user_id: n.id, coach_user_id: w.p.K.id, moved_away_at: day(6) });
      return n;
    },
    want: () => [], reads: [],
  },
  { label: 'D10 U, K\'s former client whose only row is in a public space: none, no new read', caller: (w) => w.p.U, want: () => [], reads: [] },
  { label: 'D10 Z, K\'s former client whose only row was removed: none, no new read', caller: (w) => w.p.Z, want: () => [], reads: [] },
  { label: 'D10 X, an active row in S of K\'s community (she left K): K, named, after the new reads', caller: (w) => w.p.X, want: inW, reads: NEW_READS },
];

describe('DM-FORMER-COACH-BE D: GET /community/me keeps one former coach, the one she moved away from last, and names him', () => {
  let w: World;
  let x: Record<Extra, User>;
  beforeEach(async () => {
    w = await world();
    x = w.extras();
  });

  it.each(CAPPED)('$label', async (c) => {
    const u = c.caller(w, x);
    expect(await formerDms(w, u)).toEqual(c.want(w));
  });

  it.each(CAPPED.filter((c) => c.kept))('$label (the older coach\'s thread is still kept)', async (c) => {
    const u = c.caller(w, x);
    for (const [wsId, coach] of c.kept?.(w) ?? []) {
      expect([wsId, await throughFormerArm(w, u, wsId), await listed(w, u, wsId)]).toEqual([wsId, true, [coach.id]]);
    }
    expect(await formerDms(w, u)).toEqual([]);
  });

  it('D6. A coach who left (LS-DMFC-1 P1): her GET W/dms lists no thread, and /me lists nothing', async () => {
    purge(w, w.p.K, w.wsId);
    expect([await listed(w, w.p.X), await formerDms(w, w.p.X)]).toEqual([[], []]);
  });

  it.each(FLOOR)('$label', async (f) => {
    const u = f.caller(w);
    const { dms, reads } = await meReads(w, u);
    expect([dms, NEW_READS.filter((r) => reads.includes(r))]).toEqual([f.want(w), f.reads]);
  });

  it('D8. The one listed is always one b#1253 would list: its own GET W/dms answers through the former-client arm with that coach', async () => {
    twoKept(w, 0, 2);
    bought(w, w.p.K, day(6));
    const [only] = (await formerDms(w, w.p.X)) as Array<{ workspace_id: string; coach_user_id: string }>;
    expect(await throughFormerArm(w, w.p.X, only.workspace_id)).toBe(true);
    expect(await listed(w, w.p.X, only.workspace_id)).toEqual([only.coach_user_id]);
  });
});

describe('COMMUNITY-DM-FORMER-REACH-BE B: every DM push link names its community', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };

  it('B1. K to X, X to K and A to B in W, X to K2 in W3: data.deepLink and the row\'s deep_link carry ?workspace=<the thread\'s community>; the rest of the push as today', async () => {
    w.row(w.p.X, w.w3.space);
    w.dm(w.p.X, w.p.K2, w.w3.id, 'Thanks for the plan');
    const sends: Array<[User, User, string]> = [[w.p.K, w.p.X, w.wsId], [w.p.X, w.p.K, w.wsId], [w.p.A, w.p.B, w.wsId], [w.p.X, w.p.K2, w.w3.id]];
    const kind = NotificationKind.COMMUNITY_DM_RECEIVED;
    const defaults = COMMUNITY_PUSH_DEFAULTS[kind];
    for (const [from, to, wsId] of sends) {
      const before = [w.rows.length, w.outbox.length];
      const sent = await w.dmsvc.send(from, wsId, to.id, 'Checking in');
      await settle();
      const id = sent.message.id;
      const key = `community:${kind}:${to.id}:dm:${id}`;
      const link = `tgp://community/dm/${from.id}?workspace=${wsId}`;
      expect([w.rows.length - before[0], w.outbox.length - before[1]]).toEqual([1, 1]);
      expect(w.rows[w.rows.length - 1]).toEqual({
        user_id: to.id, kind, body: COMMUNITY_PUSH_BODIES[kind].privacyOn, channel: 'push', deep_link: link,
        payload: { idempotency_key: key, category: defaults.category, target_type: 'dm', target_id: id },
      });
      expect(w.outbox[w.outbox.length - 1]).toEqual({
        userId: to.id,
        title: COMMUNITY_PUSH_TITLES[kind],
        body: COMMUNITY_PUSH_BODIES[kind].privacyOn,
        data: { kind, category: defaults.category, target_type: 'dm', target_id: id, deepLink: link },
        opts: { kind, muteAllOnly: true, dedupeKey: key, otherUserId: from.id, community: { workspaceId: wsId } },
      });
    }
  });

  it('B2 (guard). The phone\'s parse (b#1247\'s copy, test/utils/phone-link-routes.ts) gives the new link the old link\'s target', () => {
    const sender = randomUUID();
    const target = (url: string) => {
      const path = incomingLinkPath(url);
      return path === null ? null : resolveAppLink(path, 'student');
    };
    const old = target(`tgp://community/dm/${sender}`);
    expect(old).toEqual(expect.objectContaining({ screen: 'CommunityDmThread', params: { recipientId: sender } }));
    expect(target(`tgp://community/dm/${sender}?workspace=${randomUUID()}`)).toEqual(old);
  });

  it('B3 (guard). A held DM push stops on a block or a ban as today; pushStillCurrent, the coach inbox and the InboxBlockRule keep a row with the new link', async () => {
    const db = stub<PrismaService>(w.db);
    const held = (to: User, from: User) => heldPushDropReason(db, to.id, { otherUserId: from.id, community: { workspaceId: w.wsId } }, new Date());
    expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual([null, null]);
    const unblock = block(w, w.p.X, w.p.K);
    try {
      expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual(['blocked', 'blocked']);
      // The block rule names tgp://messages/ links only; neither DM link starts with or equals any link it names.
      const named = JSON.stringify(await new InboxBlockRule(db).where(w.p.K.id)).match(/tgp:\/\/[^"]*/g) ?? [];
      for (const link of [`tgp://community/dm/${w.p.X.id}`, `tgp://community/dm/${w.p.X.id}?workspace=${w.wsId}`]) {
        expect([link, named.filter((n) => link.startsWith(n))]).toEqual([link, []]);
      }
    } finally {
      unblock();
    }
    const ban = w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: w.p.X.id, lifted_at: null });
    try {
      expect([await held(w.p.X, w.p.K), await held(w.p.K, w.p.X)]).toEqual(['banned', 'banned']);
    } finally {
      w.db.tables.communityWorkspaceBan = w.db.table('communityWorkspaceBan').filter((b) => b !== ban);
    }
    for (const link of [`tgp://community/dm/${w.p.X.id}`, `tgp://community/dm/${w.p.X.id}?workspace=${w.wsId}`]) {
      expect([link, [...CLIENT_LINKS, ...SESSION_LINKS].some((p) => link.startsWith(p))]).toEqual([link, false]);
      expect([link, await pushStillCurrent(db, w.p.K.id, { deepLink: link })]).toEqual([link, true]);
    }
  });
});

describe('COMMUNITY-DM-FORMER-REACH-BE C: the coach\'s own DM list names each row', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  /** The rows of `u`'s GET W/dms as [other person, other_display_name]; at 09a99e06 the name is undefined. */
  const names = async (u: User, limit?: string) =>
    (await w.dmsvc.listThreads(u, w.wsId, limit ? { limit } : {})).threads.map((t) => [t.other_user_id, stub<Record<string, unknown>>(t).other_display_name]);

  it('C1. K\'s list: X\'s row has X\'s stored name, A\'s row A\'s; an empty or blank stored name is null; rename X (padded) and the next list shows it trimmed', async () => {
    w.dm(w.p.A, w.p.K, w.wsId, 'Thanks for the plan');
    const empty = w.member('');
    w.dm(empty, w.p.K, w.wsId, 'Quick question');
    const blank = w.member('   ');
    w.dm(blank, w.p.K, w.wsId, 'Quick question');
    expect(await names(w.p.K)).toEqual([
      [blank.id, null], [empty.id, null], [w.p.A.id, 'Viewer Member'], [w.p.X.id, 'Former X'],
    ]);
    const undo = setField(w.p.X, { name: '  Sam Rivera  ' });
    try {
      expect((await names(w.p.K)).find(([id]) => id === w.p.X.id)).toEqual([w.p.X.id, 'Sam Rivera']);
    } finally {
      undo();
    }
  });

  it('C2. X\'s list (its K row), A\'s list, a member\'s list in W and POST .../dms for every caller: null', async () => {
    w.dm(w.p.A, w.p.K, w.wsId, 'Thanks for the plan');
    w.dm(w.p.A, w.p.B, w.wsId, 'See you at the session');
    expect(await names(w.p.X)).toEqual([[w.p.K.id, null]]);
    expect(await names(w.p.A)).toEqual([[w.p.B.id, null], [w.p.K.id, null]]);
    expect(await names(w.p.B)).toEqual([[w.p.A.id, null]]);
    const opens: Array<[User, User]> = [[w.p.K, w.p.X], [w.p.X, w.p.K], [w.p.K, w.p.A], [w.p.A, w.p.K], [w.p.A, w.p.B]];
    for (const [a, b] of opens) {
      const { thread } = await w.dmsvc.openThread(a, w.wsId, b.id);
      expect([a.name, b.name, stub<Record<string, unknown>>(thread).other_display_name]).toEqual([a.name, b.name, null]);
    }
  });

  /** b#1251's page case: limit=2 with two newer threads off the rule; X's row is kept before the cut. */
  const page = (v: World) => {
    const own = v.dm(v.p.A, v.p.K, v.wsId, 'Thanks for the plan');
    v.dm(v.p.X, v.p.K, v.wsId, 'One more thing');
    const coCoach = v.user('coach', 'Co Coach', null);
    v.row(coCoach, v.space.S, 'coach');
    v.dm(coCoach, v.p.K, v.wsId, 'Quick question');
    v.dm(v.p.T, v.p.K, v.wsId, 'Quick question');
    return own;
  };

  it('C3 (guard). K\'s list with limit=2 and two newer threads off the rule: the same rows, order and page as at 09a99e06; a block drops the row', async () => {
    page(w);
    const row = (other: User) => {
      const key = CommunityDmsRepository.dmKey(w.wsId, w.p.K.id, other.id);
      const last = w.db.table('communityMessage').filter((m) => m.dm_key === key)
        .reduce((a, b) => ((a.created_at as Date) > (b.created_at as Date) ? a : b));
      return { thread_id: key, workspace_id: w.wsId, other_user_id: other.id, created_at: null, last_message_at: (last.created_at as Date).toISOString() };
    };
    const strip = (t: Record<string, unknown>) => {
      const { other_display_name: _n, ...rest } = t;
      return rest;
    };
    const { threads } = await w.dmsvc.listThreads(w.p.K, w.wsId, { limit: '2' });
    expect(threads.map((t) => strip(stub<Record<string, unknown>>(t)))).toEqual([row(w.p.X), row(w.p.A)]);
    const unblock = block(w, w.p.A, w.p.K);
    try {
      expect(await listed(w, w.p.K, w.wsId, '2')).toEqual([w.p.X.id]);
    } finally {
      unblock();
    }
  });

  it('C3. The same page with the names added; a block: the row absent, the other named', async () => {
    page(w);
    expect(await names(w.p.K, '2')).toEqual([[w.p.X.id, 'Former X'], [w.p.A.id, 'Viewer Member']]);
    const unblock = block(w, w.p.K, w.p.A);
    try {
      expect(await names(w.p.K, '2')).toEqual([[w.p.X.id, 'Former X']]);
    } finally {
      unblock();
    }
  });
});
