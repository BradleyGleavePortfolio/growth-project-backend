/**
 * App Review 1.2 for the two community surfaces Opus flagged as unprotected
 * (B-610-1, voice-note reporting): member wins and voice notes. Runs the REAL
 * community, voice and moderation services over the in-memory Prisma, so it
 * is the CI-run proof of the whole loop for each surface:
 *
 * - voice notes: report by anyone who can play the note, the coach's flagged
 *   queue with a short-lived playback link and the 24-hour respond-by time,
 *   hide / warn / ban with real effects, author delete, two-way block, and
 *   the DM boundary (DM voice notes are not offered). Audio is never
 *   text-filtered; report plus moderation is the control.
 * - member wins: content filter before the write, audience limited to the
 *   coach's moderated circle (no cross-tenant feed), report, hide, ban (also
 *   for authors with no membership row), author delete, first-name privacy.
 */
import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityService } from '../../../src/community/community.service';
import type { CommunityRepository } from '../../../src/community/community.repository';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import {
  CommunityModerationService,
  REVIEW_WITHIN_MS,
  voiceNoteLabel,
} from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunityVoiceService } from '../../../src/community/voice/community-voice.service';
import { CommunityVoiceRepository } from '../../../src/community/voice/community-voice.repository';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { AnalyticsService } from '../../../src/analytics/analytics.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

const SIGNED_URL = 'https://storage.example.test/voice-notes/signed?token=t';

describe('voice notes and member wins: report, review, block, delete (Apple 1.2)', () => {
  let db: InMemoryPrisma;
  let prisma: PrismaService;
  let safety: CommunitySafetyService;
  let community: CommunityService;
  let voice: CommunityVoiceService;
  let moderation: CommunityModerationService;
  let push: { sendCommunityPush: jest.Mock };
  let signDownload: jest.Mock;

  let coach: User;
  let otherCoach: User;
  let noSpaceCoach: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let nomad: User; // the coach's client with no community membership row yet
  let dave: User; // another tenant's client
  let eve: User; // coachless client
  let frank: User; // client of a coach with no community workspace
  let gina: User; // frank's teammate
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
    });
  }

  function seedNote(author: User, over: Record<string, unknown> = {}): string {
    const row = db.seed('communityVoiceNote', {
      workspace_id: wsId,
      cohort_id: cohortId,
      author_id: author.id,
      storage_key: `${author.id}/1700000000-abc.m4a`,
      duration_ms: 42_000,
      bytes: BigInt(120_000),
      mime_type: 'audio/mp4',
      ...over,
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
    return row.id as string;
  }

  const noteRow = (id: string) => db.table('communityVoiceNote').find((r) => r.id === id);
  const feedIds = async (u: User) => (await community.getFeed(u.id)).map((w) => w.id);

  beforeEach(() => {
    db = new InMemoryPrisma();
    prisma = stub<PrismaService>(db);
    coach = user('coach', 'Coach One');
    otherCoach = user('coach', 'Other Coach');
    noSpaceCoach = user('coach', 'Solo Coach');
    alice = user('student', 'Alice Member', coach.id);
    bob = user('student', 'Bob Member', coach.id);
    carol = user('student', 'Carol Member', coach.id);
    nomad = user('student', 'Nora Nomad', coach.id);
    dave = user('student', 'Dave Elsewhere', otherCoach.id);
    eve = user('student', 'Eve Alone', null);
    frank = user('student', 'Frank Solo', noSpaceCoach.id);
    gina = user('student', 'Gina Solo', noSpaceCoach.id);

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
    for (const u of [alice, bob, carol]) member(u, wsId, cohortId);

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
    signDownload = jest.fn(async () => SIGNED_URL);
    const access = new CommunityAccessService(prisma);
    safety = new CommunitySafetyService(prisma);
    const rt = stub<CommunityRealtimeService>(realtime);
    const np = stub<CommunityNotificationsService>(push);
    const storage = stub<VoiceUploadProvider>({
      createSignedDownload: signDownload,
      bucket: () => 'voice-notes',
      ttlSeconds: () => 600,
    });
    community = new CommunityService(prisma, stub<CommunityRepository>({}), safety);
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
      np,
      prisma,
      storage,
    );
  });

  // ── voice notes ─────────────────────────────────────────────────────────

  describe('voice notes', () => {
    it('a member reports a voice note and the coach queue can play it, with the 24-hour respond-by', async () => {
      const noteId = seedNote(bob);
      const report = await moderation.report(alice, 'voice_note', noteId, 'harassment', 'at 0:20');
      expect(report.item).toMatchObject({ status: 'open', target_type: 'voice_note' });
      // The in-memory clock is fixed in the past; date this report "just now".
      const row = db.table('communityModerationAction').find((x) => x.id === report.item.id);
      if (row) row.created_at = new Date();

      const { items } = await moderation.listFlagged(coach, {});
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item).toMatchObject({
        target_type: 'voice_note',
        target_id: noteId,
        content: 'Voice note, 0:42',
        removed: false,
        media: { kind: 'voice_note', url: SIGNED_URL, duration_ms: 42_000, mime_type: 'audio/mp4' },
        author_user_id: bob.id,
        author_name: 'Bob Member',
        cohort_name: 'Spring plan',
        reason: 'harassment',
        notes: 'at 0:20',
        overdue: false,
      });
      expect(Date.parse(item.respond_by) - Date.parse(item.created_at)).toBe(REVIEW_WITHIN_MS);
      // The playback link is short-lived (15 minutes) and signed for this note's object.
      expect(signDownload).toHaveBeenCalledWith(`${bob.id}/1700000000-abc.m4a`, 15 * 60);
      // Other tenants' coaches and members never see the queue item.
      expect((await moderation.listFlagged(otherCoach, {})).items).toHaveLength(0);
      await expect(moderation.listFlagged(alice, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('marks a report overdue once it is open past 24 hours', async () => {
      const noteId = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', noteId, 'spam', undefined);
      const row = db.table('communityModerationAction').find((x) => x.id === r.item.id);
      expect(row).toBeDefined();
      if (row) row.created_at = new Date(Date.now() - REVIEW_WITHIN_MS - 60_000);
      const { items } = await moderation.listFlagged(coach, {});
      expect(items[0].overdue).toBe(true);
    });

    it('only people who can play the note can report it (same 404 as a missing note)', async () => {
      const noteId = seedNote(bob);
      await expect(
        moderation.report(dave, 'voice_note', noteId, 'spam', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        moderation.report(
          alice,
          'voice_note',
          '99999999-9999-4999-8999-999999999999',
          'spam',
          undefined,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // A legacy DM voice note (none can be created any more) is only its author's.
      const dmNote = seedNote(bob, {
        cohort_id: null,
        conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      await expect(
        moderation.report(alice, 'voice_note', dmNote, 'spam', undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Hide removes the voice note for everyone: by id, list, search, and no new playback link', async () => {
      const noteId = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', noteId, 'sexual', undefined);
      const acted = await moderation.act(coach, r.item.id, 'hide', undefined);
      expect(acted.item.status).toBe('actioned');

      expect(noteRow(noteId)?.soft_deleted_at).toBeInstanceOf(Date);
      const search = db.table('communitySearchEntry').find((x) => x.targetId === noteId);
      expect(search?.softDeletedAt).toBeInstanceOf(Date);
      await expect(voice.getOne(alice, noteId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.getOne(bob, noteId)).rejects.toBeInstanceOf(NotFoundException);
      const page = await voice.list(carol, wsId, { limit: 20 });
      expect(page.voice_notes.map((n) => n.id)).not.toContain(noteId);
      // Closed, so it leaves the open queue.
      expect((await moderation.listFlagged(coach, {})).items).toHaveLength(0);
    });

    it('Warn notifies the author and keeps their access', async () => {
      const noteId = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', noteId, 'other', undefined);
      await moderation.act(coach, r.item.id, 'warn', 'first warning');
      expect(push.sendCommunityPush).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: bob.id,
          targetType: 'voice_note',
          targetId: noteId,
        }),
      );
      await expect(voice.getOne(bob, noteId)).resolves.toBeDefined();
    });

    it('Ban removes the note and the author loses access to the space', async () => {
      const noteId = seedNote(bob);
      const r = await moderation.report(alice, 'voice_note', noteId, 'violence', undefined);
      await moderation.act(coach, r.item.id, 'ban', undefined);
      const rows = db.table('communityMembership').filter((x) => x.user_id === bob.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((x) => x.status === 'removed' && x.removed_at)).toBe(true);
      expect(noteRow(noteId)?.soft_deleted_at).toBeInstanceOf(Date);
      const other = seedNote(carol);
      await expect(voice.getOne(bob, other)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.list(bob, wsId, { limit: 20 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a ban can never target the workspace coach; the refused ban writes nothing', async () => {
      const noteId = seedNote(coach);
      const r = await moderation.report(alice, 'voice_note', noteId, 'other', undefined);
      await expect(moderation.act(coach, r.item.id, 'ban', undefined)).rejects.toMatchObject({
        response: {
          code: 'community.moderation.cannot_ban_coach',
          message: expect.stringContaining('coach'),
        },
      });
      expect(noteRow(noteId)?.soft_deleted_at).toBeNull();
    });

    it('the author can delete their note; the queue then shows it as Removed with no playback', async () => {
      const noteId = seedNote(bob);
      await moderation.report(alice, 'voice_note', noteId, 'spam', undefined);
      await expect(voice.delete(alice, noteId)).rejects.toMatchObject({
        response: {
          code: 'community.voice.not_author',
          message: expect.stringContaining('report'),
        },
      });
      await expect(voice.delete(dave, noteId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.delete(bob, noteId)).resolves.toEqual({ deleted: true });
      expect(
        db.table('communitySearchEntry').find((x) => x.targetId === noteId)?.softDeletedAt,
      ).toBeInstanceOf(Date);
      signDownload.mockClear();
      const { items } = await moderation.listFlagged(coach, {});
      expect(items[0]).toMatchObject({ content: 'Removed', removed: true, media: null });
      expect(signDownload).not.toHaveBeenCalled();
    });

    it('a block hides voice notes both ways and the blocked side cannot probe them by delete', async () => {
      const bobNote = seedNote(bob);
      const aliceNote = seedNote(alice);
      await safety.block(alice, bob.id);
      await expect(voice.getOne(alice, bobNote)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.getOne(bob, aliceNote)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.delete(bob, aliceNote)).rejects.toBeInstanceOf(NotFoundException);
      await expect(voice.getOne(carol, bobNote)).resolves.toBeDefined();
      await safety.unblock(alice, bob.id);
      await expect(voice.getOne(alice, bobNote)).resolves.toBeDefined();
    });

    it('DM voice notes are refused with a stable code and the way forward', async () => {
      const err = await voice
        .create(alice, wsId, {
          storage_key: `${alice.id}/1700000000-abc.m4a`,
          conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          duration_ms: 5000,
          bytes: 1000,
          mime_type: 'audio/mp4',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'community.voice.dm_not_supported',
        message: expect.stringContaining('Send a text message instead'),
      });
      expect(db.table('communityVoiceNote')).toHaveLength(0);
    });

    it('labels durations as m:ss', () => {
      expect(voiceNoteLabel(0)).toBe('Voice note, 0:00');
      expect(voiceNoteLabel(59_400)).toBe('Voice note, 0:59');
      expect(voiceNoteLabel(125_000)).toBe('Voice note, 2:05');
    });
  });

  // ── member wins ─────────────────────────────────────────────────────────

  describe('member wins (More > Community)', () => {
    it('filters objectionable text before the write (422, nothing stored)', async () => {
      await expect(
        community.postWin(alice.id, { title: 'kys', description: 'Hit a new record' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(
        community.postWin(alice.id, { title: 'New record', description: 'f.u.c.k you all' }),
      ).rejects.toMatchObject({ response: { code: 'community.content.rejected' } });
      expect(db.table('communityWin')).toHaveLength(0);
    });

    it('a win is shared with the coach circle only; never with another tenant or a coachless client', async () => {
      const a = await community.postWin(alice.id, {
        title: 'Five workouts this week',
        description: 'Felt strong',
        visibility: 'public',
      });
      const d = await community.postWin(dave.id, { title: 'Ran 5k', description: 'First time' });
      const e = await community.postWin(eve.id, {
        title: 'Stretched daily',
        description: 'Seven days',
      });

      expect(await feedIds(bob)).toEqual([a.id]);
      expect(await feedIds(coach)).toEqual([a.id]);
      expect(await feedIds(dave)).toEqual([d.id]);
      // Coachless: own wins only, never a cross-tenant "public" feed.
      expect(await feedIds(eve)).toEqual([e.id]);
      expect(db.table('communityWin').every((w) => w.visibility === 'circle')).toBe(true);
    });

    it('with no moderated community space (coach runs none) members see only their own wins', async () => {
      const f = await community.postWin(frank.id, {
        title: 'Ten pushups',
        description: 'Clean reps',
      });
      const g = await community.postWin(gina.id, {
        title: 'Walked daily',
        description: 'All week',
      });
      expect(await feedIds(frank)).toEqual([f.id]);
      expect(await feedIds(gina)).toEqual([g.id]);
      // And nobody can pull it into a queue that does not exist.
      await expect(moderation.report(gina, 'win', f.id, 'spam', undefined)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('serves the contract the app renders, with first names only and an is_mine flag', async () => {
      const w = await community.postWin(alice.id, { title: 'Deadlift PR', description: '100 kg' });
      const [seen] = await community.getFeed(bob.id);
      expect(seen).toEqual({
        id: w.id,
        user_id: alice.id,
        display_name: 'Alice',
        title: 'Deadlift PR',
        description: '100 kg',
        created_at: expect.any(String),
        is_mine: false,
        displayName: 'Alice',
        action: 'Deadlift PR',
        createdAt: seen.created_at,
      });
      expect((await community.getFeed(alice.id))[0].is_mine).toBe(true);
      expect(JSON.stringify(seen)).not.toContain('Member');
    });

    it('report -> coach queue -> Hide removes the win from every feed', async () => {
      const w = await community.postWin(alice.id, {
        title: 'Best week',
        description: 'Buy my plan here',
      });
      await expect(moderation.report(dave, 'win', w.id, 'spam', undefined)).rejects.toMatchObject({
        response: { code: 'community.win.not_found', message: expect.any(String) },
      });
      const r = await moderation.report(bob, 'win', w.id, 'spam', undefined);
      const { items } = await moderation.listFlagged(coach, {});
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        workspace_id: wsId,
        target_type: 'win',
        target_id: w.id,
        content: 'Best week\n\nBuy my plan here',
        removed: false,
        media: null,
        author_user_id: alice.id,
      });
      await moderation.act(coach, r.item.id, 'hide', undefined);
      expect(await feedIds(bob)).toEqual([]);
      expect(await feedIds(alice)).toEqual([]);
      await expect(moderation.report(carol, 'win', w.id, 'spam', undefined)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('Ban works even when the author never joined a cohort; their wins leave the feed and posting stops', async () => {
      const w1 = await community.postWin(nomad.id, {
        title: 'Week one',
        description: 'Rude remark',
      });
      const w2 = await community.postWin(nomad.id, { title: 'Week two', description: 'Another' });
      const keep = await community.postWin(carol.id, { title: 'Steady', description: 'Good week' });
      const r = await moderation.report(bob, 'win', w1.id, 'harassment', undefined);
      await moderation.act(coach, r.item.id, 'ban', undefined);

      const rows = db.table('communityMembership').filter((x) => x.user_id === nomad.id);
      expect(rows).toEqual([
        expect.objectContaining({ workspace_id: wsId, cohort_id: cohortId, status: 'removed' }),
      ]);
      expect(await feedIds(bob)).toEqual([keep.id]);
      expect(await feedIds(bob)).not.toContain(w2.id);
      await expect(
        community.postWin(nomad.id, { title: 'Back again', description: 'Hello' }),
      ).rejects.toMatchObject({
        response: {
          code: 'community.win.removed_member',
          message: expect.stringContaining('Community safety'),
        },
      });
    });

    it('a block hides wins both ways; unblock restores', async () => {
      const a = await community.postWin(alice.id, { title: 'A', description: 'Alice win' });
      const b = await community.postWin(bob.id, { title: 'B', description: 'Bob win' });
      await safety.block(bob, alice.id);
      expect(await feedIds(alice)).toEqual([a.id]);
      expect(await feedIds(bob)).toEqual([b.id]);
      expect((await feedIds(carol)).sort()).toEqual([a.id, b.id].sort());
      await safety.unblock(bob, alice.id);
      expect((await feedIds(alice)).sort()).toEqual([a.id, b.id].sort());
    });

    it('the author can delete their own win; anyone else gets the same 404 as a missing win', async () => {
      const w = await community.postWin(alice.id, {
        title: 'Sleep streak',
        description: 'Seven nights',
      });
      await expect(community.deleteWin(bob.id, w.id)).rejects.toMatchObject({
        response: { code: 'community.win.not_found', message: expect.stringContaining('Refresh') },
      });
      await expect(community.deleteWin(coach.id, w.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(community.deleteWin(alice.id, w.id)).resolves.toEqual({
        id: w.id,
        deleted: true,
      });
      expect(await feedIds(bob)).toEqual([]);
      await expect(community.deleteWin(alice.id, w.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a report on a win the author then deletes shows as Removed in the queue', async () => {
      const w = await community.postWin(alice.id, { title: 'Gone soon', description: 'Text' });
      await moderation.report(bob, 'win', w.id, 'other', undefined);
      await community.deleteWin(alice.id, w.id);
      const { items } = await moderation.listFlagged(coach, {});
      expect(items[0]).toMatchObject({ target_type: 'win', content: 'Removed', removed: true });
    });
  });
});
