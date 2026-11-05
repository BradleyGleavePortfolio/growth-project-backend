// COUNT-DELETED-BE (owner ruling "Counts: approved", 10-30): a message, post, comment or reaction a person may not
// read never adds 1 to any count and never shows in a preview. Live, on the replayed migration chain, with the real
// readers: coach C; K (control) and A (author) are C's clients and each sent C one unread message. M is a member of
// C's clients space; K and A each reacted to C's post there. Each count reads 2 before a rule is applied, exactly 1
// under it (only K's row counts) and 2 again after it is undone. Rules that cannot reach a reader are named per case.
// The two "deleted message" cases at the end are LS-1185 AUDIT 6511964451 (B4) in their strict form: count 1.
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
import { CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import { CommandCenterService } from '../../src/coach/command-center/command-center.service';
import { loadHomeDay } from '../../src/coach/command-center/coach-home-day';
import { CoachHomeService } from '../../src/coach/home/coach-home.service';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import { CommunityReactionsService } from '../../src/community/reactions/community-reactions.service';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { DigestService } from '../../src/notifications/digest.service';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('count-deleted-be-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Rule = 'blocked by the viewer' | 'has blocked the viewer' | 'removed' | 'banned' | 'departed';

(DB_URL ? describe : describe.skip)('COUNT-DELETED-BE: a row the viewer may not read adds nothing to any count', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const safety = new CommunitySafetyService(db);
  const access = new CommunityAccessService(db);
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const postsRepo = new CommunityPostsRepository(db);
  const messagesRepo = new CommunityMessagesRepository(db);
  const reactionsRepo = new CommunityReactionsRepository(db);
  const reactions = new CommunityReactionsService(access, reactionsRepo, messagesRepo, postsRepo, realtime, safety);
  const posts = new CommunityPostsService(access, postsRepo, messagesRepo, realtime,
    stub<CommunityNotificationsService>({ pushEnabled: () => false }), safety, reactionsRepo);
  const of = <T extends object>(proto: T) => Object.assign(Object.create(proto), { prisma: db });
  const id = Object.fromEntries((['C', 'C2', 'K', 'A', 'M', 'mK', 'mA', 'post'] as const).map((k) => [k, randomUUID()]));
  const ws = randomUUID();
  const space = randomUUID();
  const run = randomUUID().slice(0, 8);
  const SINCE = new Date(0);
  const UNTIL = new Date('2100-01-01T00:00:00Z');
  const member = stub<User>({ id: id.M, role: 'student', coach_id: id.C });

  // Today, in a zone where it is not near midnight, so "today's" messages stay today for the whole run.
  const homeZone = () => (new Date().getUTCHours() >= 1 && new Date().getUTCHours() <= 22 ? 'UTC' : 'Asia/Tokyo');

  async function apply(rule: Rule, on: boolean): Promise<void> {
    switch (rule) {
      case 'blocked by the viewer':
      case 'has blocked the viewer':
        // Both viewers at once: the coach C (coaching counts) and the member M (reaction counts).
        for (const viewer of [id.C, id.M]) {
          const pair = rule === 'blocked by the viewer' ? { blocker_id: viewer, blocked_id: id.A } : { blocker_id: id.A, blocked_id: viewer };
          if (on) await prisma.userBlock.create({ data: pair });
          else await prisma.userBlock.deleteMany({ where: pair });
        }
        return;
      case 'removed':
        // MessageActionsService.delete keeps the row: deleted_at set, body and voice_url cleared.
        await prisma.coachMessage.update({
          where: { id: id.mA },
          data: on ? { deleted_at: new Date(), body: null, voice_url: null } : { deleted_at: null, body: 'words of A' },
        });
        return;
      case 'banned':
        if (on) await prisma.communityWorkspaceBan.create({ data: { workspace_id: ws, user_id: id.A, banned_by_id: id.C } });
        else await prisma.communityWorkspaceBan.deleteMany({ where: { workspace_id: ws, user_id: id.A } });
        return;
      case 'departed':
        await prisma.user.update({ where: { id: id.A }, data: { coach_id: on ? id.C2 : id.C } });
        return;
    }
  }

  const reactionCount = (rows: Array<{ emoji: string; count: number }>) => rows.find((r) => r.emoji === '👍')?.count ?? 0;

  const READS: Array<{ name: string; reader: string; rules: Rule[]; count: () => Promise<number> }> = [
    {
      name: 'Command Center inbox unread', reader: 'CommandCenterService.getInbox',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed', 'departed'],
      count: async () => (await of(CommandCenterService.prototype).getInbox(id.C, {})).total_unread,
    },
    {
      name: 'Command Center inbox rows', reader: 'CommandCenterService.getInbox',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed', 'departed'],
      count: async () => (await of(CommandCenterService.prototype).getInbox(id.C, {})).threads
        .length,
    },
    {
      name: 'Command Center unread tile', reader: 'CommandCenterService.getOverview',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed', 'departed'],
      count: async () => (await of(CommandCenterService.prototype).getOverview(id.C)).unread_messages,
    },
    {
      // The roster comes from the caller's scope, so a departure is the caller's (the overview's roster).
      name: 'Home Replies ring', reader: 'contactRings (through loadHomeDay)',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed'],
      count: async () => {
        const scope = { coachId: id.C, ownerCoachId: id.C, clientIds: [id.K, id.A], habits: [], workouts: [], weighIns: [], needsYou: [] };
        return (await loadHomeDay(db, scope, homeZone(), new Date())).rings.replies.received;
      },
    },
    {
      name: 'Home conversations to review', reader: 'CoachHomeService.countReview',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed', 'departed'],
      count: async () => (await of(CoachHomeService.prototype).countReview(id.C, SINCE, UNTIL)).totalConversations,
    },
    {
      name: 'coach digest unread', reader: 'DigestService._buildCoachDigestData',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed', 'departed'],
      count: async () => (await of(DigestService.prototype)._buildCoachDigestData(id.C, 'daily')).rosterStats.unreadMessages,
    },
    {
      // The roster comes from the caller (generate's roster read), so a departure is the caller's.
      name: 'Coach Brief unread threads', reader: 'CoachBriefService.aggregateSoloContext',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed'],
      count: async () => (await of(CoachBriefService.prototype).aggregateSoloContext(id.C, [id.K, id.A], 'UTC', '2026-10-30')).unreadThreads.length,
    },
    {
      // Owner 4b: a moved client's old thread stays with this coach, so departure does not apply.
      name: 'stored brief previews', reader: 'CoachBriefService.ownThreadPreviews',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'removed'],
      count: async () => {
        const items = (['K', 'A'] as const).map((k) => ({ type: 'message_unread', client_id: id[k], detail: `words of ${k}` }));
        const keep = await of(CoachBriefService.prototype).ownThreadPreviews(id.C, [{ brief_mode: 'solo_coach', action_items: items }]);
        return (keep(items) as unknown[]).length;
      },
    },
    {
      // An unreact deletes the row, so "removed" has no row to keep.
      name: 'post reaction count (viewExtras)', reader: 'CommunityReactionsRepository.listForTargets',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'banned', 'departed'],
      count: async () => reactionCount((await posts.getOne(member, id.post)).post.reactions),
    },
    {
      name: 'reaction endpoint count (visibleReactions)', reader: 'CommunityReactionsRepository.listForTarget',
      rules: ['blocked by the viewer', 'has blocked the viewer', 'banned', 'departed'],
      count: async () => reactionCount((await reactions.unreact(member, 'post', id.post, '🔥')).reactions),
    },
  ];

  beforeAll(async () => {
    const users: Array<[string, string, string | null]> = [['C', 'coach', null], ['C2', 'coach', null], ['K', 'student', 'C'], ['A', 'student', 'C'], ['M', 'student', 'C']];
    for (const [k, role, coach] of users) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`count-${run}-${k}@test.local`}, ${`Count ${k}`}, ${role}::"Role", ${coach ? id[coach] : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${ws}::uuid, ${id.C}, 'Count workspace', ${`count-${run}`}, now())`;
    await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
      VALUES ($1::uuid, $2::uuid, 'Count space', 'clients'::"CommunitySpaceVisibility", 'active', now())`, space, ws);
    for (const k of ['K', 'A', 'M']) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws, space, id[k]);
    }
    await prisma.communityPost.create({ data: { id: id.post, workspace_id: ws, cohort_id: space, scope: 'cohort', author_id: id.C, body: 'Count post' } });
    const at = new Date(Date.now() - 1000);
    for (const k of ['K', 'A']) {
      await prisma.coachMessage.create({ data: { id: id[`m${k}`], coach_id: id.C, client_id: id[k], sender_id: id[k], body: `words of ${k}`, created_at: at } });
      await prisma.communityResponse.create({ data: { workspace_id: ws, target_type: 'post', target_id: id.post, user_id: id[k], response_kind: '👍' } });
    }
  });
  afterAll(() => prisma.$disconnect());

  for (const read of READS) {
    for (const rule of read.rules) {
      it(`${read.name} (${read.reader}): ${rule} adds nothing; undoing it restores the count`, async () => {
        expect(await read.count()).toBe(2);
        await apply(rule, true);
        try {
          expect(await read.count()).toBe(1);
        } finally {
          await apply(rule, false);
        }
        expect(await read.count()).toBe(2);
      });
    }
  }

  // The stored "(voice message)" row: a deleted voice note has a null body like a live one, so only deleted_at tells.
  it('stored brief previews (CoachBriefService.ownThreadPreviews): a deleted voice message drops its stored row', async () => {
    const voice = { K: randomUUID(), A: randomUUID() };
    for (const k of ['K', 'A'] as const) {
      await prisma.coachMessage.create({ data: { id: voice[k], coach_id: id.C, client_id: id[k], sender_id: id[k], body: null, voice_url: `voice/${k}.m4a` } });
    }
    const stored = async () => {
      const items = [id.K, id.A].map((client_id) => ({ type: 'message_unread', client_id, detail: '(voice message)' }));
      const keep = await of(CoachBriefService.prototype).ownThreadPreviews(id.C, [{ brief_mode: 'solo_coach', action_items: items }]);
      return (keep(items) as unknown[]).length;
    };
    try {
      expect(await stored()).toBe(2);
      await prisma.coachMessage.update({ where: { id: voice.A }, data: { deleted_at: new Date(), voice_url: null } });
      expect(await stored()).toBe(1);
    } finally {
      await prisma.coachMessage.deleteMany({ where: { id: { in: [voice.K, voice.A] } } });
    }
  });

  // LS-1185 AUDIT 6511964451 (B4), strict: one live message and one deleted message count exactly 1.
  it('B4: a deleted message does not add to the Home conversations-to-review count', async () => {
    await apply('removed', true);
    try {
      expect((await of(CoachHomeService.prototype).countReview(id.C, SINCE, UNTIL)).totalConversations).toBe(1);
    } finally {
      await apply('removed', false);
    }
  });
  it('B4: a deleted message does not add to the coach digest unread count', async () => {
    await apply('removed', true);
    try {
      expect((await of(DigestService.prototype)._buildCoachDigestData(id.C, 'daily')).rosterStats.unreadMessages).toBe(1);
    } finally {
      await apply('removed', false);
    }
  });
});
