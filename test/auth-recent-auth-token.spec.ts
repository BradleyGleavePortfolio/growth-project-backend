/**
 * AuthService.issueRecentAuthToken — Phase 10 audit P1-1 / P1-3 fixes.
 *
 * Coverage:
 *   1. Email/password path still works (regression check).
 *   2. OAuth-only users can obtain a recent-auth token via a fresh Apple
 *      identity token (P1-1 fix: OAuth users were locked out of account
 *      deletion).
 *   3. OAuth-only users can obtain a recent-auth token via a fresh Google
 *      access token (P1-1 fix).
 *   4. Stale provider tokens (older than RECENT_AUTH_TTL_MS) are rejected.
 *   5. Provider token bound to a different user is rejected.
 *   6. Neither password nor provider_token provided -> 400.
 *   7. Wrong password -> 401.
 *   8. RECENT_AUTH_SECRET too short -> 500-class internal error, env var
 *      name NOT leaked (P1-3 fix).
 */

import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { RECENT_AUTH_SECRET_MIN_LENGTH } from '../src/auth/recent-auth.guard';

// Strong test secret (>=32 chars), matches what jest.setup.ts sets.
const VALID_SECRET = 'test-recent-auth-secret-at-least-32-chars-long';

// Patch @supabase/supabase-js createClient to a stub that we control per-test.
// AuthService.issueRecentAuthToken creates a fresh client for the password and
// Apple verify-via-Supabase paths; we intercept those constructions.
jest.mock('@supabase/supabase-js', () => {
  return {
    createClient: jest.fn(),
  };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const supabaseModule = require('@supabase/supabase-js');

function makeService(overrides: Partial<{
  prismaUser: any;
  appleVerify: any;
  supabaseAdminGetUser: any;
  supaClientFactory: any;
}> = {}) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => overrides.prismaUser ?? null),
    },
  };
  const inviteCodes: any = {};
  const analytics: any = { capture: jest.fn() };
  const audit: any = { write: jest.fn() };
  const appleVerifier: any = {
    verify: jest.fn(overrides.appleVerify ?? (async () => ({}))),
    isConfigured: () => true,
  };

  // Stub the global createClient factory so AuthService's per-call clients
  // hit our injected behaviors.
  (supabaseModule.createClient as jest.Mock).mockReset();
  (supabaseModule.createClient as jest.Mock).mockImplementation(
    overrides.supaClientFactory ??
      (() => ({
        auth: {
          signInWithPassword: jest.fn(async () => ({ error: null })),
          signInWithIdToken: jest.fn(async () => ({
            data: { user: { id: 'sup-1', email: 'oauth@example.test' } },
            error: null,
          })),
        },
      })),
  );

  const service = new AuthService(prisma, inviteCodes, analytics, audit, appleVerifier);
  // Replace the supabaseAdmin client constructed by the AuthService
  // constructor with our test stub so Google path tests can drive getUser.
  (service as any).supabaseAdmin = {
    auth: {
      getUser: jest.fn(
        overrides.supabaseAdminGetUser ??
          (async () => ({
            data: {
              user: {
                id: 'sup-google-1',
                email: 'oauth@example.test',
                app_metadata: { provider: 'google', providers: ['google'] },
                identities: [{ provider: 'google' }],
              },
            },
            error: null,
          })),
      ),
    },
  };

  return { service, prisma, appleVerifier };
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  return fn().finally(() => {
    process.env = original;
  });
}

// Helper: forge an Apple-style JWT payload with a controllable iat.
function makeFakeJwtWithIat(iatSec: number, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: iatSec, sub: 'apple-sub', email: 'oauth@example.test', ...extra }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('AuthService.issueRecentAuthToken — recent-auth (P1-1 / P1-3)', () => {
  const baseUser = {
    id: 'u-1',
    email: 'jane@example.test',
    supabase_id: 'sup-1',
    role: 'student',
  };

  it('email/password path: returns a token when password is correct', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const { service } = makeService({
          prismaUser: baseUser,
          supaClientFactory: () => ({
            auth: {
              signInWithPassword: jest.fn(async () => ({ error: null })),
            },
          }),
        });
        const result = await service.issueRecentAuthToken('u-1', {
          password: 'correct-pw',
        });
        expect(result.token.split('.')).toHaveLength(3);
        expect(result.token.startsWith('u-1.')).toBe(true);
        expect(result.expires_in_ms).toBe(300_000);
      },
    );
  });

  it('email/password path: rejects when Supabase returns an error', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const { service } = makeService({
          prismaUser: baseUser,
          supaClientFactory: () => ({
            auth: {
              signInWithPassword: jest.fn(async () => ({
                error: { message: 'Invalid login credentials' },
              })),
            },
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', { password: 'wrong' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth Apple path: returns a token when identity token is fresh and bound to caller', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service, appleVerifier } = makeService({
          prismaUser: baseUser,
          appleVerify: async () => ({
            iat: freshIat,
            sub: 'apple-sub',
            email: 'jane@example.test',
          }),
          supaClientFactory: () => ({
            auth: {
              signInWithIdToken: jest.fn(async () => ({
                data: { user: { id: 'sup-1', email: 'jane@example.test' } },
                error: null,
              })),
            },
          }),
        });
        const result = await service.issueRecentAuthToken('u-1', {
          provider_token: 'apple-id-token',
          provider: 'apple',
        });
        expect(result.token.split('.')).toHaveLength(3);
        expect(appleVerifier.verify).toHaveBeenCalledWith('apple-id-token');
      },
    );
  });

  it('OAuth Apple path: rejects a stale identity token (older than TTL)', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const staleIat = Math.floor(Date.now() / 1000) - 60 * 60;
        const { service } = makeService({
          prismaUser: baseUser,
          appleVerify: async () => ({
            iat: staleIat,
            sub: 'apple-sub',
            email: 'jane@example.test',
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'stale',
            provider: 'apple',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth Google path: returns a token when access token is fresh and bound to caller', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          prismaUser: baseUser,
          supabaseAdminGetUser: async () => ({
            data: {
              user: {
                id: 'sup-1',
                email: 'jane@example.test',
                app_metadata: { provider: 'google', providers: ['google'] },
                identities: [{ provider: 'google' }],
              },
            },
            error: null,
          }),
        });
        const token = makeFakeJwtWithIat(freshIat);
        const result = await service.issueRecentAuthToken('u-1', {
          provider_token: token,
          provider: 'google',
        });
        expect(result.token.split('.')).toHaveLength(3);
      },
    );
  });

  it('OAuth Google path: rejects a stale access token', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const staleIat = Math.floor(Date.now() / 1000) - 60 * 60;
        const { service } = makeService({ prismaUser: baseUser });
        const token = makeFakeJwtWithIat(staleIat);
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: token,
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth path: rejects a provider token bound to a different user', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          prismaUser: baseUser,
          supabaseAdminGetUser: async () => ({
            data: {
              user: {
                id: 'sup-OTHER',
                email: 'someone-else@example.test',
                app_metadata: { provider: 'google', providers: ['google'] },
                identities: [{ provider: 'google' }],
              },
            },
            error: null,
          }),
        });
        const token = makeFakeJwtWithIat(freshIat);
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: token,
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('rejects when neither password nor provider_token is provided (400)', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const { service } = makeService({ prismaUser: baseUser });
        await expect(service.issueRecentAuthToken('u-1', {})).rejects.toBeInstanceOf(
          BadRequestException,
        );
      },
    );
  });

  it('@Throttle metadata caps the endpoint at 5/min (P1-2)', () => {
    // Belt-and-braces guard against the decorator being silently removed.
    // The full integration is exercised by test/rate-limit.spec.ts (named-
    // bucket table + AppModule APP_GUARD wiring) and
    // test/auth.controller.spec.ts (handler-level metadata). Repeating the
    // assertion here so the recent-auth audit fix is fully covered in its
    // own spec without depending on grep across files.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AuthController } = require('../src/auth/auth.controller');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { THROTTLER_NAMES } = require('../src/throttler/throttler.config');
    const handler = AuthController.prototype.issueRecentAuthToken;
    const ttl = Reflect.getMetadata(
      `THROTTLER:TTL${THROTTLER_NAMES.AUTH_RECENT_AUTH}`,
      handler,
    );
    const limit = Reflect.getMetadata(
      `THROTTLER:LIMIT${THROTTLER_NAMES.AUTH_RECENT_AUTH}`,
      handler,
    );
    expect(ttl).toBe(60_000);
    expect(limit).toBe(5);
  });

  it('429: the 6th call within 60s exceeds the auth-recent-auth bucket', async () => {
    // Drive the in-memory ThrottlerStorageService directly with the same
    // bucket parameters the @Throttle decorator binds (60s TTL, limit 5),
    // and the same tracker key UserThrottlerGuard would produce for this
    // user. This proves the bucket rolls over the limit on the 6th hit —
    // the contract /auth/recent-auth-token relies on for rate-limiting.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ThrottlerStorageService } = require('@nestjs/throttler');
    const storage = new ThrottlerStorageService();
    try {
      const key = 'auth-recent-auth-user:u-1';
      const ttl = 60_000;
      const limit = 5;
      // ThrottlerGuard defaults blockDuration to the ttl when not overridden
      // (see node_modules/@nestjs/throttler/dist/throttler.guard.js). Mirror
      // that here so isBlocked stays true on the 6th call instead of
      // being immediately reset by a 0-duration block.
      const blockDuration = ttl;
      const records: any[] = [];
      for (let i = 0; i < 6; i += 1) {
        records.push(
          await storage.increment(key, ttl, limit, blockDuration, 'auth-recent-auth'),
        );
      }
      // The first 5 calls are under the limit. The 6th must report
      // isBlocked === true (i.e. the guard would throw ThrottlerException
      // → ThrottlerExceptionFilter → 429).
      expect(records[0].isBlocked).toBe(false);
      expect(records[4].isBlocked).toBe(false);
      expect(records[5].isBlocked).toBe(true);
    } finally {
      // Free the internal interval timer the storage service installs so
      // Jest doesn't hang on open handles.
      if (typeof (storage as any).onApplicationShutdown === 'function') {
        await (storage as any).onApplicationShutdown();
      }
    }
  });

  it('UserThrottlerGuard keys by user id (so the 5/min budget is per-user)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UserThrottlerGuard } = require('../src/throttler/user-throttler.guard');
    const guard = Object.create(UserThrottlerGuard.prototype);
    const tracker = await (guard as any).getTracker({
      user: { id: 'u-1' },
      headers: {},
    });
    expect(tracker).toBe('user:u-1');
  });

  it('rejects with InternalServerError when RECENT_AUTH_SECRET is too short — env name NOT in client message', async () => {
    await withEnv({ RECENT_AUTH_SECRET: 'short', RECENT_AUTH_TTL_MS: '300000' }, async () => {
      expect(VALID_SECRET.length).toBeGreaterThanOrEqual(RECENT_AUTH_SECRET_MIN_LENGTH);
      const { service } = makeService({ prismaUser: baseUser });
      try {
        await service.issueRecentAuthToken('u-1', { password: 'pw' });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InternalServerErrorException);
        // Crucial: the env var name MUST NOT appear in the client-visible message.
        const msg = (err as any).message ?? String(err);
        expect(msg).not.toContain('RECENT_AUTH_SECRET');
      }
    });
  });
});
