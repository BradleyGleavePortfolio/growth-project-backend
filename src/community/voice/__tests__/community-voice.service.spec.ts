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
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityVoiceNote, User } from '@prisma/client';
import { CommunityVoiceService } from '../community-voice.service';
import type { IssueVoiceUploadDto } from '../community-voice.dto';
import { makeUser } from './test-user.factory';

type AccessMock = {
  findWorkspace: jest.Mock;
  findCohort: jest.Mock;
  isWorkspaceCoach: jest.Mock;
  canAccessWorkspace: jest.Mock;
  canAccessCohort: jest.Mock;
  listAccessibleCohortIds: jest.Mock;
  membershipInWorkspace: jest.Mock;
};
type RepoMock = {
  createVoiceNote: jest.Mock;
  findById: jest.Mock;
  softDelete: jest.Mock;
  list: jest.Mock;
};
type UploadMock = {
  createSignedUpload: jest.Mock;
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
  };
  return { ...base, ...over };
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
    delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
    access = {
      findWorkspace: jest.fn().mockResolvedValue({ id: WS_A }),
      findCohort: jest
        .fn()
        .mockResolvedValue({ id: COHORT_A, workspace_id: WS_A }),
      isWorkspaceCoach: jest.fn().mockResolvedValue(false),
      canAccessWorkspace: jest.fn().mockResolvedValue(true),
      canAccessCohort: jest.fn().mockResolvedValue(true),
      listAccessibleCohortIds: jest.fn().mockResolvedValue([COHORT_A]),
      membershipInWorkspace: jest.fn().mockResolvedValue(true),
    };
    repo = {
      createVoiceNote: jest.fn().mockResolvedValue(note()),
      findById: jest.fn().mockResolvedValue(note()),
      softDelete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [note()], nextCursor: null }),
    };
    upload = {
      createSignedUpload: jest.fn().mockResolvedValue({
        upload_url: 'https://signed.upload/put',
        public_url: `https://x/object/public/voice-notes/${MEMBER_ID}/1700000000-abc.m4a`,
        expires_at: '2026-03-01T00:10:00.000Z',
      }),
      createSignedDownload: jest
        .fn()
        .mockResolvedValue('https://signed.download/get'),
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
    // @ts-expect-error mocks are partial implementations of the injected deps
    service = new CommunityVoiceService(access, repo, upload, realtime, analytics);
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
      expect(upload.createSignedUpload).not.toHaveBeenCalled();
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
        service.issueUploadUrl(member, WS_A, { ...spoof, mime_type: spoof.mime_type as IssueVoiceUploadDto['mime_type'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(upload.createSignedUpload).not.toHaveBeenCalled();
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

    it('does not broadcast on a community channel for a DM note', async () => {
      repo.createVoiceNote.mockResolvedValue(
        note({ cohort_id: null, conversation_id: CONV_A }),
      );
      await service.create(member, WS_A, {
        ...VALID_CREATE,
        cohort_id: undefined,
        conversation_id: CONV_A,
      });
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
      await expect(service.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a DM note to anyone but its author', async () => {
      repo.findById.mockResolvedValue(
        note({ cohort_id: null, conversation_id: CONV_A, author_id: MEMBER_ID }),
      );
      await expect(service.getOne(stranger, NOTE_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s a soft-deleted note', async () => {
      repo.findById.mockResolvedValue(note({ soft_deleted_at: new Date() }));
      await expect(service.getOne(member, NOTE_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── delete: author or coach only ─────────────────────────────────────────────

  describe('delete', () => {
    it('lets the author soft-delete their note', async () => {
      const res = await service.delete(member, NOTE_A);
      expect(res).toEqual({ deleted: true });
      expect(repo.softDelete).toHaveBeenCalledWith(NOTE_A, expect.any(Date));
    });

    it('lets a workspace coach soft-delete a member note', async () => {
      access.isWorkspaceCoach.mockResolvedValue(true);
      const res = await service.delete(coachA, NOTE_A);
      expect(res).toEqual({ deleted: true });
    });

    it('403s a stranger trying to delete', async () => {
      await expect(service.delete(stranger, NOTE_A)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repo.softDelete).not.toHaveBeenCalled();
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
      const freeMember: User = Object.assign(
        makeUser({ id: MEMBER_ID, role: 'student' }),
        { plan_tier: 'free' },
      );
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
