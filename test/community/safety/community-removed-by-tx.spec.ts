/**
 * REMOVED-BY-BE (#174-4), the write side: a coach's removal of someone else's
 * voice note or space message keeps who removed it and when, erases the
 * recording or words, and tells the author once, all in one transaction. The
 * author's own delete is unchanged, and lists keep only live rows plus coach
 * removals (an author delete and every older removal stay gone).
 *
 * Runs the real repositories on the in-memory Prisma stand-in (rollback and
 * root-client-write checks as Postgres would).
 */
import { CommunityVoiceRepository } from '../../../src/community/voice/community-voice.repository';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import {
  COMMUNITY_MODERATION_NOTICE_KIND,
  MODERATION_NOTICE_BODIES,
  noticeView,
  removalNoticeKey,
} from '../../../src/community/safety/community-moderation-notices';
import type { PrismaService } from '../../../src/prisma.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

const AUTHOR = '55555555-5555-4555-8555-555555555555';
const COACH = '66666666-6666-4666-8666-666666666666';
const KEY = `${AUTHOR}/1700000000000-0123456789abcdef.m4a`;
const SENT_AT = new Date('2026-10-01T10:00:00.000Z');
const REMOVED_AT = new Date('2026-10-01T11:00:00.000Z');

describe('REMOVED-BY-BE: removal transaction', () => {
  let db: InMemoryPrisma;
  let voice: CommunityVoiceRepository;
  let messages: CommunityMessagesRepository;
  let wsId: string;
  let cohortId: string;

  const notices = () => db.table('notification').filter((n) => n.kind === COMMUNITY_MODERATION_NOTICE_KIND);
  const seedNote = (over: Record<string, unknown> = {}) =>
    db.seed('communityVoiceNote', {
      workspace_id: wsId,
      cohort_id: cohortId,
      conversation_id: null,
      author_id: AUTHOR,
      storage_key: KEY,
      duration_ms: 42_000,
      bytes: BigInt(120_000),
      mime_type: 'audio/mp4',
      created_at: SENT_AT,
      soft_deleted_at: null,
      ...over,
    });
  const seedMessage = (over: Record<string, unknown> = {}) =>
    db.seed('communityMessage', {
      workspace_id: wsId,
      cohort_id: cohortId,
      scope: 'cohort',
      sender_id: AUTHOR,
      kind: 'text',
      body: 'words the coach removes',
      visibility: 'active',
      created_at: SENT_AT,
      updated_at: SENT_AT,
      parent_message_id: null,
      ...over,
    });

  beforeEach(() => {
    db = new InMemoryPrisma();
    db.seed('user', { id: AUTHOR, role: 'student', name: 'Sam', deleted_at: null });
    db.seed('user', { id: COACH, role: 'coach', name: 'Kim', deleted_at: null });
    wsId = db.seed('communityWorkspace', { coach_id: COACH, name: 'Hall', archived_at: null }).id as string;
    cohortId = db.seed('communityCohort', { workspace_id: wsId, name: 'Space' }).id as string;
    const prisma = stub<PrismaService>(db);
    voice = new CommunityVoiceRepository(prisma);
    messages = new CommunityMessagesRepository(prisma);
  });

  describe('voice note', () => {
    it('a coach removal keeps who and when on the note and its chat row, erases the recording, tells the author once', async () => {
      const note = seedNote();
      seedMessage({ id: note.id, kind: 'voice', body: null, created_at: SENT_AT });
      const row = { id: String(note.id), storage_key: KEY, author_id: AUTHOR };

      const work = await voice.softDeleteWithErasure(row, 'moderation', REMOVED_AT, COACH);
      expect(work.map((w) => w.target)).toEqual([KEY]);
      const stored = db.table('communityVoiceNote').find((r) => r.id === note.id);
      expect(stored).toMatchObject({ soft_deleted_at: REMOVED_AT, removed_by_user_id: COACH });
      const chat = db.table('communityMessage').find((r) => r.id === note.id);
      expect(chat).toMatchObject({ deleted_at: REMOVED_AT, visibility: 'hidden', removed_by_user_id: COACH });
      expect(db.table('communityVoiceErasure')).toEqual([expect.objectContaining({ target: KEY, reason: 'moderation' })]);

      expect(notices()).toEqual([
        expect.objectContaining({
          user_id: AUTHOR,
          body: MODERATION_NOTICE_BODIES.hide,
          channel: 'inapp',
          deep_link: 'tgp://community/safety',
          payload: {
            idempotency_key: removalNoticeKey('voice_note', String(note.id)),
            action: 'hide',
            target_type: 'voice_note',
            target_id: note.id,
          },
        }),
      ]);
      // The same notice the report queue's hide shows.
      const view = noticeView(stub(notices()[0]));
      expect(view?.action).toBe('hide');

      // Once per removal: a repeat (a retry, a racing second tap) adds nothing.
      await voice.softDeleteWithErasure(row, 'moderation', new Date(), COACH);
      expect(notices()).toHaveLength(1);
      expect(db.table('communityVoiceNote').find((r) => r.id === note.id)?.soft_deleted_at).toEqual(REMOVED_AT);
    });

    it("the author's own delete keeps no remover and sends no notice", async () => {
      const note = seedNote();
      await voice.softDeleteWithErasure({ id: String(note.id), storage_key: KEY, author_id: AUTHOR }, 'author_delete');
      expect(db.table('communityVoiceNote').find((r) => r.id === note.id)?.removed_by_user_id ?? null).toBeNull();
      expect(notices()).toHaveLength(0);
    });

    it('a failed notice write rolls the whole removal back (one transaction)', async () => {
      const note = seedNote();
      db.beforeCommit = () => {
        throw new Error('connection lost before COMMIT');
      };
      await expect(
        voice.softDeleteWithErasure({ id: String(note.id), storage_key: KEY, author_id: AUTHOR }, 'moderation', REMOVED_AT, COACH),
      ).rejects.toThrow('connection lost');
      db.beforeCommit = null;
      expect(db.table('communityVoiceNote').find((r) => r.id === note.id)).toMatchObject({ soft_deleted_at: null });
      expect(notices()).toHaveLength(0);
    });

    it('lists live notes and coach removals; an author delete and an older removal stay gone', async () => {
      const live = seedNote({ created_at: new Date('2026-10-01T09:00:00.000Z') });
      const coachRemoved = seedNote({ soft_deleted_at: REMOVED_AT, removed_by_user_id: COACH });
      seedNote({ soft_deleted_at: REMOVED_AT });
      seedNote({ soft_deleted_at: REMOVED_AT, removed_by_user_id: null });
      const page = await voice.list({
        workspaceId: wsId,
        cohortId,
        conversationId: null,
        isCoach: true,
        viewerId: COACH,
        limit: 20,
      });
      expect(page.items.map((r) => r.id).sort()).toEqual([live.id, coachRemoved.id].sort());
    });
  });

  describe('space message', () => {
    it('a coach removal keeps who and when, erases the words and tells the author once', async () => {
      const m = seedMessage();
      const msg = { id: String(m.id), created_at: SENT_AT, sender_id: AUTHOR };
      const out = await messages.removeByCoach(msg, COACH);
      expect(out).toMatchObject({ id: m.id, body: null, visibility: 'hidden', removed_by_user_id: COACH });
      expect(out.deleted_at).toBeInstanceOf(Date);
      expect(notices()).toEqual([
        expect.objectContaining({
          user_id: AUTHOR,
          body: MODERATION_NOTICE_BODIES.hide,
          payload: expect.objectContaining({
            idempotency_key: removalNoticeKey('message', String(m.id)),
            action: 'hide',
            target_type: 'message',
          }),
        }),
      ]);
      const again = await messages.removeByCoach(msg, COACH);
      expect(again.deleted_at).toEqual(out.deleted_at);
      expect(notices()).toHaveLength(1);
    });

    it("the author's own delete is unchanged: words kept off the list, no remover, no notice", async () => {
      const m = seedMessage();
      const out = await messages.softDelete({ id: String(m.id), created_at: SENT_AT });
      expect(out).toMatchObject({ visibility: 'hidden' });
      expect(out.removed_by_user_id ?? null).toBeNull();
      expect(notices()).toHaveLength(0);
    });

    it('the space list keeps live rows and coach removals; author deletes and older removals stay gone', async () => {
      const live = seedMessage({ created_at: new Date('2026-10-01T09:00:00.000Z') });
      const removed = seedMessage({ deleted_at: REMOVED_AT, visibility: 'hidden', removed_by_user_id: COACH, body: null });
      seedMessage({ deleted_at: REMOVED_AT, visibility: 'hidden' });
      seedMessage({ deleted_at: REMOVED_AT, visibility: 'hidden', removed_by_user_id: null });
      const rows = await messages.listCohortMessages({ cohortId, before: null, limit: 20 });
      expect(rows.map((r) => r.id).sort()).toEqual([live.id, removed.id].sort());
    });
  });
});
