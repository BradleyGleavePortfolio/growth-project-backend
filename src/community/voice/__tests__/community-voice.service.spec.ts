/**
 * Unit tests for CommunityVoiceService (v3-3 audio voice notes).
 *
 * Mocks CommunityAccessService + CommunityVoiceRepository + VoiceUploadProvider
 * + CommunityRealtimeService + AnalyticsService, so these run with NO DB and NO
 * Supabase. They pin the slice's tenancy + upload-confirm + bucket-binding +
 * realtime-best-effort doctrine:
 *
 *   - Tenancy: a cohort-scoped note is 404 to a non-member (existence never
 *     leaks); a DM note is 404 to anyone but its author (coach excepted).
 *   - Upload → confirm → insert: the row is only written on create(), never at
 *     URL-issue time (issueUploadUrl touches the repo zero times).
 *   - Bucket binding: a create() with a storage_key outside the caller's
 *     `${authorId}/` namespace is rejected 400 before any insert.
 *   - Realtime: the post-insert ping is best-effort — a publish throw never
 *     fails create(), and a publish_failed telemetry event is captured.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CommunityVoiceNote, User } from '@prisma/client';
import { CommunityAccessService } from '../../community-access.service';
import { CommunityVoiceService } from '../community-voice.service';
import { mintVoiceKey } from '../voice-storage-key';
import type { IssueVoiceUploadDto } from '../community-voice.dto';
import { makeUser } from './test-user.factory';
import { safetyWithBlocks } from '../../../../test/community/safety/safety-test-helpers';

type AccessMock = {
  findWorkspace: jest.Mock;
  findCohort: jest.Mock;
  isWorkspaceCoach: jest.Mock;
  canAccessWorkspace: jest.Mock;
  canAccessCohort: jest.Mock;
  assertCanPost: jest.Mock;
  listAccessibleCohortIds: jest.Mock;
  membershipInWorkspace: jest.Mock;
};
type RepoMock = {
  findByStorageKey: jest.Mock;
  createVoiceNote: jest.Mock;
  findById: jest.Mock;
  softDeleteWithErasure: jest.Mock;
  list: jest.Mock;
  recordErasure: jest.Mock;
  attemptErasure: jest.Mock;
  viewExtras: jest.Mock;
  findChatMessage: jest.Mock;
  markHeard: jest.Mock;
  consentSeenAt: jest.Mock;
  markConsentSeen: jest.Mock;
};
type UploadMock = {
  createSignedUpload: jest.Mock;
  createSignedUploadWithKey: jest.Mock;
  statObject: jest.Mock;
  removeObjects: jest.Mock;
  createSignedDownload: jest.Mock;
  bucket: jest.Mock;
  ttlSeconds: jest.Mock;
};
type RealtimeMock = {
  cohortShard: jest.Mock;
  channels: { cohort: jest.Mock };
  broadcastCommunityEvent: jest.Mock;
};
type AnalyticsMock = { capture: jest.Mock };

const WS_A = '11111111-1111-1111-1111-111111111111';
const COHORT_A = '33333333-3333-3333-3333-333333333333';
const NOTE_A = '44444444-4444-4444-4444-444444444444';
const COACH_A_ID = '55555555-5555-5555-5555-555555555555';
const MEMBER_ID = '66666666-6666-6666-6666-666666666666';
const STRANGER_ID = '77777777-7777-7777-7777-777777777777';
const CONV_A = '88888888-8888-8888-8888-888888888888';

const coachA = makeUser({ id: COACH_A_ID, role: 'coach' });
const member = makeUser({ id: MEMBER_ID, role: 'student' });
const stranger = makeUser({ id: STRANGER_ID, role: 'student' });

function note(over: Partial<CommunityVoiceNote> = {}): CommunityVoiceNote {
  const base: CommunityVoiceNote = {
    id: NOTE_A,
    workspace_id: WS_A,
    cohort_id: COHORT_A,
    conversation_id: null,
    author_id: MEMBER_ID,
    storage_key: `${MEMBER_ID}/1700000000-abc.m4a`,
    duration_ms: 5000,
    bytes: BigInt(120000),
    mime_type: 'audio/mp4',
    waveform_peaks: null,
    created_at: new Date('2026-03-01T00:00:00.000Z'),
    soft_deleted_at: null,
    removed_by_user_id: null,
  };
  return { ...base, ...over };
}

const HEARD_AT = new Date('2026-03-02T00:00:00.000Z');
const PARENT_ID = '99999999-9999-4999-8999-999999999999';
const ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function extras(over: Record<string, unknown> = {}) {
  return {
    coachId: COACH_A_ID,
    names: new Map<string, string | null>([[MEMBER_ID, 'Sam Rivers'], [COACH_A_ID, 'Coach Kim']]),
    fullName: () => false,
    heardAt: new Map<string, Date>(),
    chat: new Map<string, { parent_message_id: string | null }>(),
    ...over,
  };
}

function chatMessage(over: Record<string, unknown> = {}) {
  return {
    id: PARENT_ID,
    created_at: new Date('2026-02-28T00:00:00.000Z'),
    scope: 'cohort',
    workspace_id: WS_A,
    cohort_id: COHORT_A,
    sender_id: COACH_A_ID,
    deleted_at: null,
    plan_context_type: null,
    parent_message_id: null,
    parent_message_at: null,
    ...over,
  };
}

const VALID_CREATE = {
  storage_key: `${MEMBER_ID}/1700000000-abc.m4a`,
  cohort_id: COHORT_A,
  conversation_id: undefined,
  duration_ms: 5000,
  bytes: 120000,
  mime_type: 'audio/mp4' as const,
};

describe('CommunityVoiceService', () => {
  let access: AccessMock;
  let repo: RepoMock;
  let upload: UploadMock;
  let realtime: RealtimeMock;
  let analytics: AnalyticsMock;
  let service: CommunityVoiceService;

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
    // A-610-1: create() accepts only server-minted keys (issuance MAC).
    process.env.VOICE_KEY_SIGNING_SECRET = 'test-voice-key-secret';
    VALID_CREATE.storage_key = mintVoiceKey(MEMBER_ID, 'm4a');
    delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
    access = {
      findWorkspace: jest.fn().mockResolvedValue({ id: WS_A }),
      findCohort: jest.fn().mockResolvedValue({ id: COHORT_A, workspace_id: WS_A }),
      isWorkspaceCoach: jest.fn().mockResolvedValue(false),
      canAccessWorkspace: jest.fn().mockResolvedValue(true),
      canAccessCohort: jest.fn().mockResolvedValue(true),
      assertCanPost: jest.fn().mockResolvedValue(undefined),
      listAccessibleCohortIds: jest.fn().mockResolvedValue([COHORT_A]),
      membershipInWorkspace: jest.fn().mockResolvedValue(true),
    };
    repo = {
      findByStorageKey: jest.fn().mockResolvedValue(null),
      createVoiceNote: jest.fn().mockResolvedValue({ row: note(), replayed: false }),
      findById: jest.fn().mockResolvedValue(note()),
      softDeleteWithErasure: jest.fn(async (n: { storage_key: string }) => [
        { id: 'erasure-0', kind: 'object', target: n.storage_key, attempts: 0 },
      ]),
      list: jest.fn().mockResolvedValue({ items: [note()], nextCursor: null }),
      recordErasure: jest.fn(async (keys: string[]) =>
        keys.map((k, i) => ({ id: `erasure-${i}`, kind: 'object', target: k, attempts: 0 })),
      ),
      attemptErasure: jest.fn().mockResolvedValue({ completed: 1, pending: 0 }),
      viewExtras: jest.fn().mockResolvedValue(extras()),
      findChatMessage: jest.fn().mockResolvedValue(chatMessage()),
      markHeard: jest.fn().mockResolvedValue(HEARD_AT),
      consentSeenAt: jest.fn().mockResolvedValue(null),
      markConsentSeen: jest.fn().mockResolvedValue(HEARD_AT),
    };
    upload = {
      createSignedUpload: jest.fn().mockResolvedValue({
        upload_url: 'https://signed.upload/put',
        public_url: `https://x/object/public/voice-notes/${MEMBER_ID}/1700000000-abc.m4a`,
        expires_at: '2026-03-01T00:10:00.000Z',
      }),
      createSignedUploadWithKey: jest.fn().mockResolvedValue({
        upload_url: 'https://signed.upload/put',
        public_url: `https://x/object/public/voice-notes/${MEMBER_ID}/1700000000-abc.m4a`,
        storage_key: `${MEMBER_ID}/1700000000-abc.m4a`,
        expires_at: '2026-03-01T00:10:00.000Z',
      }),
      statObject: jest
        .fn()
        .mockResolvedValue({ state: 'present', size: 120000, contentType: 'audio/mp4' }),
      removeObjects: jest.fn().mockResolvedValue({ removed: 1, failed: false }),
      createSignedDownload: jest.fn().mockResolvedValue('https://signed.download/get'),
      bucket: jest.fn().mockReturnValue('voice-notes'),
      ttlSeconds: jest.fn().mockReturnValue(600),
    };
    realtime = {
      cohortShard: jest.fn().mockReturnValue(0),
      channels: { cohort: jest.fn().mockReturnValue('community:cohort:x:messages:0') },
      broadcastCommunityEvent: jest.fn().mockResolvedValue(undefined),
    };
    analytics = { capture: jest.fn() };
    // Structural mocks stub only the methods the service calls; the partials are
    // intentional (R0 permits @ts-expect-error with a one-line justification).
    // prettier-ignore
    // @ts-expect-error mocks are partial implementations of the injected deps
    service = new CommunityVoiceService(access, repo, upload, realtime, analytics, safetyWithBlocks());
  });

  // ── issueUploadUrl: validate-before-mint, no speculative row ─────────────────

  describe('issueUploadUrl', () => {
    it('mints a signed URL without writing any row', async () => {
      const res = await service.issueUploadUrl(member, WS_A, {
        duration_ms: 5000,
        bytes: 120000,
        mime_type: 'audio/mp4',
      });
      expect(res.upload_url).toBe('https://signed.upload/put');
      expect(res.storage_key).toBe(`${MEMBER_ID}/1700000000-abc.m4a`);
      expect(res.bucket).toBe('voice-notes');
      // Upload-confirm doctrine: NO durable row at URL-issue time.
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
    });

    it('404s a non-member before minting any URL', async () => {
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(
        service.issueUploadUrl(stranger, WS_A, {
          duration_ms: 5000,
          bytes: 120000,
          mime_type: 'audio/mp4',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(upload.createSignedUploadWithKey).not.toHaveBeenCalled();
    });

    it('rejects a disallowed mime type with 400 (no URL minted)', async () => {
      // A declared-type spoof past the 4-type allowlist. The DTO field is the
      // mime union, but a real HTTP client can send any string, so the service
      // re-checks. We model that untrusted input with a string-typed payload
      // (the service signature widens it to IssueVoiceUploadDto) — no cast.
      const spoof: { duration_ms: number; bytes: number; mime_type: string } = {
        duration_ms: 5000,
        bytes: 120000,
        mime_type: 'audio/mpeg',
      };
      await expect(
        service.issueUploadUrl(member, WS_A, {
          ...spoof,
          mime_type: spoof.mime_type as IssueVoiceUploadDto['mime_type'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(upload.createSignedUploadWithKey).not.toHaveBeenCalled();
    });
  });

  // ── BPF-1: a member of a public space only (the Hall is closed to them) ──────

  describe('BPF-1: a note for a space meets that space\'s rule, as a text message there', () => {
    beforeEach(() => access.canAccessWorkspace.mockResolvedValue(false));
    const forTheSpace = { duration_ms: 5000, bytes: 120000, mime_type: 'audio/mp4' as const, cohort_id: COHORT_A };

    it('B-TEST: the upload for the space is issued and the note there is sent', async () => {
      await expect(service.issueUploadUrl(member, WS_A, forTheSpace)).resolves.toEqual(
        expect.objectContaining({ storage_key: `${MEMBER_ID}/1700000000-abc.m4a` }),
      );
      expect((await service.create(member, WS_A, VALID_CREATE)).voice_note.id).toBe(NOTE_A);
      expect(access.canAccessCohort).toHaveBeenCalledWith(expect.objectContaining({ id: COHORT_A }), member);
    });
  });

  // ── create: bucket binding + durable insert + best-effort ping ───────────────

  describe('create', () => {
    it('persists a cohort note for a member and fires published telemetry', async () => {
      const res = await service.create(member, WS_A, VALID_CREATE);
      expect(res.voice_note.id).toBe(NOTE_A);
      expect(res.voice_note.url).toBe('https://signed.download/get');
      expect(repo.createVoiceNote).toHaveBeenCalledWith(
        expect.objectContaining({ authorId: MEMBER_ID, cohortId: COHORT_A }),
      );
      expect(analytics.capture).toHaveBeenCalledWith(
        MEMBER_ID,
        'community.voice.note_published',
        expect.objectContaining({ workspace_id: WS_A }),
      );
    });

    it('rejects a storage_key outside the caller namespace (bucket binding)', async () => {
      await expect(
        service.create(member, WS_A, {
          ...VALID_CREATE,
          storage_key: `${STRANGER_ID}/forged.m4a`,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
    });

    it('does not fail the write when the realtime ping throws (best-effort)', async () => {
      realtime.broadcastCommunityEvent.mockRejectedValue(new Error('rt down'));
      const res = await service.create(member, WS_A, VALID_CREATE);
      expect(res.voice_note.id).toBe(NOTE_A);
      // allow the void-ed .catch() microtask to settle
      await new Promise((r) => setImmediate(r));
      expect(analytics.capture).toHaveBeenCalledWith(
        MEMBER_ID,
        'community.voice.publish_failed',
        expect.objectContaining({ workspace_id: WS_A }),
      );
    });

    it('refuses a DM voice note before any row is written (no DM thread binding)', async () => {
      const err = await service
        .create(member, WS_A, {
          ...VALID_CREATE,
          cohort_id: undefined,
          conversation_id: CONV_A,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'community.voice.dm_not_supported',
          message: expect.stringContaining('not in direct messages'),
        }),
      );
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    });
  });

  // ── reads: tenancy 404s ──────────────────────────────────────────────────────

  describe('getOne', () => {
    it('returns a cohort note to a member of the cohort', async () => {
      const res = await service.getOne(member, NOTE_A);
      expect(res.voice_note.id).toBe(NOTE_A);
    });

    it('404s a cohort note to a non-member (existence never leaks)', async () => {
      access.canAccessCohort.mockResolvedValue(false);
      await expect(service.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a DM note to anyone but its author', async () => {
      repo.findById.mockResolvedValue(
        note({ cohort_id: null, conversation_id: CONV_A, author_id: MEMBER_ID }),
      );
      await expect(service.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a soft-deleted note', async () => {
      repo.findById.mockResolvedValue(note({ soft_deleted_at: new Date() }));
      await expect(service.getOne(member, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── delete: author or coach only ─────────────────────────────────────────────

  describe('delete', () => {
    it('lets the author soft-delete their note', async () => {
      const res = await service.delete(member, NOTE_A);
      expect(res).toEqual({ deleted: true });
      expect(repo.softDeleteWithErasure).toHaveBeenCalledWith(
        expect.objectContaining({ id: NOTE_A, storage_key: note().storage_key }),
        'author_delete',
      );
    });

    it('commits the erasure work and the soft delete together, then tries storage (C-610-10)', async () => {
      const order: string[] = [];
      repo.softDeleteWithErasure.mockImplementation(async (n: { storage_key: string }) => {
        order.push('erasure+softDelete (one transaction)');
        return [{ id: 'e1', kind: 'object', target: n.storage_key, attempts: 0 }];
      });
      repo.attemptErasure.mockImplementation(async () => {
        order.push('attempt');
        return { completed: 0, pending: 1 };
      });
      await expect(service.delete(member, NOTE_A)).resolves.toEqual({ deleted: true });
      expect(order).toEqual(['erasure+softDelete (one transaction)', 'attempt']);
      expect(repo.recordErasure).not.toHaveBeenCalled();
      expect(repo.attemptErasure).toHaveBeenCalledWith(upload, [
        { id: 'e1', kind: 'object', target: note().storage_key, attempts: 0 },
      ]);
    });

    it('a failed delete transaction fails the delete and never calls storage', async () => {
      repo.softDeleteWithErasure.mockRejectedValue(new Error('db down'));
      await expect(service.delete(member, NOTE_A)).rejects.toThrow('db down');
      expect(repo.attemptErasure).not.toHaveBeenCalled();
    });

    it('an erasure attempt that throws after the commit still answers deleted; the cron owns it (C-610-10)', async () => {
      repo.attemptErasure.mockRejectedValue(new Error('erasure table timeout'));
      await expect(service.delete(member, NOTE_A)).resolves.toEqual({ deleted: true });
      expect(repo.softDeleteWithErasure).toHaveBeenCalledTimes(1);
    });

    it('lets a workspace coach soft-delete a member note', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      const res = await service.delete(coachA, NOTE_A);
      expect(res).toEqual({ deleted: true });
    });

    it('403s a member who can hear the note but did not record it', async () => {
      const err = await service.delete(stranger, NOTE_A).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'community.voice.not_author',
          message: expect.any(String),
        }),
      );
      expect(repo.softDeleteWithErasure).not.toHaveBeenCalled();
    });

    it('404s (not 403) a non-member, so a note id cannot be probed', async () => {
      access.canAccessCohort.mockResolvedValue(false);
      await expect(service.delete(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.softDeleteWithErasure).not.toHaveBeenCalled();
    });

    it('404s a member in a block relation with the author (either direction)', async () => {
      // prettier-ignore
      // @ts-expect-error mocks are partial implementations of the injected deps
      const blocked = new CommunityVoiceService(access, repo, upload, realtime, analytics, safetyWithBlocks([[MEMBER_ID, STRANGER_ID]]));
      await expect(blocked.delete(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.softDeleteWithErasure).not.toHaveBeenCalled();
    });

    it('also hides the note from search when the author deletes it (same transaction)', async () => {
      await service.delete(member, NOTE_A);
      // The search row is soft-deleted inside softDeleteWithErasure; the
      // in-memory transaction spec (community-ugc-b5.spec.ts) proves it.
      expect(repo.softDeleteWithErasure).toHaveBeenCalledTimes(1);
    });

    it('404s an already-deleted note', async () => {
      repo.findById.mockResolvedValue(note({ soft_deleted_at: new Date() }));
      await expect(service.delete(member, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── REMOVED-BY-BE (#174-4): a coach's removal stays visible as a placeholder ──

  describe('coach removal (REMOVED-BY-BE)', () => {
    /** Partial mocks typed at the constructor (no cast token). */
    function stub<T>(v: unknown): T {
      return v as T;
    }
    const REMOVED_AT = new Date('2026-03-01T01:00:00.000Z');
    const removedNote = () => note({ soft_deleted_at: REMOVED_AT, removed_by_user_id: COACH_A_ID });

    it('files a coach removal of a member note as moderation and keeps who removed it', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      await expect(service.delete(coachA, NOTE_A)).resolves.toEqual({ deleted: true });
      expect(repo.softDeleteWithErasure).toHaveBeenCalledWith(
        expect.objectContaining({ id: NOTE_A, author_id: MEMBER_ID }),
        'moderation',
        expect.any(Date),
        COACH_A_ID,
      );
    });

    it('keeps the author delete as before: author_delete, no remover, no removal ping', async () => {
      await service.delete(member, NOTE_A);
      expect(repo.softDeleteWithErasure).toHaveBeenCalledWith(expect.objectContaining({ id: NOTE_A }), 'author_delete');
      expect(realtime.broadcastCommunityEvent).not.toHaveBeenCalled();
    });

    it('a coach deleting their own note is an author delete (it vanishes)', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.findById.mockResolvedValue(note({ author_id: COACH_A_ID }));
      await service.delete(coachA, NOTE_A);
      expect(repo.softDeleteWithErasure).toHaveBeenCalledWith(expect.objectContaining({ id: NOTE_A }), 'author_delete');
    });

    it('pings the space with the placeholder (ids and times only) so open screens swap it', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      await service.delete(coachA, NOTE_A);
      expect(realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
      const [audience, event, payload, meta] = realtime.broadcastCommunityEvent.mock.calls[0];
      expect(audience).toEqual({ workspaceId: WS_A, cohortId: COHORT_A });
      expect(event).toBe('community.message.updated');
      expect(payload).toEqual({
        id: NOTE_A,
        workspaceId: WS_A,
        cohortId: COHORT_A,
        updatedAt: expect.any(String),
        removedAt: expect.any(String),
        createdAt: '2026-03-01T00:00:00.000Z',
        kind: 'voice',
        authorId: MEMBER_ID,
        removedBy: { role: 'coach', userId: COACH_A_ID },
      });
      expect(JSON.stringify(payload)).not.toMatch(/Coach Kim|Sam Rivers|https?:|m4a/);
      expect(meta).toEqual({ distinctId: COACH_A_ID, channelKind: 'cohort' });
    });

    it('FR-1165R (B2): a Hall note removal pings the Hall readers once, same strict payload with cohortId null', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.findById.mockResolvedValue(note({ cohort_id: null }));
      await service.delete(coachA, NOTE_A);
      expect(realtime.broadcastCommunityEvent).toHaveBeenCalledTimes(1);
      const [audience, event, payload, meta] = realtime.broadcastCommunityEvent.mock.calls[0];
      expect(audience).toEqual({ workspaceId: WS_A, cohortId: null });
      expect(event).toBe('community.message.updated');
      expect(payload).toEqual(expect.objectContaining({ id: NOTE_A, workspaceId: WS_A, cohortId: null, kind: 'voice' }));
      expect(Object.keys(payload).sort()).toEqual(
        ['authorId', 'cohortId', 'createdAt', 'id', 'kind', 'removedAt', 'removedBy', 'updatedAt', 'workspaceId'],
      );
      expect(meta).toEqual({ distinctId: COACH_A_ID, channelKind: 'workspace' });
    });

    it('a failed removal ping never fails the delete', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      realtime.broadcastCommunityEvent.mockRejectedValue(new Error('realtime down'));
      await expect(service.delete(coachA, NOTE_A)).resolves.toEqual({ deleted: true });
    });

    it('lists a coach-removed note as a placeholder: no URL, no audio, who removed it and when', async () => {
      repo.list.mockResolvedValue({ items: [removedNote()], nextCursor: null });
      const res = await service.list(member, WS_A, { cohort_id: COHORT_A });
      expect(res.voice_notes).toEqual([
        {
          id: NOTE_A,
          workspace_id: WS_A,
          cohort_id: COHORT_A,
          conversation_id: null,
          author_id: MEMBER_ID,
          url: null,
          duration_ms: 0,
          bytes: 0,
          mime_type: 'audio/mp4',
          has_waveform: false,
          created_at: '2026-03-01T00:00:00.000Z',
          author_name: 'Sam',
          author_is_coach: false,
          waveform_peaks: null,
          heard_at: null,
          message_id: null,
          parent_message_id: null,
          removed_at: REMOVED_AT.toISOString(),
          removed_by: { role: 'coach', user_id: COACH_A_ID, name: 'Coach' },
        },
      ]);
      expect(upload.createSignedDownload).not.toHaveBeenCalled();
    });

    it('a live note carries no removed keys', async () => {
      const res = await service.list(member, WS_A, { cohort_id: COHORT_A });
      expect(res.voice_notes[0]).not.toHaveProperty('removed_at');
      expect(res.voice_notes[0]).not.toHaveProperty('removed_by');
    });

    it('reads a coach-removed note as its placeholder', async () => {
      repo.findById.mockResolvedValue(removedNote());
      const res = await service.getOne(member, NOTE_A);
      expect(res.voice_note).toEqual(
        expect.objectContaining({ id: NOTE_A, url: null, removed_at: REMOVED_AT.toISOString() }),
      );
      expect(upload.createSignedDownload).not.toHaveBeenCalled();
    });

    it('still 404s an author-deleted note (no remover) on a read', async () => {
      repo.findById.mockResolvedValue(note({ soft_deleted_at: REMOVED_AT }));
      await expect(service.getOne(member, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a removed note stays 404 to a non-member and to someone in a block relation with the author', async () => {
      repo.findById.mockResolvedValue(removedNote());
      access.canAccessCohort.mockResolvedValueOnce(false);
      await expect(service.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      const blocked = new CommunityVoiceService(
        stub(access),
        stub(repo),
        stub(upload),
        stub(realtime),
        stub(analytics),
        stub(safetyWithBlocks([[MEMBER_ID, STRANGER_ID]])),
      );
      await expect(blocked.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('heard and a second delete still treat a removed note as missing', async () => {
      repo.findById.mockResolvedValue(removedNote());
      await expect(service.markHeard(member, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      access.isWorkspaceCoach.mockResolvedValue(true);
      await expect(service.delete(coachA, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.softDeleteWithErasure).not.toHaveBeenCalled();
    });
  });

  // ── VOICE-BE: names, coach flag, waveform, heard, consent, reply link ─────────

  describe('studio fields (VOICE-BE)', () => {
    it('names the author (first name in a non-client space) and flags the coach', async () => {
      let res = await service.getOne(member, NOTE_A);
      expect(res.voice_note).toMatchObject({ author_name: 'Sam', author_is_coach: false });
      repo.findById.mockResolvedValue(note({ author_id: COACH_A_ID }));
      res = await service.getOne(member, NOTE_A);
      expect(res.voice_note).toMatchObject({ author_name: 'Coach', author_is_coach: true });
      repo.viewExtras.mockResolvedValue(extras({ fullName: () => true }));
      res = await service.getOne(member, NOTE_A);
      expect(res.voice_note.author_name).toBe('Coach Kim');
      expect(repo.viewExtras).toHaveBeenCalledWith(MEMBER_ID, [expect.objectContaining({ id: NOTE_A })]);
    });

    it('stores the waveform peaks one byte each and returns them on read', async () => {
      await service.create(member, WS_A, { ...VALID_CREATE, waveform_peaks: [0, 0.5, 1] });
      const seed = repo.createVoiceNote.mock.calls[0][0];
      expect(Array.from(seed.waveformPeaks as Uint8Array)).toEqual([0, 128, 255]);
      repo.findById.mockResolvedValue(note({ waveform_peaks: Uint8Array.from([0, 128, 255]) }));
      const res = await service.getOne(member, NOTE_A);
      expect(res.voice_note.waveform_peaks).toEqual([0, 0.502, 1]);
      expect(res.voice_note.has_waveform).toBe(true);
    });

    it('a note without peaks reads null (has_waveform false)', async () => {
      await service.create(member, WS_A, VALID_CREATE);
      expect(repo.createVoiceNote.mock.calls[0][0].waveformPeaks).toBeNull();
      const res = await service.getOne(member, NOTE_A);
      expect(res.voice_note).toMatchObject({ waveform_peaks: null, has_waveform: false });
    });

    it('returns the listener\'s own heard time and the chat message link', async () => {
      repo.viewExtras.mockResolvedValue(
        extras({
          heardAt: new Map([[NOTE_A, HEARD_AT]]),
          chat: new Map([[NOTE_A, { parent_message_id: ROOT_ID }]]),
        }),
      );
      const res = await service.getOne(member, NOTE_A);
      expect(res.voice_note).toMatchObject({
        heard_at: HEARD_AT.toISOString(),
        message_id: NOTE_A,
        parent_message_id: ROOT_ID,
      });
    });

    it('a reply links to its chat message; a reply to a reply joins the first message', async () => {
      await service.create(member, WS_A, { ...VALID_CREATE, parent_message_id: PARENT_ID });
      expect(repo.createVoiceNote.mock.calls[0][0].parent).toEqual({
        id: PARENT_ID,
        at: new Date('2026-02-28T00:00:00.000Z'),
      });
      const rootAt = new Date('2026-02-27T00:00:00.000Z');
      repo.findChatMessage.mockResolvedValue(
        chatMessage({ parent_message_id: ROOT_ID, parent_message_at: rootAt }),
      );
      await service.create(member, WS_A, { ...VALID_CREATE, parent_message_id: PARENT_ID });
      expect(repo.createVoiceNote.mock.calls[1][0].parent).toEqual({ id: ROOT_ID, at: rootAt });
    });

    it.each([
      ['missing', null],
      ['in another space', chatMessage({ cohort_id: '12121212-1212-4212-8212-121212121212' })],
      ['deleted', chatMessage({ deleted_at: new Date() })],
      ['a plan-tag sub-surface row', chatMessage({ plan_context_type: 'workout' })],
      ['a DM row', chatMessage({ scope: 'dm', cohort_id: null })],
    ])('404s a reply whose parent is %s, before any row is written', async (_label, parent) => {
      repo.findChatMessage.mockResolvedValue(parent);
      const err = await service
        .create(member, WS_A, { ...VALID_CREATE, parent_message_id: PARENT_ID })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toEqual({
        error: 'not_found',
        code: 'community.message.not_found',
      });
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
    });

    it('a Hall note cannot be a reply (no chat there)', async () => {
      await expect(
        service.create(member, WS_A, { ...VALID_CREATE, cohort_id: undefined, parent_message_id: PARENT_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findChatMessage).not.toHaveBeenCalled();
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
    });

    // FIX-1122-R1 (Sol B1): a reply needs access and a live parent in the space, not the start permission.
    const ELSEWHERE = '12121212-1212-4212-8212-121212121212';
    it.each([
      ['a client voice reply in Announcements is sent', 'announcement', 'coach', chatMessage(), 'sent'],
      ['a client top-level voice note in Announcements is refused', 'announcement', 'coach', null, 'community.space.read_only'],
      ['a reply whose parent is in another space is 404', 'announcement', 'coach', chatMessage({ cohort_id: ELSEWHERE }), 'community.message.not_found'],
      ['a reply whose parent is in another tenant is 404', 'announcement', 'coach', chatMessage({ workspace_id: ELSEWHERE, cohort_id: ELSEWHERE }), 'community.message.not_found'],
      ['a reply in a section is refused', 'section', 'all', chatMessage(), 'community.space.read_only'],
    ])('%s', async (_case, kind, posting_policy, parent, outcome) => {
      access.findCohort.mockResolvedValue({ id: COHORT_A, workspace_id: WS_A, kind, posting_policy });
      access.assertCanPost.mockImplementation((c: unknown, u: unknown) =>
        // @ts-expect-error the real start rule, run over the mocked isWorkspaceCoach (false for a member)
        CommunityAccessService.prototype.assertCanPost.call(access, c, u),
      );
      repo.findChatMessage.mockResolvedValue(parent);
      const dto = parent ? { ...VALID_CREATE, parent_message_id: PARENT_ID } : VALID_CREATE;
      const got = await service.create(member, WS_A, dto).then(
        () => 'sent',
        (e: { getResponse: () => { code: string } }) => e.getResponse().code,
      );
      expect(got).toBe(outcome);
      expect(repo.createVoiceNote).toHaveBeenCalledTimes(outcome === 'sent' ? 1 : 0);
    });

    it('a coach note marks the space answered; a member note does not', async () => {
      await service.create(member, WS_A, VALID_CREATE);
      expect(repo.createVoiceNote.mock.calls[0][0].answersClients).toBe(false);
      await service.create(coachA, WS_A, { ...VALID_CREATE, storage_key: mintVoiceKey(COACH_A_ID, 'm4a') });
      expect(repo.createVoiceNote.mock.calls[1][0].answersClients).toBe(true);
    });

    it('pings the space chat (messageCreated) with the note id', async () => {
      await service.create(member, WS_A, VALID_CREATE);
      await new Promise((r) => setImmediate(r));
      expect(realtime.broadcastCommunityEvent).toHaveBeenCalledWith(
        { workspaceId: WS_A, cohortId: COHORT_A },
        'community.message.created',
        expect.objectContaining({ id: NOTE_A, cohortId: COHORT_A, authorId: MEMBER_ID }),
        expect.anything(),
      );
    });

    it('marks a readable note heard for the caller only', async () => {
      const res = await service.markHeard(member, NOTE_A);
      expect(res).toEqual({ voice_note_id: NOTE_A, heard_at: HEARD_AT.toISOString() });
      expect(repo.markHeard).toHaveBeenCalledWith(NOTE_A, MEMBER_ID);
    });

    it('404s heard on a note the caller cannot read, writing nothing', async () => {
      access.canAccessCohort.mockResolvedValue(false);
      await expect(service.markHeard(stranger, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      repo.findById.mockResolvedValue(note({ soft_deleted_at: new Date() }));
      await expect(service.markHeard(member, NOTE_A)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.markHeard).not.toHaveBeenCalled();
    });

    it('consent is unseen until marked, then seen with its first time', async () => {
      await expect(service.consent(member)).resolves.toEqual({ seen: false, seen_at: null });
      await expect(service.markConsentSeen(member)).resolves.toEqual({
        seen: true,
        seen_at: HEARD_AT.toISOString(),
      });
      expect(repo.markConsentSeen).toHaveBeenCalledWith(MEMBER_ID);
      repo.consentSeenAt.mockResolvedValue(HEARD_AT);
      await expect(service.consent(member)).resolves.toEqual({ seen: true, seen_at: HEARD_AT.toISOString() });
    });
  });

  // ── entitlement gate (FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT) ──────

  describe('entitlement gate', () => {
    it('403s a free-tier member when entitlement is required', async () => {
      process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT = 'true';
      // `plan_tier` is not a column on the User model; the service reads it
      // dynamically (a forward-compat entitlement signal). Attach it with a
      // plain object spread so the test exercises the free-tier branch without
      // a forbidden type assertion.
      const freeMember: User = Object.assign(makeUser({ id: MEMBER_ID, role: 'student' }), {
        plan_tier: 'free',
      });
      await expect(
        service.issueUploadUrl(freeMember, WS_A, {
          duration_ms: 5000,
          bytes: 120000,
          mime_type: 'audio/mp4',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
