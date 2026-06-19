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

/** Pull the raw token out of an `Authorization: Bearer <token>` header. */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : undefined;
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
