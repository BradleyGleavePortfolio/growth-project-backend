/**
 * Two-way blocking on every community read surface (operator ruling
 * 2026-10-01; owner-approved copy "If you block someone, they can no longer
 * see your posts or message you, and they are not told").
 *
 * For each surface: the blocker does not see the blocked user's content, the
 * blocked user does not see the blocker's content, and unblocking restores
 * both directions. DMs stay closed both ways. The final describe block is a
 * regression guard: every GET route under src/community is enumerated from
 * the controllers' Nest metadata and must be classified here as either
 * block-filtered (and its service method must call the filter) or exempt with
 * a written reason, so a new read path cannot silently skip the filter.
 */
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { CommunityVoiceNote, User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../../src/community/dms/community-dms.repository';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunityReactionsService } from '../../../src/community/reactions/community-reactions.service';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';
import { CommunityCohortMembersService } from '../../../src/community/cohorts/community-cohort-members.service';
import type { CommunityCohortMembersRepository } from '../../../src/community/cohorts/community-cohort-members.repository';
import { CommunityService } from '../../../src/community/community.service';
import type { CommunityRepository } from '../../../src/community/community.repository';
import { CommunitySearchService } from '../../../src/community/search/community-search.service';
import type { CommunitySearchRepository } from '../../../src/community/search/community-search.repository';
import { CommunityVoiceService } from '../../../src/community/voice/community-voice.service';
import type { CommunityVoiceRepository } from '../../../src/community/voice/community-voice.repository';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { AnalyticsService } from '../../../src/analytics/analytics.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import { InMemoryPrisma } from './in-memory-prisma';
import { safetyWithBlocks } from './safety-test-helpers';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '11111111-1111-4111-8111-111111111111';
const COHORT = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const CAROL = '55555555-5555-4555-8555-555555555555';
const COACH = '66666666-6666-4666-8666-666666666666';

// ── In-memory flow: posts, comments, cohort messages, DMs ───────────────────

describe('two-way block: posts, comments, cohort messages and DMs (in-memory Prisma)', () => {
  let db: InMemoryPrisma;
  let safety: CommunitySafetyService;
  let posts: CommunityPostsService;
  let messages: CommunityMessagesService;
  let dms: CommunityDmsService;
  let coach: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let wsId: string;
  let cohortId: string;
  const push = { sendCommunityPush: jest.fn(async () => undefined) };

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
    push.sendCommunityPush.mockClear();
    db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    coach = user('coach', 'Coach One');
    alice = user('student', 'Alice Member');
    bob = user('student', 'Bob Member');
    carol = user('student', 'Carol Member');
    const ws = db.seed('communityWorkspace', {
      coach_id: coach.id,
      name: 'Hall',
      dm_enabled_default: true,
      archived_at: null,
    });
    wsId = ws.id as string;
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
  });

  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

  // Hall posts are authored by the workspace coach (members cannot post), and a
  // member cannot block their own coach, so the post surfaces are exercised
  // with the coach as the blocker; member-to-member is covered by comments.
  it('Hall posts: when the coach blocks a member, the member no longer sees the coach posts; unblock restores', async () => {
    const p1 = await posts.create(coach, wsId, { title: 'Week one', body: 'Welcome' });
    await safety.block(coach, alice.id);

    expect((await posts.list(alice, wsId, {})).posts).toHaveLength(0);
    await expect(posts.getOne(alice, p1.post.id)).rejects.toBeInstanceOf(NotFoundException);
    // the coach (blocker) and bystanders still see it
    expect(ids((await posts.list(carol, wsId, {})).posts)).toEqual([p1.post.id]);
    expect(ids((await posts.list(coach, wsId, {})).posts)).toEqual([p1.post.id]);

    await safety.unblock(coach, alice.id);
    expect(ids((await posts.list(alice, wsId, {})).posts)).toEqual([p1.post.id]);
    await expect(posts.getOne(alice, p1.post.id)).resolves.toBeDefined();
  });

  it('comments and replies: hidden both ways between members; unblock restores', async () => {
    const post = await posts.create(coach, wsId, { title: 'Check in', body: 'How was it' });
    const aC = await posts.addComment(alice, post.post.id, 'Alice reply');
    const bC = await posts.addComment(bob, post.post.id, 'Bob reply');
    const cC = await posts.addComment(carol, post.post.id, 'Carol reply');
    await safety.block(bob, alice.id);

    expect(ids((await posts.listComments(alice, post.post.id)).comments)).toEqual([
      aC.comment.id,
      cC.comment.id,
    ]);
    expect(ids((await posts.listComments(bob, post.post.id)).comments)).toEqual([
      bC.comment.id,
      cC.comment.id,
    ]);
    expect((await posts.listComments(carol, post.post.id)).comments).toHaveLength(3);

    await safety.unblock(bob, alice.id);
    expect((await posts.listComments(alice, post.post.id)).comments).toHaveLength(3);
    expect((await posts.listComments(bob, post.post.id)).comments).toHaveLength(3);
  });

  it('a blocked member cannot reply to, read the thread of, or notify the blocker', async () => {
    const post = await posts.create(coach, wsId, { title: 'Check in', body: 'How was it' });
    await safety.block(coach, alice.id);
    push.sendCommunityPush.mockClear();
    await expect(posts.addComment(alice, post.post.id, 'hey')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(posts.listComments(alice, post.post.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(push.sendCommunityPush).not.toHaveBeenCalled();

    await safety.unblock(coach, alice.id);
    await expect(posts.addComment(alice, post.post.id, 'hey')).resolves.toBeDefined();
    expect(push.sendCommunityPush).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: coach.id, targetId: post.post.id }),
    );
  });

  it('cohort messages (list and by id): hidden both ways, restored on unblock', async () => {
    const aM = await messages.send(alice, cohortId, 'Alice in the cohort');
    const bM = await messages.send(bob, cohortId, 'Bob in the cohort');
    await safety.block(alice, bob.id);

    expect(ids((await messages.list(alice, cohortId, {})).messages)).toEqual([aM.message.id]);
    expect(ids((await messages.list(bob, cohortId, {})).messages)).toEqual([bM.message.id]);
    expect((await messages.list(carol, cohortId, {})).messages).toHaveLength(2);
    await expect(messages.getOne(bob, aM.message.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(messages.getOne(alice, bM.message.id)).rejects.toBeInstanceOf(NotFoundException);

    await safety.unblock(alice, bob.id);
    expect((await messages.list(bob, cohortId, {})).messages).toHaveLength(2);
    await expect(messages.getOne(bob, aM.message.id)).resolves.toBeDefined();
  });

  it('DMs: closed both ways and the thread disappears for both; unblock reopens', async () => {
    await dms.send(alice, wsId, bob.id, 'hello');
    await safety.block(alice, bob.id);

    expect((await dms.listThreads(alice, wsId, {})).threads).toHaveLength(0);
    expect((await dms.listThreads(bob, wsId, {})).threads).toHaveLength(0);
    // The blocked person (bob) sees the same 404 as a member who is not
    // there, so the block is not disclosed; the blocker (alice) is told it is
    // her block and how to undo it.
    await expect(dms.send(bob, wsId, alice.id, 'again')).rejects.toMatchObject({
      status: 404,
      response: { code: 'community.dm.not_found' },
    });
    await expect(dms.send(alice, wsId, bob.id, 'hi')).rejects.toMatchObject({
      status: 403,
      response: { code: 'community.dm.blocked_by_you' },
    });
    await expect(dms.listThread(bob, wsId, alice.id, {})).rejects.toMatchObject({
      status: 404,
      response: { code: 'community.dm.not_found' },
    });
    await expect(dms.openThread(alice, wsId, bob.id)).rejects.toMatchObject({
      status: 403,
      response: { code: 'community.dm.blocked_by_you' },
    });

    await safety.unblock(alice, bob.id);
    expect((await dms.listThreads(bob, wsId, {})).threads).toHaveLength(1);
    await expect(dms.send(bob, wsId, alice.id, 'back')).resolves.toBeDefined();
  });

  it('hiddenFromViewer returns both directions and never the viewer', async () => {
    await safety.block(alice, bob.id);
    await safety.block(carol, alice.id);
    expect([...(await safety.hiddenFromViewer(alice.id))].sort()).toEqual(
      [bob.id, carol.id].sort(),
    );
    expect([...(await safety.hiddenFromViewer(bob.id))]).toEqual([alice.id]);
    expect([...(await safety.hiddenFromViewer(carol.id))]).toEqual([alice.id]);
    expect((await safety.hiddenFromViewer(coach.id)).size).toBe(0);
  });
});

// ── Stubbed surfaces: member list, leaderboard, wins feed, Today, search, voice ──

describe('two-way block: member list, leaderboard, wins, Today, search and voice notes', () => {
  let blocks: Array<[string, string]>;
  beforeEach(() => {
    blocks = [];
  });
  const viewer = (id: string, role = 'student') => stub<User>({ id, role, coach_id: COACH });
  const blockEachWay: Array<[string, [string, string]]> = [
    ['Alice blocks Bob', [ALICE, BOB]],
    ['Bob blocks Alice', [BOB, ALICE]],
  ];

  describe('cohort member list (roster)', () => {
    function build(isCoach = false) {
      const member = (userId: string, name: string) => ({
        id: `${userId.slice(0, 24)}aaaaaaaaaaaa`,
        user_id: userId,
        role: 'student',
        status: 'active',
        joined_at: new Date('2026-09-01T00:00:00.000Z'),
        user: { name, email: `${name}@example.test` },
      });
      const access = {
        findCohort: async () => ({ id: COHORT, workspace_id: WS }),
        membershipInCohort: async () => ({ status: 'active' }),
        isWorkspaceCoach: async () => isCoach,
      };
      const repo = {
        findCohort: async () => ({ id: COHORT, workspace_id: WS }),
        findCohortById: async () => ({ id: COHORT, workspace_id: WS }),
        listMembers: async () => [
          member(ALICE, 'Alice'),
          member(BOB, 'Bob'),
          member(CAROL, 'Carol'),
        ],
      };
      return new CommunityCohortMembersService(
        stub<CommunityAccessService>(access),
        stub<CommunityCohortMembersRepository>(repo),
        safetyWithBlocks(blocks),
      );
    }

    it.each(blockEachWay)(
      '%s: neither sees the other on the roster; unblock restores',
      async (_l, pair) => {
        const svc = build();
        blocks.push(pair);
        const names = async (id: string) =>
          (await svc.list(viewer(id), COHORT, {})).members.map((m) => m.user_id);
        expect(await names(ALICE)).toEqual([ALICE, CAROL]);
        expect(await names(BOB)).toEqual([BOB, CAROL]);
        expect(await names(CAROL)).toEqual([ALICE, BOB, CAROL]);
        blocks.length = 0;
        expect(await names(BOB)).toEqual([ALICE, BOB, CAROL]);
      },
    );
  });

  describe('workout leaderboard and community wins feed (CommunityService)', () => {
    function build() {
      const students = [ALICE, BOB, CAROL].map((id) => ({
        id,
        name: `${id.slice(0, 4)} Lastname`,
        role: 'student',
      }));
      const prisma = {
        user: {
          findUnique: async (a: { where: { id: string } }) => ({
            id: a.where.id,
            role: 'student',
            coach_id: COACH,
          }),
          findMany: async () => students,
        },
        workoutSession: { groupBy: async () => [] },
        // The coach runs a community workspace, so wins are shared with the
        // coach's circle (community-wins.policy); nobody is removed.
        communityWorkspace: { findFirst: async () => ({ id: WS }) },
        communityMembership: { findMany: async () => [] },
        communityWorkspaceBan: { findMany: async () => [] },
        communityWin: {
          findMany: async () =>
            [ALICE, BOB, CAROL].map((id) => ({
              id: `win-${id}`,
              user_id: id,
              title: 'Logged a workout',
              description: 'Forty minutes',
              created_at: new Date('2026-09-30T00:00:00.000Z'),
              user: { name: 'Sam Member' },
            })),
        },
      };
      return new CommunityService(
        stub<PrismaService>(prisma),
        stub<CommunityRepository>({}),
        safetyWithBlocks(blocks),
      );
    }

    it.each(blockEachWay)(
      '%s: leaderboard rows hidden both ways; unblock restores',
      async (_l, pair) => {
        const svc = build();
        blocks.push(pair);
        const rows = async (id: string) =>
          (await svc.getLeaderboard(id, 'week')).map((r) => r.user_id).sort();
        expect(await rows(ALICE)).toEqual([ALICE, CAROL].sort());
        expect(await rows(BOB)).toEqual([BOB, CAROL].sort());
        blocks.length = 0;
        expect(await rows(ALICE)).toEqual([ALICE, BOB, CAROL].sort());
      },
    );

    it.each(blockEachWay)('%s: wins hidden both ways; unblock restores', async (_l, pair) => {
      const svc = build();
      blocks.push(pair);
      const wins = async (id: string) => (await svc.getFeed(id)).map((w) => w.id).sort();
      expect(await wins(ALICE)).toEqual([`win-${ALICE}`, `win-${CAROL}`].sort());
      expect(await wins(BOB)).toEqual([`win-${BOB}`, `win-${CAROL}`].sort());
      blocks.length = 0;
      expect(await wins(BOB)).toHaveLength(3);
    });

    it('client privacy: other members see first names only on the leaderboard and wins', async () => {
      const svc = build();
      const board = await svc.getLeaderboard(ALICE, 'week');
      expect(board.map((r) => r.name).sort()).toEqual(
        [ALICE, BOB, CAROL].map((id) => id.slice(0, 4)).sort(),
      );
      const wins = await svc.getFeed(ALICE);
      expect(new Set(wins.map((w) => w.displayName))).toEqual(new Set(['Sam']));
    });
  });

  describe('client privacy: first names only to other members', () => {
    it('roster: members see first names, the coach sees the full name', async () => {
      const row = {
        id: 'abcdef01-0000-4000-8000-000000000001',
        user_id: BOB,
        role: 'student',
        status: 'active',
        joined_at: new Date('2026-09-01T00:00:00.000Z'),
        user: { name: 'Bob Q Member', email: 'bob@example.test' },
      };
      const build = (isCoach: boolean) =>
        new CommunityCohortMembersService(
          stub<CommunityAccessService>({
            findCohort: async () => ({ id: COHORT, workspace_id: WS }),
            membershipInCohort: async () => ({ status: 'active' }),
            isWorkspaceCoach: async () => isCoach,
          }),
          stub<CommunityCohortMembersRepository>({ listMembers: async () => [row] }),
          safetyWithBlocks(blocks),
        );
      const forMember = await build(false).list(viewer(ALICE), COHORT, {});
      expect(forMember.members[0].display_name).toBe('Bob');
      expect(forMember.members[0].email).toBeNull();
      const forCoach = await build(true).list(viewer(COACH, 'coach'), COHORT, {});
      expect(forCoach.members[0].display_name).toBe('Bob Q Member');
    });

    it('block list shows the first name of the person blocked', async () => {
      const safety = new CommunitySafetyService(
        stub<PrismaService>({
          userBlock: {
            findMany: async () => [
              {
                blocked_id: BOB,
                created_at: new Date('2026-10-01T00:00:00.000Z'),
                blocked: { name: 'Bob Q Member' },
              },
              {
                blocked_id: CAROL,
                created_at: new Date('2026-10-01T00:00:00.000Z'),
                blocked: null,
              },
            ],
          },
        }),
      );
      const { blocks: rows } = await safety.listBlocks({ id: ALICE });
      expect(rows.map((r) => r.name)).toEqual(['Bob', 'Member']);
    });
  });

  describe('Today pinned post (CommunityService.getToday)', () => {
    const ORIGINAL = process.env.FEATURE_COMMUNITY_API;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.FEATURE_COMMUNITY_API;
      else process.env.FEATURE_COMMUNITY_API = ORIGINAL;
    });

    it.each(blockEachWay)(
      '%s: a pinned post by the other side is not surfaced; unblock restores',
      async (_l, pair) => {
        process.env.FEATURE_COMMUNITY_API = 'true';
        const PINNED = '77777777-7777-4777-8777-777777777777';
        const repo = {
          findActiveMembershipForUser: async () => ({ workspace_id: WS, cohort_id: null }),
          findWorkspaceById: async () => ({ id: WS }),
          findCohortById: async () => null,
          findTodayContent: async () => ({
            event: null,
            challenge: null,
            pinnedPost: { id: PINNED, title: 'Alice pinned', author_id: ALICE },
          }),
        };
        const svc = new CommunityService(
          stub<PrismaService>({}),
          stub<CommunityRepository>(repo),
          safetyWithBlocks(blocks),
        );
        blocks.push(pair);
        expect((await svc.getToday(viewer(BOB))).pinned_post).toBeNull();
        expect((await svc.getToday(viewer(ALICE))).pinned_post?.id).toBe(PINNED);
        expect((await svc.getToday(viewer(CAROL))).pinned_post?.id).toBe(PINNED);
        blocks.length = 0;
        expect((await svc.getToday(viewer(BOB))).pinned_post?.id).toBe(PINNED);
      },
    );
  });

  describe('Today event and challenge (coach-created)', () => {
    const EVT_TODAY = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
    const CH_TODAY = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
    const ORIGINAL = process.env.FEATURE_COMMUNITY_API;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.FEATURE_COMMUNITY_API;
      else process.env.FEATURE_COMMUNITY_API = ORIGINAL;
    });

    it.each([
      ['the coach blocked the member', [COACH, BOB]],
      ['the member blocked the coach', [BOB, COACH]],
    ] as Array<[string, [string, string]]>)(
      'when %s, Today shows neither the event nor the challenge; unblock restores',
      async (_l, pair) => {
        process.env.FEATURE_COMMUNITY_API = 'true';
        const repo = {
          findActiveMembershipForUser: async () => ({ workspace_id: WS, cohort_id: null }),
          findWorkspaceById: async () => ({ id: WS }),
          findCohortById: async () => null,
          findTodayContent: async () => ({
            event: {
              id: EVT_TODAY,
              title: 'Live Q and A',
              starts_at: new Date('2026-10-02T17:00:00.000Z'),
              live_url: null,
              created_by_id: COACH,
            },
            challenge: {
              id: CH_TODAY,
              title: '10k steps',
              ends_at: new Date('2026-10-09T00:00:00.000Z'),
              created_by_id: COACH,
            },
            pinnedPost: null,
          }),
        };
        const svc = new CommunityService(
          stub<PrismaService>({}),
          stub<CommunityRepository>(repo),
          safetyWithBlocks(blocks),
        );
        blocks.push(pair);
        const blocked = await svc.getToday(viewer(BOB));
        expect(blocked.event).toBeNull();
        expect(blocked.challenge).toBeNull();
        const bystander = await svc.getToday(viewer(CAROL));
        expect(bystander.event?.id).toBe(EVT_TODAY);
        expect(bystander.challenge?.id).toBe(CH_TODAY);
        blocks.length = 0;
        expect((await svc.getToday(viewer(BOB))).event?.id).toBe(EVT_TODAY);
      },
    );
  });

  describe('reactions', () => {
    const POST = '99999999-9999-4999-8999-999999999999';
    const MSG = 'abababab-abab-4bab-8bab-abababababab';
    const DM = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    function build() {
      const reactionRows = [
        { user_id: ALICE, response_kind: 'like' },
        { user_id: BOB, response_kind: 'like' },
        { user_id: CAROL, response_kind: 'like' },
      ];
      const added: string[] = [];
      const messagesRepo = {
        findById: async (id: string) =>
          id === MSG
            ? {
                id: MSG,
                workspace_id: WS,
                cohort_id: null,
                sender_id: ALICE,
                dm_key: null,
                recipient_user_id: null,
                plan_context_type: null,
                deleted_at: null,
                created_at: new Date('2026-09-30T00:00:00.000Z'),
              }
            : id === DM
              ? {
                  id: DM,
                  workspace_id: WS,
                  cohort_id: null,
                  sender_id: ALICE,
                  dm_key: `dm:${WS}:${ALICE}:${BOB}`,
                  recipient_user_id: BOB,
                  plan_context_type: null,
                  deleted_at: null,
                  created_at: new Date('2026-09-30T00:00:00.000Z'),
                }
              : null,
      };
      const postsRepo = {
        findById: async () => ({
          id: POST,
          workspace_id: WS,
          author_id: COACH,
          deleted_at: null,
          created_at: new Date('2026-09-30T00:00:00.000Z'),
        }),
      };
      const svc = new CommunityReactionsService(
        stub<CommunityAccessService>({ canAccessWorkspace: async () => true }),
        stub<CommunityReactionsRepository>({
          addReaction: async (a: { userId: string }) => {
            added.push(a.userId);
          },
          removeReaction: async () => undefined,
          listForTarget: async () => reactionRows,
        }),
        stub<CommunityMessagesRepository>(messagesRepo),
        stub<CommunityPostsRepository>(postsRepo),
        stub<CommunityRealtimeService>({
          channels: { workspace: () => 'ws', cohort: () => 'c' },
          cohortShard: () => 0,
          broadcastCommunityEvent: async () => undefined,
        }),
        safetyWithBlocks(blocks),
      );
      return { svc, added };
    }

    it.each(blockEachWay)(
      '%s: neither can react to the other; counts exclude the other side',
      async (_l, pair) => {
        const { svc, added } = build();
        blocks.push(pair);
        // MSG is authored by ALICE: BOB cannot react to it either way
        await expect(svc.react(viewer(BOB), 'message', MSG, '👍')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(added).toEqual([]);
        // CAROL reacting sees all three; ALICE sees her own and CAROL's only
        const forCarol = await svc.react(viewer(CAROL), 'message', MSG, '👍');
        expect(forCarol.reactions[0].count).toBe(3);
        const forAlice = await svc.react(viewer(ALICE), 'post', POST, '👍');
        expect(forAlice.reactions[0].count).toBe(2);
        blocks.length = 0;
        await expect(svc.react(viewer(BOB), 'message', MSG, '👍')).resolves.toBeDefined();
      },
    );

    it('a DM message can be reacted to only by its two participants', async () => {
      const { svc } = build();
      await expect(svc.react(viewer(CAROL), 'message', DM, '👍')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.react(viewer(BOB), 'message', DM, '👍')).resolves.toBeDefined();
    });
  });

  describe('search', () => {
    function build() {
      const row = (id: string, author: string) => ({
        id,
        kind: 'post' as const,
        target_id: `tgt-${id}`,
        cohort_id: COHORT,
        author_id: author,
        excerpt: 'week one',
        created_at: new Date('2026-09-30T00:00:00.000Z'),
        rank: 0.5,
      });
      const access = {
        canAccessWorkspace: async () => true,
        isWorkspaceCoach: async () => false,
        listAccessibleCohortIds: async () => [COHORT],
      };
      const repo = { search: async () => [row('a', ALICE), row('b', BOB), row('c', CAROL)] };
      return new CommunitySearchService(
        stub<CommunitySearchRepository>(repo),
        stub<CommunityAccessService>(access),
        stub<AnalyticsService>({ capture: () => undefined }),
        safetyWithBlocks(blocks),
      );
    }

    it.each(blockEachWay)('%s: results hidden both ways; unblock restores', async (_l, pair) => {
      const svc = build();
      blocks.push(pair);
      const res = async (id: string) =>
        (await svc.search({ id, role: 'student' }, WS, { q: 'week' })).results.map((r) => r.id);
      expect(await res(ALICE)).toEqual(['a', 'c']);
      expect(await res(BOB)).toEqual(['b', 'c']);
      blocks.length = 0;
      expect(await res(BOB)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('voice notes (list and by id)', () => {
    const NOTE_A = '88888888-8888-4888-8888-888888888888';
    const NOTE_B = '99999999-9999-4999-8999-999999999999';
    function note(id: string, author: string): CommunityVoiceNote {
      return {
        id,
        workspace_id: WS,
        cohort_id: COHORT,
        conversation_id: null,
        author_id: author,
        storage_key: `${author}/1700000000-abc.m4a`,
        duration_ms: 5000,
        bytes: BigInt(120000),
        mime_type: 'audio/mp4',
        waveform_peaks: null,
        created_at: new Date('2026-09-30T00:00:00.000Z'),
        soft_deleted_at: null,
      };
    }
    function build() {
      const notes = [note(NOTE_A, ALICE), note(NOTE_B, BOB)];
      const access = {
        findWorkspace: async () => ({ id: WS }),
        findCohort: async () => ({ id: COHORT, workspace_id: WS }),
        isWorkspaceCoach: async () => false,
        canAccessWorkspace: async () => true,
        canAccessCohort: async () => true,
        listAccessibleCohortIds: async () => [COHORT],
        membershipInWorkspace: async () => true,
      };
      const repo = {
        findById: async (id: string) => notes.find((n) => n.id === id) ?? null,
        list: async () => ({ items: notes, nextCursor: null }),
      };
      const upload = { createSignedDownload: async () => 'https://signed.download/get' };
      return new CommunityVoiceService(
        stub<CommunityAccessService>(access),
        stub<CommunityVoiceRepository>(repo),
        stub<VoiceUploadProvider>(upload),
        stub<CommunityRealtimeService>({}),
        stub<AnalyticsService>({ capture: () => undefined }),
        safetyWithBlocks(blocks),
      );
    }

    it.each(blockEachWay)(
      '%s: notes hidden both ways in the list and by id; unblock restores',
      async (_l, pair) => {
        const svc = build();
        blocks.push(pair);
        const list = async (id: string) =>
          (await svc.list(viewer(id), WS, { limit: 20 })).voice_notes.map((n) => n.id);
        expect(await list(ALICE)).toEqual([NOTE_A]);
        expect(await list(BOB)).toEqual([NOTE_B]);
        await expect(svc.getOne(viewer(BOB), NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
        await expect(svc.getOne(viewer(ALICE), NOTE_B)).rejects.toBeInstanceOf(NotFoundException);
        await expect(svc.getOne(viewer(CAROL), NOTE_A)).resolves.toBeDefined();
        blocks.length = 0;
        expect(await list(BOB)).toEqual([NOTE_A, NOTE_B]);
        await expect(svc.getOne(viewer(BOB), NOTE_A)).resolves.toBeDefined();
      },
    );
  });
});

// ── Regression guard: no community read path skips the block filter ─────────

/**
 * Every GET route in src/community, keyed `<Controller>.<handler>`. FILTERED
 * routes name the service file + method that must apply the two-way filter;
 * EXEMPT routes carry the reason. An unclassified GET fails the suite.
 */
const FILTER_CALL = /\b(filterBlocked|hiddenFromViewer|assertVisibleTo|visiblePost|authoriseDm)\(/;

const FILTERED: Record<string, { file: string; method: string; entry?: string }> = {
  'CommunityPostsController.list': { file: 'posts/community-posts.service.ts', method: 'list' },
  'CommunityPostsController.getOne': { file: 'posts/community-posts.service.ts', method: 'getOne' },
  'CommunityPostsController.listComments': {
    file: 'posts/community-posts.service.ts',
    method: 'listComments',
  },
  'CommunityMessagesController.list': {
    file: 'messages/community-messages.service.ts',
    method: 'list',
  },
  'CommunityMessagesController.getOne': {
    file: 'messages/community-messages.service.ts',
    method: 'getOne',
  },
  'CommunityVoiceController.list': { file: 'voice/community-voice.service.ts', method: 'list' },
  'CommunityVoiceController.getOne': { file: 'voice/community-voice.service.ts', method: 'getOne' },
  'CommunityDmsController.listThreads': {
    file: 'dms/community-dms.service.ts',
    method: 'listThreads',
  },
  'CommunityDmsController.listThread': {
    file: 'dms/community-dms.service.ts',
    method: 'listThread',
  },
  'CommunitySearchController.query': {
    file: 'search/community-search.service.ts',
    method: 'search',
  },
  'CommunityChallengesController.leaderboard': {
    file: 'challenges/community-challenges.service.ts',
    method: 'getLeaderboard',
  },
  'CommunityChallengesController.listComments': {
    file: 'challenges/community-challenges.service.ts',
    method: 'listComments',
  },
  'CommunityCohortMembersController.list': {
    file: 'cohorts/community-cohort-members.service.ts',
    method: 'list',
  },
  'CommunityController.getToday': { file: 'community.service.ts', method: 'getToday' },
  'CommunityController.getLeaderboard': { file: 'community.service.ts', method: 'getLeaderboard' },
  'CommunityController.getFeed': { file: 'community.service.ts', method: 'getFeed' },
  // Coach-authored lessons, events and challenges are "posts" too: a block
  // between the coach and a member (community block by the coach, or a coach
  // messaging block in either direction, same UserBlock row) hides them.
  'CommunityClassroomController.listFeed': {
    file: 'classroom/community-classroom.service.ts',
    method: 'listFeed',
  },
  'CommunityClassroomController.getOne': {
    file: 'classroom/community-classroom.service.ts',
    method: 'readablePost',
    entry: 'getOne',
  },
  'CommunityEventsController.list': { file: 'events/community-events.service.ts', method: 'list' },
  'CommunityEventsController.getOne': {
    file: 'events/community-events.service.ts',
    method: 'readableEvent',
    entry: 'getOne',
  },
  'CommunityChallengesController.list': {
    file: 'challenges/community-challenges.service.ts',
    method: 'list',
  },
  'CommunityChallengesController.getOne': {
    file: 'challenges/community-challenges.service.ts',
    method: 'readableChallenge',
    entry: 'getOne',
  },
};

const COACH_ONLY =
  'coach/owner-only work surface; reported or member content must stay visible to the moderating coach';

const EXEMPT: Record<string, string> = {
  'CommunityWearablePromptsController.list':
    "coach/owner-only (@Roles('coach','owner')): the coach's own prompts about their clients",
  'CommunityModerationController.queue': COACH_ONLY,
  'CommunityModerationController.flagged': COACH_ONLY,
  'CommunityCoachInboxController.list': COACH_ONLY,
  'CommunityCoachEmptyStatesController.emptyStates': 'static coach copy, no member content',
  'AiTriageController.getTriage': COACH_ONLY,
  'PlanContextController.resolve': 'resolves a plan reference id, no member-authored content',
  'CommunitySafetyController.info': 'static safety copy',
  'CommunitySafetyController.list': "the caller's own block list",
  'CommunitySafetyController.notices':
    "the caller's own moderation notices (fixed server copy, no other member's content)",
  'CommunityController.getMe': "the caller's own membership and flags",
  'CommunityController.getWorkspace': 'workspace metadata (name, coach), no member content',
  'CommunityController.getCohorts': 'cohort metadata, no member content',
  'CommunityController.getCohort': 'cohort metadata and member count, no member content',
};

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...controllerFiles(p));
    } else if (name.endsWith('.controller.ts')) {
      out.push(p);
    }
  }
  return out;
}

function enumerateGetRoutes(files: Map<string, string> = new Map()): string[] {
  const root = join(__dirname, '../../../src/community');
  const routes: string[] = [];
  for (const file of controllerFiles(root)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod: Record<string, unknown> = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      const proto = stub<Record<string, unknown>>(exported.prototype);
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue;
        const handler = proto[key];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET) continue;
        routes.push(`${exported.name}.${key}`);
        files.set(`${exported.name}.${key}`, file);
      }
    }
    expect(relative(root, file)).not.toMatch(/^\.\./);
  }
  return routes.sort();
}

function methodBody(source: string, method: string): string {
  const start = source.search(
    new RegExp(`\\n  (?:public |private |protected )?async ${method}(?:<[^>]*>)?\\(`),
  );
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  // Up to the next class member at two-space indent (or the class end).
  const next = rest
    .slice(1)
    .search(/\n {2}(?:public |private |protected )?(?:async )?\w+(?:<[^>]*>)?\(|\n\}/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('regression guard: every community read path is classified and filtered', () => {
  const routeFiles = new Map<string, string>();
  const routes = enumerateGetRoutes(routeFiles);

  it('extracts one method body only (the guard cannot pass on the whole file)', () => {
    const src =
      '\nclass X {\n  async a() {\n    filterBlocked(1);\n  }\n\n  async b() {\n    return 2;\n  }\n}\n';
    expect(methodBody(src, 'a')).toMatch(FILTER_CALL);
    expect(methodBody(src, 'b')).not.toMatch(FILTER_CALL);
    expect(methodBody(src, 'b')).toContain('return 2');
  });

  it('finds the community GET routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(30);
  });

  it('classifies every GET route as block-filtered or exempt (with a reason)', () => {
    const unclassified = routes.filter((r) => !(r in FILTERED) && !(r in EXEMPT));
    expect(unclassified).toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
    // no stale entries either
    const known = new Set(routes);
    expect(Object.keys(FILTERED).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((k) => !known.has(k))).toEqual([]);
  });

  it.each(Object.entries(FILTERED))('%s applies the two-way block filter', (_route, target) => {
    const source = readFileSync(join(__dirname, '../../../src/community', target.file), 'utf8');
    const body = methodBody(source, target.method);
    expect(body).not.toBe('');
    expect(body).toMatch(FILTER_CALL);
  });

  // C-610-2: the filtered service method must be the one the route actually
  // reaches. The controller handler calls the entry method, and an entry that
  // differs from the filtering helper calls that helper and returns its result.
  it.each(Object.entries(FILTERED))('%s is wired to the filtered method', (route, target) => {
    const [, handler] = route.split('.');
    const controllerSource = readFileSync(String(routeFiles.get(route)), 'utf8');
    const handlerBody = methodBody(controllerSource, handler);
    expect(handlerBody).not.toBe('');
    const entry = target.entry ?? target.method;
    expect(handlerBody).toMatch(new RegExp(`return (?:await )?this\\.\\w+\\.${entry}\\(`));
    if (entry !== target.method) {
      const source = readFileSync(join(__dirname, '../../../src/community', target.file), 'utf8');
      expect(methodBody(source, entry)).toMatch(new RegExp(`await this\\.${target.method}\\(`));
    }
  });

  it('the wiring check rejects a handler that calls a different method', () => {
    const src = '\nclass C {\n  async list() {\n    return this.svc.listAll(1);\n  }\n}\n';
    expect(methodBody(src, 'list')).not.toMatch(/return (?:await )?this\.\w+\.list\(/);
    expect(methodBody(src, 'list')).toMatch(/return (?:await )?this\.\w+\.listAll\(/);
  });

  it('the shared filter is two-way (queries both blocker_id and blocked_id)', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/community/safety/community-safety.service.ts'),
      'utf8',
    );
    const filter = methodBody(source, 'filterBlocked');
    expect(filter).toMatch(/hiddenFromViewer\(/);
    const hidden = methodBody(source, 'hiddenFromViewer');
    expect(hidden).toMatch(/blocker_id: viewerId/);
    expect(hidden).toMatch(/blocked_id: viewerId/);
  });
});
