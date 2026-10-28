// LS-1165R4 B1 (owner, DECISIONS #178-7 - op 1): a coach's removal of a post takes its search copy with it.
// Live, on the replayed migration chain, with the real services the routes call: the reindex route writes each
// post's search copy (its title and its body words), then coach A removes one post with DELETE and one with the
// report queue's Hide, and hides a reply with the queue's Hide (a reply has no DELETE route; a reply is never in
// search and the reindex route cannot put it there). A search by a removed title word or body word then finds
// nothing, for member V and for coach A; the live post is still found; the placeholders still show to V and the
// author O. Every 0 follows a 1: each word is found before its removal.
import { randomUUID } from 'crypto';
import { PrismaClient, type User } from '@prisma/client';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import type { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import type { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunitySearchController } from '../../src/community/search/community-search.controller';
import { CommunitySearchRepository } from '../../src/community/search/community-search.repository';
import { CommunitySearchService } from '../../src/community/search/community-search.service';
import { SearchIndexerService } from '../../src/community/search/search-indexer.service';
import type { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import type { PrismaService } from '../../src/prisma.service';
import { stub } from '../utils/trial-fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-removed-post-search-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'O' | 'V';
const PEOPLE: Key[] = ['A', 'O', 'V']; // the coach first: clients reference them
const ROLE = (k: Key) => (k === 'A' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('LS-1165R4 B1: a removed post leaves search with its words (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = stub<PrismaService>(prisma);
  const access = new CommunityAccessService(db);
  const safety = new CommunitySafetyService(db);
  const realtime = stub<CommunityRealtimeService>({ broadcastCommunityEvent: async () => undefined });
  const push = stub<CommunityNotificationsService>({ pushEnabled: () => false, sendCommunityPush: async () => undefined });
  const postsRepo = new CommunityPostsRepository(db);
  const messagesRepo = new CommunityMessagesRepository(db);
  const posts = new CommunityPostsService(access, postsRepo, messagesRepo, realtime, push, safety, new CommunityReactionsRepository(db));
  const moderation = new CommunityModerationService(access, new CommunityModerationRepository(db), messagesRepo, postsRepo,
    realtime, push, db, stub<VoiceUploadProvider>({ createSignedDownload: async () => null }));
  const searchRepo = new CommunitySearchRepository(db);
  const search = new CommunitySearchController(
    new CommunitySearchService(searchRepo, access, stub<AnalyticsService>({ capture: () => undefined }), safety),
    new SearchIndexerService(searchRepo), access, db);
  const id: Record<Key, string> = { A: randomUUID(), O: randomUUID(), V: randomUUID() };
  const ws = randomUUID();
  const mem = randomUUID();
  const run = randomUUID().slice(0, 8);
  const user = (k: Key) => stub<User>({ id: id[k], role: ROLE(k), coach_id: k === 'A' ? null : id.A });
  const as = (k: Key) => stub<AuthedRequest>({ user: user(k) });
  // What a search by `q` finds (post ids, sorted) for member V and for coach A.
  const finds = async (q: string) => {
    const found = async (k: Key) => (await search.query(as(k), ws, { q })).results.map((r) => r.targetId).sort();
    return { V: await found('V'), A: await found('A') };
  };
  const both = (ids: string[]) => ({ V: [...ids].sort(), A: [...ids].sort() });
  const byCoach = expect.objectContaining({ role: 'coach', user_id: id.A });

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${randomUUID()}, ${`removed-search-${id[k]}`}, ${`Person ${k}`}, ${ROLE(k)}::"Role", ${k === 'A' ? null : id.A})`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${ws}::uuid, ${id.A}, 'RLS workspace', ${`removed-search-${run}`}, now())`;
    await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
      VALUES ($1::uuid, $2::uuid, 'RLS mem', 'members'::"CommunitySpaceVisibility", 'active', now())`, mem, ws);
    for (const k of ['O', 'V'] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws, mem, id[k]);
    }
  });
  afterAll(() => prisma.$disconnect());

  it('a search by a removed title word or body word finds nothing, for a member and the coach; the placeholders show', async () => {
    const indexed = async (title: string, body: string) => {
      const p = (await posts.create(user('O'), ws, { title, body })).post;
      expect(await search.reindex(as('A'), ws, { kind: 'post', targetId: p.id, title, transcript: body }))
        .toEqual({ accepted: true, created: true });
      return p.id;
    };
    const direct = await indexed('Kettlebell swing plan', 'deadlift tempo');
    const queued = await indexed('Kettlebell clean drill', 'thruster grip');
    const live = await indexed('Kettlebell press ladder', 'goblet squat');
    const reply = (await posts.addComment(user('O'), live, 'burpee finisher')).comment.id;
    await expect(search.reindex(as('A'), ws, { kind: 'post', targetId: reply, title: 'burpee finisher' }))
      .rejects.toMatchObject({ status: 404 });
    const WORDS: Array<[string, string]> = [
      ['swing', direct], ['deadlift', direct], ['clean', queued], ['thruster', queued], ['press', live], ['goblet', live],
    ];
    for (const [q, p] of WORDS) expect({ q, found: await finds(q) }).toEqual({ q, found: both([p]) });
    expect(await finds('kettlebell')).toEqual(both([direct, queued, live]));
    expect(await finds('burpee')).toEqual(both([]));

    await posts.remove(user('A'), direct, true);
    for (const [type, target] of [['post', queued], ['comment', reply]] as const) {
      const r = await moderation.report(user('V'), type, target, 'harassment', undefined);
      expect((await moderation.act(user('A'), r.item.id, 'hide', undefined)).item.status).toBe('actioned');
    }

    for (const [q, p] of WORDS) expect({ q, found: await finds(q) }).toEqual({ q, found: both(p === live ? [live] : []) });
    expect(await finds('kettlebell')).toEqual(both([live]));
    expect(await finds('burpee')).toEqual(both([]));
    // No removed word is left in a search row (read without row security); the reply never had one.
    const rows = await prisma.communitySearchEntry.findMany({ where: { workspaceId: ws } });
    expect(Object.fromEntries(rows.map((r) => [r.targetId, [r.excerpt, r.softDeletedAt !== null]]))).toEqual({
      [direct]: ['', true], [queued]: ['', true], [live]: ['Kettlebell press ladder \u2014 goblet squat', false],
    });
    for (const k of ['V', 'O'] as const) {
      const hall = (await posts.list(user(k), ws, {}, true)).posts;
      for (const p of [direct, queued]) {
        expect(hall.find((x) => x.id === p)).toMatchObject({ title: null, body: null, removed_by: byCoach });
      }
      expect((await posts.listComments(user(k), live, true)).comments).toEqual([
        expect.objectContaining({ id: reply, body: null, removed_by: byCoach }),
      ]);
    }
  });
});
