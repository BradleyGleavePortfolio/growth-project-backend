import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { AppLoggerService } from './app-logger.service';

/**
 * RequestIdMiddleware — assigns a unique X-Request-ID to every request.
 *
 * WHY: support engineers need to correlate log lines, Sentry events, and
 * Prometheus metrics for the same user request.  Without a request-scoped
 * identifier, two simultaneous requests from the same user produce
 * interleaved log lines that are impossible to untangle.
 *
 * CONTRACT:
 *  - If the incoming request already carries an `X-Request-ID` header (e.g.
 *    from a reverse proxy, Fly's edge, or a retry from the mobile client),
 *    that value is honoured — stripped to 128 chars and URI-component-decoded
 *    to prevent log injection.
 *  - If no header is present, a new 16-byte hex ID is generated.
 *  - The resolved ID is attached to:
 *      1. `req.requestId`       (available to NestJS interceptors / guards)
 *      2. `AppLoggerService.requestId`  (thread-local surrogate; safe because
 *         Node.js is single-threaded — the field is overwritten for every
 *         incoming request before any controller logic runs)
 *      3. `res.setHeader('X-Request-ID', id)` so clients can correlate their
 *         own logs against server logs
 *
 * ORDERING: this middleware must run BEFORE any auth guard or audit
 * interceptor.  It is registered first inside ObservabilityModule and the
 * module itself is the FIRST import in AppModule.  This ensures the request_id
 * is present on every log line, including auth failures.
 */
/**
 * Resolve the request id from an incoming `X-Request-ID` header value:
 * honour an upstream proxy's ID (Fly edge, mobile retry, load balancer),
 * sanitised to alphanumeric + hyphens to prevent header/log injection, or
 * generate a fresh 16-byte hex ID. Exported so the R-DARK-1 feature-flag
 * 404 middleware — which runs BEFORE this Nest-consumer middleware — can
 * derive the identical id for its short-circuited responses.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  return raw
    ? String(raw)
        .replace(/[^a-zA-Z0-9\-_]/g, '')
        .slice(0, 128)
    : randomBytes(16).toString('hex');
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
    const id = resolveRequestId(req.headers['x-request-id']);

    req.requestId = id;

    // Thread the ID through the logger context so every log line during this
    // request lifecycle carries it automatically.
    AppLoggerService.requestId = id;
    AppLoggerService.userId = undefined; // reset; auth guard will set this after JWT validation

    res.setHeader('X-Request-ID', id);

    // Clear the thread-local after the response finishes to avoid leakage
    // between back-to-back requests on the same process tick (defensive).
    res.on('finish', () => {
      if (AppLoggerService.requestId === id) {
        AppLoggerService.requestId = undefined;
        AppLoggerService.userId = undefined;
      }
    });

    next();
  }
}
