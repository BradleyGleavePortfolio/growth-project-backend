import type { Request, Response } from 'express';
import {
  featureFlagNotFoundMiddleware,
  FEATURE_GATED_ROUTES,
} from '../../../src/common/feature-flag/feature-flag-not-found.middleware';

/**
 * R-DARK-1 for the IMPORTER-F reconstruct route.
 *
 * POST /api/scout/reconstruct is layered under /api/scout, so it is gated by a
 * MORE-specific registry entry (FEATURE_SCOUT_RECONSTRUCT) in ADDITION to the
 * broad /api/scout ingest gate. The route is live only when BOTH flags are
 * exactly "true"; otherwise it is a uniform 404, indistinguishable from an
 * unmounted route, before any guard runs.
 */

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  const setHeader = jest.fn();
  const partial: Partial<Response> = { status, json, setHeader };
  return { res: partial as Response, status, json };
}

function makeReq(path: string, method = 'POST'): Request {
  return { path, method, url: path, originalUrl: path, headers: {} } as Request;
}

describe('featureFlagNotFoundMiddleware — /api/scout/reconstruct (IMPORTER-F)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('registers the reconstruct gate with its own env var', () => {
    const entry = FEATURE_GATED_ROUTES.find((r) => r.pattern === '/api/scout/reconstruct');
    expect(entry?.envVar).toBe('FEATURE_SCOUT_RECONSTRUCT');
  });

  it('404s when FEATURE_SCOUT_RECONSTRUCT is off even if FEATURE_SCOUT_INGEST is on', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    delete process.env.FEATURE_SCOUT_RECONSTRUCT;
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/reconstruct'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('stays dark when FEATURE_SCOUT_INGEST is off regardless of the reconstruct flag', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'true';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/reconstruct'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats any non-"true" reconstruct value as OFF', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'TRUE';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/reconstruct'), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through only when BOTH flags are exactly "true"', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'true';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq('/api/scout/reconstruct'), res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
