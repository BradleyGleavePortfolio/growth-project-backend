/**
 * PR-12 — SupabaseStorageProvider tests.
 *
 * Covers the provider behaviour against a stubbed Supabase client:
 *   - isConfigured() reflects env presence
 *   - createSignedUploadUrl returns the SDK's signed URL
 *   - createSignedDownloadUrl clamps expiry into [60, 86400]
 *   - putObject + deleteObject round-trip through the SDK
 *   - StorageNotConfiguredError surfaces when env is missing
 *   - StorageProviderError surfaces when the SDK returns an error
 */

import { ConfigService } from '@nestjs/config';
import { SupabaseStorageProvider } from '../src/coach-media/supabase-storage.provider';
import {
  StorageNotConfiguredError,
  StorageProviderError,
} from '../src/coach-media/storage-provider';

function makeSupabaseStub(opts: {
  signedUploadResult?: {
    data?: { signedUrl: string; token?: string } | null;
    error?: { message: string } | null;
  };
  signedDownloadResult?: {
    data?: { signedUrl: string } | null;
    error?: { message: string } | null;
  };
  uploadResult?: { data?: { path: string } | null; error?: { message: string } | null };
  removeResult?: { data?: unknown; error?: { message: string } | null };
}) {
  const fromCalls: string[] = [];
  return {
    fromCalls,
    getClient: () => ({
      storage: {
        from: (bucket: string) => {
          fromCalls.push(bucket);
          return {
            createSignedUploadUrl: jest.fn(async () =>
              opts.signedUploadResult ?? {
                data: { signedUrl: 'https://supabase.test/upload?t=stub', token: 't' },
                error: null,
              },
            ),
            createSignedUrl: jest.fn(async () =>
              opts.signedDownloadResult ?? {
                data: { signedUrl: 'https://supabase.test/download?t=stub' },
                error: null,
              },
            ),
            upload: jest.fn(async (path: string) =>
              opts.uploadResult ?? { data: { path }, error: null },
            ),
            remove: jest.fn(async () =>
              opts.removeResult ?? { data: [], error: null },
            ),
          };
        },
      },
    }),
  };
}

function makeProvider(opts: {
  configured?: boolean;
  bucket?: string;
  supabaseStub?: ReturnType<typeof makeSupabaseStub>;
} = {}) {
  // ConfigService falls back to process.env when its inline cache misses
  // a key; for the "unconfigured" tests we shadow process.env via a
  // get() override so we can simulate a deploy without the env vars
  // present, regardless of what the test runner inherits.
  const inline =
    opts.configured === false
      ? {}
      : {
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'service-key',
          SUPABASE_MEDIA_BUCKET: opts.bucket ?? 'coach-media',
        };
  const config = new ConfigService(inline);
  if (opts.configured === false) {
    // Force misses so isConfigured() reports false regardless of test
    // env inheritance.
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) => (inline as Record<string, string>)[key]);
  }
  const stub = opts.supabaseStub ?? makeSupabaseStub({});
  const provider = new SupabaseStorageProvider(
    stub as unknown as ConstructorParameters<typeof SupabaseStorageProvider>[0],
    config,
  );
  return { provider, stub };
}

describe('SupabaseStorageProvider', () => {
  it('isConfigured reflects env presence', () => {
    expect(makeProvider({ configured: true }).provider.isConfigured()).toBe(
      true,
    );
    expect(makeProvider({ configured: false }).provider.isConfigured()).toBe(
      false,
    );
  });

  it('bucketName falls back to default when SUPABASE_MEDIA_BUCKET unset', () => {
    const config = new ConfigService({
      SUPABASE_URL: 'u',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    });
    const stub = makeSupabaseStub({});
    const provider = new SupabaseStorageProvider(
      stub as unknown as ConstructorParameters<typeof SupabaseStorageProvider>[0],
      config,
    );
    expect(provider.bucketName()).toBe('coach-media');
  });

  it('createSignedUploadUrl returns the SDK signed URL', async () => {
    const { provider } = makeProvider();
    const out = await provider.createSignedUploadUrl({
      storageKey: 'coach-1/asset-1.pdf',
      contentType: 'application/pdf',
    });
    expect(out.signedUrl).toBe('https://supabase.test/upload?t=stub');
    expect(out.storageKey).toBe('coach-1/asset-1.pdf');
    expect(out.provider).toBe('supabase');
  });

  it('createSignedUploadUrl maps SDK error → StorageProviderError', async () => {
    const stub = makeSupabaseStub({
      signedUploadResult: { data: null, error: { message: 'bucket missing' } },
    });
    const { provider } = makeProvider({ supabaseStub: stub });
    await expect(
      provider.createSignedUploadUrl({ storageKey: 'k.pdf' }),
    ).rejects.toThrow(StorageProviderError);
  });

  it('createSignedUploadUrl throws StorageNotConfiguredError when env missing', async () => {
    const { provider } = makeProvider({ configured: false });
    await expect(
      provider.createSignedUploadUrl({ storageKey: 'k.pdf' }),
    ).rejects.toThrow(StorageNotConfiguredError);
  });

  it('createSignedDownloadUrl returns SDK signed URL and uses the bucket', async () => {
    const stub = makeSupabaseStub({});
    const { provider } = makeProvider({
      supabaseStub: stub,
      bucket: 'my-bucket',
    });
    const out = await provider.createSignedDownloadUrl('k.pdf');
    expect(out).toBe('https://supabase.test/download?t=stub');
    expect(stub.fromCalls).toContain('my-bucket');
  });

  it('createSignedDownloadUrl clamps requested expiry to [60, 86400]', async () => {
    let captured = 0;
    const stub = makeSupabaseStub({});
    // Override the SDK's createSignedUrl to capture expiresIn.
    const original = stub.getClient;
    stub.getClient = () => {
      const client = original.call(stub);
      const origFrom = client.storage.from;
      client.storage.from = (bucket: string) => {
        const handle = origFrom.call(client.storage, bucket);
        const origCSU = handle.createSignedUrl;
        (handle as { createSignedUrl: (path: string, expiresIn: number) => unknown }).createSignedUrl = (path: string, expiresIn: number) => {
          captured = expiresIn;
          return origCSU.call(handle, path, expiresIn);
        };
        return handle;
      };
      return client;
    };
    const { provider } = makeProvider({ supabaseStub: stub });
    await provider.createSignedDownloadUrl('k.pdf', { expiresInSeconds: 1 });
    expect(captured).toBe(60); // floor
    await provider.createSignedDownloadUrl('k.pdf', {
      expiresInSeconds: 86400 * 10,
    });
    expect(captured).toBe(86400); // ceiling
  });

  it('putObject succeeds', async () => {
    const { provider } = makeProvider();
    const out = await provider.putObject({
      storageKey: 'a.pdf',
      body: Buffer.from('x'),
      contentType: 'application/pdf',
    });
    expect(out.storageKey).toBe('a.pdf');
    expect(out.provider).toBe('supabase');
  });

  it('putObject maps SDK error → StorageProviderError', async () => {
    const stub = makeSupabaseStub({
      uploadResult: { data: null, error: { message: 'quota exceeded' } },
    });
    const { provider } = makeProvider({ supabaseStub: stub });
    await expect(
      provider.putObject({ storageKey: 'a.pdf', body: Buffer.from('x') }),
    ).rejects.toThrow(StorageProviderError);
  });

  it('deleteObject returns true on success and false on error (idempotent)', async () => {
    const okStub = makeSupabaseStub({});
    const errStub = makeSupabaseStub({
      removeResult: { data: null, error: { message: '404' } },
    });
    const okProv = makeProvider({ supabaseStub: okStub }).provider;
    const errProv = makeProvider({ supabaseStub: errStub }).provider;
    expect(await okProv.deleteObject('k')).toBe(true);
    expect(await errProv.deleteObject('k')).toBe(false);
  });
});
