/**
 * B-UGC-5 (ruling OR-112-6): the #610 audit carries closed before launch.
 *
 *  - C-610-10, author-delete half (Opus + Sol): the author's delete recorded
 *    the erasure work and soft-deleted the note in SEPARATE commits. A crash
 *    or failed write between them left a LIVE note with open erasure work,
 *    so the retry cron erased the audio of a note members could still see
 *    (it stopped playing). Now the work row, the note's soft delete and its
 *    search row commit in one transaction, and storage runs only after it.
 *  - C-610-12 (Opus + Sol): re-opening COMPLETED erasure work kept the old
 *    `attempts`, so the first failure of the new intent backed off from the
 *    old count (e.g. 2 hours instead of 1 minute). A genuinely new intent now
 *    starts at zero; still-open work keeps its count.
 *
 * Runs the REAL CommunityVoiceService, CommunityVoiceRepository and erasure
 * helpers over the in-memory Prisma, whose transactions roll back on a throw
 * or a lost COMMIT and refuse root-client writes while open (B-610-13), so a
 * non-atomic write path cannot pass by accident.
 */
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';

import { CommunityVoiceService } from '../../../src/community/voice/community-voice.service';
import { CommunityVoiceRepository } from '../../../src/community/voice/community-voice.repository';
import {
  attemptVoiceErasures,
  recordVoiceErasures,
  voiceErasureBackoffMs,
  type VoiceErasureStorage,
} from '../../../src/community/voice/voice-erasure';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { AnalyticsService } from '../../../src/analytics/analytics.service';
import type { PrismaService } from '../../../src/prisma.service';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

const AUTHOR_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${AUTHOR_ID}/1700000000000-0123456789abcdef.m4a`;

interface Faults {
  /** The note's search-row write fails (connection lost mid-delete). */
  searchWrite?: boolean;
  /** Root-client erasure updates fail (DB blip after the delete committed). */
  rootErasureUpdate?: boolean;
}

/**
 * The repository's PrismaService: the in-memory DB with injectable faults on
 * the root client AND inside every transaction (the old code wrote through
 * the root client, the fixed code through the transaction).
 */
function prismaWithFaults(db: InMemoryPrisma, faults: Faults): PrismaService {
  const wrap = (client: object, inTx: boolean): object =>
    new Proxy(client, {
      get(target, prop: string) {
        if (prop === '$transaction' && !inTx) {
          return async (fn: (tx: object) => Promise<unknown>) =>
            db.$transaction((tx) => fn(wrap(tx, true)));
        }
        const value: unknown = Reflect.get(target, prop);
        if (prop === 'communitySearchEntry' && faults.searchWrite) {
          return {
            ...(value as object),
            updateMany: async () => {
              throw new Error('connection lost during delete');
            },
          };
        }
        if (prop === 'communityVoiceErasure' && faults.rootErasureUpdate && !inTx) {
          return {
            ...(value as object),
            updateMany: async () => {
              throw new Error('erasure table timeout');
            },
          };
        }
        return value;
      },
    });
  return stub<PrismaService>(wrap(db, false));
}

describe('B-UGC-5: author delete is atomic; reopened erasure work starts fresh', () => {
  let db: InMemoryPrisma;
  let faults: Faults;
  let storage: {
    bucket: () => string;
    removeObjects: jest.Mock;
    objectGone: jest.Mock;
    removeOwnerFolder: jest.Mock;
    ownerFolderEmpty: jest.Mock;
  };
  /** Open transactions seen at each storage call (must always be 0). */
  let txOpenAtStorage: number[];
  let voice: CommunityVoiceService;
  let author: User;
  let noteId: string;

  const note = () => db.table('communityVoiceNote').find((r) => r.id === noteId);
  const searchRow = () =>
    db.table('communitySearchEntry').find((r) => r.targetId === noteId);
  const erasures = () => db.table('communityVoiceErasure');

  beforeEach(() => {
    db = new InMemoryPrisma();
    faults = {};
    txOpenAtStorage = [];
    author = stub<User>(
      db.seed('user', { id: AUTHOR_ID, role: 'student', name: 'Bob', deleted_at: null }),
    );
    const ws = db.seed('communityWorkspace', { coach_id: 'coach-1', name: 'Hall', archived_at: null });
    const row = db.seed('communityVoiceNote', {
      workspace_id: ws.id,
      cohort_id: null,
      conversation_id: null,
      author_id: AUTHOR_ID,
      storage_key: KEY,
      duration_ms: 42_000,
      bytes: BigInt(120_000),
      mime_type: 'audio/mp4',
      soft_deleted_at: null,
    });
    noteId = row.id as string;
    db.seed('communitySearchEntry', {
      workspaceId: ws.id,
      cohortId: null,
      kind: 'voice_note_transcript',
      targetId: noteId,
      authorId: AUTHOR_ID,
      excerpt: 'voice note',
      visibleToRoles: ['coach', 'student'],
    });
    storage = {
      bucket: () => 'voice-notes',
      removeObjects: jest.fn(async (keys: string[]) => {
        txOpenAtStorage.push(db.openTransactions);
        return { removed: keys.length, failed: false };
      }),
      objectGone: jest.fn(async () => {
        txOpenAtStorage.push(db.openTransactions);
        return true;
      }),
      removeOwnerFolder: jest.fn(async () => ({ removed: 0, failed: false })),
      ownerFolderEmpty: jest.fn(async () => true),
    };
    const prisma = prismaWithFaults(db, faults);
    voice = new CommunityVoiceService(
      stub<CommunityAccessService>({}),
      new CommunityVoiceRepository(prisma),
      stub<VoiceUploadProvider>(storage),
      stub<CommunityRealtimeService>({}),
      stub<AnalyticsService>({ capture: () => undefined }),
      stub<CommunitySafetyService>({}),
    );
  });

  afterEach(() => {
    db.beforeCommit = null;
  });

  // ── C-610-10: author delete ────────────────────────────────────────────

  describe('C-610-10 (author-delete half)', () => {
    it('a failure between recording the erasure and the soft delete leaves no erasure work for a still-live note', async () => {
      faults.searchWrite = true;
      await expect(voice.delete(author, noteId)).rejects.toThrow('connection lost during delete');
      // Nothing half-done: no open erasure that the cron would run against a
      // live note, the note still plays, the search row is untouched.
      expect(erasures()).toHaveLength(0);
      expect(note()?.soft_deleted_at).toBeNull();
      expect(searchRow()?.softDeletedAt).toBeNull();
      expect(storage.removeObjects).not.toHaveBeenCalled();

      // The member's retry, once the fault clears, deletes everything once.
      faults.searchWrite = false;
      await expect(voice.delete(author, noteId)).resolves.toEqual({ deleted: true });
      expect(erasures()).toHaveLength(1);
      expect(erasures()[0]).toMatchObject({ kind: 'object', target: KEY, attempts: 0 });
      expect(erasures()[0].completed_at).toBeInstanceOf(Date);
      expect(note()?.soft_deleted_at).toBeInstanceOf(Date);
      expect(searchRow()?.softDeletedAt).toBeInstanceOf(Date);
    });

    it('a lost COMMIT (process death) rolls back the erasure work, the soft delete and the search row', async () => {
      db.beforeCommit = () => {
        throw new Error('server closed the connection unexpectedly');
      };
      await expect(voice.delete(author, noteId)).rejects.toThrow(/closed the connection/);
      expect(erasures()).toHaveLength(0);
      expect(note()?.soft_deleted_at).toBeNull();
      expect(searchRow()?.softDeletedAt).toBeNull();
      expect(storage.removeObjects).not.toHaveBeenCalled();
      expect(storage.objectGone).not.toHaveBeenCalled();
    });

    it('one transaction holds all three writes, and storage runs only after it commits', async () => {
      const committed: string[][] = [];
      db.beforeCommit = (writes) => {
        expect(storage.removeObjects).not.toHaveBeenCalled();
        committed.push([...writes]);
      };
      const txSpy = jest.spyOn(db, '$transaction');
      await expect(voice.delete(author, noteId)).resolves.toEqual({ deleted: true });
      expect(txSpy).toHaveBeenCalledTimes(1);
      expect(committed).toEqual([
        expect.arrayContaining([
          'communityVoiceErasure.upsert',
          'communityVoiceNote.updateMany',
          'communitySearchEntry.updateMany',
        ]),
      ]);
      expect(storage.removeObjects).toHaveBeenCalledWith([KEY]);
      expect(txOpenAtStorage.length).toBeGreaterThan(0);
      expect(txOpenAtStorage.every((n) => n === 0)).toBe(true);
      expect(erasures()[0].completed_at).toBeInstanceOf(Date);
    });

    it('an erasure attempt that fails after the commit still answers deleted; the work stays open for the cron', async () => {
      faults.rootErasureUpdate = true;
      await expect(voice.delete(author, noteId)).resolves.toEqual({ deleted: true });
      expect(note()?.soft_deleted_at).toBeInstanceOf(Date);
      expect(searchRow()?.softDeletedAt).toBeInstanceOf(Date);
      expect(erasures()).toHaveLength(1);
      expect(erasures()[0].completed_at).toBeNull();
    });

    it('deleting an already-deleted note keeps its first soft_deleted_at and re-opens the erasure', async () => {
      await voice.delete(author, noteId);
      const first = note()?.soft_deleted_at;
      await expect(voice.delete(author, noteId)).rejects.toBeInstanceOf(NotFoundException);
      expect(note()?.soft_deleted_at).toBe(first);
      expect(erasures()).toHaveLength(1);
      expect(erasures()[0].completed_at).toBeInstanceOf(Date);
    });
  });

  // ── C-610-12: a re-opened erasure starts a fresh failure count ─────────

  describe('C-610-12 (retry count on a re-opened erasure)', () => {
    const failing: VoiceErasureStorage = {
      bucket: () => 'voice-notes',
      removeObjects: async () => ({ removed: 0, failed: true }),
      objectGone: async () => null,
      removeOwnerFolder: async () => ({ removed: 0, failed: true }),
      ownerFolderEmpty: async () => null,
    };

    function seedErasure(over: Record<string, unknown>) {
      return db.seed('communityVoiceErasure', {
        kind: 'object',
        target: KEY,
        reason: 'moderation',
        ...over,
      });
    }

    it('re-opening COMPLETED work resets attempts and last_error, so the first failure backs off 1 minute', async () => {
      seedErasure({
        attempts: 7,
        last_error: 'storage_remove_failed',
        completed_at: new Date('2026-09-01T00:00:00Z'),
      });
      const now = new Date('2026-10-02T12:00:00Z');
      const rows = await recordVoiceErasures(stub<PrismaService>(db), [{ kind: 'object', target: KEY }], 'author_delete', now);
      expect(rows).toEqual([expect.objectContaining({ kind: 'object', target: KEY, attempts: 0 })]);
      expect(erasures()[0]).toMatchObject({
        attempts: 0,
        last_error: null,
        completed_at: null,
        reason: 'author_delete',
      });

      const at = new Date('2026-10-02T12:00:05Z');
      await attemptVoiceErasures(stub<PrismaService>(db), failing, rows, undefined, () => at);
      expect(erasures()[0].attempts).toBe(1);
      expect((erasures()[0].next_attempt_at as Date).getTime()).toBe(
        at.getTime() + voiceErasureBackoffMs(1),
      );
      expect(voiceErasureBackoffMs(1)).toBe(60_000);
    });

    it('still-open work keeps its count when recorded again (it is the same failing work), and is made due now', async () => {
      seedErasure({
        attempts: 4,
        last_error: 'storage_check_unavailable',
        completed_at: null,
        next_attempt_at: new Date('2026-10-02T20:00:00Z'),
      });
      const now = new Date('2026-10-02T12:00:00Z');
      const rows = await recordVoiceErasures(stub<PrismaService>(db), [{ kind: 'object', target: KEY }], 'author_delete', now);
      expect(rows[0].attempts).toBe(4);
      expect(erasures()[0]).toMatchObject({
        attempts: 4,
        last_error: 'storage_check_unavailable',
        reason: 'moderation',
        completed_at: null,
      });
      expect((erasures()[0].next_attempt_at as Date).getTime()).toBe(now.getTime());
    });

    it('an author re-delete after a completed erasure re-opens it with a fresh count', async () => {
      await voice.delete(author, noteId);
      const row = erasures()[0];
      row.attempts = 9;
      row.last_error = 'object_still_present';
      storage.objectGone.mockResolvedValue(null);
      storage.removeObjects.mockResolvedValue({ removed: 0, failed: true });
      await expect(voice.delete(author, noteId)).rejects.toBeInstanceOf(NotFoundException);
      // Re-opened as a new intent, then one failed try: attempts 1, not 10.
      expect(erasures()[0]).toMatchObject({
        attempts: 1,
        last_error: 'storage_remove_failed',
        completed_at: null,
      });
    });
  });
});
