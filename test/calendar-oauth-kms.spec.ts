import { randomBytes } from 'crypto';
import { GoogleOAuthService } from '../src/scheduling/google-oauth/google-oauth.service';
import { KmsService } from '../src/common/kms/kms.service';

class TestableOAuth extends GoogleOAuthService {
  public setFetchImpl(impl: typeof fetch): void {
    (this as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl;
  }
}

const VALID_KEY_B64 = randomBytes(32).toString('base64');
const ORIGINAL_ENV = { ...process.env };

function fakeTokenResponse(refresh: string | undefined): typeof fetch {
  return (async () => {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-1',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/calendar.events',
          ...(refresh ? { refresh_token: refresh } : {}),
        };
      },
      async text() {
        return '';
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('Calendar OAuth KMS retrofit', () => {
  function configureOAuth() {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  }

  it('encrypt-on-persist: exchangeCode encrypts the refresh token via the CalendarConnection encrypted_refresh_token column', async () => {
    configureOAuth();
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const prisma = {
      calendarConnection: {
        upsert: jest.fn(),
        updateMany: jest.fn(async (_args: any) => ({ count: 1 })),
        findFirst: jest.fn(),
      },
    } as never;
    const kms = new KmsService();
    kms.resetForTests();
    const svc = new TestableOAuth(prisma, kms);
    svc.setFetchImpl(fakeTokenResponse('the-refresh-token'));

    await svc.exchangeCode({ code: 'auth-code-1', userId: 'user-1' });

    const updateCalls = (prisma as any).calendarConnection.updateMany.mock.calls;
    expect(updateCalls.length).toBe(1);
    const writtenData = updateCalls[0][0].data;
    expect(writtenData.encrypted_refresh_token).toBeDefined();
    expect(writtenData.encrypted_refresh_token).not.toBe('the-refresh-token');
    expect(writtenData.encrypted_refresh_token.startsWith('PLAINTEXT:')).toBe(false);
    // And it must round-trip back to the original value via the same key.
    expect(kms.decrypt(writtenData.encrypted_refresh_token)).toBe(
      'the-refresh-token',
    );
  });

  it('decrypt-on-refresh: refreshAccessToken reads encrypted_refresh_token from DB and submits the decrypted value', async () => {
    configureOAuth();
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const kms = new KmsService();
    kms.resetForTests();
    const encryptedToken = kms.encrypt('rt-from-db');
    const prisma = {
      calendarConnection: {
        upsert: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findFirst: jest.fn(async () => ({
          encrypted_refresh_token: encryptedToken,
        })),
      },
    } as never;
    const svc = new TestableOAuth(prisma, kms);

    let observedRefreshToken: string | null = null;
    svc.setFetchImpl((async (_url: string, init: any) => {
      const body = new URLSearchParams(init.body as string);
      observedRefreshToken = body.get('refresh_token');
      return {
        ok: true,
        async json() {
          return {
            access_token: 'fresh-access',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/calendar.events',
          };
        },
        async text() {
          return '';
        },
      } as unknown as Response;
    }) as unknown as typeof fetch);

    const out = await svc.refreshAccessToken({ userId: 'user-1' });
    expect(out.access_token).toBe('fresh-access');
    expect(observedRefreshToken).toBe('rt-from-db');
  });

  it('fallback-to-process-stash: when the CalendarConnection row has no encrypted token yet, refreshAccessToken falls back to the in-process stash', async () => {
    configureOAuth();
    process.env.KMS_MASTER_KEY = VALID_KEY_B64;
    const kms = new KmsService();
    kms.resetForTests();
    const prisma = {
      calendarConnection: {
        upsert: jest.fn(),
        // First call (during exchangeCode) finds no row to update.
        updateMany: jest.fn(async () => ({ count: 0 })),
        // Refresh path finds no DB row either.
        findFirst: jest.fn(async () => null),
      },
    } as never;
    const svc = new TestableOAuth(prisma, kms);
    svc.setFetchImpl(fakeTokenResponse('stash-refresh-token'));

    // Populate the in-process stash via exchangeCode.
    await svc.exchangeCode({ code: 'auth-code-2', userId: 'user-2' });

    let observedRefreshToken: string | null = null;
    svc.setFetchImpl((async (_url: string, init: any) => {
      const body = new URLSearchParams(init.body as string);
      observedRefreshToken = body.get('refresh_token');
      return {
        ok: true,
        async json() {
          return {
            access_token: 'fresh-access',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/calendar.events',
          };
        },
        async text() {
          return '';
        },
      } as unknown as Response;
    }) as unknown as typeof fetch);

    const out = await svc.refreshAccessToken({ userId: 'user-2' });
    expect(out.access_token).toBe('fresh-access');
    expect(observedRefreshToken).toBe('stash-refresh-token');
  });
});
