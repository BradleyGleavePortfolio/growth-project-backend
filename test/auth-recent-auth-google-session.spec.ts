/**
 * Google re-auth for account deletion (mobile #313 B-313-1, operator policy 5).
 *
 * The mobile build has no Google client id (sign-in is Supabase-brokered), so
 * it proves a fresh Google sign-in by running the Supabase Google OAuth flow
 * again and sending that new session's access token as
 * provider=google_session. The server accepts it only when Supabase validates
 * the token, it belongs to the caller, the identity has a google provider and
 * the token's amr records an oauth sign-in within RECENT_AUTH_TTL_MS. The
 * app's existing session token (old amr timestamp) is refused, which keeps
 * the Audit #3 replay closed.
 */
import { UnauthorizedException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthService } from '../src/auth/auth.service';
import { IssueRecentAuthTokenDto } from '../src/auth/auth.dto';
import type { PrismaService } from '../src/prisma.service';
import type { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { AuditService } from '../src/audit/audit.service';
import type { AppleVerifierService } from '../src/auth/apple-verifier.service';
import type { GoogleVerifierService } from '../src/auth/google-verifier.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: {} })) }));

function stub<T>(value: unknown): T {
  return value as T;
}

const SECRET = 'test-recent-auth-secret-at-least-32-chars-long';
const user = { id: 'u-1', email: 'jane@example.test', supabase_id: 'sup-1', role: 'student' };

function sessionToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'ES256', typ: 'JWT' })}.${enc({
    iss: 'https://abc.supabase.co/auth/v1',
    aud: 'authenticated',
    sub: 'sup-1',
    ...claims,
  })}.sig`;
}

function make(getUser: jest.Mock) {
  const googleVerifier = { verify: jest.fn(), isConfigured: () => false };
  const service = new AuthService(
    stub<PrismaService>({ user: { findUnique: jest.fn(async () => user) } }),
    stub<InviteCodesService>({}),
    stub<AnalyticsService>({ capture: jest.fn() }),
    stub<AuditService>({ write: jest.fn() }),
    stub<AppleVerifierService>({ verify: jest.fn(), isConfigured: () => true }),
    stub<GoogleVerifierService>(googleVerifier),
  );
  Object.assign(service, { supabaseAdmin: { auth: { getUser } } });
  return { service, googleVerifier };
}

const supaUser = (overrides: Record<string, unknown> = {}) =>
  jest.fn(async () => ({
    data: {
      user: {
        id: 'sup-1',
        app_metadata: { provider: 'email', providers: ['email', 'google'] },
        ...overrides,
      },
    },
    error: null,
  }));

async function withEnv(fn: () => Promise<void>) {
  const original = { ...process.env };
  Object.assign(process.env, { RECENT_AUTH_SECRET: SECRET, RECENT_AUTH_TTL_MS: '300000' });
  try {
    await fn();
  } finally {
    process.env = original;
  }
}

const now = () => Math.floor(Date.now() / 1000);

describe('recent-auth provider=google_session', () => {
  it('issues a token for a Supabase session created by a Google sign-in moments ago', () =>
    withEnv(async () => {
      const getUser = supaUser();
      const { service, googleVerifier } = make(getUser);
      const token = sessionToken({ amr: [{ method: 'oauth', timestamp: now() - 20 }] });
      const res = await service.issueRecentAuthToken('u-1', {
        provider: 'google_session',
        provider_token: token,
      });
      expect(res.token.split('.')).toHaveLength(3);
      expect(getUser).toHaveBeenCalledWith(token);
      // Works with Google sign-up disabled: no Google client id is needed.
      expect(googleVerifier.verify).not.toHaveBeenCalled();
    }));

  it('refuses the app’s existing session (oauth sign-in older than the TTL) — Audit #3 replay', () =>
    withEnv(async () => {
      const { service } = make(supaUser());
      const token = sessionToken({
        iat: now() - 5,
        amr: [{ method: 'oauth', timestamp: now() - 3 * 24 * 3600 }],
      });
      await expect(
        service.issueRecentAuthToken('u-1', { provider: 'google_session', provider_token: token }),
      ).rejects.toThrow('stale');
    }));

  it('refuses a session whose amr has no oauth sign-in (password or refresh only)', () =>
    withEnv(async () => {
      const { service } = make(supaUser());
      const token = sessionToken({ amr: [{ method: 'password', timestamp: now() - 5 }] });
      await expect(
        service.issueRecentAuthToken('u-1', { provider: 'google_session', provider_token: token }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }));

  it('refuses another account’s session', () =>
    withEnv(async () => {
      const { service } = make(supaUser({ id: 'sup-other' }));
      const token = sessionToken({
        sub: 'sup-other',
        amr: [{ method: 'oauth', timestamp: now() - 5 }],
      });
      await expect(
        service.issueRecentAuthToken('u-1', { provider: 'google_session', provider_token: token }),
      ).rejects.toThrow('does not belong');
    }));

  it('refuses a token Supabase rejects, and an identity without Google', () =>
    withEnv(async () => {
      const token = sessionToken({ amr: [{ method: 'oauth', timestamp: now() - 5 }] });
      const rejected = make(
        jest.fn(async () => ({ data: { user: null }, error: { message: 'invalid JWT' } })),
      );
      await expect(
        rejected.service.issueRecentAuthToken('u-1', {
          provider: 'google_session',
          provider_token: token,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const noGoogle = make(
        supaUser({ app_metadata: { provider: 'apple', providers: ['apple'] } }),
      );
      await expect(
        noGoogle.service.issueRecentAuthToken('u-1', {
          provider: 'google_session',
          provider_token: token,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }));

  it('refuses a malformed token without calling Supabase', () =>
    withEnv(async () => {
      const getUser = supaUser();
      const { service } = make(getUser);
      await expect(
        service.issueRecentAuthToken('u-1', {
          provider: 'google_session',
          provider_token: 'not-a-jwt-value',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(getUser).not.toHaveBeenCalled();
    }));

  it('the DTO accepts google_session and still rejects unknown providers', async () => {
    const ok = plainToInstance(IssueRecentAuthTokenDto, {
      provider: 'google_session',
      provider_token: 'x'.repeat(20),
    });
    expect(await validate(ok)).toHaveLength(0);
    const bad = plainToInstance(IssueRecentAuthTokenDto, {
      provider: 'github',
      provider_token: 'x'.repeat(20),
    });
    expect((await validate(bad)).length).toBeGreaterThan(0);
  });
});
