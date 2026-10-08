/**
 * CF-COMM-BE-128 (FW-COMM-128 U1 + U2): every post and reply the app reads
 * carries the author's FIRST name (owner default 10-07: first names on posts
 * and replies, the same rule as wins) and the reactions the viewer may see,
 * in the same shape the reaction endpoints return. Before this, a reaction
 * tap changed nothing on screen (the post had no reaction data) and a client
 * could not tell the coach's post from another client's.
 *
 * Real services and repositories over the in-memory Prisma used by the
 * safety suites; no network, no database.
 */
import 'reflect-metadata';
import type { User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';
import { CommunityReactionsService } from '../../../src/community/reactions/community-reactions.service';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { InMemoryPrisma } from '../safety/in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

describe('community posts and replies: author first name and reactions (CF-COMM-BE-128)', () => {
  let db: InMemoryPrisma;
  let safety: CommunitySafetyService;
  let posts: CommunityPostsService;
  let reactions: CommunityReactionsService;
  let coach: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let wsId: string;

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
    return stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: null }));
  }

  beforeEach(() => {
    db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    coach = user('coach', 'Dana Whitfield');
    alice = user('student', 'Alice Hartley');
    bob = user('student', 'Bob Okafor');
    // No stored name: shown as "Member", never blank and never an id.
    carol = user('student', '');
    const ws = db.seed('communityWorkspace', {
      coach_id: coach.id,
      name: 'Community',
      dm_enabled_default: true,
      archived_at: null,
    });
    wsId = ws.id as string;
    const cohort = db.seed('communityCohort', { workspace_id: wsId, name: 'All members' });
    for (const u of [alice, bob, carol]) {
      db.seed('communityMembership', {
        workspace_id: wsId,
        cohort_id: cohort.id,
        user_id: u.id,
        status: 'active',
        role: 'member',
        dm_enabled: null,
        removed_at: null,
      });
    }
    const access = new CommunityAccessService(prisma);
    const postsRepo = new CommunityPostsRepository(prisma);
    const msgRepo = new CommunityMessagesRepository(prisma);
    const reactionsRepo = new CommunityReactionsRepository(prisma);
    safety = new CommunitySafetyService(prisma);
    const rt = stub<CommunityRealtimeService>(realtime);
    posts = new CommunityPostsService(
      access,
      postsRepo,
      msgRepo,
      rt,
      stub<CommunityNotificationsService>({ sendCommunityPush: async () => undefined }),
      safety,
      reactionsRepo,
    );
    reactions = new CommunityReactionsService(
      access,
      reactionsRepo,
      msgRepo,
      postsRepo,
      rt,
      safety,
    );
  });

  it('posts and replies name their author by first name only, on every read and write', async () => {
    const created = await posts.create(coach, wsId, { title: 'Week one', body: 'Welcome in' });
    expect(created.post.author_name).toBe('Dana');
    expect(created.post.reactions).toEqual([]);

    const aliceReply = await posts.addComment(alice, created.post.id, 'Thanks, coach');
    expect(aliceReply.comment.author_name).toBe('Alice');
    expect(aliceReply.comment.reactions).toEqual([]);
    const carolReply = await posts.addComment(carol, created.post.id, 'Same here');
    expect(carolReply.comment.author_name).toBe('Member');

    const bobPost = await posts.create(bob, wsId, {
      title: 'First week done',
      body: 'Three sessions',
    });
    expect(bobPost.post.author_name).toBe('Bob');

    const feed = await posts.list(alice, wsId, {});
    expect(feed.posts.map((p) => [p.id, p.author_name])).toEqual([
      [bobPost.post.id, 'Bob'],
      [created.post.id, 'Dana'],
    ]);
    const one = await posts.getOne(bob, created.post.id);
    expect(one.post.author_name).toBe('Dana');
    const thread = await posts.listComments(bob, created.post.id);
    expect(thread.comments.map((c) => c.author_name)).toEqual(['Alice', 'Member']);

    const edited = await posts.edit(bob, bobPost.post.id, { body: 'Four sessions' });
    expect(edited.post.author_name).toBe('Bob');
    // The coach removes a member's post: the response still names the author, not the coach.
    const removed = await posts.remove(coach, bobPost.post.id);
    expect(removed.post.author_name).toBe('Bob');

    // Member privacy: no surname ever leaves the API on these surfaces.
    const everything = JSON.stringify([
      created,
      aliceReply,
      carolReply,
      bobPost,
      feed,
      one,
      thread,
      edited,
      removed,
    ]);
    for (const surname of ['Whitfield', 'Hartley', 'Okafor']) {
      expect(everything).not.toContain(surname);
    }
  });

  it('a post shows its reactions, marks the viewer own, and matches what the reaction tap returned', async () => {
    const { post } = await posts.create(coach, wsId, { title: 'Check in', body: 'How did it go' });
    expect((await posts.getOne(alice, post.id)).post.reactions).toEqual([]);

    const afterAlice = await reactions.react(alice, 'post', post.id, '🔥');
    expect((await posts.getOne(alice, post.id)).post.reactions).toEqual(afterAlice.reactions);
    expect(afterAlice.reactions).toEqual([{ emoji: '🔥', count: 1, reacted_by_me: true }]);
    expect((await posts.getOne(bob, post.id)).post.reactions).toEqual([
      { emoji: '🔥', count: 1, reacted_by_me: false },
    ]);

    await reactions.react(bob, 'post', post.id, '🔥');
    const afterBob = await reactions.react(bob, 'post', post.id, '👍');
    expect((await posts.getOne(bob, post.id)).post.reactions).toEqual(afterBob.reactions);
    expect(afterBob.reactions).toEqual([
      { emoji: '🔥', count: 2, reacted_by_me: true },
      { emoji: '👍', count: 1, reacted_by_me: true },
    ]);

    // Removing works from what the screen shows: Alice sees her reaction as active, taps it again.
    const undone = await reactions.unreact(alice, 'post', post.id, '🔥');
    expect((await posts.getOne(alice, post.id)).post.reactions).toEqual(undone.reactions);
    expect(undone.reactions).toEqual([
      { emoji: '🔥', count: 1, reacted_by_me: false },
      { emoji: '👍', count: 1, reacted_by_me: false },
    ]);
  });

  it('the feed carries each post its own reactions, and replies carry theirs', async () => {
    const p1 = await posts.create(coach, wsId, { title: 'One', body: 'First' });
    const p2 = await posts.create(coach, wsId, { title: 'Two', body: 'Second' });
    await reactions.react(alice, 'post', p1.post.id, '👍');

    const feed = await posts.list(bob, wsId, {});
    const byId = new Map(feed.posts.map((p) => [p.id, p.reactions]));
    expect(byId.get(p1.post.id)).toEqual([{ emoji: '👍', count: 1, reacted_by_me: false }]);
    expect(byId.get(p2.post.id)).toEqual([]);

    const reply = await posts.addComment(alice, p1.post.id, 'Done');
    const quiet = await posts.addComment(carol, p1.post.id, 'Also done');
    await reactions.react(bob, 'comment', reply.comment.id, '💪');
    const thread = await posts.listComments(alice, p1.post.id);
    const replies = new Map(thread.comments.map((c) => [c.id, c.reactions]));
    expect(replies.get(reply.comment.id)).toEqual([
      { emoji: '💪', count: 1, reacted_by_me: false },
    ]);
    expect(replies.get(quiet.comment.id)).toEqual([]);
    // A post reaction never shows on a reply, and a reply reaction never on the post.
    expect((await posts.getOne(alice, p1.post.id)).post.reactions).toEqual([
      { emoji: '👍', count: 1, reacted_by_me: true },
    ]);
  });

  it('a reaction by someone in a block relation with the viewer is not counted for that viewer', async () => {
    const { post } = await posts.create(coach, wsId, { title: 'Check in', body: 'How did it go' });
    const reply = await posts.addComment(carol, post.id, 'Good');
    await reactions.react(alice, 'post', post.id, '🎉');
    await reactions.react(alice, 'comment', reply.comment.id, '🎉');
    await safety.block(bob, alice.id);

    expect((await posts.getOne(bob, post.id)).post.reactions).toEqual([]);
    expect((await posts.list(bob, wsId, {})).posts[0].reactions).toEqual([]);
    expect((await posts.listComments(bob, post.id)).comments[0].reactions).toEqual([]);
    // Everyone else still sees it.
    expect((await posts.getOne(carol, post.id)).post.reactions).toEqual([
      { emoji: '🎉', count: 1, reacted_by_me: false },
    ]);

    await safety.unblock(bob, alice.id);
    expect((await posts.getOne(bob, post.id)).post.reactions).toEqual([
      { emoji: '🎉', count: 1, reacted_by_me: false },
    ]);
  });
});
