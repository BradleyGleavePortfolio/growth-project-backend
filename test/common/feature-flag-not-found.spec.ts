import type { Request, Response } from 'express';
import {
  featureFlagNotFoundMiddleware,
  FEATURE_GATED_ROUTES,
} from '../../src/common/feature-flag/feature-flag-not-found.middleware';

/**
 * R-DARK-1 generic middleware contract.
 *
 * These are unit tests over the middleware function itself. The bootstrap-
 * level 6-probe request suite (real guard chain, real HTTP, key-equality
 * against a truly unmounted route) lives in
 * feature-flag-not-found.bootstrap.spec.ts.
 */

function makeRes(): {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
} {
  const json = jest.fn();
  // mockReturnThis() makes `res.status(404)` return `res`, so the chained
  // `.status(404).json(...)` call in the middleware resolves against the mock.
  const status = jest.fn().mockReturnThis();
  const setHeader = jest.fn();
  // Response is assignable to Partial<Response>, so the `as Response` narrowing
  // assertion below is permitted (it is not one of the R75 banned cast forms).
  const partial: Partial<Response> = { status, json, setHeader };
  return { res: partial as Response, status, json, setHeader };
}

function makeReq(path: string, method = 'GET', headers: Record<string, string> = {}): Request {
  return { path, method, url: path, originalUrl: path, headers } as Request;
}

/** The exact key set HttpExceptionFilter emits for a 404 with a request id
 * present — round-2 shape-leak fix: the middleware must match it exactly. */
const FILTER_404_BODY = (method: string, url: string) => ({
  statusCode: 404,
  message: `Cannot ${method} ${url}`,
  error: 'Not Found',
  timestamp: expect.any(String),
  path: url,
  request_id: expect.any(String),
});

describe('featureFlagNotFoundMiddleware (R-DARK-1)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('exposes the scout + extension-pair gated route registry', () => {
    const envVars = FEATURE_GATED_ROUTES.map((r) => r.envVar);
    expect(envVars).toContain('FEATURE_SCOUT_INGEST');
    expect(envVars).toContain('FEATURE_EXTENSION_PAIRING');
  });

  it('returns a uniform 404 with the HttpExceptionFilter envelope when FEATURE_SCOUT_INGEST is unset', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    const { res, status, json } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout', 'GET'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(FILTER_404_BODY('GET', '/api/scout'));
    // No extra keys either — key equality, not just a superset.
    expect(Object.keys(json.mock.calls[0][0]).sort()).toEqual([
      'error',
      'message',
      'path',
      'request_id',
      'statusCode',
      'timestamp',
    ]);
  });

  it('honours an upstream X-Request-ID and mirrors it in header + body', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    const { res, json, setHeader } = makeRes();

    featureFlagNotFoundMiddleware(
      makeReq('/api/scout', 'GET', { 'x-request-id': 'edge-abc-123' }),
      res,
      jest.fn(),
    );

    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', 'edge-abc-123');
    expect(json.mock.calls[0][0].request_id).toBe('edge-abc-123');
  });

  it('echoes Access-Control-Allow-Origin for an allow-listed Origin (gate runs before cors)', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    process.env.CORS_ORIGINS = 'https://console.example.test';
    delete process.env.STOREFRONT_BASE_URL;
    const { res, setHeader } = makeRes();

    featureFlagNotFoundMiddleware(
      makeReq('/api/scout', 'GET', { origin: 'https://console.example.test' }),
      res,
      jest.fn(),
    );

    expect(setHeader).toHaveBeenCalledWith('Vary', 'Origin');
    expect(setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://console.example.test',
    );
    expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
  });

  it('does NOT echo Access-Control-Allow-Origin for a non-allow-listed Origin', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    process.env.CORS_ORIGINS = 'https://console.example.test';
    delete process.env.STOREFRONT_BASE_URL;
    const { res, setHeader } = makeRes();

    featureFlagNotFoundMiddleware(
      makeReq('/api/scout', 'GET', { origin: 'https://evil.example.test' }),
      res,
      jest.fn(),
    );

    const acao = setHeader.mock.calls.filter(
      (c: unknown[]) => c[0] === 'Access-Control-Allow-Origin',
    );
    expect(acao).toHaveLength(0);
  });

  it('returns 404 for OPTIONS (preflight) on a gated path when the flag is off', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/ingest', 'OPTIONS'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('runs before the guard chain — short-circuits a gated subpath without invoking next()', () => {
    process.env.FEATURE_SCOUT_INGEST = 'false';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/ingest', 'POST'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    // next() is what hands control to the Nest guard chain. Not calling it
    // proves the gate precedes JwtAuthGuard/RolesGuard, so no 401/403 leaks.
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 for /api/extension/pair routes when FEATURE_EXTENSION_PAIRING is unset', () => {
    delete process.env.FEATURE_EXTENSION_PAIRING;
    const { res, status, json } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/extension/pair/init', 'POST'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(FILTER_404_BODY('POST', '/api/extension/pair/init'));
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and does not short-circuit when the flag env is exactly "true"', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout', 'GET'), res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('treats any non-"true" value (e.g. "1", "TRUE") as OFF and returns 404', () => {
    process.env.FEATURE_SCOUT_INGEST = 'TRUE';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout', 'GET'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a non-gated path regardless of flag state', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    delete process.env.FEATURE_EXTENSION_PAIRING;
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/health', 'GET'), res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not match a path that only shares a prefix token (/api/scoutish)', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scoutish', 'GET'), res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
