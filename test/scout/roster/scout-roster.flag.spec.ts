import type { Request, Response } from 'express';
import { featureFlagNotFoundMiddleware } from '../../../src/common/feature-flag/feature-flag-not-found.middleware';

/**
 * R-DARK-1 for the IMPORTER-G roster read route.
 *
 * GET /api/scout/reconstruct/roster is a SUBPATH of /api/scout/reconstruct, so
 * it inherits BOTH the broad /api/scout gate (FEATURE_SCOUT_INGEST) and the
 * more-specific /api/scout/reconstruct gate (FEATURE_SCOUT_RECONSTRUCT) with no
 * middleware change. The route is live only when BOTH flags are exactly "true";
 * otherwise it is a uniform 404 before any guard runs. This is the intended
 * coupling: the read can never be exposed more broadly than the write it reads.
 */

const ROSTER_PATH = '/api/scout/reconstruct/roster';

function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnThis();
  const setHeader = jest.fn();
  const partial: Partial<Response> = { status, json, setHeader };
  return { res: partial as Response, status, json };
}

function makeReq(path: string): Request {
  return { path, method: 'GET', url: path, originalUrl: path, headers: {} } as Request;
}

describe('featureFlagNotFoundMiddleware — /api/scout/reconstruct/roster (IMPORTER-G)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('404s when FEATURE_SCOUT_RECONSTRUCT is off even if FEATURE_SCOUT_INGEST is on', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    delete process.env.FEATURE_SCOUT_RECONSTRUCT;
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq(ROSTER_PATH), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('stays dark when FEATURE_SCOUT_INGEST is off regardless of the reconstruct flag', () => {
    delete process.env.FEATURE_SCOUT_INGEST;
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'true';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq(ROSTER_PATH), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats any non-"true" reconstruct value as OFF', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'TRUE';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq(ROSTER_PATH), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through only when BOTH flags are exactly "true"', () => {
    process.env.FEATURE_SCOUT_INGEST = 'true';
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'true';
    const { res, status } = makeRes();
    const next = jest.fn();

    featureFlagNotFoundMiddleware(makeReq(ROSTER_PATH), res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
