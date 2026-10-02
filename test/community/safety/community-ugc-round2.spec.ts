/**
 * #610 fix round 2 (Sol BLOCK + AUD-OPUS-2): behaviour proofs over the REAL
 * community, voice, moderation, safety and access services on the in-memory
 * Prisma. Each block fails on the pre-fix code:
 *
 * - B-610-1: a member with zero cohort memberships who sees a teammate's
 *   wins can block them (was 404 block.not_found); safety, report and the
 *   review queue stay reachable when FEATURE_COMMUNITY_API is off, like wins.
 * - B-610-2: a ban is a durable workspace ban: a new default cohort, an
 *   archived old cohort and first-touch bootstrap never re-admit the member;
 *   a banned viewer only sees their own wins and cannot post; reinstatement
 *   is explicit.
 * - B-610-3: a banned/removed author can still delete their own voice note.
 * - B-610-4: Warn / Hide / Ban store a member-readable notice atomically with
 *   the resolution, also with push off and no device token; the response
 *   says what was stored.
 * - B-610-5: author delete and moderator hide/ban erase the recording.
 */
import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityService } from '../../../src/community/community.service';
import { CommunityRepository } from '../../../src/community/community.repository';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunityModerationController } from '../../../src/community/moderation/community-moderation.controller';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunitySafetyController } from '../../../src/community/safety/community-safety.controller';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { CommunityVoiceService } from '../../../src/community/voice/community-voice.service';
import { CommunityVoiceRepository } from '../../../src/community/voice/community-voice.repository';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import { liftWorkspaceBan } from '../../../src/community/community-ban';
import { COMMUNITY_MODERATION_NOTICE_KIND } from '../../../src/community/safety/community-moderation-notices';
import type { AnalyticsService } from '../../../src/analytics/analytics.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

describe('#610 round 2: wins safety reach, durable bans, notices, recording erasure', () => {
  let db: InMemoryPrisma;
  let prisma: PrismaService;
  let safety: CommunitySafetyService;
  let community: CommunityService;
  let voice: CommunityVoiceService;
  let moderation: CommunityModerationService;
  let access: CommunityAccessService;
  let push: { sendCommunityPush: jest.Mock };
  let removeObjects: jest.Mock;

  let coach: User;
  let alice: User;
  let bob: User;
  let nomad: User; // the coach's client with no community membership row
  let dave: User; // another tenant's client
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

  const savedEnv = { ...process.env };

  function user(role: string, name: string, coachId: string | null = null): User {
    return stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  }

  function member(u: User, workspaceId: string, cohort: string): void {
    db.seed('communityMembership', {
      workspace_id: workspaceId,
      cohort_id: cohort,
      user_id: u.id,
      status: 'active',
      role: 'student',
      dm_enabled: null,
      removed_at: null,
      joined_at: new Date(),
      notify_level: 'all',
      last_read_message_at: null,
    });
  }

  function seedNote(author: User): { id: string; key: string } {
    const key = `${author.id}/1700000000000-0123456789abcdef.m4a`;
    const row = db.seed('communityVoiceNote', {
      workspace_id: wsId,
      cohort_id: cohortId,
      author_id: author.id,
      storage_key: key,
      duration_ms: 42_000,
      bytes: BigInt(120_000),
      mime_type: 'audio/mp4',
    });
    db.seed('communitySearchEntry', {
      workspaceId: wsId,
      cohortId,
      kind: 'voice_note_transcript',
      targetId: row.id,
      authorId: author.id,
      excerpt: 'voice note',
      visibleToRoles: ['coach', 'assistant', 'student'],
    });
    return { id: row.id as string, key };
  }

  const feedIds = async (u: User) => (await community.getFeed(u.id)).map((w) => w.id);
  const activeMemberships = (u: User) =>
    db.table('communityMembership').filter((m) => m.user_id === u.id && m.status === 'active');

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    delete process.env.FEATURE_COMMUNITY_PUSH;
    db = new InMemoryPrisma();
    prisma = stub<PrismaService>(db);
    coach = user('coach', 'Coach One');
    const otherCoach = user('coach', 'Other Coach');
    alice = user('student', 'Alice Member', coach.id);
    bob = user('student', 'Bob Member', coach.id);
    nomad = user('student', 'Nora Nomad', coach.id);
    dave = user('student', 'Dave Elsewhere', otherCoach.id);

    const ws = db.seed('communityWorkspace', {
      coach_id: coach.id,
      name: 'Hall',
      dm_enabled_default: true,
      archived_at: null,
    });
    wsId = ws.id as string;
    const cohort = db.seed('communityCohort', {
      workspace_id: wsId,
      name: 'Spring plan',
      status: 'active',
      archived_at: null,
      sort_order: 0,
    });
    cohortId = cohort.id as string;
    member(alice, wsId, cohortId);
    member(bob, wsId, cohortId);

    const otherWs = db.seed('communityWorkspace', {
      coach_id: otherCoach.id,
      name: 'Elsewhere',
      dm_enabled_default: true,
      archived_at: null,
    });
    const otherCohort = db.seed('communityCohort', {
      workspace_id: otherWs.id,
      name: 'Other plan',
      status: 'active',
      archived_at: null,
      sort_order: 0,
    });
    member(dave, otherWs.id as string, otherCohort.id as string);

    push = { sendCommunityPush: jest.fn(async () => undefined) };
    removeObjects = jest.fn(async (keys: string[]) => ({ removed: keys.length, failed: false }));
    access = new CommunityAccessService(prisma);
    safety = new CommunitySafetyService(prisma);
    const rt = stub<CommunityRealtimeService>(realtime);
    const storage = stub<VoiceUploadProvider>({
      createSignedDownload: jest.fn(async () => 'https://storage.example.test/signed'),
      removeObjects,
      bucket: () => 'voice-notes',
      ttlSeconds: () => 600,
    });
    community = new CommunityService(prisma, new CommunityRepository(prisma), safety);
    voice = new CommunityVoiceService(
      access,
      new CommunityVoiceRepository(prisma),
      storage,
      rt,
      stub<AnalyticsService>({ capture: () => undefined }),
      safety,
    );
    moderation = new CommunityModerationService(
      access,
      new CommunityModerationRepository(prisma),
      new CommunityMessagesRepository(prisma),
      new CommunityPostsRepository(prisma),
      rt,
      stub<CommunityNotificationsService>(push),
      prisma,
      storage,
    );
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  // ── B-610-1 ──────────────────────────────────────────────────────────────

  describe('B-610-1: safety wherever wins are', () => {
    it('a member with zero memberships can block a teammate whose wins they see', async () => {
      const a = await community.postWin(alice.id, { title: 'A', description: 'Alice win' });
      expect(db.table('communityMembership').filter((m) => m.user_id === nomad.id)).toEqual([]);
      expect(await feedIds(nomad)).toEqual([a.id]);

      await expect(safety.block(nomad, alice.id)).resolves.toBeDefined();
      expect(await feedIds(nomad)).toEqual([]);
      expect(await feedIds(alice)).toEqual([a.id]);
    });

    it('the wins circle never opens blocking across tenants or against the coach', async () => {
      await expect(safety.block(dave, alice.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(safety.block(nomad, coach.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('safety, report and the review queue stay reachable when FEATURE_COMMUNITY_API is off', () => {
      process.env.FEATURE_COMMUNITY_API = 'false';
      const guard = new CommunityFeatureFlagGuard(new Reflector());
      const ctxFor = (cls: object, handler: (...args: never[]) => unknown): ExecutionContext =>
        stub<ExecutionContext>({
          switchToHttp: () => ({ getRequest: () => ({ user: { id: nomad.id } }) }),
          getHandler: () => handler,
          getClass: () => cls,
        });
      const safetyProto = CommunitySafetyController.prototype;
      const modProto = CommunityModerationController.prototype;
      const handlers: Array<[object, (...args: never[]) => unknown]> = [
        [CommunitySafetyController, safetyProto.info],
        [CommunitySafetyController, safetyProto.block],
        [CommunitySafetyController, safetyProto.unblock],
        [CommunitySafetyController, safetyProto.list],
        [CommunitySafetyController, safetyProto.notices],
        [CommunitySafetyController, safetyProto.markNoticeRead],
        [CommunityModerationController, modProto.report],
        [CommunityModerationController, modProto.flagged],
        [CommunityModerationController, modProto.queue],
        [CommunityModerationController, modProto.act],
      ];
      for (const [cls, handler] of handlers) {
        expect(handler).toBeDefined();
        expect(guard.canActivate(ctxFor(cls, handler))).toBe(true);
      }
    });
  });

  // ── B-610-2 ──────────────────────────────────────────────────────────────

  describe('B-610-2: a ban is durable and workspace-wide', () => {
    async function banBob(): Promise<string> {
      const note = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', note.id, 'harassment', undefined);
      await moderation.act(coach, r.item.id, 'ban', undefined);
      return note.id;
    }

    it('a new default cohort, an archived old cohort and first-touch bootstrap never re-admit a banned member', async () => {
      await banBob();
      expect(db.table('communityWorkspaceBan')).toEqual([
        expect.objectContaining({ workspace_id: wsId, user_id: bob.id }),
      ]);
      // The coach reorganizes: a new default cohort, the old one archived.
      const fresh = db.seed('communityCohort', {
        workspace_id: wsId,
        name: 'Autumn plan',
        status: 'active',
        archived_at: null,
        sort_order: -1,
      });
      const old = db.table('communityCohort').find((c) => c.id === cohortId);
      if (old) {
        old.status = 'archived';
        old.archived_at = new Date();
      }

      const me = await community.getMe(bob);
      expect(me.membership).toBeNull();
      expect(activeMemberships(bob)).toEqual([]);
      expect(await access.canAccessWorkspace(wsId, bob)).toBe(false);
      expect(
        await access.canAccessCohort({ id: fresh.id as string, workspace_id: wsId }, bob),
      ).toBe(false);
      expect(await access.listAccessibleCohortIds(wsId, bob.id)).toEqual([]);
      // A never-banned teammate still bootstraps into the new default cohort.
      const nomadMe = await community.getMe(nomad);
      expect(nomadMe.membership).not.toBeNull();
      expect(activeMemberships(nomad)).toEqual([expect.objectContaining({ cohort_id: fresh.id })]);
    });

    it('a banned viewer only sees their own wins and cannot post new ones', async () => {
      const mine = await community.postWin(bob.id, { title: 'Mine', description: 'Bob win' });
      const theirs = await community.postWin(alice.id, { title: 'A', description: 'Alice win' });
      await banBob();
      expect(await feedIds(bob)).toEqual([mine.id]);
      expect(await feedIds(alice)).toEqual([theirs.id]);
      await expect(
        community.postWin(bob.id, { title: 'Again', description: 'Hello' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a ban on an author with no cohort membership still writes the durable ban', async () => {
      const w = await community.postWin(nomad.id, { title: 'N', description: 'Rude remark' });
      const r = await moderation.report(alice, 'win', w.id, 'harassment', undefined);
      await moderation.act(coach, r.item.id, 'ban', undefined);
      expect(db.table('communityWorkspaceBan')).toEqual([
        expect.objectContaining({ workspace_id: wsId, user_id: nomad.id }),
      ]);
      expect((await community.getMe(nomad)).membership).toBeNull();
    });

    it('only an explicit reinstatement lifts the ban', async () => {
      await banBob();
      await liftWorkspaceBan(prisma, {
        workspaceId: wsId,
        userId: bob.id,
        liftedById: coach.id,
        at: new Date(),
      });
      // Reinstated: the coach re-adds them (the cohort-members path also lifts).
      member(bob, wsId, cohortId);
      expect(await access.canAccessWorkspace(wsId, bob)).toBe(true);
    });
  });

  // ── B-610-3 + B-610-5 (author delete) ───────────────────────────────────

  describe('B-610-3 / B-610-5: author delete', () => {
    it('a banned author can still delete their own voice note, and the recording is erased', async () => {
      const kept = seedNote(bob);
      await (async () => {
        const n = seedNote(bob);
        const r = await moderation.report(alice, 'voice_note', n.id, 'other', undefined);
        await moderation.act(coach, r.item.id, 'ban', undefined);
      })();
      removeObjects.mockClear();
      await expect(voice.delete(bob, kept.id)).resolves.toEqual({ deleted: true });
      const row = db.table('communityVoiceNote').find((n) => n.id === kept.id);
      expect(row?.soft_deleted_at).toBeInstanceOf(Date);
      const search = db.table('communitySearchEntry').find((s) => s.targetId === kept.id);
      expect(search?.softDeletedAt).toBeInstanceOf(Date);
      expect(removeObjects).toHaveBeenCalledWith([kept.key]);
    });

    it('someone else still gets 404 (cannot read) or 403 (can read, not the author)', async () => {
      const n = seedNote(bob);
      await expect(voice.delete(dave, n.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.delete(alice, n.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect(removeObjects).not.toHaveBeenCalled();
    });
  });

  // ── B-610-4 ──────────────────────────────────────────────────────────────

  describe('B-610-4: the member is told in the app, push or not', () => {
    it('Warn with push off and no device token stores a notice the member can read', async () => {
      const n = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', n.id, 'other', 'please stop');
      const res = await moderation.act(coach, r.item.id, 'warn', 'first warning');
      expect(res.member_notice).toEqual({ stored: true, push: 'attempted' });
      expect(res.item.status).toBe('actioned');

      const { notices, unread_count } = await safety.listNotices(bob);
      expect(unread_count).toBe(1);
      expect(notices).toEqual([
        expect.objectContaining({
          action: 'warn',
          read: false,
          message: expect.stringContaining('warning'),
        }),
      ]);
      // Never the reporter, the report reason or the moderator notes.
      expect(JSON.stringify(notices)).not.toMatch(/Alice|please stop|first warning/);
      expect(db.table('notification')).toEqual([
        expect.objectContaining({
          user_id: bob.id,
          kind: COMMUNITY_MODERATION_NOTICE_KIND,
          channel: 'inapp',
        }),
      ]);

      await safety.markNoticeRead(bob, notices[0].id);
      expect((await safety.listNotices(bob)).unread_count).toBe(0);
      await expect(safety.markNoticeRead(alice, notices[0].id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('Hide and Ban also store a notice; Dismiss stores none', async () => {
      const a = seedNote(bob);
      const b = seedNote(alice);
      const c = seedNote(bob);
      const r1 = await moderation.report(alice, 'voice_note', a.id, 'other', undefined);
      const r2 = await moderation.report(bob, 'voice_note', b.id, 'other', undefined);
      const r3 = await moderation.report(alice, 'voice_note', c.id, 'other', undefined);
      await moderation.act(coach, r2.item.id, 'dismiss', undefined);
      expect((await safety.listNotices(alice)).notices).toEqual([]);
      const hidden = await moderation.act(coach, r1.item.id, 'hide', undefined);
      expect(hidden.member_notice?.stored).toBe(true);
      await moderation.act(coach, r3.item.id, 'ban', undefined);
      const actions = (await safety.listNotices(bob)).notices.map((x) => x.action).sort();
      expect(actions).toEqual(['ban', 'hide']);
    });

    it('the notice is written in the resolution transaction: a failed insert fails the action and sends no push', async () => {
      const n = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', n.id, 'other', undefined);
      const realTx = db.$transaction.bind(db);
      // Simulate the notice insert failing inside the transaction: the
      // resolution must not be returned (and on Postgres is rolled back).
      jest.spyOn(db, '$transaction').mockImplementation(async (fn) =>
        realTx(async () => {
          const failing = new Proxy(db, {
            get: (t, prop: string) =>
              prop === 'notification'
                ? {
                    findMany: async () => [],
                    create: async () => {
                      throw new Error('insert failed');
                    },
                  }
                : Reflect.get(t, prop),
          });
          return fn(failing);
        }),
      );
      await expect(moderation.act(coach, r.item.id, 'warn', undefined)).rejects.toThrow(
        'insert failed',
      );
      expect(push.sendCommunityPush).not.toHaveBeenCalled();
    });
  });

  // ── B-610-5 (moderation) ─────────────────────────────────────────────────

  describe('B-610-5: hidden or banned recordings are erased after the report closes', () => {
    it('Hide erases the recording object and keeps the moderation row as the audit record', async () => {
      const n = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', n.id, 'other', undefined);
      await moderation.act(coach, r.item.id, 'hide', undefined);
      expect(removeObjects).toHaveBeenCalledWith([n.key]);
      const audit = db.table('communityModerationAction').find((x) => x.id === r.item.id);
      expect(audit).toMatchObject({ status: 'actioned', action: 'hide', target_id: n.id });
    });

    it('Warn and Dismiss never erase anything', async () => {
      const n = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', n.id, 'other', undefined);
      await moderation.act(coach, r.item.id, 'warn', undefined);
      const r2 = await moderation.report(alice, 'voice_note', n.id, 'spam', undefined);
      await moderation.act(coach, r2.item.id, 'dismiss', undefined);
      expect(removeObjects).not.toHaveBeenCalled();
    });
  });
});
