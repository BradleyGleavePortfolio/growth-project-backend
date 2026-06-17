/**
 * Unit tests for CoachExerciseService (FEATURE_CUSTOM_EXERCISE library).
 *
 * The service is the AUTHORITATIVE gate — the DTO mirrors the limits, but an
 * internal caller must never bypass them. These pin:
 *   - mime outside the allowlist rejects (400) before any signed URL is minted;
 *   - over-cap size rejects (400);
 *   - a non-coach (student) is rejected (403) on every surface;
 *   - the flag resolver defaults OFF and only the literal 'true' flips it on;
 *   - a forged storage_key outside the caller's namespace is rejected (400);
 *   - a media_kind/mime mismatch is rejected (400);
 *   - a valid presign mints a server-namespaced key + echoes the bucket;
 *   - an instructions-only ('none') create stores no media and yields media_url null;
 *   - the list view derives a fresh signed READ url from the stored key.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { CoachExercise, Role, User } from '@prisma/client';
import { CoachExerciseService } from '../coach-exercise.service';
import {
  MAX_MEDIA_BYTES,
  type CreateCoachExerciseDto,
} from '../coach-exercise.dto';
import { resolveCustomExerciseFlag } from '../coach-exercise-flag.guard';

const COACH_ID = '22222222-2222-2222-2222-222222222222';
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

function makeUser(id: string, role: Role): User {
  const base: User = {
    id,
    supabase_id: `supabase-${id}`,
    email: `${id}@example.test`,
    name: 'Test User',
    phone: null,
    role,
    coach_id: null,
    coach_practice_type: null,
    created_at: EPOCH,
    archived_at: null,
    deletion_scheduled_at: null,
    deleted_at: null,
    deletion_token_hash: null,
    deletion_token_expires_at: null,
    deletion_requested_at: null,
    deletion_confirmed_at: null,
    expo_push_token: null,
    default_payout_method_id: null,
    first_win_completed_at: null,
    show_on_leaderboard: false,
    leaderboard_display_name: null,
  };
  return base;
}

const coach = makeUser(COACH_ID, 'coach');
const student = makeUser('33333333-3333-3333-3333-333333333333', 'student');

function buildService(): {
  service: CoachExerciseService;
  repo: { create: jest.Mock; listForCoach: jest.Mock };
  createSignedUpload: jest.Mock;
  createSignedDownload: jest.Mock;
} {
  const createSignedUpload = jest.fn().mockResolvedValue({
    upload_url: 'https://signed/put',
    public_url: `https://x/object/public/coach-exercises/${COACH_ID}/k.jpg`,
    expires_at: '2026-03-01T00:10:00.000Z',
  });
  const createSignedDownload = jest
    .fn()
    .mockResolvedValue('https://signed/get/url');
  const upload = {
    createSignedUpload,
    createSignedDownload,
    deriveStorageKey: (publicUrl: string, ownerId: string) => {
      const marker = '/coach-exercises/';
      const idx = publicUrl.indexOf(marker);
      const key = publicUrl.slice(idx + marker.length);
      return key.startsWith(`${ownerId}/`) ? key : `${ownerId}/fallback`;
    },
    bucket: jest.fn().mockReturnValue('coach-exercises'),
    ttlSeconds: jest.fn().mockReturnValue(600),
  };
  const repo = { create: jest.fn(), listForCoach: jest.fn() };
  // @ts-expect-error partial structural mocks of the injected deps (R0: the
  // only sanctioned escape is @ts-expect-error with a reason, never a cast).
  const service = new CoachExerciseService(repo, upload);
  return { service, repo, createSignedUpload, createSignedDownload };
}

describe('CoachExerciseService — flag', () => {
  const original = process.env.FEATURE_CUSTOM_EXERCISE;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_CUSTOM_EXERCISE;
    else process.env.FEATURE_CUSTOM_EXERCISE = original;
  });

  it('defaults OFF and only the literal "true" flips it on', () => {
    delete process.env.FEATURE_CUSTOM_EXERCISE;
    expect(resolveCustomExerciseFlag()).toBe(false);
    process.env.FEATURE_CUSTOM_EXERCISE = 'TRUE';
    expect(resolveCustomExerciseFlag()).toBe(false);
    process.env.FEATURE_CUSTOM_EXERCISE = '1';
    expect(resolveCustomExerciseFlag()).toBe(false);
    process.env.FEATURE_CUSTOM_EXERCISE = 'true';
    expect(resolveCustomExerciseFlag()).toBe(true);
  });
});

describe('CoachExerciseService — presign limits', () => {
  it('rejects a mime outside the allowlist before minting a URL', async () => {
    const { service, createSignedUpload } = buildService();
    await expect(
      service.issueUploadUrl(coach, {
        bytes: 1000,
        // @ts-expect-error deliberately invalid mime for the negative path
        mime_type: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createSignedUpload).not.toHaveBeenCalled();
  });

  it('rejects an over-cap size before minting a URL', async () => {
    const { service, createSignedUpload } = buildService();
    await expect(
      service.issueUploadUrl(coach, {
        bytes: MAX_MEDIA_BYTES + 1,
        mime_type: 'image/jpeg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createSignedUpload).not.toHaveBeenCalled();
  });

  it('rejects a student on the presign surface (403)', async () => {
    const { service } = buildService();
    await expect(
      service.issueUploadUrl(student, { bytes: 1000, mime_type: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('mints a server-namespaced key and echoes the bucket', async () => {
    const { service } = buildService();
    const target = await service.issueUploadUrl(coach, {
      bytes: 1000,
      mime_type: 'image/jpeg',
    });
    expect(target.bucket).toBe('coach-exercises');
    expect(target.storage_key.startsWith(`${COACH_ID}/`)).toBe(true);
    expect(target.expires_in_seconds).toBe(600);
  });
});

describe('CoachExerciseService — create', () => {
  it('rejects a forged storage_key outside the caller namespace (400)', async () => {
    const { service, repo } = buildService();
    const dto: CreateCoachExerciseDto = {
      name: 'Sun Salutation',
      instructions: 'Flow through the poses slowly.',
      media_kind: 'image',
      storage_key: 'someone-else/k.jpg',
      media_mime: 'image/jpeg',
    };
    await expect(service.create(coach, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a media_kind/mime mismatch (400)', async () => {
    const { service } = buildService();
    const dto: CreateCoachExerciseDto = {
      name: 'Sun Salutation',
      instructions: 'Flow.',
      media_kind: 'image',
      storage_key: `${COACH_ID}/k.mp4`,
      media_mime: 'video/mp4',
    };
    await expect(service.create(coach, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stores no media for an instructions-only (none) move; media_url is null', async () => {
    const { service, repo, createSignedDownload } = buildService();
    const row: CoachExercise = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      coach_id: COACH_ID,
      name: 'Breathing',
      instructions: 'Inhale 4, hold 4, exhale 4.',
      media_kind: 'none',
      storage_key: null,
      media_mime: null,
      created_at: EPOCH,
      archived_at: null,
    };
    repo.create.mockResolvedValue(row);
    const res = await service.create(coach, {
      name: 'Breathing',
      instructions: 'Inhale 4, hold 4, exhale 4.',
      media_kind: 'none',
    });
    expect(res.coach_exercise.media_url).toBeNull();
    expect(res.coach_exercise.media_kind).toBe('none');
    expect(createSignedDownload).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ coachId: COACH_ID, storageKey: null }),
    );
  });

  it('persists media + derives a fresh signed READ url for an image move', async () => {
    const { service, repo, createSignedDownload } = buildService();
    const row: CoachExercise = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      coach_id: COACH_ID,
      name: 'Warrior II',
      instructions: 'Open the hips.',
      media_kind: 'image',
      storage_key: `${COACH_ID}/warrior.jpg`,
      media_mime: 'image/jpeg',
      created_at: EPOCH,
      archived_at: null,
    };
    repo.create.mockResolvedValue(row);
    const res = await service.create(coach, {
      name: 'Warrior II',
      instructions: 'Open the hips.',
      media_kind: 'image',
      storage_key: `${COACH_ID}/warrior.jpg`,
      media_mime: 'image/jpeg',
    });
    expect(res.coach_exercise.media_url).toBe('https://signed/get/url');
    expect(createSignedDownload).toHaveBeenCalledWith(`${COACH_ID}/warrior.jpg`);
  });
});

describe('CoachExerciseService — list', () => {
  it('rejects a student (403)', async () => {
    const { service } = buildService();
    await expect(service.list(student)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns the coach own library with signed media urls', async () => {
    const { service, repo } = buildService();
    repo.listForCoach.mockResolvedValue([
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        coach_id: COACH_ID,
        name: 'Tree Pose',
        instructions: 'Balance.',
        media_kind: 'image',
        storage_key: `${COACH_ID}/tree.jpg`,
        media_mime: 'image/jpeg',
        created_at: EPOCH,
        archived_at: null,
      },
    ]);
    const res = await service.list(coach);
    expect(res.coach_exercises).toHaveLength(1);
    expect(res.coach_exercises[0].media_url).toBe('https://signed/get/url');
    expect(repo.listForCoach).toHaveBeenCalledWith(COACH_ID);
  });
});
