import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

/**
 * CacheControlInterceptor — no phone, browser or proxy keeps a copy of an API
 * response unless the route itself says it may.
 *
 * Behavior:
 * - Every response that reaches a controller gets
 *   `Cache-Control: private, no-store`: any method, success or error. The
 *   header is set BEFORE the handler runs, so the exception filter's error
 *   responses and handlers that answer through @Res() carry it too.
 *   (Until SETUP-STALE-132, 2xx GETs got `private, max-age=60`: a phone's
 *   HTTP cache then served personal reads such as GET /coach/onboarding from
 *   memory for up to a minute after a write, and the coach setup wizard
 *   posted a step the server had already passed -> 400 STEP_OUT_OF_ORDER.)
 * - The following route prefixes receive exactly `Cache-Control: no-store`
 *   (unchanged), because their responses change per request or carry
 *   credentials:
 *     /auth/*              login responses (access tokens)
 *     /messaging/*         realtime coach-client messaging
 *     /admin/*             owner-only console (per-request fanout)
 *     /health*             liveness probes
 *     /readyz              current database readiness, never a cached success
 *     /.well-known/*       AASA + assetlinks (their handler sets its own
 *                          public policy, which wins; see below)
 * - A policy already on the response when this interceptor runs (an
 *   @Header() decorator, which Nest applies before interceptors, or a
 *   middleware) is left alone, and a handler that sets its own header
 *   overwrites this default. That is how the genuinely public,
 *   unauthenticated routes keep public caching: the HTML pages in
 *   public-pages.controller.ts (`public, max-age=300`), /.well-known/*
 *   (`public, max-age=3600`) and the coach landing pages
 *   (`public, max-age=60, stale-while-revalidate=300`).
 */

const NO_STORE_PREFIXES: ReadonlyArray<string> = [
  '/auth/',
  '/messaging/',
  '/admin/',
  '/health',
  '/readyz',
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

    // Do not stomp on a policy set before the handler (decorator/middleware).
    if (!res.getHeader('Cache-Control')) {
      const path = req.path || req.url || '';
      res.setHeader('Cache-Control', matchesNoStore(path) ? 'no-store' : 'private, no-store');
    }
    return next.handle();
  }
}
