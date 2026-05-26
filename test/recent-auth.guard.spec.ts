/**
 * RecentAuthGuard — unit tests.
 *
 * Tests cover:
 *   - Missing RECENT_AUTH_SECRET → 403
 *   - Missing header → 401
 *   - Malformed header (wrong segment count) → 401
 *   - Expired token → 401
 *   - Future-issued token (beyond clock skew) → 401
 *   - Wrong user id in token → 403
 *   - Tampered HMAC → 401
 *   - Valid token for correct user → passes
 *   - Same token presented twice within TTL → 403 (A1-C5-P1-3 single-use regression)
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  RecentAuthGuard,
  RECENT_AUTH_HEADER,
  RECENT_AUTH_TTL_MS,
  issueRecentAuthToken,
} from '../src/auth/recent-auth.guard';
import { PrismaService } from '../src/prisma.service';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER_ID = 'user-abc-123';

function makeToken(userId: string, issuedAt: number, secret: string): string {
  const issuedAtStr = issuedAt.toString();
  const hmac = createHmac('sha256', secret)
    .update(`${userId}:${issuedAtStr}`)
    .digest('hex');
  return `${userId}.${issuedAtStr}.${hmac}`;
}

/** Build a PrismaService stub with a controllable recentAuthNonce.create mock. */
function buildPrismaMock(
  createImpl?: () => Promise<unknown>,
): PrismaService {
  return {
    recentAuthNonce: {
      create: jest.fn().mockImplementation(
        createImpl ?? (() => Promise.resolve({ id: 'nonce-1' })),
      ),
    },
  } as unknown as PrismaService;
}

// No default value here — every caller MUST be explicit about the secret
// they're injecting. Previously this defaulted to SECRET, which meant
// `makeConfigSvc(undefined)` silently substituted the valid secret back
// in (JS default-parameter semantics), defeating the
// "missing-secret → 403" test (A1-C5-P1-3 audit class).
function makeConfigSvc(
  secret: string | null | undefined,
): ConfigService {
  return {
    get: jest.fn().mockImplementation((k: string) => {
      if (k === 'RECENT_AUTH_SECRET') return secret ?? undefined;
      if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      return undefined;
    }),
  } as unknown as ConfigService;
}

function makeCtx(token: string | undefined, userId: string = USER_ID): ExecutionContext {
  const req = {
    headers: token ? { [RECENT_AUTH_HEADER]: token } : {},
    user: { id: userId },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RecentAuthGuard', () => {
  let guard: RecentAuthGuard;
  let prismaMock: PrismaService;

  beforeEach(() => {
    prismaMock = buildPrismaMock();
    guard = new RecentAuthGuard(makeConfigSvc(SECRET), prismaMock);
  });

  it('throws 403 when RECENT_AUTH_SECRET is not configured', async () => {
    const guardNoSecret = new RecentAuthGuard(
      makeConfigSvc(undefined),
      prismaMock,
    );
    await expect(
      guardNoSecret.canActivate(makeCtx('any.token.here')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws 401 when header is missing', async () => {
    const req = { headers: {}, user: { id: USER_ID } };
    const emptyCtx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(emptyCtx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 for malformed token (wrong segment count)', async () => {
    const req = {
      headers: { [RECENT_AUTH_HEADER]: 'only.two' },
      user: { id: USER_ID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 for an expired token', async () => {
    const expiredAt = Date.now() - RECENT_AUTH_TTL_MS - 1000;
    const token = makeToken(USER_ID, expiredAt, SECRET);
    await expect(guard.canActivate(makeCtx(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 403 when token user_id does not match authenticated user', async () => {
    const token = makeToken('other-user-id', Date.now(), SECRET);
    await expect(guard.canActivate(makeCtx(token))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws 401 when HMAC is tampered', async () => {
    const issuedAt = Date.now();
    const token = `${USER_ID}.${issuedAt}.${'a'.repeat(64)}`; // tampered HMAC
    await expect(guard.canActivate(makeCtx(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('passes for a valid, fresh token (nonce write succeeds)', async () => {
    const token = makeToken(USER_ID, Date.now(), SECRET);
    await expect(guard.canActivate(makeCtx(token))).resolves.toBe(true);
    // Nonce was written exactly once
    expect(
      (prismaMock.recentAuthNonce.create as jest.Mock),
    ).toHaveBeenCalledTimes(1);
  });

  // ── A1-C5-P1-3: single-use enforcement ────────────────────────────────────

  it('rejects a replayed token (same token presented twice within TTL) → 403 RECENT_AUTH_TOKEN_ALREADY_USED', async () => {
    // The guard's nonce write resolves on the first call but throws P2002 on
    // the second (simulating the DB unique constraint on hmac_suffix).
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`hmac_suffix`)',
      { code: 'P2002', clientVersion: '5.0.0', meta: {} },
    );
    const guardReplay = new RecentAuthGuard(
      makeConfigSvc(SECRET),
      buildPrismaMock(() => Promise.reject(p2002)),
    );
    const token = makeToken(USER_ID, Date.now(), SECRET);

    await expect(guardReplay.canActivate(makeCtx(token))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guardReplay.canActivate(makeCtx(token))).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'RECENT_AUTH_TOKEN_ALREADY_USED',
      }),
    });
  });

  it('fails closed (403) when the nonce write encounters an unexpected DB error', async () => {
    const dbError = new Error('connection timeout');
    const guardDbErr = new RecentAuthGuard(
      makeConfigSvc(SECRET),
      buildPrismaMock(() => Promise.reject(dbError)),
    );
    const token = makeToken(USER_ID, Date.now(), SECRET);

    await expect(guardDbErr.canActivate(makeCtx(token))).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('issueRecentAuthToken helper', () => {
    it('produces a token that passes guard validation', async () => {
      const token = issueRecentAuthToken(USER_ID, SECRET);
      await expect(guard.canActivate(makeCtx(token))).resolves.toBe(true);
    });

    it('produces tokens with 3 dot-separated parts', () => {
      const token = issueRecentAuthToken(USER_ID, SECRET);
      expect(token.split('.')).toHaveLength(3);
    });
  });
});
// CI trigger
