/**
 * Focused unit tests for the VoiceUploadProvider bucket / namespace / TTL
 * contract (the extracted signed-upload helper, lifted out of
 * messaging.service.ts in this PR).
 *
 * These run with NO Supabase — SupabaseService is a structural mock. They pin:
 *   - The object path is namespaced by the OWNER id (bucket binding — a client
 *     can never mint a key outside `${ownerId}/`).
 *   - The content-type → extension map covers exactly the audio allowlist.
 *   - The signed-URL TTL is env-driven and CLAMPED into [60, 86400] so a
 *     misconfigured env can never issue a dead-on-arrival or never-expiring URL.
 *   - createSignedDownload degrades to null (disabled player, never a 500) when
 *     storage is unconfigured or the SDK build lacks createSignedUrl.
 */
import { VoiceUploadProvider } from '../voice-upload.provider';

const OWNER = '99999999-9999-9999-9999-999999999999';

type StorageHandle = {
  createSignedUploadUrl?: jest.Mock;
  createSignedUrl?: jest.Mock;
  getPublicUrl?: jest.Mock;
};

function makeProvider(storage?: StorageHandle, configured = true): VoiceUploadProvider {
  const client = {
    storage: { from: jest.fn().mockReturnValue(storage ?? {}) },
  };
  const supabase = {
    getClient: jest.fn(() => {
      if (!configured) throw new Error('SUPABASE_URL not set');
      return client;
    }),
  };
  // Structural mock of the only dependency the provider injects.
  // @ts-expect-error supabase is a partial mock of SupabaseService
  return new VoiceUploadProvider(supabase);
}

describe('VoiceUploadProvider — bucket binding & path', () => {
  afterEach(() => {
    delete process.env.VOICE_SIGNED_URL_TTL_SEC;
    delete process.env.SUPABASE_VOICE_BUCKET;
  });

  it('namespaces the object path by the owner id', () => {
    const provider = makeProvider();
    const key = provider.storageKeyFor(OWNER, 'audio/mp4');
    expect(key.startsWith(`${OWNER}/`)).toBe(true);
  });

  it('maps each allowlisted mime to a stable extension', () => {
    const provider = makeProvider();
    expect(provider.storageKeyFor(OWNER, 'audio/mp4')).toMatch(/\.m4a$/);
    expect(provider.storageKeyFor(OWNER, 'audio/aac')).toMatch(/\.aac$/);
    expect(provider.storageKeyFor(OWNER, 'audio/webm')).toMatch(/\.webm$/);
    expect(provider.storageKeyFor(OWNER, 'audio/wav')).toMatch(/\.wav$/);
  });

  it('uses the default bucket when unconfigured', () => {
    const provider = makeProvider();
    expect(provider.bucket()).toBe('voice-notes');
  });

  it('honours SUPABASE_VOICE_BUCKET when set', () => {
    process.env.SUPABASE_VOICE_BUCKET = 'custom-bucket';
    const provider = makeProvider();
    expect(provider.bucket()).toBe('custom-bucket');
  });
});

describe('VoiceUploadProvider — TTL clamp', () => {
  afterEach(() => {
    delete process.env.VOICE_SIGNED_URL_TTL_SEC;
  });

  it('defaults to 600s', () => {
    expect(makeProvider().ttlSeconds()).toBe(600);
  });

  it('clamps a tiny TTL up to the 60s floor', () => {
    process.env.VOICE_SIGNED_URL_TTL_SEC = '5';
    expect(makeProvider().ttlSeconds()).toBe(60);
  });

  it('clamps a huge TTL down to the 86400s ceiling', () => {
    process.env.VOICE_SIGNED_URL_TTL_SEC = '999999';
    expect(makeProvider().ttlSeconds()).toBe(86400);
  });

  it('falls back to default for a non-numeric TTL', () => {
    process.env.VOICE_SIGNED_URL_TTL_SEC = 'not-a-number';
    expect(makeProvider().ttlSeconds()).toBe(600);
  });
});

describe('VoiceUploadProvider — createSignedDownload degradation', () => {
  it('returns null when storage is unconfigured', async () => {
    const provider = makeProvider(undefined, false);
    expect(await provider.createSignedDownload('key')).toBeNull();
  });

  it('returns null when the SDK build lacks createSignedUrl', async () => {
    const provider = makeProvider({}); // no createSignedUrl
    expect(await provider.createSignedDownload('key')).toBeNull();
  });

  it('returns null when signing errors', async () => {
    const provider = makeProvider({
      createSignedUrl: jest
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'nope' } }),
    });
    expect(await provider.createSignedDownload('key')).toBeNull();
  });

  it('returns the signed URL on success', async () => {
    const provider = makeProvider({
      createSignedUrl: jest
        .fn()
        .mockResolvedValue({ data: { signedUrl: 'https://dl' }, error: null }),
    });
    expect(await provider.createSignedDownload('key')).toBe('https://dl');
  });
});
