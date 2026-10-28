/**
 * Community UGC safety (Apple 1.2) — end-to-end flow through the REAL
 * community services and repositories over an in-memory Prisma.
 *
 * The live-DB community e2e specs are env-gated and skipped in CI, so this
 * spec is the CI-run proof that the whole loop works: objectionable-content
 * filter on every write surface, report with a reason, the coach's enriched
 * flagged queue at the route the app calls, hide / warn / ban with real
 * effects, block hiding a user's content everywhere for the blocker, and the
 * published contact path. Route metadata (paths, roles, flag guard) is
 * asserted from the controllers so the mobile URLs cannot drift again.
 */
import 'reflect-metadata';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../../src/community/dms/community-dms.repository';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunityModerationController } from '../../../src/community/moderation/community-moderation.controller';
import { CommunityChallengesService } from '../../../src/community/challenges/community-challenges.service';
import { CommunityChallengesRepository } from '../../../src/community/challenges/community-challenges.repository';
import {
  COMMUNITY_REPORT_REASONS,
  CommunitySafetyService,
} from '../../../src/community/safety/community-safety.service';
import { CommunitySafetyController } from '../../../src/community/safety/community-safety.controller';
import { CommunitySearchController } from '../../../src/community/search/community-search.controller';
import { CommunitySearchRepository } from '../../../src/community/search/community-search.repository';
import type { CommunitySearchService } from '../../../src/community/search/community-search.service';
import { SearchIndexerService } from '../../../src/community/search/search-indexer.service';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import type { PrismaService } from '../../../src/prisma.service';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import { InMemoryPrisma } from './in-memory-prisma';
import { SUPPORT_EMAIL } from '../../../src/public-pages/trust-pages.html';

function stub<T>(v: unknown): T {
  return v as T;
}

describe('community UGC safety flow (Apple 1.2)', () => {
  let db: InMemoryPrisma;
  let prisma: PrismaService;
  let safety: CommunitySafetyService;
  let posts: CommunityPostsService;
  let messages: CommunityMessagesService;
  let dms: CommunityDmsService;
  let moderation: CommunityModerationService;
  let push: { sendCommunityPush: jest.Mock };

  let coach: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let otherCoach: User;
  let wsId: string;
  let cohortId: string;

  const realtime = {
    channels: {
      cohort: () => 'cohort',
      workspace: () => 'workspace',
      user: () => 'user',
      moderation: () => 'moderation',
    },
    cohortShard: () => 0,
    broadcastCommunityEvent: jest.fn(async () => undefined),
  };

  function user(role: string, name: string): User {
    const coachId = role === 'student' ? coach.id : null;
    return stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  }

  beforeEach(() => {
    db = new InMemoryPrisma();
    prisma = stub<PrismaService>(db);
    coach = user('coach', 'Coach One');
    alice = user('student', 'Alice Member');
    bob = user('student', 'Bob Member');
    carol = user('student', 'Carol Member');
    otherCoach = user('coach', 'Other Coach');
    const ws = db.seed('communityWorkspace', {
      coach_id: coach.id,
      name: 'Hall',
      dm_enabled_default: true,
      archived_at: null,
    });
    wsId = ws.id as string;
    db.seed('communityWorkspace', {
      coach_id: otherCoach.id,
      name: 'Elsewhere',
      dm_enabled_default: true,
      archived_at: null,
    });
    const cohort = db.seed('communityCohort', { workspace_id: wsId, name: 'Spring plan' });
    cohortId = cohort.id as string;
    for (const u of [alice, bob, carol]) {
      db.seed('communityMembership', {
        workspace_id: wsId,
        cohort_id: cohortId,
        user_id: u.id,
        status: 'active',
        role: 'member',
        dm_enabled: null,
        removed_at: null,
      });
    }

    push = { sendCommunityPush: jest.fn(async () => undefined) };
    const access = new CommunityAccessService(prisma);
    const postsRepo = new CommunityPostsRepository(prisma);
    const msgRepo = new CommunityMessagesRepository(prisma);
    safety = new CommunitySafetyService(prisma);
    const rt = stub<CommunityRealtimeService>(realtime);
    const np = stub<CommunityNotificationsService>(push);
    posts = new CommunityPostsService(
      access,
      postsRepo,
      msgRepo,
      rt,
      np,
      safety,
      new CommunityReactionsRepository(prisma),
    );
    messages = new CommunityMessagesService(
      access,
      msgRepo,
      rt,
      stub<PlanContextService>({ validate: async () => null }),
      safety,
      stub<CommunityNotificationsService>({
        pushEnabled: () => false,
        sendCommunityPush: async () => undefined,
      }),
    );
    dms = new CommunityDmsService(access, new CommunityDmsRepository(prisma), rt, np, safety);
    moderation = new CommunityModerationService(
      access,
      new CommunityModerationRepository(prisma),
      msgRepo,
      postsRepo,
      rt,
      np,
      prisma,
      stub<VoiceUploadProvider>({ createSignedDownload: async () => null }),
    );
  });

  // ── objectionable-content filter ─────────────────────────────────────────

  it('rejects objectionable text on post, comment, cohort message, edit and DM before writing', async () => {
    const before = db.table('communityMessage').length;
    await expect(
      posts.create(coach, wsId, { title: 'Week one', body: 'kill yourself' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const post = await posts.create(coach, wsId, { title: 'Week one', body: 'Welcome' });
    await expect(posts.addComment(alice, post.post.id, 'kys')).rejects.toMatchObject({
      response: { code: 'community.content.rejected' },
    });
    await expect(messages.send(alice, cohortId, 'f.u.c.k you')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    const ok = await messages.send(alice, cohortId, 'Morning session done');
    await expect(messages.edit(alice, ok.message.id, 'go die')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(dms.send(alice, wsId, bob.id, 'send nudes')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    // only the one acceptable cohort message was written
    expect(db.table('communityMessage').length).toBe(before + 1);
    expect(db.table('communityPost').length).toBe(1);
  });

  // ── report -> flagged queue -> hide / warn / ban ─────────────────────────

  it('report with a reason lands in the coach flagged queue enriched for the app', async () => {
    const m = await messages.send(bob, cohortId, 'Buy my supplements at this link');
    const report = await moderation.report(alice, 'message', m.message.id, 'spam', 'twice today');
    expect(report.item.status).toBe('open');

    const flagged = await moderation.listFlagged(coach, {});
    expect(flagged.items).toHaveLength(1);
    expect(flagged.items[0]).toMatchObject({
      id: report.item.id,
      target_type: 'message',
      target_id: m.message.id,
      content: 'Buy my supplements at this link',
      author_user_id: bob.id,
      author_name: 'Bob Member',
      cohort_name: 'Spring plan',
      reason: 'spam',
    });
    // another workspace's coach and a member never see it
    expect((await moderation.listFlagged(otherCoach, {})).items).toHaveLength(0);
    await expect(moderation.listFlagged(alice, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  // FR-1165R (LS-1165 B1/B2, #174-4): the queue's Hide is the same removal as
  // the coach's direct DELETE: on the next read, the attributed placeholder
  // with no content; one author notice; the photo's erasure recorded; one
  // live removal ping to the space.
  it.each(['text', 'photo'] as const)('hide of a %s message leaves the attributed placeholder and closes the item', async (kind) => {
    const id =
      kind === 'text'
        ? (await messages.send(bob, cohortId, 'rude but not filtered')).message.id
        : String(db.seed('communityMessage', { workspace_id: wsId, cohort_id: cohortId, scope: 'cohort', kind: 'image', sender_id: bob.id, body: 'rude caption', visibility: 'visible', deleted_at: null, plan_context_type: null }).id);
    if (kind === 'photo') {
      db.seed('communityMessageImage', { message_id: id, cohort_id: cohortId, author_id: bob.id, storage_key: `${bob.id}/${cohortId}-1.sent.jpg`, width: 1, height: 1 });
    }
    const r = await moderation.report(alice, 'message', id, 'harassment', undefined);
    realtime.broadcastCommunityEvent.mockClear();
    const acted = await moderation.act(coach, r.item.id, 'hide', undefined);
    expect(acted.item.status).toBe('actioned');
    const row = (await messages.list(alice, cohortId, {})).messages.find((x) => x.id === id);
    expect(row).toMatchObject({ deleted: true, body: null, voice_note: null, removed_by: { role: 'coach', user_id: coach.id, name: expect.any(String) } });
    expect(JSON.stringify(row)).not.toMatch(/rude|\.jpg|https?:/);
    expect(db.table('communityMessage').find((x) => x.id === id)).toMatchObject({ body: null, removed_by_user_id: coach.id });
    expect(db.table('notification').filter((n) => n.user_id === bob.id)).toHaveLength(1);
    expect(push.sendCommunityPush.mock.calls.filter(([p]) => p.recipientId === bob.id)).toHaveLength(1);
    if (kind === 'photo') {
      const target = `${bob.id}/${cohortId}-1.sent.jpg`;
      expect(db.table('communityVoiceErasure')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'image_object', target, reason: 'moderation' })]));
    }
    const pings = (realtime.broadcastCommunityEvent.mock.calls as unknown[][]).filter((c) => c[1] === 'community.message.updated');
    expect(pings).toEqual([[
      { workspaceId: wsId, cohortId },
      'community.message.updated',
      expect.objectContaining({ id, workspaceId: wsId, cohortId, authorId: bob.id, removedBy: { role: 'coach', userId: coach.id } }),
      { distinctId: coach.id, channelKind: 'cohort' },
    ]]);
    expect((await moderation.listFlagged(coach, {})).items).toHaveLength(0);
  });

  // FR-1165R3 (owner B "3.) b", LS-1165R2 B1): a coach's removal of a post,
  // a post comment or a challenge comment is the attributed placeholder for
  // the phone that asks (REMOVED_ROWS_HEADER, REMOVED-BY-M3); today's phone,
  // which does not ask, keeps today's behaviour (left out).
  const postPing = (id: string) => [
    { workspaceId: wsId, cohortId: null },
    'community.post.updated',
    { id, workspaceId: wsId, updatedAt: expect.any(String) },
    { distinctId: coach.id, channelKind: 'workspace' },
  ];
  const byCoach = () => ({ role: 'coach', user_id: coach.id, name: expect.any(String) });

  it("a coach's DELETE of a member's post leaves the placeholder, tells the author once and pings the post", async () => {
    const p = (await posts.create(bob, wsId, { title: 'Rude title', body: 'rude words' })).post;
    realtime.broadcastCommunityEvent.mockClear();
    const del = await posts.remove(coach, p.id, true);
    expect(del.post).toMatchObject({ id: p.id, deleted: true, title: null, body: null, removed_by: byCoach() });
    expect(db.table('communityPost').find((x) => x.id === p.id)).toMatchObject({ title: null, body: null, removed_by_user_id: coach.id });
    const row = (await posts.list(alice, wsId, {}, true)).posts.find((x) => x.id === p.id);
    expect(row).toMatchObject({ deleted: true, title: null, body: null, pinned: false, reactions: [], removed_at: expect.any(String), removed_by: byCoach() });
    expect(JSON.stringify(row)).not.toMatch(/rude/i);
    expect((await posts.getOne(alice, p.id, true)).post.removed_by).toEqual(byCoach());
    expect((await posts.listComments(alice, p.id, true)).comments).toEqual([]);
    // Today's phone: left out, as before.
    expect((await posts.list(alice, wsId, {})).posts.map((x) => x.id)).not.toContain(p.id);
    await expect(posts.getOne(alice, p.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.table('notification').filter((n) => n.user_id === bob.id)).toHaveLength(1);
    expect(realtime.broadcastCommunityEvent.mock.calls).toEqual([postPing(p.id)]);
    // A second DELETE finds nothing; an author's own delete still vanishes.
    await expect(posts.remove(coach, p.id, true)).rejects.toBeInstanceOf(NotFoundException);
    const own = (await posts.create(bob, wsId, { title: 'Mine', body: 'mine' })).post;
    await posts.remove(bob, own.id, true);
    expect((await posts.list(alice, wsId, {}, true)).posts.map((x) => x.id)).not.toContain(own.id);
    expect(db.table('notification').filter((n) => n.user_id === bob.id)).toHaveLength(1);
  });

  it('the queue Hide of a post and of a post comment leaves placeholders and pings the post once each', async () => {
    const host = (await posts.create(coach, wsId, { title: 'Check in', body: 'How was the week' })).post;
    const c = (await posts.addComment(bob, host.id, 'rude reply')).comment;
    const kept = (await posts.addComment(carol, host.id, 'kind reply')).comment;
    const p = (await posts.create(bob, wsId, { title: 'Mine', body: 'rude post' })).post;
    for (const [type, id, pinged] of [['comment', c.id, host.id], ['post', p.id, p.id]] as const) {
      const r = await moderation.report(alice, type, id, 'harassment', undefined);
      realtime.broadcastCommunityEvent.mockClear();
      expect((await moderation.act(coach, r.item.id, 'hide', undefined)).item.status).toBe('actioned');
      const pings = (realtime.broadcastCommunityEvent.mock.calls as unknown[][]).filter((x) => x[1] === 'community.post.updated');
      expect(pings).toEqual([postPing(pinged)]);
    }
    const replies = (await posts.listComments(alice, host.id, true)).comments;
    expect(replies).toEqual([
      expect.objectContaining({ id: c.id, body: null, reactions: [], removed_at: expect.any(String), removed_by: byCoach() }),
      expect.objectContaining({ id: kept.id, body: 'kind reply' }),
    ]);
    expect(replies[1]).not.toHaveProperty('removed_by');
    expect((await posts.listComments(alice, host.id)).comments.map((x) => x.id)).toEqual([kept.id]);
    expect((await posts.list(alice, wsId, {}, true)).posts.find((x) => x.id === p.id)).toMatchObject({ title: null, body: null, removed_by: byCoach() });
    expect(db.table('notification').filter((n) => n.user_id === bob.id)).toHaveLength(2);
  });

  it('the queue Hide of a challenge comment leaves the placeholder for the phone that asks', async () => {
    const challenges = new CommunityChallengesService(
      new CommunityAccessService(prisma),
      new CommunityChallengesRepository(prisma),
      moderation,
      stub<CommunityRealtimeService>(realtime),
      stub<CommunityNotificationsService>(push),
      safety,
    );
    const ch = String(db.seed('communityChallenge', { workspace_id: wsId, cohort_id: cohortId, created_by_id: coach.id, title: 'Steps', status: 'active', archived_at: null }).id);
    const c = String(db.seed('communityMessage', { workspace_id: wsId, cohort_id: cohortId, scope: 'cohort', kind: 'text', sender_id: bob.id, body: 'rude cheer', visibility: 'active', plan_context_type: 'community_challenge_comment', plan_context_id: ch }).id);
    const r = await moderation.report(alice, 'comment', c, 'harassment', undefined);
    await moderation.act(coach, r.item.id, 'hide', undefined);
    const shown = await challenges.listComments(alice, ch, {}, true);
    expect(shown.comments).toEqual([expect.objectContaining({ id: c, body: null, removed_at: expect.any(String), removed_by: byCoach() })]);
    expect((await challenges.listComments(alice, ch, {})).comments).toEqual([]);
  });

  // LS-1165R4 B1 (owner #178-7 op 1): the coach's DELETE and the queue's Hide take the post's
  // search copy (the reindex route's row: its title and body words) out of search and erase its
  // words, in the removal's own transaction. A reply has no search copy and the reindex cannot
  // make one. The live search, by each word: test/rls/community-removed-post-search-rls.spec.ts.
  it('a removal takes the post search copy with it in the same transaction; a reply has none', async () => {
    const search = new CommunitySearchController(stub<CommunitySearchService>({}),
      new SearchIndexerService(new CommunitySearchRepository(prisma)), new CommunityAccessService(prisma), prisma);
    const asCoach = stub<AuthedRequest>({ user: coach });
    const copy = (id: string) => db.table('communitySearchEntry').filter((e) => e.targetId === id);
    const indexed = async (title: string, body: string) => {
      const p = (await posts.create(bob, wsId, { title, body })).post;
      await search.reindex(asCoach, wsId, { kind: 'post', targetId: p.id, title, transcript: body });
      return p.id;
    };
    const direct = await indexed('Kettlebell swing plan', 'deadlift tempo');
    const queued = await indexed('Kettlebell clean drill', 'thruster grip');
    const live = await indexed('Kettlebell press ladder', 'goblet squat');
    const reply = (await posts.addComment(bob, live, 'burpee finisher')).comment.id;
    await expect(search.reindex(asCoach, wsId, { kind: 'post', targetId: reply, title: 'burpee finisher' }))
      .rejects.toBeInstanceOf(NotFoundException);
    // A lost COMMIT of the DELETE rolls the search copy back with the post.
    db.beforeCommit = () => {
      throw new Error('connection lost before COMMIT');
    };
    await expect(posts.remove(coach, direct, true)).rejects.toThrow('connection lost before COMMIT');
    expect(copy(direct)).toEqual([expect.objectContaining({ softDeletedAt: null, excerpt: 'Kettlebell swing plan \u2014 deadlift tempo' })]);
    const committed: string[][] = [];
    db.beforeCommit = (writes) => {
      committed.push([...writes]);
    };
    await posts.remove(coach, direct, true);
    for (const [type, id] of [['post', queued], ['comment', reply]] as const) {
      const r = await moderation.report(alice, type, id, 'harassment', undefined);
      expect((await moderation.act(coach, r.item.id, 'hide', undefined)).item.status).toBe('actioned');
    }
    // The DELETE's transaction and the Hide's each hold the post's removal and its search copy's.
    expect(committed.filter((w) => w.includes('communitySearchEntry.updateMany'))).toEqual([
      expect.arrayContaining(['communityPost.updateMany', 'communitySearchEntry.updateMany', 'notification.create']),
      expect.arrayContaining(['communityModerationAction.updateMany', 'communityPost.updateMany', 'communitySearchEntry.updateMany']),
    ]);
    for (const id of [direct, queued]) {
      expect(copy(id)).toEqual([expect.objectContaining({ softDeletedAt: expect.any(Date), excerpt: '' })]);
    }
    expect(copy(live)).toEqual([expect.objectContaining({ softDeletedAt: null, excerpt: 'Kettlebell press ladder \u2014 goblet squat' })]);
    expect(copy(reply)).toEqual([]);
    // The placeholders still show.
    const hall = (await posts.list(alice, wsId, {}, true)).posts;
    for (const id of [direct, queued]) {
      expect(hall.find((x) => x.id === id)).toMatchObject({ title: null, body: null, removed_by: byCoach() });
    }
    expect((await posts.listComments(alice, live, true)).comments).toEqual([
      expect.objectContaining({ id: reply, body: null, removed_by: byCoach() }),
    ]);
  });

  it('warn notifies the author and keeps their access', async () => {
    const m = await messages.send(bob, cohortId, 'borderline remark');
    const r = await moderation.report(alice, 'message', m.message.id, 'other', undefined);
    await moderation.act(coach, r.item.id, 'warn', 'first warning');
    expect(push.sendCommunityPush).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: bob.id, targetId: m.message.id }),
    );
    await expect(messages.send(bob, cohortId, 'understood')).resolves.toBeDefined();
  });

  it('ban removes the content and the author loses access to the space', async () => {
    const m = await messages.send(bob, cohortId, 'abusive remark');
    const r = await moderation.report(alice, 'message', m.message.id, 'harassment', undefined);
    await moderation.act(coach, r.item.id, 'ban', undefined);
    const memberships = db.table('communityMembership').filter((x) => x.user_id === bob.id);
    expect(memberships.every((x) => x.status === 'removed' && x.removed_at)).toBe(true);
    await expect(messages.send(bob, cohortId, 'still here')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(messages.list(bob, cohortId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect((await messages.list(alice, cohortId, {})).messages.map((x) => x.id)).not.toContain(
      m.message.id,
    );
  });

  it('a ban can never target the workspace coach', async () => {
    const m = await messages.send(coach, cohortId, 'coach note');
    const r = await moderation.report(alice, 'message', m.message.id, 'other', undefined);
    await expect(moderation.act(coach, r.item.id, 'ban', undefined)).rejects.toMatchObject({
      response: { code: 'community.moderation.cannot_ban_coach' },
    });
    // A refused ban writes nothing: the coach's message stays visible.
    expect((await messages.list(alice, cohortId, {})).messages.map((x) => x.id)).toContain(
      m.message.id,
    );
  });

  it('only the owning coach can act on an item (others get the not-found 404)', async () => {
    const m = await messages.send(bob, cohortId, 'something');
    const r = await moderation.report(alice, 'message', m.message.id, 'spam', undefined);
    await expect(moderation.act(alice, r.item.id, 'hide', undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(moderation.act(otherCoach, r.item.id, 'hide', undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── block ────────────────────────────────────────────────────────────────

  it('block hides messages and comments both ways (blocker and blocked), bystanders unaffected', async () => {
    const post = await posts.create(coach, wsId, { title: 'Check in', body: 'How was the week' });
    const bobMsg = await messages.send(bob, cohortId, 'Bob in the cohort');
    const aliceMsg = await messages.send(alice, cohortId, 'Alice in the cohort');
    const bobComment = await posts.addComment(bob, post.post.id, 'Bob comment');
    const aliceComment = await posts.addComment(alice, post.post.id, 'Alice comment');

    await safety.block(alice, bob.id);

    const forAlice = await messages.list(alice, cohortId, {});
    expect(forAlice.messages.map((x) => x.id)).toEqual([aliceMsg.message.id]);
    const commentsForAlice = await posts.listComments(alice, post.post.id);
    expect(commentsForAlice.comments.map((c) => c.id)).not.toContain(bobComment.comment.id);

    // "If you block someone, they can no longer see your posts": the blocked
    // user no longer sees the blocker either.
    const forBob = await messages.list(bob, cohortId, {});
    expect(forBob.messages.map((x) => x.id)).toEqual([bobMsg.message.id]);
    const commentsForBob = await posts.listComments(bob, post.post.id);
    expect(commentsForBob.comments.map((c) => c.id)).not.toContain(aliceComment.comment.id);

    // everyone else still sees everything
    const forCoach = await messages.list(coach, cohortId, {});
    expect(forCoach.messages).toHaveLength(2);

    expect((await safety.listBlocks(alice)).blocks).toEqual([
      // client privacy: first name only
      expect.objectContaining({ user_id: bob.id, name: 'Bob' }),
    ]);
    await safety.unblock(alice, bob.id);
    expect((await messages.list(alice, cohortId, {})).messages).toHaveLength(2);
    expect((await messages.list(bob, cohortId, {})).messages).toHaveLength(2);
  });

  it('block closes DMs in both directions, hides the thread from both lists and tells each person who closed it', async () => {
    await dms.send(bob, wsId, alice.id, 'hello');
    expect((await dms.listThreads(alice, wsId, {})).threads).toHaveLength(1);
    await safety.block(alice, bob.id);
    expect((await dms.listThreads(alice, wsId, {})).threads).toHaveLength(0);
    // Blocked person: told the other person blocked them (no message text: the phone shows "{N} has blocked you").
    await expect(dms.send(bob, wsId, alice.id, 'hello again')).rejects.toMatchObject({
      status: 403,
      response: { error: 'forbidden', code: 'community.dm.blocked_by_them' },
    });
    // Blocker: told it is their block, with the way back.
    await expect(dms.send(alice, wsId, bob.id, 'hi')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dms.listThread(alice, wsId, bob.id, {})).rejects.toMatchObject({
      response: {
        code: 'community.dm.blocked_by_you',
        message: expect.stringContaining('unblock them in Community safety'),
      },
    });
    expect((await dms.listThreads(bob, wsId, {})).threads).toHaveLength(0);
  });

  it('block rejects self, strangers outside the community and the member’s own coach', async () => {
    await expect(safety.block(alice, alice.id)).rejects.toMatchObject({
      response: { code: 'community.block.self' },
    });
    await expect(safety.block(alice, otherCoach.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(safety.block(alice, coach.id)).rejects.toMatchObject({
      response: { code: 'community.block.workspace_coach' },
    });
    // idempotent
    await safety.block(alice, bob.id);
    await safety.block(alice, bob.id);
    expect(db.table('userBlock')).toHaveLength(1);
  });

  it('every block refusal carries a stable code and a human message with a next step', async () => {
    const refusals = [
      safety.block(alice, alice.id),
      safety.block(alice, otherCoach.id),
      safety.block(alice, coach.id),
    ];
    const bodies = await Promise.all(
      refusals.map((p) => p.then(() => null).catch((e: { response: unknown }) => e.response)),
    );
    expect(bodies).toEqual([
      expect.objectContaining({ code: 'community.block.self', message: expect.any(String) }),
      expect.objectContaining({ code: 'community.block.not_found', message: expect.any(String) }),
      expect.objectContaining({
        code: 'community.block.workspace_coach',
        message: expect.stringContaining('report'),
      }),
    ]);
    await safety.block(alice, bob.id);
    await expect(dms.send(alice, wsId, bob.id, 'hi')).rejects.toMatchObject({
      response: {
        code: 'community.dm.blocked_by_you',
        message: expect.stringContaining('Community safety'),
      },
    });
    // #169-5: the blocked side's code is the phone's cue for "{N} has blocked you" (BAM-2b); the phone shows no server text.
    await expect(dms.send(bob, wsId, alice.id, 'hi')).rejects.toMatchObject({
      response: { error: 'forbidden', code: 'community.dm.blocked_by_them' },
    });
    for (const body of bodies) {
      const msg = (body as { message: string }).message;
      expect(msg).not.toMatch(/!/);
      expect(msg).not.toMatch(/something went wrong/i);
    }
  });

  it('a DM can be reported only by one of its two participants', async () => {
    const sent = await dms.send(bob, wsId, alice.id, 'just between us');
    // a third member of the same workspace cannot pull it into the queue by id
    await expect(
      moderation.report(carol, 'message', sent.message.id, 'harassment', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    // the recipient can
    await expect(
      moderation.report(alice, 'message', sent.message.id, 'harassment', undefined),
    ).resolves.toBeDefined();
  });

  // ── published contact path ──────────────────────────────────────────────

  it('publishes a contact email, guidelines and the report reasons', () => {
    const info = safety.safetyInfo();
    expect(info.contact_email).toMatch(/@/);
    expect(info.guidelines.length).toBeGreaterThan(2);
    expect(info.report_reasons.map((r) => r.code)).toEqual(
      COMMUNITY_REPORT_REASONS.map((r) => r.code),
    );
    // One support address (OR-109-1): the repo's SUPPORT_EMAIL constant,
    // with no env override that could make the app and the public pages differ.
    expect(info.contact_email).toBe(SUPPORT_EMAIL);
    process.env.COMMUNITY_SAFETY_CONTACT_EMAIL = 'safety@example.test';
    expect(safety.safetyInfo().contact_email).toBe(SUPPORT_EMAIL);
    delete process.env.COMMUNITY_SAFETY_CONTACT_EMAIL;
  });

  // ── route contract the mobile app depends on ─────────────────────────────

  function route(ctrl: object, method: string): { path: string; verb: number; guards: unknown[] } {
    const fn = stub<Record<string, object>>(ctrl)[method];
    return {
      path: Reflect.getMetadata(PATH_METADATA, fn),
      verb: Reflect.getMetadata(METHOD_METADATA, fn),
      guards: Reflect.getMetadata(GUARDS_METADATA, fn) ?? [],
    };
  }

  it('exposes the routes the app calls, all behind the community feature flag', () => {
    const mod = CommunityModerationController.prototype;
    const saf = CommunitySafetyController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, CommunityModerationController)).toBe('community');
    expect(Reflect.getMetadata(PATH_METADATA, CommunitySafetyController)).toBe('community');
    const expected: Array<[object, string, string, number]> = [
      [mod, 'report', 'moderation/reports', RequestMethod.POST],
      [mod, 'flagged', 'moderation/flagged', RequestMethod.GET],
      [mod, 'act', 'moderation/items/:itemId', RequestMethod.PATCH],
      [saf, 'info', 'safety', RequestMethod.GET],
      [saf, 'list', 'blocks', RequestMethod.GET],
      [saf, 'block', 'blocks', RequestMethod.POST],
      [saf, 'unblock', 'blocks/:userId', RequestMethod.DELETE],
    ];
    for (const [ctrl, method, path, verb] of expected) {
      const r = route(ctrl, method);
      expect([method, r.path, r.verb]).toEqual([method, path, verb]);
      expect(r.guards).toContain(CommunityFeatureFlagGuard);
    }
  });
});
