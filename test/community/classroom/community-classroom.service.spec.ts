/**
 * Unit tests for CommunityClassroomService (v3-2 media-backed lessons).
 *
 * Mocks CommunityAccessService + CommunityClassroomRepository + ConfigService +
 * the StorageProvider, so these run with NO DB and NO Supabase. They pin the
 * slice's tenancy + media + release doctrine:
 *
 *   - Tenancy: a cohort-scoped lesson is 404 to a non-member (existence never
 *     leaks); coach-only writes 403 a non-coach who can otherwise read.
 *   - Media signing: a per-kind size cap is enforced BEFORE any signed upload
 *     URL is minted (oversized → 400, no URL issued); the storage key embeds
 *     the workspace id (workspace-bound, no cross-workspace replay); read-time
 *     download URLs use the configurable TTL.
 *   - Release lock: a published-but-future lesson is 404 to a student via getOne
 *     and reports release_locked=true to the coach; publish picks scheduled vs
 *     published from the release time.
 *   - Storage not configured: media tiles degrade to url=null rather than 500.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type {
  CommunityClassroomMediaAsset,
  CommunityClassroomPost,
} from '@prisma/client';
import { CommunityClassroomService } from '../../../src/community/classroom/community-classroom.service';
import type { ClassroomPostWithMedia } from '../../../src/community/classroom/community-classroom.repository';
import { makeUser } from './test-user.factory';

type AccessMock = {
  findWorkspace: jest.Mock;
  findCohort: jest.Mock;
  isWorkspaceCoach: jest.Mock;
  canAccessWorkspace: jest.Mock;
  canAccessCohort: jest.Mock;
  listAccessibleCohortIds: jest.Mock;
};
type RepoMock = {
  createPostWithMedia: jest.Mock;
  findPostById: jest.Mock;
  updatePost: jest.Mock;
  softDeletePost: jest.Mock;
  listForCoach: jest.Mock;
  listForStudent: jest.Mock;
  findMediaById: jest.Mock;
  attachMedia: jest.Mock;
};
type ConfigMock = { get: jest.Mock };
type StorageMock = {
  isConfigured: jest.Mock;
  createSignedUploadUrl: jest.Mock;
  createSignedDownloadUrl: jest.Mock;
};

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const COHORT_A = '33333333-3333-3333-3333-333333333333';
const POST_A = '44444444-4444-4444-4444-444444444444';
const COACH_A_ID = '55555555-5555-5555-5555-555555555555';
const MEMBER_ID = '66666666-6666-6666-6666-666666666666';
const STRANGER_ID = '77777777-7777-7777-7777-777777777777';
const MEDIA_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const coachA = makeUser({ id: COACH_A_ID, role: 'coach' });
const member = makeUser({ id: MEMBER_ID, role: 'student' });
const stranger = makeUser({ id: STRANGER_ID, role: 'student' });

// The service reads the real wall clock (`new Date()`), so PAST/FUTURE are
// expressed relative to the run time to keep these assertions stable whenever
// the suite executes (a hard-coded year would silently flip past/future).
const NOW_BASE = new Date('2026-03-01T00:00:00.000Z');
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

function mediaAsset(
  over: Partial<CommunityClassroomMediaAsset> = {},
): CommunityClassroomMediaAsset {
  return {
    id: MEDIA_ID,
    post_id: POST_A,
    workspace_id: WS_A,
    kind: 'video',
    storage_key: `community-classroom/${WS_A}/${POST_A}/video/key`,
    duration_sec: 120,
    bytes: BigInt(1024),
    mime_type: 'video/mp4',
    width: 1920,
    height: 1080,
    created_at: NOW_BASE,
    ...over,
  } as CommunityClassroomMediaAsset;
}

function post(
  over: Partial<CommunityClassroomPost> = {},
  media: CommunityClassroomMediaAsset[] = [],
): ClassroomPostWithMedia {
  const base = {
    id: POST_A,
    workspace_id: WS_A,
    cohort_id: null,
    coach_id: COACH_A_ID,
    title: 'Lesson 1',
    body_markdown: 'Body',
    status: 'published',
    pinned: false,
    pinned_order: null,
    release_at: null,
    published_at: NOW_BASE,
    created_at: NOW_BASE,
    updated_at: NOW_BASE,
    soft_deleted_at: null,
    ...over,
  } as CommunityClassroomPost;
  return { ...base, media_assets: media };
}

describe('CommunityClassroomService', () => {
  let access: AccessMock;
  let repo: RepoMock;
  let config: ConfigMock;
  let storage: StorageMock;
  let service: CommunityClassroomService;

  beforeEach(() => {
    access = {
      findWorkspace: jest.fn(),
      findCohort: jest.fn(),
      isWorkspaceCoach: jest.fn(),
      canAccessWorkspace: jest.fn(),
      canAccessCohort: jest.fn(),
      listAccessibleCohortIds: jest.fn().mockResolvedValue([]),
    };
    repo = {
      createPostWithMedia: jest.fn(),
      findPostById: jest.fn(),
      updatePost: jest.fn(),
      softDeletePost: jest.fn(),
      listForCoach: jest.fn(),
      listForStudent: jest.fn(),
      findMediaById: jest.fn(),
      attachMedia: jest.fn(),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      createSignedUploadUrl: jest
        .fn()
        .mockResolvedValue({ signedUrl: 'https://signed.upload', storageKey: 'k', provider: 'supabase' }),
      createSignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.download'),
    };
    service = new CommunityClassroomService(
      access as never,
      repo as never,
      config as never,
      storage as never,
    );
  });

  // ── Create / media size cap / workspace-bound key ──────────────────────────

  describe('create', () => {
    it('creates a draft lesson for the owning coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.createPostWithMedia.mockResolvedValue(post({ status: 'draft' }));

      const res = await service.create(coachA, WS_A, {
        title: 'Lesson 1',
        body_markdown: 'Body',
      });
      expect(res.post.id).toBe(POST_A);
      expect(res.post.status).toBe('draft');
      expect(repo.createPostWithMedia).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'draft', coachId: COACH_A_ID }),
      );
    });

    it('403s a member who is not the coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.create(member, WS_A, { title: 'X', body_markdown: 'Y' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.createPostWithMedia).not.toHaveBeenCalled();
    });

    it('404s a non-member before any write (existence never leaks)', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(
        service.create(stranger, WS_A, { title: 'X', body_markdown: 'Y' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an oversized video BEFORE minting any signed upload URL', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);

      await expect(
        service.create(coachA, WS_A, {
          title: 'L',
          body_markdown: 'B',
          media: [{ kind: 'video', bytes: 600 * 1024 * 1024 }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.createPostWithMedia).not.toHaveBeenCalled();
      expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('mints workspace-bound storage keys + signed upload URLs for media', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      const asset = mediaAsset();
      repo.createPostWithMedia.mockResolvedValue(
        post({ status: 'draft' }, [asset]),
      );

      const res = await service.create(coachA, WS_A, {
        title: 'L',
        body_markdown: 'B',
        media: [{ kind: 'video', bytes: 1024 }],
      });
      // The persisted storage key embeds the workspace id (tenant binding).
      const seeds = repo.createPostWithMedia.mock.calls[0][0].media;
      expect(seeds[0].storageKey).toContain(`community-classroom/${WS_A}/`);
      expect(res.upload_targets).toHaveLength(1);
      expect(res.upload_targets[0].upload_url).toBe('https://signed.upload');
      expect(storage.createSignedUploadUrl).toHaveBeenCalledTimes(1);
    });

    it('returns 400 (not 500) when storage is unconfigured but media is declared', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      storage.isConfigured.mockReturnValue(false);
      repo.createPostWithMedia.mockResolvedValue(
        post({ status: 'draft' }, [mediaAsset()]),
      );
      await expect(
        service.create(coachA, WS_A, {
          title: 'L',
          body_markdown: 'B',
          media: [{ kind: 'image', bytes: 1024 }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Read / release lock / signed download ──────────────────────────────────

  describe('getOne', () => {
    it('returns a released lesson to a workspace member with a signed media URL', async () => {
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: PAST }, [mediaAsset()]),
      );
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.canAccessWorkspace.mockResolvedValue(true);

      const res = await service.getOne(member, POST_A);
      expect(res.post.id).toBe(POST_A);
      expect(res.post.release_locked).toBe(false);
      expect(res.post.media[0].url).toBe('https://signed.download');
      expect(storage.createSignedDownloadUrl).toHaveBeenCalled();
    });

    it('404s a student on a published-but-not-yet-released lesson (release lock)', async () => {
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: FUTURE }),
      );
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.canAccessWorkspace.mockResolvedValue(true);
      await expect(service.getOne(member, POST_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('shows release_locked=true to the coach for a future-release lesson', async () => {
      repo.findPostById.mockResolvedValue(
        post({ status: 'scheduled', release_at: FUTURE }),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      const res = await service.getOne(coachA, POST_A);
      expect(res.post.release_locked).toBe(true);
    });

    it('404s a non-member on a released lesson (membership required)', async () => {
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: PAST }),
      );
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(service.getOne(stranger, POST_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s on a soft-deleted lesson', async () => {
      repo.findPostById.mockResolvedValue(
        post({ soft_deleted_at: NOW_BASE }),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      await expect(service.getOne(coachA, POST_A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('degrades media url to null when storage is unconfigured (no 500)', async () => {
      storage.isConfigured.mockReturnValue(false);
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: PAST }, [mediaAsset()]),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      const res = await service.getOne(coachA, POST_A);
      expect(res.post.media[0].url).toBeNull();
      expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('uses the configured signed-URL TTL for download URLs', async () => {
      config.get.mockImplementation((k: string) =>
        k === 'MEDIA_SIGNED_URL_TTL_SEC' ? '300' : undefined,
      );
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: PAST }, [mediaAsset()]),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      await service.getOne(coachA, POST_A);
      expect(storage.createSignedDownloadUrl).toHaveBeenCalledWith(
        expect.any(String),
        { expiresInSeconds: 300 },
      );
    });

    it('clamps an absurd TTL env to the 24h ceiling', async () => {
      config.get.mockImplementation((k: string) =>
        k === 'MEDIA_SIGNED_URL_TTL_SEC' ? '999999999' : undefined,
      );
      repo.findPostById.mockResolvedValue(
        post({ status: 'published', release_at: PAST }, [mediaAsset()]),
      );
      access.isWorkspaceCoach.mockResolvedValue(true);
      await service.getOne(coachA, POST_A);
      expect(storage.createSignedDownloadUrl).toHaveBeenCalledWith(
        expect.any(String),
        { expiresInSeconds: 60 * 60 * 24 },
      );
    });
  });

  // ── Publish (scheduled vs published) ───────────────────────────────────────

  describe('publish', () => {
    it('publishes immediately (published) when release_at is null/past', async () => {
      repo.findPostById.mockResolvedValue(post({ status: 'draft', published_at: null }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.updatePost.mockResolvedValue(post({ status: 'published' }));
      await service.publish(coachA, POST_A, {});
      expect(repo.updatePost).toHaveBeenCalledWith(
        POST_A,
        expect.objectContaining({ status: 'published' }),
      );
    });

    it('schedules (scheduled) when release_at is in the future', async () => {
      repo.findPostById.mockResolvedValue(post({ status: 'draft', published_at: null }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.updatePost.mockResolvedValue(
        post({ status: 'scheduled', release_at: FUTURE }),
      );
      await service.publish(coachA, POST_A, { release_at: FUTURE.toISOString() });
      expect(repo.updatePost).toHaveBeenCalledWith(
        POST_A,
        expect.objectContaining({ status: 'scheduled' }),
      );
    });

    it('403s a non-coach attempting to publish a visible lesson', async () => {
      repo.findPostById.mockResolvedValue(post({ status: 'published', release_at: PAST }));
      access.isWorkspaceCoach.mockResolvedValue(false);
      await expect(
        service.publish(member, POST_A, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── Feed (coach vs student source) ─────────────────────────────────────────

  describe('listFeed', () => {
    it('uses the coach source for the owning coach', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.listForCoach.mockResolvedValue({ items: [post()], nextCursor: null });
      const res = await service.listFeed(coachA, WS_A, {});
      expect(repo.listForCoach).toHaveBeenCalled();
      expect(repo.listForStudent).not.toHaveBeenCalled();
      expect(res.posts).toHaveLength(1);
    });

    it('uses the student source (visibility pushed into the query) for a member', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(true);
      access.isWorkspaceCoach.mockResolvedValue(false);
      access.listAccessibleCohortIds.mockResolvedValue([COHORT_A]);
      repo.listForStudent.mockResolvedValue({ items: [], nextCursor: null });
      await service.listFeed(member, WS_A, {});
      expect(repo.listForStudent).toHaveBeenCalledWith(
        expect.objectContaining({ visibleCohortIds: [COHORT_A] }),
      );
      expect(repo.listForCoach).not.toHaveBeenCalled();
    });

    it('404s a non-member workspace feed read', async () => {
      access.findWorkspace.mockResolvedValue({ id: WS_A });
      access.canAccessWorkspace.mockResolvedValue(false);
      await expect(service.listFeed(stranger, WS_A, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── Media attach (cross-workspace binding) ─────────────────────────────────

  describe('attachMedia', () => {
    it('binds new media keys to the lesson workspace, not a caller-supplied one', async () => {
      repo.findPostById.mockResolvedValue(post({ workspace_id: WS_A }));
      access.isWorkspaceCoach.mockResolvedValue(true);
      repo.attachMedia.mockResolvedValue([mediaAsset({ workspace_id: WS_A })]);
      repo.findPostById.mockResolvedValueOnce(post({ workspace_id: WS_A }));

      await service.attachMedia(coachA, POST_A, [{ kind: 'pdf', bytes: 1024 }]);
      const seeds = repo.attachMedia.mock.calls[0][0].media;
      expect(seeds[0].storageKey).toContain(`community-classroom/${WS_A}/`);
      expect(seeds[0].storageKey).not.toContain(WS_B);
    });
  });
});
