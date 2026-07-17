import type { Request, Response, NextFunction } from 'express';
import { buildNotFoundEnvelope } from '../../filters/not-found-envelope';
import { resolveRequestId } from '../../observability/request-id.middleware';
import { computeCorsAllowedOrigin } from '../cors-origins';

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
  // IMPORTER-F reconstruct — a second, more-specific gate layered under
  // /api/scout. Because the registry is evaluated for EVERY matching pattern,
  // POST /api/scout/reconstruct is dark unless BOTH FEATURE_SCOUT_INGEST and
  // FEATURE_SCOUT_RECONSTRUCT are literally 'true'. Reconstruction is a strict
  // downstream of ingest, so this coupling is intentional.
  { pattern: '/api/scout/reconstruct', envVar: 'FEATURE_SCOUT_RECONSTRUCT' },
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
        // Round-2 hardening: mirror HttpExceptionFilter's normalized 404 for
        // an unmounted route (shared builder — see not-found-envelope.ts),
        // including the X-Request-ID header + request_id field that
        // RequestIdMiddleware would have added had the request reached the
        // Nest stack. Same id-resolution logic (resolveRequestId), so the
        // dark 404 is key-for-key identical to a real unmounted 404.
        const requestId = resolveRequestId(req.headers['x-request-id']);
        res.setHeader('X-Request-ID', requestId);
        // This gate now runs BEFORE enableCors (so OPTIONS preflight on a
        // dark route 404s instead of being answered 204 by the cors
        // package). Echo the allow-list origin — same origin math as
        // enableCors via computeCorsAllowedOrigin — so an allow-listed
        // browser client can read the 404 body.
        res.setHeader('Vary', 'Origin');
        const allowOrigin = computeCorsAllowedOrigin(req);
        if (allowOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowOrigin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        res.status(404).json(buildNotFoundEnvelope(req, requestId));
        return;
      }
    }
  }
  next();
}
