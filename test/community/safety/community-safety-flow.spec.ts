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
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../../src/community/dms/community-dms.repository';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunityModerationController } from '../../../src/community/moderation/community-moderation.controller';
import {
  COMMUNITY_REPORT_REASONS,
  CommunitySafetyService,
} from '../../../src/community/safety/community-safety.service';
import { CommunitySafetyController } from '../../../src/community/safety/community-safety.controller';
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
    return stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: null }));
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
    posts = new CommunityPostsService(access, postsRepo, msgRepo, rt, np, safety);
    messages = new CommunityMessagesService(
      access,
      msgRepo,
      rt,
      stub<PlanContextService>({ validate: async () => null }),
      safety,
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

  it('hide removes the content for everyone and closes the item', async () => {
    const m = await messages.send(bob, cohortId, 'rude but not filtered');
    const r = await moderation.report(alice, 'message', m.message.id, 'harassment', undefined);
    const acted = await moderation.act(coach, r.item.id, 'hide', undefined);
    expect(acted.item.status).toBe('actioned');
    const list = await messages.list(alice, cohortId, {});
    expect(list.messages.map((x) => x.id)).not.toContain(m.message.id);
    expect((await moderation.listFlagged(coach, {})).items).toHaveLength(0);
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

  it('only the owning coach can act on an item', async () => {
    const m = await messages.send(bob, cohortId, 'something');
    const r = await moderation.report(alice, 'message', m.message.id, 'spam', undefined);
    await expect(moderation.act(alice, r.item.id, 'hide', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(moderation.act(otherCoach, r.item.id, 'hide', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
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

  it('block closes DMs in both directions and hides the thread from both sides', async () => {
    await dms.send(bob, wsId, alice.id, 'hello');
    expect((await dms.listThreads(alice, wsId, {})).threads).toHaveLength(1);
    await safety.block(alice, bob.id);
    expect((await dms.listThreads(alice, wsId, {})).threads).toHaveLength(0);
    // Blocked person: indistinguishable from "not there" (same 404 body).
    const notThere = await dms.send(bob, wsId, carol.id + '-gone', 'x').catch((e: unknown) => e);
    const blockedErr = await dms.send(bob, wsId, alice.id, 'hello again').catch((e: unknown) => e);
    expect(blockedErr).toBeInstanceOf(NotFoundException);
    expect((blockedErr as NotFoundException).getResponse()).toEqual(
      (notThere as NotFoundException).getResponse(),
    );
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
    await expect(dms.send(bob, wsId, alice.id, 'hi')).rejects.toMatchObject({
      response: { code: 'community.dm.not_found', message: expect.stringContaining('Refresh') },
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
