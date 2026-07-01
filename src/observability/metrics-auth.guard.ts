import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { isProdLike } from '../common/env-validation';

/**
 * MetricsAuthGuard — bearer-token gate (default-deny) for the privileged
 * observability endpoints (`/metrics/prom`, `/admin/db-stats`).
 *
 *   - METRICS_AUTH_TOKEN set   → require matching `Authorization: Bearer`; else 401.
 *   - unset in a prod-like env → 503 (fail closed) so a misconfigured deploy
 *                                never exposes runtime internals.
 *   - unset in development     → allow, for local scraping.
 *
 * The token is compared in constant time to avoid leaking it via response timing.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const configured = process.env.METRICS_AUTH_TOKEN;

    if (!configured || configured.length === 0) {
      if (isProdLike(process.env.NODE_ENV)) {
        throw new ServiceUnavailableException(
          'Metrics endpoint is not configured: set METRICS_AUTH_TOKEN to enable scraping.',
        );
      }
      // Development convenience: allow unauthenticated access locally.
      return true;
    }

    const presented = extractBearerToken(req.headers['authorization']);
    if (!presented || !constantTimeEquals(presented, configured)) {
      throw new UnauthorizedException('Invalid or missing metrics bearer token.');
    }
    return true;
  }
}

/** Max accepted `Authorization` length (OWASP header-parsing cap); longer
 * values are rejected before any scan so the parser can't be driven to
 * pathological cost. */
const MAX_AUTHORIZATION_HEADER_LENGTH = 4096;

const BEARER_PREFIX = 'bearer ';

/**
 * Pull the token out of an `Authorization: Bearer <token>` header using bounded,
 * non-backtracking string ops (length cap + prefix check + trim, no regex) so an
 * attacker-controlled pre-auth header can't trigger polynomial backtracking.
 */
export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  // Cap on RAW length BEFORE any scan (trim() walks the whole string), so a huge
  // whitespace-prefixed header is rejected without being fully scanned first.
  if (value.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return undefined;
  }
  const token = trimmed.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? undefined : token;
}

/**
 * Constant-time string compare. Fast-fails on length mismatch (length is not
 * secret here); otherwise XOR-accumulates every char so loop duration is
 * independent of where the first difference occurs.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
