import type { Request, Response } from 'express';
import {
  featureFlagNotFoundMiddleware,
  FEATURE_GATED_ROUTES,
} from '../../src/common/feature-flag/feature-flag-not-found.middleware';

/**
 * R-DARK-1 generic middleware contract.
 *
 * These are unit tests over the middleware function itself — the concrete
 * per-feature 6-probe request tests (no-auth / non-coach / coach × flag on/off)
 * land with the downstream PRs that actually mount /api/scout and
 * /api/extension/pair routes; those routes do not exist on `main`, so a full
 * supertest bootstrap here would assert nothing beyond this function's behavior.
 */

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  // mockReturnThis() makes `res.status(404)` return `res`, so the chained
  // `.status(404).json(...)` call in the middleware resolves against the mock.
  const status = jest.fn().mockReturnThis();
  // Response is assignable to Partial<Response>, so the `as Response` narrowing
  // assertion below is permitted (it is not one of the R75 banned cast forms).
  const partial: Partial<Response> = { status, json };
  return { res: partial as Response, status, json };
}

function makeReq(path: string, method = 'GET', originalUrl = path): Request {
  return { path, method, originalUrl } as Request;
}

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

  it('returns a uniform 404 with the Nest not-found body shape when FEATURE_SCOUT_INGEST is unset', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    const { res, status, json } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout', 'GET'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Cannot GET /api/scout',
      error: 'Not Found',
    });
  });

  it('runs before the guard chain — short-circuits a gated subpath without invoking next()', () => {
    process.env.FEATURE_SCOUT_INGEST = 'false';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(
      makeReq('/api/scout/ingest', 'POST', '/api/scout/ingest'),
      res,
      next,
    );

    expect(status).toHaveBeenCalledWith(404);
    // next() is what hands control to the Nest guard chain. Not calling it
    // proves the gate precedes JwtAuthGuard/RolesGuard, so no 401/403 leaks.
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 for /api/extension/pair routes when FEATURE_EXTENSION_PAIRING is unset', () => {
    delete process.env.FEATURE_EXTENSION_PAIRING;
    const { res, status, json } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(
      makeReq('/api/extension/pair/init', 'POST', '/api/extension/pair/init'),
      res,
      next,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Cannot POST /api/extension/pair/init',
      error: 'Not Found',
    });
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
