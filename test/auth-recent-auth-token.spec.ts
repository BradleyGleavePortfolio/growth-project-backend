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
  ServiceUnavailableException,
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
  googleVerify: any;
  googleConfigured: boolean;
  supabaseAdminGetUserById: any;
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
  const googleVerifier: any = {
    verify: jest.fn(overrides.googleVerify ?? (async () => ({}))),
    isConfigured: () => overrides.googleConfigured ?? true,
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

  const service = new AuthService(
    prisma,
    inviteCodes,
    analytics,
    audit,
    appleVerifier,
    googleVerifier,
  );
  // Replace the supabaseAdmin client constructed by the AuthService
  // constructor with our test stub. The Google branch uses
  // `auth.admin.getUserById` to look up the user's Google identity sub for
  // binding (when matchesByEmail is false).
  (service as any).supabaseAdmin = {
    auth: {
      admin: {
        getUserById: jest.fn(
          overrides.supabaseAdminGetUserById ??
            (async () => ({
              data: {
                user: {
                  id: 'sup-1',
                  email: 'jane@example.test',
                  identities: [
                    {
                      provider: 'google',
                      id: 'google-sub-jane',
                      identity_data: { sub: 'google-sub-jane' },
                    },
                  ],
                },
              },
              error: null,
            })),
        ),
      },
    },
  };

  return { service, prisma, appleVerifier, googleVerifier };
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

  it('OAuth Google path: returns a token when ID token is fresh and bound by email', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service, googleVerifier } = makeService({
          prismaUser: baseUser,
          googleVerify: async () => ({
            iat: freshIat,
            sub: 'google-sub-jane',
            email: 'jane@example.test',
            email_verified: true,
          }),
        });
        const result = await service.issueRecentAuthToken('u-1', {
          provider_token: 'google-id-token',
          provider: 'google',
        });
        expect(result.token.split('.')).toHaveLength(3);
        expect(googleVerifier.verify).toHaveBeenCalledWith('google-id-token');
      },
    );
  });

  it('OAuth Google path: returns a token when ID token is bound by Google sub even if email differs', async () => {
    // Users who change their Google primary email keep the same `sub`. We
    // must accept the token as long as the sub matches a Google identity
    // recorded on the Supabase user row, regardless of email.
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          prismaUser: baseUser,
          googleVerify: async () => ({
            iat: freshIat,
            sub: 'google-sub-jane',
            email: 'jane-new@example.test',
            email_verified: true,
          }),
        });
        const result = await service.issueRecentAuthToken('u-1', {
          provider_token: 'google-id-token',
          provider: 'google',
        });
        expect(result.token.split('.')).toHaveLength(3);
      },
    );
  });

  it('OAuth Google path: rejects a stale ID token', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const staleIat = Math.floor(Date.now() / 1000) - 60 * 60;
        const { service } = makeService({
          prismaUser: baseUser,
          googleVerify: async () => ({
            iat: staleIat,
            sub: 'google-sub-jane',
            email: 'jane@example.test',
            email_verified: true,
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'stale-google-id-token',
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth Google path: rejects when GoogleVerifierService throws (bad signature, wrong audience, etc.)', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const { service } = makeService({
          prismaUser: baseUser,
          googleVerify: async () => {
            throw new Error('signature verification failed');
          },
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'forged-or-supabase-token',
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth Google path: rejects the current Supabase session token used as provider_token (Audit #3 P1)', async () => {
    // This is the headline regression: under the old implementation,
    // `verifyOAuthRecentAuthProof` called `supabaseAdmin.auth.getUser()`
    // which accepts a Supabase access JWT. Because the caller's
    // Authorization header IS a Supabase access JWT, the same value passed
    // as `provider_token` passed the "fresh re-auth" gate without any
    // real Google interaction.
    //
    // The fix routes the token through GoogleVerifierService, which
    // verifies it against Google's JWKS with audience pinned to
    // GOOGLE_CLIENT_ID(S). A Supabase access JWT is signed by Supabase
    // (ES256, kid=...), with `iss` like
    // "https://<project>.supabase.co/auth/v1", `aud` "authenticated", so
    // jwtVerify rejects it on issuer/audience/signature grounds — we
    // simulate that here by having the verifier throw.
    await withEnv(
      {
        RECENT_AUTH_SECRET: VALID_SECRET,
        RECENT_AUTH_TTL_MS: '300000',
        GOOGLE_CLIENT_ID: 'real-google-client-id.apps.googleusercontent.com',
      },
      async () => {
        const supabaseSessionJwtHeader = Buffer.from(
          JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'supabase-key-id' }),
        ).toString('base64url');
        const supabaseSessionJwtPayload = Buffer.from(
          JSON.stringify({
            iss: 'https://abc.supabase.co/auth/v1',
            aud: 'authenticated',
            sub: 'sup-1',
            iat: Math.floor(Date.now() / 1000) - 10,
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: 'jane@example.test',
            app_metadata: { provider: 'google' },
          }),
        ).toString('base64url');
        const supabaseSessionToken = `${supabaseSessionJwtHeader}.${supabaseSessionJwtPayload}.supabase-signature`;

        const { service, googleVerifier } = makeService({
          prismaUser: baseUser,
          // The real GoogleVerifierService (jose.jwtVerify) would reject
          // this token: wrong issuer, wrong audience, and the signature
          // doesn't validate against Google's JWKS. Simulate that.
          googleVerify: async () => {
            throw new Error(
              'unexpected "iss" claim value (expected accounts.google.com)',
            );
          },
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: supabaseSessionToken,
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(googleVerifier.verify).toHaveBeenCalledWith(supabaseSessionToken);
      },
    );
  });

  it('OAuth Google path: rejects a fresh, valid Google ID token issued for a different email (Audit #3 P1)', async () => {
    // Attacker has their own freshly minted Google ID token (verifies
    // cleanly against Google's JWKS, audience matches our client id, iat
    // is fresh). They send it as `provider_token` on a recent-auth call
    // for the victim's account. Even though the token is "real", the
    // verified Google identity (email/sub) does not belong to the victim
    // — the call MUST be rejected.
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          prismaUser: baseUser,
          googleVerify: async () => ({
            iat: freshIat,
            sub: 'google-sub-attacker',
            email: 'attacker@example.test',
            email_verified: true,
          }),
          // Victim's Supabase row stores its own Google identity sub —
          // not the attacker's. So sub-binding fails too.
          supabaseAdminGetUserById: async () => ({
            data: {
              user: {
                id: 'sup-1',
                email: 'jane@example.test',
                identities: [
                  {
                    provider: 'google',
                    id: 'google-sub-jane',
                    identity_data: { sub: 'google-sub-jane' },
                  },
                ],
              },
            },
            error: null,
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'attacker-google-id-token',
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      },
    );
  });

  it('OAuth Google path: rejects when GOOGLE_CLIENT_ID(S) is not configured', async () => {
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const { service, googleVerifier } = makeService({
          prismaUser: baseUser,
          googleConfigured: false,
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'whatever',
            provider: 'google',
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        // Must not have leaked to the verifier — we short-circuit when
        // unconfigured to avoid silently passing tokens with no audience pin.
        expect(googleVerifier.verify).not.toHaveBeenCalled();
      },
    );
  });

  it('OAuth Apple path: rejects an Apple token bound to a different account (Audit #2 P1)', async () => {
    // Attacker has:
    //   - victim's session JWT (req.user resolves to the victim)
    //   - their OWN fresh Apple identity token (verifies cleanly, fresh iat)
    // The Supabase ID-token exchange returns the attacker's Supabase user
    // (different `id`, different `email`), neither of which matches the
    // victim's account. The previous bypass `!(sub && supaUserId)` accepted
    // the call because both `sub` (from the JWT payload) and `supaUserId`
    // (from Supabase) were non-empty. The fix removes the bypass entirely,
    // so the call must be rejected with UnauthorizedException.
    await withEnv(
      { RECENT_AUTH_SECRET: VALID_SECRET, RECENT_AUTH_TTL_MS: '300000' },
      async () => {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          // Victim row.
          prismaUser: baseUser,
          // Apple token verifies (attacker's real token), with attacker's
          // email and sub. iat is fresh.
          appleVerify: async () => ({
            iat: freshIat,
            sub: 'apple-sub-attacker',
            email: 'attacker@example.test',
          }),
          // Supabase ID-token exchange returns the attacker's Supabase user.
          // Neither id nor email matches the victim (baseUser.supabase_id =
          // 'sup-1', baseUser.email = 'jane@example.test').
          supaClientFactory: () => ({
            auth: {
              signInWithIdToken: jest.fn(async () => ({
                data: {
                  user: {
                    id: 'sup-attacker',
                    email: 'attacker@example.test',
                  },
                },
                error: null,
              })),
            },
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'attacker-apple-token',
            provider: 'apple',
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
          googleVerify: async () => ({
            iat: freshIat,
            sub: 'google-sub-other',
            email: 'someone-else@example.test',
            email_verified: true,
          }),
          supabaseAdminGetUserById: async () => ({
            data: {
              user: {
                id: 'sup-1',
                email: 'jane@example.test',
                identities: [
                  {
                    provider: 'google',
                    id: 'google-sub-jane',
                    identity_data: { sub: 'google-sub-jane' },
                  },
                ],
              },
            },
            error: null,
          }),
        });
        await expect(
          service.issueRecentAuthToken('u-1', {
            provider_token: 'other-user-google-id-token',
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

  it('two authenticated users behind the same IP get independent buckets (Audit #2 P2-A)', async () => {
    // Proves the per-user 5/min cap on /auth/recent-auth-token does NOT
    // collide across users sharing a NAT / CGNAT / corporate IP. User A
    // exhausting their budget MUST NOT throttle user B.
    //
    // We drive the same ThrottlerStorageService that backs the in-memory
    // throttler in tests, using the tracker keys UserThrottlerGuard would
    // emit when JwtAuthGuard has populated `req.user` (which is the order
    // app.module.ts now registers the guards in — JWT first, throttler
    // second). The same shared `fly-client-ip` header is on every request,
    // but is ignored by getTracker() because `req.user.id` is set.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UserThrottlerGuard } = require('../src/throttler/user-throttler.guard');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ThrottlerStorageService } = require('@nestjs/throttler');
    const guard = Object.create(UserThrottlerGuard.prototype);

    const sharedHeaders = { 'fly-client-ip': '203.0.113.7' };
    const reqA = { user: { id: 'user-A' }, headers: sharedHeaders };
    const reqB = { user: { id: 'user-B' }, headers: sharedHeaders };

    const trackerA = await (guard as any).getTracker(reqA);
    const trackerB = await (guard as any).getTracker(reqB);
    expect(trackerA).toBe('user:user-A');
    expect(trackerB).toBe('user:user-B');
    expect(trackerA).not.toBe(trackerB);

    const storage = new ThrottlerStorageService();
    try {
      const bucket = 'auth-recent-auth';
      const ttl = 60_000;
      const limit = 5;
      const blockDuration = ttl;

      // User A exhausts the 5/min budget and trips the limit on the 6th call.
      const aKey = `${bucket}-${trackerA}`;
      for (let i = 0; i < 5; i += 1) {
        const r = await storage.increment(aKey, ttl, limit, blockDuration, bucket);
        expect(r.isBlocked).toBe(false);
      }
      const aOverflow = await storage.increment(aKey, ttl, limit, blockDuration, bucket);
      expect(aOverflow.isBlocked).toBe(true);

      // User B (same IP) is still completely unaffected: first request is
      // under their own 5/min cap, not at the per-user limit.
      const bKey = `${bucket}-${trackerB}`;
      const bFirst = await storage.increment(bKey, ttl, limit, blockDuration, bucket);
      expect(bFirst.isBlocked).toBe(false);
      // And user B can spend their full budget independently.
      for (let i = 0; i < 4; i += 1) {
        const r = await storage.increment(bKey, ttl, limit, blockDuration, bucket);
        expect(r.isBlocked).toBe(false);
      }
      const bOverflow = await storage.increment(bKey, ttl, limit, blockDuration, bucket);
      expect(bOverflow.isBlocked).toBe(true);
    } finally {
      if (typeof (storage as any).onApplicationShutdown === 'function') {
        await (storage as any).onApplicationShutdown();
      }
    }
  });

  it('AppModule registers JwtAuthGuard before UserThrottlerGuard (Audit #2 P2-A)', () => {
    // The ordering is load-bearing: with throttler registered first,
    // `req.user` is undefined when getTracker() runs and per-user limits
    // silently fall back to IP-based tracking. Pinning the order in a test
    // prevents accidental re-shuffling of app.module.ts providers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('../src/app.module');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { APP_GUARD } = require('@nestjs/core');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JwtAuthGuard } = require('../src/auth/auth.guard');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UserThrottlerGuard } = require('../src/throttler/user-throttler.guard');
    const providers = Reflect.getMetadata('providers', AppModule) as Array<any>;
    const jwtIdx = providers.findIndex(
      (p) => p && p.provide === APP_GUARD && p.useClass === JwtAuthGuard,
    );
    const throttlerIdx = providers.findIndex(
      (p) => p && p.provide === APP_GUARD && p.useClass === UserThrottlerGuard,
    );
    expect(jwtIdx).toBeGreaterThanOrEqual(0);
    expect(throttlerIdx).toBeGreaterThanOrEqual(0);
    expect(jwtIdx).toBeLessThan(throttlerIdx);
  });

  it('signInWithPassword timeout → sanitized ServiceUnavailableException, no provider detail in message', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const original = { ...process.env };
      Object.assign(process.env, {
        RECENT_AUTH_SECRET: VALID_SECRET,
        RECENT_AUTH_TTL_MS: '300000',
      });
      try {
        const { service } = makeService({
          prismaUser: baseUser,
          supaClientFactory: () => ({
            auth: {
              // Returns a promise that never resolves — triggers the 10s timer.
              signInWithPassword: jest.fn(() => new Promise(() => {})),
            },
          }),
        });
        const promise = service.issueRecentAuthToken('u-1', { password: 'pw' });
        // Surface any rejection so unhandled-rejection warnings don't pollute output.
        const settled = promise.catch((e) => e);
        // Let the prisma findUnique microtask resolve so we reach the
        // withAuthTimeout call and its setTimeout is armed.
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(11_000);
        const err = await settled;
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const msg = (err as Error).message ?? String(err);
        expect(msg).toBe('Authentication service temporarily unavailable');
        expect(msg).not.toContain('Supabase');
        expect(msg).not.toContain('AUTH_TIMEOUT');
        expect(msg).not.toContain('signInWithPassword');
        expect(msg).not.toContain('SUPABASE_URL');
        expect(msg).not.toContain('SUPABASE_ANON_KEY');
        expect(msg).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(msg).not.toContain('RECENT_AUTH_SECRET');
      } finally {
        process.env = original;
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('Apple signInWithIdToken timeout → sanitized ServiceUnavailableException', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const original = { ...process.env };
      Object.assign(process.env, {
        RECENT_AUTH_SECRET: VALID_SECRET,
        RECENT_AUTH_TTL_MS: '300000',
      });
      try {
        const freshIat = Math.floor(Date.now() / 1000) - 30;
        const { service } = makeService({
          prismaUser: baseUser,
          appleVerify: async () => ({
            iat: freshIat,
            sub: 'apple-sub',
            email: 'jane@example.test',
          }),
          supaClientFactory: () => ({
            auth: {
              // Hangs forever — the withAuthTimeout wrapper must fire.
              signInWithIdToken: jest.fn(() => new Promise(() => {})),
            },
          }),
        });
        const promise = service.issueRecentAuthToken('u-1', {
          provider_token: 'apple-id-token',
          provider: 'apple',
        });
        const settled = promise.catch((e) => e);
        // Let the prisma findUnique microtask resolve so we reach the
        // withAuthTimeout call and its setTimeout is armed.
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(11_000);
        const err = await settled;
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const msg = (err as Error).message ?? String(err);
        expect(msg).toBe('Authentication service temporarily unavailable');
        expect(msg).not.toContain('Supabase');
        expect(msg).not.toContain('AUTH_TIMEOUT');
        expect(msg).not.toContain('signInWithIdToken');
        expect(msg).not.toContain('signInWithPassword');
        expect(msg).not.toContain('SUPABASE_URL');
        expect(msg).not.toContain('SUPABASE_ANON_KEY');
        expect(msg).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      } finally {
        process.env = original;
      }
    } finally {
      jest.useRealTimers();
    }
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
