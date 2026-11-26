/**
 * FIX-1251-FORMER-BLOCK (b#1251, LS-1251R1 C1; owner 203-D51 option 1, #203-E99 "former can block"): a former client
 * can block their old coach on POST /community/blocks, and the block closes the thread they kept with that coach both
 * ways (the coach's next send is refused and pushes nothing). A current client still cannot block their current coach
 * (403 community.block.workspace_coach, today's words), and nor can a member who is not a student.
 * "Former" is the relation of app.community_dm_former_client (migration 20270502011600 migration.sql:71-72: a student
 * whose coach is not the community's coach); "current" is clientOf (src/community/community-public-row.ts:36).
 *
 * The real CommunitySafetyService, CommunityDmsService and CommunityAccessService over the in-memory Prisma double, with
 * the pushes and realtime pings captured. World (as test/community/community-dm-rules-be.spec.ts builds it, copied, not
 * imported): coach K owns W with spaces S (members), P (public) and Pk (package); coach L. A and B are K's clients in
 * S. X has a row in S and a thread with K, then X's coach becomes L; Y as X with no thread; Z as X with its row removed;
 * V as X and banned in W; U as X whose only row is in P; Q as X whose only row is in Pk (no purchase); T has no row and
 * a thread. Each case builds its own world. No sample message touches a sensitive topic.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { User } from '@prisma/client';
import { accessWorld, type AccessWorld } from '../access/member-content-fixture';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../../src/community/dms/community-dms.repository';
import { CommunitySafetyController } from '../../../src/community/safety/community-safety.controller';
import { clientsAmong } from '../../../src/community/community-public-row';
import { heldPushDropReason } from '../../../src/notifications/push/held-push-source';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';

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

type Key = 'K' | 'L' | 'A' | 'B' | 'X' | 'Y' | 'Z' | 'V' | 'U' | 'Q' | 'T';
interface Push { recipientId: string; deepLink?: string; otherUserId?: string; workspaceId?: string; targetId: string }

interface World extends AccessWorld {
  access: CommunityAccessService;
  dmsvc: CommunityDmsService;
  pushes: Push[];
  pings: unknown[];
  p: Record<Key, User>;
  space: { S: string; P: string; Pk: string };
  user(role: string, name: string, coachId: string | null): User;
  row(u: User, cohortId: string, role?: string, status?: string, workspaceId?: string): void;
  dm(from: User, to: User, body?: string): string;
}

async function world(): Promise<World> {
  const w = await accessWorld();
  Object.assign(w.db, { $executeRaw: async () => 0 });
  const prisma = stub<PrismaService>(w.db);
  const access = new CommunityAccessService(prisma);
  const pushes: Push[] = [];
  const pings: unknown[] = [];
  const realtime = stub<CommunityRealtimeService>({
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async (...args: unknown[]) => {
      pings.push(args);
    },
  });
  const push = stub<CommunityNotificationsService>({
    pushEnabled: () => true,
    sendCommunityPush: async (q: Push) => {
      pushes.push(q);
    },
  });
  const dmsvc = new CommunityDmsService(access, new CommunityDmsRepository(prisma), realtime, push, w.safety);
  const user = (role: string, name: string, coachId: string | null) =>
    stub<User>(w.db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  const row = (u: User, cohortId: string, role = 'student', status = 'active', workspaceId = w.wsId) => {
    w.db.seed('communityMembership', {
      workspace_id: workspaceId, cohort_id: cohortId, user_id: u.id, status, role, dm_enabled: null,
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
  const space = { S: w.cohortId, P: cohort('Open room', 'public'), Pk: cohort('Plan room', 'package') };
  const L = w.db.table('user').find((u) => u.name === 'Coach Two') as unknown as User;
  const K = w.coach;
  const p = { K, L, A: w.viewer, B: w.control } as Record<Key, User>;
  const former: Array<[Key, string | null, boolean]> = [
    ['X', space.S, true], ['Y', space.S, false], ['Z', space.S, true], ['V', space.S, true],
    ['U', space.P, true], ['Q', space.Pk, true], ['T', null, true],
  ];
  for (const [k, where, thread] of former) {
    const u = user('student', `Former ${k}`, K.id);
    if (where) row(u, where);
    if (thread) {
      dm(u, K, 'Thanks for the plan');
      dm(K, u, 'Glad it helps');
    }
    p[k] = u;
  }
  const z = w.db.table('communityMembership').find((m) => m.user_id === p.Z.id) as { status: string; removed_at: Date | null };
  z.status = 'removed';
  z.removed_at = new Date();
  w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: p.V.id, lifted_at: null });
  for (const [k] of former) (p[k] as { coach_id: string | null }).coach_id = L.id;
  return { ...w, access, dmsvc, pushes, pings, p, space, user, row, dm };
}

/** '200', or the status and code the call is refused with. */
async function outcome(q: Promise<unknown>): Promise<string> {
  const e: unknown = await q.then(() => null, (x: unknown) => x);
  if (e === null) return '200';
  if (!(e instanceof HttpException)) throw e;
  return `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
}

const COACH_403 = '403 community.block.workspace_coach';
const NOT_FOUND = '404 community.block.not_found';
const BY_YOU = '403 community.dm.blocked_by_you';
const BY_THEM = '403 community.dm.blocked_by_them';
const DM_404 = '404 community.dm.not_found';
const TODAYS_WORDS = {
  error: 'forbidden',
  code: 'community.block.workspace_coach',
  message: 'You cannot block your coach. You can report a message or post, or email the safety contact in Community safety.',
};

const blocks = (w: World, from: User, to: User) =>
  w.db.table('userBlock').filter((b) => b.blocker_id === from.id && b.blocked_id === to.id).length;

/** The other people of `u`'s DM list, or 'refused <status> <code>'. */
async function listed(w: World, u: User): Promise<string[] | string> {
  try {
    return (await w.dmsvc.listThreads(u, w.wsId, {})).threads.map((t) => t.other_user_id);
  } catch (e) {
    if (e instanceof HttpException) return `refused ${e.getStatus()} ${(e.getResponse() as { code?: string }).code}`;
    throw e;
  }
}

/** What K and X each get from open, send and their lists, at one moment. */
async function snapshot(w: World): Promise<Record<string, string>> {
  const { K, X } = w.p;
  const kList = await listed(w, K);
  const xList = await listed(w, X);
  return {
    KopenX: await outcome(w.dmsvc.openThread(K, w.wsId, X.id)),
    KsendX: await outcome(w.dmsvc.send(K, w.wsId, X.id, 'Checking in')),
    XopenK: await outcome(w.dmsvc.openThread(X, w.wsId, K.id)),
    XsendK: await outcome(w.dmsvc.send(X, w.wsId, K.id, 'Checking in')),
    KlistsX: Array.isArray(kList) ? String(kList.includes(X.id)) : kList,
    XlistsK: Array.isArray(xList) ? String(xList.includes(K.id)) : xList,
  };
}
const OPEN = { KopenX: '200', KsendX: '200', XopenK: '200', XsendK: '200', KlistsX: 'true', XlistsK: 'true' };
const HERS = { KopenX: BY_THEM, KsendX: BY_THEM, XopenK: BY_YOU, XsendK: BY_YOU, KlistsX: 'false', XlistsK: 'false' };
const OUT = { KopenX: DM_404, KsendX: DM_404, XopenK: DM_404, XsendK: DM_404, KlistsX: 'false', XlistsK: 'refused 404 community.dm.not_found' };

describe('FIX-1251-FORMER-BLOCK: a former client blocks the old coach (203-D51 op 1)', () => {
  it('a. X (former, row in S, thread with K) blocks K: { blocked_user_id: K, blocked: true }, one row; the route answers 200', async () => {
    const w = await world();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, CommunitySafetyController.prototype.block)).toBe(200);
    await expect(w.safety.block(w.p.X, w.p.K.id)).resolves.toEqual({ blocked_user_id: w.p.K.id, blocked: true });
    expect(blocks(w, w.p.X, w.p.K)).toBe(1);
  });

  it('b. after X\'s block: K\'s send 403 blocked_by_them with no row, no ping, no push; a held push is dropped; X 403 blocked_by_you; gone from both lists', async () => {
    const w = await world();
    const { K, X } = w.p;
    expect(await snapshot(w)).toEqual(OPEN);
    await w.safety.block(X, K.id);
    const rows = w.db.table('communityMessage').length;
    const [pushes, pings] = [w.pushes.length, w.pings.length];
    expect(await outcome(w.dmsvc.send(K, w.wsId, X.id, 'Glad it helps'))).toBe(BY_THEM);
    expect(await outcome(w.dmsvc.openThread(K, w.wsId, X.id))).toBe(BY_THEM);
    expect(await outcome(w.dmsvc.listThread(K, w.wsId, X.id, {}))).toBe(BY_THEM);
    expect(await outcome(w.dmsvc.openThread(X, w.wsId, K.id))).toBe(BY_YOU);
    expect(await outcome(w.dmsvc.send(X, w.wsId, K.id, 'Thanks'))).toBe(BY_YOU);
    // What X can still read of the thread under her own block: what the head gives any blocked pair (recorded).
    expect(await outcome(w.dmsvc.listThread(X, w.wsId, K.id, {}))).toBe(BY_YOU);
    expect(w.db.table('communityMessage')).toHaveLength(rows);
    expect([w.pushes.length, w.pings.length]).toEqual([pushes, pings]);
    const db = stub<PrismaService>(w.db);
    const held = (to: User, from: User) => heldPushDropReason(db, to.id, { otherUserId: from.id, community: { workspaceId: w.wsId } }, new Date());
    expect([await held(X, K), await held(K, X)]).toEqual(['blocked', 'blocked']);
    expect(await listed(w, K)).not.toContain(X.id);
    expect(await listed(w, X)).toEqual([]);
  });

  it('c. X unblocks: the thread opens both ways again and K\'s next send pushes once', async () => {
    const w = await world();
    const { K, X } = w.p;
    await w.safety.block(X, K.id);
    await expect(w.safety.unblock(X, K.id)).resolves.toEqual({ blocked_user_id: K.id, blocked: false });
    expect(blocks(w, X, K)).toBe(0);
    const before = w.pushes.length;
    await w.dmsvc.send(K, w.wsId, X.id, 'Glad it helps');
    expect(w.pushes.slice(before).map((q) => [q.recipientId, q.deepLink])).toEqual([[X.id, `tgp://community/dm/${K.id}?workspace=${w.wsId}`]]);
    expect(await snapshot(w)).toEqual(OPEN);
  });

  it('d. X blocks K twice: one row', async () => {
    const w = await world();
    await w.safety.block(w.p.X, w.p.K.id);
    await w.safety.block(w.p.X, w.p.K.id);
    expect(blocks(w, w.p.X, w.p.K)).toBe(1);
  });

  it('e. A (K\'s current client) blocks K: 403 community.block.workspace_coach with today\'s words, no row', async () => {
    const w = await world();
    const e: unknown = await w.safety.block(w.p.A, w.p.K.id).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect([(e as HttpException).getStatus(), (e as HttpException).getResponse()]).toEqual([403, TODAYS_WORDS]);
    expect(await outcome(w.safety.block(w.p.B, w.p.K.id))).toBe(COACH_403);
    expect(blocks(w, w.p.A, w.p.K) + blocks(w, w.p.B, w.p.K)).toBe(0);
  });

  it('f. X back on K\'s roster: her block of K is refused 403 (current again); her block from before still closes the thread until she unblocks', async () => {
    const w = await world();
    const { K, X } = w.p;
    (X as { coach_id: string | null }).coach_id = K.id;
    expect(await outcome(w.safety.block(X, K.id))).toBe(COACH_403);
    (X as { coach_id: string | null }).coach_id = w.p.L.id;
    await w.safety.block(X, K.id);
    (X as { coach_id: string | null }).coach_id = K.id;
    expect(await outcome(w.safety.block(X, K.id))).toBe(COACH_403);
    expect(blocks(w, X, K)).toBe(1);
    expect(await snapshot(w)).toEqual(HERS);
    await w.safety.unblock(X, K.id);
    expect(await snapshot(w)).toEqual(OPEN);
  });

  it('g. a student with no coach at all who holds a row in W blocks K: written', async () => {
    const w = await world();
    const n = w.user('student', 'No Coach', null);
    w.row(n, w.space.S);
    expect(await outcome(w.safety.block(n, w.p.K.id))).toBe('200');
  });

  it('h. the PR\'s other formers: Y, Z, V, U and Q (each holds a row in W) blocked written; T (no row) 404 as today', async () => {
    const w = await world();
    const got: Record<string, string> = {};
    for (const k of ['Y', 'Z', 'V', 'U', 'Q', 'T'] as const) got[k] = await outcome(w.safety.block(w.p[k], w.p.K.id));
    expect(got).toEqual({ Y: '200', Z: '200', V: '200', U: '200', Q: '200', T: NOT_FOUND });
  });

  it('i. not a client, as today: a coach-role member with a coach row in S 403; a student with an assistant row whose coach is not K: written', async () => {
    const w = await world();
    const coCoach = w.user('coach', 'Co Coach', null);
    w.row(coCoach, w.space.S, 'coach');
    w.dm(coCoach, w.p.K, 'Quick question');
    const helper = w.user('student', 'Helper Student', w.p.L.id);
    w.row(helper, w.space.S, 'assistant');
    const owner = w.user('owner', 'Platform Owner', null);
    w.row(owner, w.space.S, 'coach');
    const subCoach = w.user('sub_coach', 'Sub Coach', w.p.K.id);
    w.row(subCoach, w.space.S, 'assistant');
    expect({
      coCoach: await outcome(w.safety.block(coCoach, w.p.K.id)),
      owner: await outcome(w.safety.block(owner, w.p.K.id)),
      subCoach: await outcome(w.safety.block(subCoach, w.p.K.id)),
      helper: await outcome(w.safety.block(helper, w.p.K.id)),
    }).toEqual({ coCoach: COACH_403, owner: COACH_403, subCoach: COACH_403, helper: '200' });
  });

  it('j. unchanged neighbours: self 400; a stranger 404; K blocks X; A blocks B; X blocks L in L\'s own community 403; X blocks L with no row there 404', async () => {
    const w = await world();
    const { K, L, A, B, X } = w.p;
    const stranger = w.user('student', 'Stranger', null);
    expect(await outcome(w.safety.block(X, X.id))).toBe('400 community.block.self');
    expect(await outcome(w.safety.block(X, stranger.id))).toBe(NOT_FOUND);
    expect(await outcome(w.safety.block(X, L.id))).toBe(NOT_FOUND);
    expect(await outcome(w.safety.block(K, X.id))).toBe('200');
    expect(await outcome(w.safety.block(A, B.id))).toBe('200');
    const w2 = w.db.seed('communityWorkspace', { coach_id: L.id, name: 'Second hall', dm_enabled_default: true, archived_at: null }).id as string;
    const s2 = w.db.seed('communityCohort', { workspace_id: w2, name: 'Second room', visibility: 'members', status: 'active', archived_at: null }).id as string;
    w.row(X, s2, 'student', 'active', w2);
    expect(await outcome(w.safety.block(X, L.id))).toBe(COACH_403);
    // K's current client who shares only L's community with K (K holds a coach row there) and holds no row in W: the
    // refusal is for the coach's own community only (the membership arm), so this is written, as today.
    const elsewhere = w.user('student', 'Elsewhere Client', K.id);
    w.row(elsewhere, s2, 'student', 'active', w2);
    w.row(K, s2, 'coach', 'active', w2);
    expect(await outcome(w.safety.block(elsewhere, K.id))).toBe('200');
  });

  it('k. agreement: nobody formerClientsIn keeps a thread for is refused the block; nobody clientsAmong calls K\'s client with a row in W can block K', async () => {
    const w = await world();
    const extra = {
      noCoach: w.user('student', 'No Coach', null),
      helper: w.user('student', 'Helper Student', w.p.L.id),
      coCoach: w.user('coach', 'Co Coach', null),
      rejoined: w.user('student', 'Rejoined', w.p.L.id),
    };
    for (const u of Object.values(extra)) {
      w.row(u, w.space.S, u.role === 'coach' ? 'coach' : u === extra.helper ? 'assistant' : 'student');
      w.dm(u, w.p.K, 'Quick question');
    }
    (extra.rejoined as { coach_id: string | null }).coach_id = w.p.K.id;
    const people: Array<[string, User]> = [
      ...(['A', 'B', 'X', 'Y', 'Z', 'V', 'U', 'Q', 'T'] as const).map((k) => [k, w.p[k]] as [string, User]),
      ...Object.entries(extra),
    ];
    const prisma = stub<PrismaService>(w.db);
    const rows: Array<[string, boolean, boolean, boolean, string]> = [];
    for (const [label, u] of people) {
      const kept = (await w.access.formerClientsIn(w.wsId, [[w.p.K.id, u.id]])).has(u.id);
      const current = (await clientsAmong(prisma, w.p.K.id, [u.id])).has(u.id);
      const inW = w.db.table('communityMembership').some((m) => m.user_id === u.id && m.workspace_id === w.wsId);
      rows.push([label, kept, current, inW, await outcome(w.safety.block(u, w.p.K.id))]);
    }
    expect(rows.filter(([, kept, , , got]) => kept && got !== '200')).toEqual([]);
    expect(rows.filter(([, , current, inW, got]) => current && inW && got !== COACH_403)).toEqual([]);
    // The table itself, so a change to who is kept or current shows here too.
    expect(Object.fromEntries(rows.map(([label, kept, current, , got]) => [label, `${kept ? 'kept' : '-'} ${current ? 'current' : '-'} ${got}`]))).toEqual({
      A: `- current ${COACH_403}`, B: `- current ${COACH_403}`, X: 'kept - 200', Y: '- - 200', Z: '- - 200', V: '- - 200',
      U: '- - 200', Q: '- - 200', T: `- - ${NOT_FOUND}`, noCoach: 'kept - 200', helper: 'kept - 200',
      coCoach: `- - ${COACH_403}`, rejoined: `- current ${COACH_403}`,
    });
  });
});

describe('FIX-1251-FORMER-BLOCK: the sequence table (what open, send and both lists answer after every step)', () => {
  it('X blocks K, X rejoins K\'s roster, X leaves again, X unblocks', async () => {
    const w = await world();
    const { K, L, X } = w.p;
    const coach = (id: string) => ((X as { coach_id: string | null }).coach_id = id);
    const steps: Record<string, Record<string, string>> = {};
    await w.safety.block(X, K.id);
    steps.blocked = await snapshot(w);
    coach(K.id);
    steps.rejoined = await snapshot(w);
    steps.blockAgain = { again: await outcome(w.safety.block(X, K.id)) };
    coach(L.id);
    steps.leftAgain = await snapshot(w);
    await w.safety.unblock(X, K.id);
    steps.unblocked = await snapshot(w);
    expect(steps).toEqual({ blocked: HERS, rejoined: HERS, blockAgain: { again: COACH_403 }, leftAgain: HERS, unblocked: OPEN });
  });

  it('X blocks K and rejoins, then unblocks: today\'s arm, the thread listed once each side', async () => {
    const w = await world();
    const { K, X } = w.p;
    await w.safety.block(X, K.id);
    (X as { coach_id: string | null }).coach_id = K.id;
    await w.safety.unblock(X, K.id);
    expect(await snapshot(w)).toEqual(OPEN);
    expect(((await listed(w, K)) as string[]).filter((id) => id === X.id)).toHaveLength(1);
  });

  it('K blocks X first, then X blocks K, then K unblocks: still closed by hers; then X unblocks: open', async () => {
    const w = await world();
    const { K, X } = w.p;
    const steps: Record<string, Record<string, string>> = {};
    await w.safety.block(K, X.id);
    steps.kBlocked = await snapshot(w);
    await w.safety.block(X, K.id);
    steps.both = await snapshot(w);
    await w.safety.unblock(K, X.id);
    steps.kUnblocked = await snapshot(w);
    await w.safety.unblock(X, K.id);
    steps.xUnblocked = await snapshot(w);
    const HIS = { KopenX: BY_YOU, KsendX: BY_YOU, XopenK: BY_THEM, XsendK: BY_THEM, KlistsX: 'false', XlistsK: 'false' };
    // Both blocks: each is told it is their own block (assertDmAllowed asks the caller's own row first).
    const BOTH = { ...HIS, XopenK: BY_YOU, XsendK: BY_YOU };
    expect(steps).toEqual({ kBlocked: HIS, both: BOTH, kUnblocked: HERS, xUnblocked: OPEN });
  });

  it('X blocks K, then K bans X, then the ban is lifted: out while banned; closed by her block once lifted', async () => {
    const w = await world();
    const { K, X } = w.p;
    const steps: Record<string, Record<string, string>> = {};
    await w.safety.block(X, K.id);
    const ban = w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: X.id, lifted_at: null }) as { lifted_at: Date | null };
    steps.banned = await snapshot(w);
    steps.blockWhileBanned = { again: await outcome(w.safety.block(X, K.id)) };
    ban.lifted_at = new Date();
    steps.lifted = await snapshot(w);
    expect(steps).toEqual({ banned: OUT, blockWhileBanned: { again: '200' }, lifted: HERS });
  });

  it('X blocks K, then K removes X\'s row: out of the pair; her block stays and can be made again', async () => {
    const w = await world();
    const { K, X } = w.p;
    await w.safety.block(X, K.id);
    const m = w.db.table('communityMembership').find((r) => r.user_id === X.id) as { status: string; removed_at: Date | null };
    m.status = 'removed';
    m.removed_at = new Date();
    expect(await snapshot(w)).toEqual(OUT);
    expect(await outcome(w.safety.block(X, K.id))).toBe('200');
    expect(blocks(w, X, K)).toBe(1);
  });
});
