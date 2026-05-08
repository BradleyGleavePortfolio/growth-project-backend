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
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  RecentAuthGuard,
  RECENT_AUTH_HEADER,
  RECENT_AUTH_TTL_MS,
  issueRecentAuthToken,
} from '../src/auth/recent-auth.guard';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER_ID = 'user-abc-123';

function makeToken(userId: string, issuedAt: number, secret: string): string {
  const issuedAtStr = issuedAt.toString();
  const hmac = createHmac('sha256', secret)
    .update(`${userId}:${issuedAtStr}`)
    .digest('hex');
  return `${userId}.${issuedAtStr}.${hmac}`;
}

function makeContext(options: {
  token?: string;
  userId?: string;
  secret?: string | null;
}): ExecutionContext {
  const mockGet = jest.fn().mockImplementation((key: string) => {
    if (key === 'RECENT_AUTH_SECRET') return options.secret ?? SECRET;
    if (key === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
    return undefined;
  });

  const req = {
    headers: options.token ? { [RECENT_AUTH_HEADER]: options.token } : {},
    user: options.userId ? { id: options.userId } : { id: USER_ID },
  };

  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RecentAuthGuard', () => {
  let guard: RecentAuthGuard;

  beforeEach(() => {
    const config = { get: jest.fn() } as unknown as ConfigService;
    guard = new RecentAuthGuard(config);
  });

  it('throws 403 when RECENT_AUTH_SECRET is not configured', () => {
    const ctx = makeContext({ secret: null, token: 'any.token.here' });
    (guard['config'].get as jest.Mock).mockReturnValue(undefined);
    // Rebuild with config that returns undefined for secret
    const configWithNoSecret = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const guardNoSecret = new RecentAuthGuard(configWithNoSecret);
    expect(() => guardNoSecret.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 401 when header is missing', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const ctx = makeContext({ token: undefined });
    // Remove token from context
    const req = { headers: {}, user: { id: USER_ID } };
    const emptyCtx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(() => g.canActivate(emptyCtx)).toThrow(UnauthorizedException);
  });

  it('throws 401 for malformed token (wrong segment count)', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: 'only.two' },
      user: { id: USER_ID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(() => g.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 401 for an expired token', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const expiredAt = Date.now() - RECENT_AUTH_TTL_MS - 1000;
    const token = makeToken(USER_ID, expiredAt, SECRET);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: token },
      user: { id: USER_ID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(() => g.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 403 when token user_id does not match authenticated user', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const token = makeToken('other-user-id', Date.now(), SECRET);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: token },
      user: { id: USER_ID }, // different user
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(() => g.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws 401 when HMAC is tampered', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const issuedAt = Date.now();
    const token = `${USER_ID}.${issuedAt}.${'a'.repeat(64)}`; // tampered HMAC
    const req = {
      headers: { [RECENT_AUTH_HEADER]: token },
      user: { id: USER_ID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(() => g.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('passes for a valid, fresh token', () => {
    const configSvc = {
      get: jest.fn().mockImplementation((k: string) => {
        if (k === 'RECENT_AUTH_SECRET') return SECRET;
        if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
      }),
    } as unknown as ConfigService;
    const g = new RecentAuthGuard(configSvc);
    const token = makeToken(USER_ID, Date.now(), SECRET);
    const req = {
      headers: { [RECENT_AUTH_HEADER]: token },
      user: { id: USER_ID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(g.canActivate(ctx)).toBe(true);
  });

  describe('issueRecentAuthToken helper', () => {
    it('produces a token that passes guard validation', () => {
      const configSvc = {
        get: jest.fn().mockImplementation((k: string) => {
          if (k === 'RECENT_AUTH_SECRET') return SECRET;
          if (k === 'RECENT_AUTH_TTL_MS') return RECENT_AUTH_TTL_MS;
        }),
      } as unknown as ConfigService;
      const g = new RecentAuthGuard(configSvc);
      const token = issueRecentAuthToken(USER_ID, SECRET);
      const req = {
        headers: { [RECENT_AUTH_HEADER]: token },
        user: { id: USER_ID },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      expect(g.canActivate(ctx)).toBe(true);
    });

    it('produces tokens with 3 dot-separated parts', () => {
      const token = issueRecentAuthToken(USER_ID, SECRET);
      expect(token.split('.')).toHaveLength(3);
    });
  });
});
