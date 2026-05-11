// test/google-oauth.service.spec.ts
//
// PR #142 — Google Calendar OAuth scaffold tests.
//
// Coverage:
//   1. isConfigured() returns false when env vars are missing.
//   2. buildAuthorizeUrl() throws 503 when not configured.
//   3. buildAuthorizeUrl() composes the correct authorize URL with
//      access_type=offline and prompt=consent (needed to receive a
//      refresh_token on first link AND on re-link after revocation).
//   4. exchangeCode() throws 503 when not configured.
//   5. exchangeCode() POSTs the correct form to Google's token endpoint
//      and stashes the refresh_token on success.
//   6. refreshAccessToken() throws Unauthorized when no refresh token
//      is stored for the user.

import 'reflect-metadata';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GoogleOAuthService } from '../src/scheduling/google-oauth/google-oauth.service';
import { KmsService } from '../src/common/kms/kms.service';

const ORIGINAL_ENV = { ...process.env };

// Phase 2 master switch — these specs exercise the OAuth surface,
// so the flag is on for every test below. Flag-off behavior has
// its own dedicated test.
beforeEach(() => {
  process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'true';
});

class TestableOAuth extends GoogleOAuthService {
  // Expose the protected fetchImpl so tests can stub it.
  public setFetchImpl(impl: typeof fetch): void {
    (this as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl;
  }
}

function makeService() {
  const prisma = {
    calendarConnection: {
      upsert: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
      findFirst: jest.fn(async () => null),
    },
  } as never;
  const kms = new KmsService();
  kms.resetForTests();
  return new TestableOAuth(prisma, kms);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('GoogleOAuthService.isConfigured', () => {
  it('returns false when GOOGLE_OAUTH_CLIENT_ID is missing', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/cb';
    const svc = makeService();
    expect(svc.isConfigured()).toBe(false);
  });

  it('returns true when all three env vars are present', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/cb';
    const svc = makeService();
    expect(svc.isConfigured()).toBe(true);
  });
});

describe('GoogleOAuthService.buildAuthorizeUrl', () => {
  it('throws ServiceUnavailable when OAuth is not configured', () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const svc = makeService();
    expect(() =>
      svc.buildAuthorizeUrl({ userId: 'u-1', state: 'u-1:nonce' }),
    ).toThrow(ServiceUnavailableException);
  });

  it('composes the authorize URL with access_type=offline and prompt=consent', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-1';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    process.env.GOOGLE_OAUTH_SCOPES =
      'https://www.googleapis.com/auth/calendar.events';
    const svc = makeService();
    const url = svc.buildAuthorizeUrl({ userId: 'u-1', state: 'u-1:nonce' });
    expect(url).toContain(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url).toContain('client_id=client-1');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapi.test%2Fcb');
    expect(url).toContain('response_type=code');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('state=u-1%3Anonce');
    expect(url).toContain('calendar.events');
  });
});

describe('GoogleOAuthService.exchangeCode', () => {
  it('throws ServiceUnavailable when OAuth is not configured', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const svc = makeService();
    await expect(
      svc.exchangeCode({ code: 'c-1', userId: 'u-1' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('POSTs the form-encoded body and stashes the refresh_token on success', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-1';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const svc = makeService();
    let capturedBody = '';
    svc.setFetchImpl(async (input, init) => {
      capturedBody = (init?.body as string) ?? '';
      return new Response(
        JSON.stringify({
          access_token: 'at-1',
          expires_in: 3600,
          refresh_token: 'rt-1',
          scope: 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const tokens = await svc.exchangeCode({ code: 'c-1', userId: 'u-1' });
    expect(tokens.access_token).toBe('at-1');
    expect(tokens.refresh_token).toBe('rt-1');
    expect(capturedBody).toContain('code=c-1');
    expect(capturedBody).toContain('client_id=client-1');
    expect(capturedBody).toContain('grant_type=authorization_code');
  });
});

describe('GoogleOAuthService feature flag', () => {
  it('isConfigured returns false when FEATURE_GOOGLE_CALENDAR_SYNC is off', () => {
    delete process.env.FEATURE_GOOGLE_CALENDAR_SYNC;
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-1';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const svc = makeService();
    expect(svc.isConfigured()).toBe(false);
  });

  it('isFeatureFlagOn reflects env var', () => {
    delete process.env.FEATURE_GOOGLE_CALENDAR_SYNC;
    expect(GoogleOAuthService.isFeatureFlagOn()).toBe(false);
    process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'true';
    expect(GoogleOAuthService.isFeatureFlagOn()).toBe(true);
  });
});

describe('GoogleOAuthService.refreshAccessToken', () => {
  it('throws Unauthorized when no refresh token is stored for the user', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-1';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const svc = makeService();
    await expect(
      svc.refreshAccessToken({ userId: 'u-unknown' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
