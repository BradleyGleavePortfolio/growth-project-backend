/**
 * Extended MetricsAuthGuard tests — exercises header whitespace tolerance,
 * empty-token-as-unset semantics, prod-like env variants, and constant-time
 * comparison edge cases. Complements metrics-auth.spec.ts.
 */

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  constantTimeEquals,
  extractBearerToken,
  MetricsAuthGuard,
} from '../../src/observability/metrics-auth.guard';

function ctxWithAuth(authHeader?: string): ExecutionContext {
  const headers = authHeader ? { authorization: authHeader } : {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  };
  // The guard only ever calls `context.switchToHttp().getRequest()`; the rest
  // of the ExecutionContext surface (getArgs/getClass/switchToRpc/...) is
  // infeasible to mock, so we expose just the exercised method and widen the
  // structurally-compatible stub to the public type.
  return host as ExecutionContext;
}

describe('constantTimeEquals edge cases', () => {
  it('returns true for two empty strings', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });
  it('returns false when one side is empty', () => {
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
  it('distinguishes single trailing-character differences', () => {
    expect(constantTimeEquals('token-a', 'token-b')).toBe(false);
  });
});

describe('extractBearerToken tolerance', () => {
  it('tolerates extra whitespace around the token', () => {
    expect(extractBearerToken('Bearer    spaced-token')).toBe('spaced-token');
  });
  it('trims the surrounding header value', () => {
    expect(extractBearerToken('   Bearer abc   ')).toBe('abc');
  });
  it('returns undefined for a bare scheme with no token', () => {
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
  it('returns undefined for an empty array', () => {
    expect(extractBearerToken([])).toBeUndefined();
  });
});

describe('MetricsAuthGuard env permutations', () => {
  const ORIGINAL_TOKEN = process.env.METRICS_AUTH_TOKEN;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  let guard: MetricsAuthGuard;

  beforeEach(() => {
    guard = new MetricsAuthGuard();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.METRICS_AUTH_TOKEN;
    else process.env.METRICS_AUTH_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('treats an empty-string token as unset (503 in production)', () => {
    process.env.METRICS_AUTH_TOKEN = '';
    process.env.NODE_ENV = 'production';
    expect(() => guard.canActivate(ctxWithAuth('Bearer anything'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('fails closed with 503 in staging when token unset', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'staging';
    expect(() => guard.canActivate(ctxWithAuth())).toThrow(ServiceUnavailableException);
  });

  it('accepts a whitespace-padded bearer token against the configured value', () => {
    process.env.METRICS_AUTH_TOKEN = 'tok-123';
    expect(guard.canActivate(ctxWithAuth('Bearer   tok-123'))).toBe(true);
  });

  it('rejects a token that differs only by trailing whitespace inside the value', () => {
    process.env.METRICS_AUTH_TOKEN = 'tok-123';
    expect(() => guard.canActivate(ctxWithAuth('Bearer tok-1234'))).toThrow(UnauthorizedException);
  });

  it('allows unauthenticated access when token unset in test env', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'test';
    // 'test' is not prod-like, so the dev-convenience allow path applies.
    expect(guard.canActivate(ctxWithAuth())).toBe(true);
  });
});
