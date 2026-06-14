/**
 * Limit-enforcement unit tests for CommunityVoiceService.
 *
 * The service is the AUTHORITATIVE gate for duration / size / mime — the DTO
 * mirrors these, but an internal caller must never bypass them. These pin:
 *   - Duration must be within (0, MAX_VOICE_DURATION_MS]; 0 and over-cap reject.
 *   - Size must be within (0, MAX_VOICE_BYTES]; 0 and over-cap reject.
 *   - A duration/size MISMATCH (tiny duration, huge payload) is rejected even
 *     when each value is individually in range (duration-spoof defence).
 *   - A valid in-range payload mints a URL.
 * All rejections are 400 and happen BEFORE any signed URL is minted.
 */
import { BadRequestException } from '@nestjs/common';
import { CommunityVoiceService } from '../community-voice.service';
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS,
} from '../community-voice.dto';
import { makeUser } from './test-user.factory';

const WS_A = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '66666666-6666-6666-6666-666666666666';
const member = makeUser({ id: MEMBER_ID, role: 'student' });

function buildService(): {
  service: CommunityVoiceService;
  createSignedUpload: jest.Mock;
} {
  const access = {
    findWorkspace: jest.fn().mockResolvedValue({ id: WS_A }),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    isWorkspaceCoach: jest.fn().mockResolvedValue(false),
    membershipInWorkspace: jest.fn().mockResolvedValue(true),
  };
  const createSignedUpload = jest.fn().mockResolvedValue({
    upload_url: 'https://signed/put',
    public_url: `https://x/object/public/voice-notes/${MEMBER_ID}/k.m4a`,
    expires_at: '2026-03-01T00:10:00.000Z',
  });
  const upload = {
    createSignedUpload,
    bucket: jest.fn().mockReturnValue('voice-notes'),
    ttlSeconds: jest.fn().mockReturnValue(600),
  };
  const repo = { createVoiceNote: jest.fn() };
  const realtime = {};
  const analytics = { capture: jest.fn() };
  // @ts-expect-error partial structural mocks of the injected deps
  const service = new CommunityVoiceService(access, repo, upload, realtime, analytics);
  return { service, createSignedUpload };
}

function issue(
  service: CommunityVoiceService,
  over: Partial<{ duration_ms: number; bytes: number; mime_type: 'audio/mp4' }>,
) {
  return service.issueUploadUrl(member, WS_A, {
    duration_ms: 5000,
    bytes: 120000,
    mime_type: 'audio/mp4',
    ...over,
  });
}

describe('CommunityVoiceService — limits', () => {
  beforeEach(() => {
    delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
    delete process.env.VOICE_NOTE_MAX_DURATION_MS;
    delete process.env.VOICE_NOTE_MAX_BYTES;
  });

  it('accepts an in-range payload', async () => {
    const { service, createSignedUpload } = buildService();
    await expect(issue(service, {})).resolves.toBeDefined();
    expect(createSignedUpload).toHaveBeenCalledTimes(1);
  });

  it('rejects zero duration', async () => {
    const { service, createSignedUpload } = buildService();
    await expect(issue(service, { duration_ms: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createSignedUpload).not.toHaveBeenCalled();
  });

  it('rejects over-cap duration', async () => {
    const { service } = buildService();
    await expect(
      issue(service, { duration_ms: MAX_VOICE_DURATION_MS + 1, bytes: 1000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects zero bytes', async () => {
    const { service } = buildService();
    await expect(issue(service, { bytes: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects over-cap bytes', async () => {
    const { service } = buildService();
    await expect(
      issue(service, {
        bytes: MAX_VOICE_BYTES + 1,
        duration_ms: MAX_VOICE_DURATION_MS,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duration/size mismatch (tiny duration, huge payload)', async () => {
    const { service, createSignedUpload } = buildService();
    // 1s of audio claiming ~10MB — far past the ~512KB/s + 256KB budget.
    await expect(
      issue(service, { duration_ms: 1000, bytes: 10_000_000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createSignedUpload).not.toHaveBeenCalled();
  });
});
