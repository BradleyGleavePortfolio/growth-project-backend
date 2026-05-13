import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * CacheControlInterceptor — adds a conservative private cache hint to safe,
 * idempotent GET responses while opting sensitive surfaces out of caching.
 *
 * Behavior:
 * - 2xx GET responses receive `Cache-Control: private, max-age=60` so a
 *   coach or client device can avoid round-tripping the same read more than
 *   once per minute. `private` keeps responses out of any shared/CDN cache;
 *   `max-age` is short enough that a coach action will appear within a
 *   minute even on the worst-case stale-cache device.
 * - The following route prefixes ALWAYS receive `Cache-Control: no-store`
 *   regardless of method or status code, because their responses change
 *   per-request or carry credentials that must never be persisted:
 *     /auth/*              login responses (access tokens)
 *     /messaging/*         realtime coach-client messaging
 *     /admin/*             owner-only console (per-request fanout)
 *     /health*             health/readiness probes
 *     /.well-known/*       AASA + assetlinks (signed by deploy, not cacheable
 *                          long enough to matter; clients re-fetch on every
 *                          link tap)
 * - Non-GET methods and non-2xx responses are left untouched. The
 *   HttpExceptionFilter already controls error response shape; this
 *   interceptor stays out of that path.
 * - We do NOT overwrite a Cache-Control header that the handler explicitly
 *   set — controllers that opt into a different policy (e.g. longer maxage
 *   for static-ish public pages) take precedence.
 */

const NO_STORE_PREFIXES: ReadonlyArray<string> = [
  '/auth/',
  '/messaging/',
  '/admin/',
  '/health',
  '/.well-known/',
];

// The /api global prefix is excluded for /health and /.well-known but applied
// to /auth, /messaging, /admin. Match against the un-prefixed path so the
// rule is consistent regardless of how the route is mounted.
function matchesNoStore(path: string): boolean {
  const stripped = path.startsWith('/api/') ? path.slice(4) : path;
  for (const prefix of NO_STORE_PREFIXES) {
    if (stripped === prefix.replace(/\/$/, '') || stripped.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const path = req.path || req.url || '';
    const method = (req.method || 'GET').toUpperCase();

    return next.handle().pipe(
      tap(() => {
        // Do not stomp on a handler-set policy.
        if (res.getHeader('Cache-Control')) return;

        if (matchesNoStore(path)) {
          res.setHeader('Cache-Control', 'no-store');
          return;
        }

        if (method !== 'GET') return;
        // Only annotate successful responses; let errors flow through the
        // exception filter without a cache hint that would tell a downstream
        // proxy to remember a transient failure.
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          res.setHeader('Cache-Control', 'private, max-age=60');
        }
      }),
    );
  }
}
