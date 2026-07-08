import type { Request, Response, NextFunction } from 'express';

/**
 * Registry of feature-gated route patterns. Each entry: { pattern, envVar }.
 * pattern matches against req.path (no query string) with a leading '/api' prefix.
 * Matching is prefix-based; the surface is dark for every method and every
 * subpath under the pattern when the env var is not literally "true".
 *
 * R-DARK-1: this runs BEFORE any guard so an unauth/wrong-role caller
 * cannot distinguish "flag off" from "route does not exist."
 */
export interface FeatureGatedRoute {
  readonly pattern: string; // e.g. '/api/scout' — matches /api/scout and /api/scout/*
  readonly envVar: string; // e.g. 'FEATURE_SCOUT_INGEST'
}

export const FEATURE_GATED_ROUTES: readonly FeatureGatedRoute[] = [
  // Scout ingest, progress, ingest/complete — one flag, all routes under /api/scout
  { pattern: '/api/scout', envVar: 'FEATURE_SCOUT_INGEST' },
  // Extension pair — init/status/redeem
  { pattern: '/api/extension/pair', envVar: 'FEATURE_EXTENSION_PAIRING' },
];

export function featureFlagNotFoundMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const path = req.path;
  for (const route of FEATURE_GATED_ROUTES) {
    if (path === route.pattern || path.startsWith(route.pattern + '/')) {
      // Read env at request time (not cached) so ops can toggle without redeploy.
      if (process.env[route.envVar] !== 'true') {
        // Mirror Nest's default NotFoundException body for an unmounted route
        // ("Cannot <METHOD> <url>") so a disabled route is byte-for-byte
        // indistinguishable from an unregistered path.
        res.status(404).json({
          statusCode: 404,
          message: 'Cannot ' + req.method + ' ' + req.originalUrl,
          error: 'Not Found',
        });
        return;
      }
    }
  }
  next();
}
