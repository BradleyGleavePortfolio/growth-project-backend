/**
 * MetricsAuthGuard tests.
 *
 * Covers:
 *  1. constantTimeEquals — equal strings
 *  2. constantTimeEquals — different content same length
 *  3. constantTimeEquals — different length
 *  4. extractBearerToken — valid Bearer header
 *  5. extractBearerToken — case-insensitive scheme
 *  6. extractBearerToken — array header (takes first)
 *  7. extractBearerToken — missing / malformed header
 *  8. guard allows when token matches
 *  9. guard rejects (401) on token mismatch
 * 10. guard rejects (401) when header absent but token configured
 * 11. guard returns 503 in prod when token unset (fail closed)
 * 12. guard allows in dev when token unset
 */

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import {
  constantTimeEquals,
  extractBearerToken,
  MetricsAuthGuard,
} from '../../src/observability/metrics-auth.guard';

function ctxWithAuth(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authHeader ? { authorization: authHeader } : {} }),
    }),
  } as unknown as ExecutionContext;
}

describe('constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEquals('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });
  it('returns false for same-length but different content', () => {
    expect(constantTimeEquals('aaaaaa', 'aaaaab')).toBe(false);
  });
  it('returns false for different lengths', () => {
    expect(constantTimeEquals('short', 'longer-value')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a valid Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });
  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });
  it('takes the first value when the header is an array', () => {
    expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });
  it('returns undefined for missing or malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
  });
});

describe('MetricsAuthGuard', () => {
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

  it('allows access when the bearer token matches', () => {
    process.env.METRICS_AUTH_TOKEN = 'super-secret';
    expect(guard.canActivate(ctxWithAuth('Bearer super-secret'))).toBe(true);
  });

  it('rejects with 401 when the token does not match', () => {
    process.env.METRICS_AUTH_TOKEN = 'super-secret';
    expect(() => guard.canActivate(ctxWithAuth('Bearer wrong'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects with 401 when no Authorization header is present but a token is configured', () => {
    process.env.METRICS_AUTH_TOKEN = 'super-secret';
    expect(() => guard.canActivate(ctxWithAuth())).toThrow(UnauthorizedException);
  });

  it('fails closed with 503 in a prod-like env when the token is unset', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    expect(() => guard.canActivate(ctxWithAuth())).toThrow(ServiceUnavailableException);
  });

  it('allows access in development when the token is unset', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'development';
    expect(guard.canActivate(ctxWithAuth())).toBe(true);
  });
});
