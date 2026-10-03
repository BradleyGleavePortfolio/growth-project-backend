/**
 * A Google-only account can delete itself (operator note from the Opus #642
 * audit: production main answers 400 to provider=google_session until #608
 * ships). This suite runs the whole re-auth chain on #608's code:
 *
 *   1. POST /auth/recent-auth-token with { provider: 'google_session',
 *      provider_token } passes the production ValidationPipe
 *      (whitelist + forbidNonWhitelisted + transform), so no 400;
 *   2. AuthService.issueRecentAuthToken accepts a Supabase session whose amr
 *      records a Google OAuth sign-in moments ago and mints a re-auth token;
 *   3. the real RecentAuthGuard on POST /me/delete-account accepts that
 *      token for the same user, refuses it for anyone else and refuses a replay;
 *   4. the delete-account route is guarded by RecentAuthGuard.
 */
import {
  ArgumentMetadata,
  ExecutionContext,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthService } from '../src/auth/auth.service';
import { IssueRecentAuthTokenDto } from '../src/auth/auth.dto';
import { RECENT_AUTH_HEADER, RecentAuthGuard } from '../src/auth/recent-auth.guard';
import { AccountDeletionController } from '../src/account-deletion/account-deletion.controller';
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
const user = { id: 'u-google', email: 'g@example.test', supabase_id: 'sup-g', role: 'student' };

function sessionToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'ES256', typ: 'JWT' })}.${enc({
    iss: 'https://abc.supabase.co/auth/v1',
    aud: 'authenticated',
    sub: 'sup-g',
    ...claims,
  })}.sig`;
}

function authService() {
  const service = new AuthService(
    stub<PrismaService>({ user: { findUnique: jest.fn(async () => user) } }),
    stub<InviteCodesService>({}),
    stub<AnalyticsService>({ capture: jest.fn() }),
    stub<AuditService>({ write: jest.fn() }),
    stub<AppleVerifierService>({ verify: jest.fn(), isConfigured: () => true }),
    stub<GoogleVerifierService>({ verify: jest.fn(), isConfigured: () => false }),
  );
  const getUser = jest.fn(async () => ({
    data: {
      user: {
        id: 'sup-g',
        // Google-only: no email/password identity.
        app_metadata: { provider: 'google', providers: ['google'] },
      },
    },
    error: null,
  }));
  Object.assign(service, { supabaseAdmin: { auth: { getUser } } });
  return service;
}

function guard() {
  const nonces = new Set<string>();
  const prisma = stub<PrismaService>({
    recentAuthNonce: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const key = JSON.stringify(args.data);
        if (nonces.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        nonces.add(key);
        return { id: 'n' };
      }),
    },
  });
  const config = stub<ConfigService>({
    get: (k: string) =>
      k === 'RECENT_AUTH_SECRET' ? SECRET : k === 'RECENT_AUTH_TTL_MS' ? 300_000 : undefined,
  });
  return new RecentAuthGuard(config, prisma);
}

function deletionCtx(token: string, userId: string): ExecutionContext {
  const req = { headers: { [RECENT_AUTH_HEADER]: token }, user: { id: userId } };
  return stub<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => req }) });
}

const prev = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { RECENT_AUTH_SECRET: SECRET, RECENT_AUTH_TTL_MS: '300000' });
});
afterEach(() => {
  process.env = { ...prev };
});

describe('Google-only account deletion re-auth (google_session)', () => {
  it('the production ValidationPipe accepts the google_session body (no 400)', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const meta: ArgumentMetadata = { type: 'body', metatype: IssueRecentAuthTokenDto };
    const body = await pipe.transform(
      { provider: 'google_session', provider_token: sessionToken({ amr: [] }) },
      meta,
    );
    expect(body).toBeInstanceOf(IssueRecentAuthTokenDto);
    expect(body.provider).toBe('google_session');
  });

  it('a fresh Google sign-in session mints a token the delete-account guard accepts once, for that user only', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token } = await authService().issueRecentAuthToken(user.id, {
      provider: 'google_session',
      provider_token: sessionToken({ amr: [{ method: 'oauth', timestamp: now - 15 }] }),
    });
    const g = guard();
    await expect(g.canActivate(deletionCtx(token, 'someone-else'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(g.canActivate(deletionCtx(token, user.id))).resolves.toBe(true);
    // Single use: the same token cannot authorise a second destructive call.
    await expect(g.canActivate(deletionCtx(token, user.id))).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'RECENT_AUTH_TOKEN_ALREADY_USED' }),
    });
  });

  it('POST /me/delete-account is the route guarded by RecentAuthGuard', () => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, AccountDeletionController.prototype.requestDeletion) ??
      [];
    expect(guards).toContain(RecentAuthGuard);
  });
});
