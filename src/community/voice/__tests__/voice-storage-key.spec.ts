/**
 * A-610-1 regression: voice storage keys against the REAL installed storage
 * SDK (@supabase/supabase-js -> @supabase/storage-js) with a recording fake
 * fetch. No network, no production object.
 *
 * Before the fix, create() accepted any key that started with `<caller id>/`
 * and the read path signed it with the service-role client; the SDK builds
 * `/object/sign/voice-notes/<me>/../../coach-media/<victim>/x` and URL
 * normalization turns that into another bucket's object. These tests prove:
 *  - the SDK really normalizes such keys across folders/buckets (the threat);
 *  - our normalizer mirrors the SDK request path exactly;
 *  - every forged shape (dot segment, encoded, backslash, double slash,
 *    foreign owner, other bucket, query/hash) gets NO row and NO storage
 *    request of any kind (no stat, no signing);
 *  - only a key the server minted for this caller (issuance MAC, recent)
 *    publishes, after the uploaded object is confirmed at that exact path;
 *  - signing for reads re-checks the key and the author folder every time.
 */
import { BadRequestException } from '@nestjs/common';
import type { CommunityVoiceNote, User } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { CommunityVoiceService } from '../community-voice.service';
import { VoiceUploadProvider } from '../voice-upload.provider';
import {
  isSignableVoiceKey,
  mintVoiceKey,
  normalizedSdkObjectPath,
  verifyPublishableVoiceKey,
  VOICE_KEY_PUBLISH_WINDOW_MS,
} from '../voice-storage-key';
import type { SupabaseService } from '../../../supabase/supabase.service';
import { makeUser } from './test-user.factory';
import { safetyWithBlocks } from '../../../../test/community/safety/safety-test-helpers';

const WS = '11111111-1111-4111-8111-111111111111';
const COHORT = '33333333-3333-4333-8333-333333333333';
const ME = '66666666-6666-4666-8666-666666666666';
const VICTIM = '77777777-7777-4777-8777-777777777777';
const BUCKET = 'voice-notes';

interface Seen {
  method: string;
  path: string;
}

function fakeStorage(opts: { infoStatus?: number; size?: number; contentType?: string } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: unknown, init?: { method?: string }) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? 'GET', path: url.pathname });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname.includes('/object/upload/sign/')) {
      const p = url.pathname.split('/object/upload/sign/')[1];
      return json({ url: `/object/upload/sign/${p}?token=t` });
    }
    if (url.pathname.includes('/object/info/')) {
      if (opts.infoStatus && opts.infoStatus !== 200) {
        return json(
          { statusCode: String(opts.infoStatus), error: 'not_found', message: 'Object not found' },
          opts.infoStatus,
        );
      }
      return json({ size: opts.size ?? 120000, content_type: opts.contentType ?? 'audio/mp4' });
    }
    if (url.pathname.includes('/object/sign/')) {
      const p = url.pathname.split('/object/sign/')[1];
      return json({ signedURL: `/object/sign/${p}?token=t` });
    }
    return json({});
  };
  const client = createClient('https://p.supabase.co', 'service-role-key-for-test', {
    global: { fetch: fetchImpl },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const supabase: Pick<SupabaseService, 'getClient'> = { getClient: () => client };
  // The provider only calls getClient(); the structural pick is enough.
  // prettier-ignore
  // @ts-expect-error partial SupabaseService (getClient only)
  const provider = new VoiceUploadProvider(supabase);
  return { provider, seen, client };
}

const FORGED: Array<[string, string]> = [
  ['dot segment into another owner', `${ME}/../${VICTIM}/1700000000000-0123456789abcdef.m4a`],
  ['dot segments into another bucket', `${ME}/../../coach-media/${VICTIM}/private.mp4`],
  ['encoded dot segment', `${ME}/%2e%2e/${VICTIM}/x.m4a`],
  ['encoded slash', `${ME}%2f..%2f${VICTIM}/x.m4a`],
  ['backslash', `${ME}/..\\${VICTIM}\\x.m4a`],
  ['double slash', `${ME}//x.m4a`],
  ['foreign owner', `${VICTIM}/1700000000000-0123456789abcdef.m4a`],
  ['leading slash to another bucket', `/coach-media/${VICTIM}/x.m4a`],
  ['query smuggling', `${ME}/x.m4a?download=1`],
  ['hash smuggling', `${ME}/x.m4a#frag`],
  ['single dot segment', `${ME}/./x.m4a`],
];

function makeService(provider: VoiceUploadProvider) {
  const created: CommunityVoiceNote[] = [];
  const access = {
    findWorkspace: jest.fn().mockResolvedValue({ id: WS }),
    findCohort: jest.fn().mockResolvedValue({ id: COHORT, workspace_id: WS }),
    isWorkspaceCoach: jest.fn().mockResolvedValue(false),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    canAccessCohort: jest.fn().mockResolvedValue(true),
    listAccessibleCohortIds: jest.fn().mockResolvedValue([COHORT]),
    membershipInWorkspace: jest.fn().mockResolvedValue(true),
  };
  const repo = {
    findByStorageKey: jest.fn().mockResolvedValue(null),
    createVoiceNote: jest.fn(async (seed: { storageKey: string; bytes: number }) => {
      const row: CommunityVoiceNote = {
        id: '44444444-4444-4444-8444-444444444444',
        workspace_id: WS,
        cohort_id: COHORT,
        conversation_id: null,
        author_id: ME,
        storage_key: seed.storageKey,
        duration_ms: 5000,
        bytes: BigInt(seed.bytes),
        mime_type: 'audio/mp4',
        waveform_peaks: null,
        created_at: new Date('2026-10-01T00:00:00.000Z'),
        soft_deleted_at: null,
      };
      created.push(row);
      return row;
    }),
  };
  const realtime = {
    cohortShard: () => 0,
    channels: { cohort: () => 'c' },
    broadcastCommunityEvent: jest.fn().mockResolvedValue(undefined),
  };
  // prettier-ignore
  // @ts-expect-error mocks are partial implementations of the injected deps
  const service = new CommunityVoiceService(access, repo, provider, realtime, { capture: () => undefined }, safetyWithBlocks());
  return { service, repo, created };
}

const me: User = makeUser({ id: ME, role: 'student' });
const body = (storage_key: string) => ({
  storage_key,
  cohort_id: COHORT,
  conversation_id: undefined,
  duration_ms: 5000,
  bytes: 120000,
  mime_type: 'audio/mp4' as const,
});

describe('A-610-1 voice storage keys (real storage SDK request path)', () => {
  beforeEach(() => {
    process.env.VOICE_KEY_SIGNING_SECRET = 'test-voice-key-secret';
    delete process.env.SUPABASE_VOICE_BUCKET;
    delete process.env.FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT;
  });

  it('the installed SDK really normalizes a dot-segment key into another bucket (the threat)', async () => {
    const { client, seen } = fakeStorage();
    const forged = `${ME}/../../coach-media/${VICTIM}/private.mp4`;
    await client.storage.from(BUCKET).createSignedUrl(forged, 60);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe(`/storage/v1/object/sign/coach-media/${VICTIM}/private.mp4`);
    // Our normalizer mirrors the SDK request path exactly.
    expect(`/storage/v1${normalizedSdkObjectPath(BUCKET, forged)}`).toBe(seen[0].path);
  });

  it.each(FORGED)('our normalizer matches the SDK request path for %s', async (_label, key) => {
    const { client, seen } = fakeStorage();
    await client.storage.from(BUCKET).createSignedUrl(key, 60);
    expect(seen).toHaveLength(1);
    expect(`/storage/v1${normalizedSdkObjectPath(BUCKET, key)}`).toBe(seen[0].path);
    expect(isSignableVoiceKey(BUCKET, key, ME)).toBe(false);
  });

  it.each(FORGED)(
    'create() refuses a %s key: no row, no stat, no signing request',
    async (_label, key) => {
      const { provider, seen } = fakeStorage();
      const { service, repo } = makeService(provider);
      const err = await service.create(me, WS, body(key)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'community.voice.storage_key_rejected',
      });
      expect(repo.createVoiceNote).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    },
  );

  it.each(FORGED)('createSignedDownload never signs a %s key', async (_label, key) => {
    const { provider, seen } = fakeStorage();
    await expect(provider.createSignedDownload(key, 60, ME)).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it('a key minted by upload-url publishes after the object is confirmed, and signs at that exact path', async () => {
    const { provider, seen } = fakeStorage({ size: 118000 });
    const { service, created } = makeService(provider);
    const issued = await service.issueUploadUrl(me, WS, {
      duration_ms: 5000,
      bytes: 120000,
      mime_type: 'audio/mp4',
    });
    expect(issued.storage_key).toMatch(
      new RegExp(`^${ME}/\\d{13}-[0-9a-f]{16}-[0-9a-f]{32}\\.m4a$`),
    );
    expect(seen.map((s) => s.path)).toEqual([
      `/storage/v1/object/upload/sign/${BUCKET}/${issued.storage_key}`,
    ]);
    seen.length = 0;
    const res = await service.create(me, WS, body(issued.storage_key));
    expect(created).toHaveLength(1);
    expect(created[0].storage_key).toBe(issued.storage_key);
    // The stored size is authoritative, not the declared one.
    expect(Number(created[0].bytes)).toBe(118000);
    expect(seen.map((s) => s.path)).toEqual([
      `/storage/v1/object/info/${BUCKET}/${issued.storage_key}`,
      `/storage/v1/object/sign/${BUCKET}/${issued.storage_key}`,
    ]);
    expect(res.voice_note.url).toContain(`/object/sign/${BUCKET}/${issued.storage_key}`);
  });

  it('refuses a minted key when nothing was uploaded there (upload_missing), with no row', async () => {
    const { provider } = fakeStorage({ infoStatus: 404 });
    const { service, repo } = makeService(provider);
    const err = await service
      .create(me, WS, body(mintVoiceKey(ME, 'm4a')))
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'community.voice.upload_missing',
    });
    expect(repo.createVoiceNote).not.toHaveBeenCalled();
  });

  it('refuses a minted key whose object is not audio (upload_mismatch)', async () => {
    const { provider } = fakeStorage({ contentType: 'text/html' });
    const { service, repo } = makeService(provider);
    const err = await service
      .create(me, WS, body(mintVoiceKey(ME, 'm4a')))
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'community.voice.upload_mismatch',
    });
    expect(repo.createVoiceNote).not.toHaveBeenCalled();
  });

  it('refuses a key minted for someone else, a tampered MAC, an expired key and a legacy key', () => {
    const theirs = mintVoiceKey(VICTIM, 'm4a');
    const reprefixed = theirs.replace(VICTIM, ME);
    expect(verifyPublishableVoiceKey(BUCKET, theirs, ME)).toEqual({ ok: false, reason: 'owner' });
    expect(verifyPublishableVoiceKey(BUCKET, reprefixed, ME)).toEqual({
      ok: false,
      reason: 'signature',
    });
    const mine = mintVoiceKey(ME, 'm4a');
    const flipped = mine.replace(
      /-([0-9a-f])([0-9a-f]{31})\.m4a$/,
      (_m, a: string, rest: string) => `-${a === '0' ? '1' : '0'}${rest}.m4a`,
    );
    expect(verifyPublishableVoiceKey(BUCKET, flipped, ME)).toEqual({
      ok: false,
      reason: 'signature',
    });
    const old = mintVoiceKey(ME, 'm4a', Date.now() - VOICE_KEY_PUBLISH_WINDOW_MS - 60_000);
    expect(verifyPublishableVoiceKey(BUCKET, old, ME)).toEqual({ ok: false, reason: 'expired' });
    const legacy = `${ME}/1700000000000-0123456789abcdef.m4a`;
    expect(verifyPublishableVoiceKey(BUCKET, legacy, ME)).toEqual({ ok: false, reason: 'shape' });
    expect(verifyPublishableVoiceKey(BUCKET, mine, ME).ok).toBe(true);
  });

  it('fails closed when no signing secret is configured', () => {
    const key = mintVoiceKey(ME, 'm4a');
    delete process.env.VOICE_KEY_SIGNING_SECRET;
    const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(verifyPublishableVoiceKey(BUCKET, key, ME)).toEqual({
        ok: false,
        reason: 'secret_missing',
      });
      expect(() => mintVoiceKey(ME, 'm4a')).toThrow();
    } finally {
      if (prevService !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
    }
  });

  it('read signing stays bound to the author folder: an existing legacy key signs only for its owner', async () => {
    const { provider, seen } = fakeStorage();
    const legacy = `${ME}/1700000000000-0123456789abcdef.m4a`;
    await expect(provider.createSignedDownload(legacy, 60, VICTIM)).resolves.toBeNull();
    expect(seen).toEqual([]);
    await expect(provider.createSignedDownload(legacy, 60, ME)).resolves.toContain(legacy);
    expect(seen.map((s) => s.path)).toEqual([`/storage/v1/object/sign/${BUCKET}/${legacy}`]);
  });

  it('erasure only ever sends canonical keys to storage (B-610-5 uses the same check)', async () => {
    const { provider, seen } = fakeStorage();
    const ok = mintVoiceKey(ME, 'm4a');
    await provider.removeObjects([ok, ...FORGED.map(([, k]) => k)]);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('DELETE');
    expect(seen[0].path).toBe(`/storage/v1/object/${BUCKET}`);
  });
});
