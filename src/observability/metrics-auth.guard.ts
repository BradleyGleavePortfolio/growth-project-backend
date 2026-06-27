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

/**
 * Maximum accepted length of the `Authorization` header value, in bytes.
 * Anything longer is rejected outright before any parsing. The 4096-byte cap
 * follows the OWASP guidance for HTTP header parsing and ensures the bounded
 * string scan below cannot be driven to pathological cost by an attacker.
 */
const MAX_AUTHORIZATION_HEADER_LENGTH = 4096;

const BEARER_PREFIX = 'bearer ';

/**
 * Pull the raw token out of an `Authorization: Bearer <token>` header.
 *
 * Parsing is deliberately performed with bounded, non-backtracking string
 * operations (a length cap, a fixed-length prefix check, and `trim`) rather
 * than a regular expression, so an attacker-controlled header on the
 * pre-auth metrics endpoints cannot trigger polynomial backtracking.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return undefined;
  }
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return undefined;
  }
  const token = trimmed.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? undefined : token;
}

/**
 * Length-aware constant-time string comparison. Returns false fast on length
 * mismatch (length is not secret here) and otherwise XOR-accumulates every
 * character so the loop duration does not depend on where the first
 * difference occurs.
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
