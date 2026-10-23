// BLOCK-ALL-BE (agent 168), owner rule #168-4: "a ban from a space covers that space only. The banned person sees
// no messages in that space and cannot type there"; a block closes every conversation between the two people both
// ways. Live, on the replayed migration chain, with the real services: A and B coach; V and X are A's clients; X
// also writes in B's public space. The moderation Ban records the ban for A's community (community_workspace_bans).
// Every 0 follows a 1: each read runs before the ban (or block), after it, and after the unban (or unblock).
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { authorsWhoLeft } from '../../src/community/community-space-access';
import { CommunityCoachInboxRepository } from '../../src/community/inbox/community-coach-inbox.repository';
import { CommunityCoachInboxService } from '../../src/community/inbox/community-coach-inbox.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import { inBlockWith } from '../../src/messaging/block-pair';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('ban-block-rule-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'V' | 'X';
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, V: 'A', X: 'A' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('#168-4: a ban hides the banned author in that community; a block closes both ways', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const chat = new CommunityMessagesService(access, new CommunityMessagesRepository(db),
    stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined }), stub<PlanContextService>({}), safety,
    stub<CommunityNotificationsService>({ pushEnabled: () => false }));
  const inbox = new CommunityCoachInboxService(access, new CommunityCoachInboxRepository(db));
  const segments = new SegmentResolverService(db);
  const id = Object.fromEntries((['A', 'B', 'V', 'X', 'mV', 'mX', 'mXb'] as const).map((k) => [k, randomUUID()]));
  const ws = { A: randomUUID(), B: randomUUID() };
  const space = { cli: randomUUID(), pub: randomUUID() };
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: COACH[k] ? id[COACH[k] as Key] : null });
  const chatOf = async (k: Key, s: string) => (await chat.list(user(k), s, {})).messages.map((m) => m.id).sort();
  const byId = (k: Key, m: string) => chat.getOne(user(k), id[m]).then(() => 'ok', (e: { status?: number }) => e.status);
  const inboxOf = async (k: Key) => (await inbox.list(user(k), {})).items.map((i) => i.id).sort();
  const ban = (lifted: Date | null) => prisma.communityWorkspaceBan.upsert({
    where: { workspace_id_user_id: { workspace_id: ws.A, user_id: id.X } },
    create: { workspace_id: ws.A, user_id: id.X, banned_by_id: id.A },
    update: { lifted_at: lifted },
  });
  const sorted = (...keys: string[]) => keys.map((k) => id[k]).sort();

  beforeAll(async () => {
    for (const k of ['A', 'B', 'V', 'X'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`banblock-${id[k]}`}, ${`RLS ${k}`}, ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as Key] : null})`;
    }
    for (const c of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`banblock-${run}-${c}`}, now())`;
    }
    const spaces: Array<[string, string, string, Key[]]> = [[space.cli, ws.A, 'clients', ['V', 'X']], [space.pub, ws.B, 'public', ['X']]];
    for (const [s, w, visibility, members] of spaces) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'RLS space', $3::"CommunitySpaceVisibility", 'active', now())`, s, w, visibility);
      for (const k of members) {
        await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), w, s, id[k]);
      }
    }
    const rows: Array<[string, string, string, Key]> = [['mV', ws.A, space.cli, 'V'], ['mX', ws.A, space.cli, 'X'], ['mXb', ws.B, space.pub, 'X']];
    for (const [m, w, s, a] of rows) {
      await prisma.communityMessage.create({ data: { id: id[m], workspace_id: w, cohort_id: s, scope: 'cohort', sender_id: id[a], body: `RLS ${m}` } });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('a ban hides every row the banned person wrote in that community from everyone else; unban restores them', async () => {
    expect(await chatOf('V', space.cli)).toEqual(sorted('mV', 'mX'));
    expect(await byId('V', 'mX')).toBe('ok');
    expect(await inboxOf('A')).toEqual(sorted('mV', 'mX'));
    expect((await authorsWhoLeft(db, [space.cli])).length).toBe(0);
    await ban(null);
    expect(await chatOf('V', space.cli)).toEqual(sorted('mV'));
    expect(await chatOf('A', space.cli)).toEqual(sorted('mV'));
    expect(await byId('V', 'mX')).toBe(404);
    expect(await inboxOf('A')).toEqual(sorted('mV'));
    expect(await authorsWhoLeft(db, [space.cli])).toEqual([[space.cli, id.X]]);
    await ban(new Date());
    expect(await chatOf('V', space.cli)).toEqual(sorted('mV', 'mX'));
    expect(await byId('V', 'mX')).toBe('ok');
    expect(await inboxOf('A')).toEqual(sorted('mV', 'mX'));
  });

  it('the ban covers that community only: another coach\'s space still shows the banned person', async () => {
    await ban(null);
    expect(await chatOf('B', space.pub)).toEqual(sorted('mXb'));
    expect(await byId('B', 'mXb')).toBe('ok');
    await ban(new Date());
  });

  it('the banned person cannot read or type in that space; their coaching 1:1 thread is untouched; unban restores', async () => {
    const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: { status?: number }) => e.status);
    expect(await status(chat.list(user('X'), space.cli, {}))).toBe('ok');
    await ban(null);
    expect(await status(chat.list(user('X'), space.cli, {}))).toBe(404);
    expect(await status(chat.send(user('X'), space.cli, 'still here'))).toBe(404);
    expect(await inBlockWith(db, id.A, [id.X])).toEqual(new Set()); // a ban is not a block: the coaching chat stays open
    await ban(new Date());
    expect(await status(chat.list(user('X'), space.cli, {}))).toBe('ok');
  });

  it('a block either way hides the other person\'s rows (coach inbox included) and unblock restores them', async () => {
    expect(await inBlockWith(db, id.A, [id.V, id.X])).toEqual(new Set());
    await prisma.userBlock.create({ data: { blocker_id: id.X, blocked_id: id.V } }); // X blocked V
    expect(await chatOf('V', space.cli)).toEqual(sorted('mV'));
    expect(await chatOf('X', space.cli)).toEqual(sorted('mX'));
    await prisma.userBlock.create({ data: { blocker_id: id.V, blocked_id: id.A } }); // V blocked their coach
    expect(await inBlockWith(db, id.A, [id.V, id.X])).toEqual(new Set([id.V]));
    expect(await inBlockWith(db, id.V, [id.A, id.X])).toEqual(new Set([id.A, id.X]));
    expect(await inboxOf('A')).toEqual(sorted('mX'));
    // Broadcasts skip the pair whichever side blocked (V blocked A here; A blocks X next).
    const coachScope = { actorId: id.A, tenantId: id.A, clientIds: [id.V, id.X] };
    expect(await segments.blockedAmong(coachScope, [id.V, id.X])).toEqual(new Set([id.V]));
    await prisma.userBlock.create({ data: { blocker_id: id.A, blocked_id: id.X } });
    expect(await segments.blockedAmong(coachScope, [id.V, id.X])).toEqual(new Set([id.V, id.X]));
    await prisma.userBlock.deleteMany({ where: { blocker_id: id.A } });
    await prisma.userBlock.deleteMany({ where: { OR: [{ blocker_id: id.X }, { blocker_id: id.V }] } });
    expect(await chatOf('V', space.cli)).toEqual(sorted('mV', 'mX'));
    expect(await inboxOf('A')).toEqual(sorted('mV', 'mX'));
  });
});
