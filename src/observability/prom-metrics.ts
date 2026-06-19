import type { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * prom-metrics — official `prom-client` registry that complements the
 * hand-rolled {@link MetricsService}.
 *
 * WHY a second registry?  The existing {@link MetricsService} serialises a
 * minimal set of application counters/histograms in Prometheus text format
 * and is wired through the NestJS interceptor chain. It does NOT expose the
 * Node.js runtime internals (process CPU, resident memory, event-loop lag,
 * garbage-collection pauses) that operators need to diagnose a misbehaving
 * process. `prom-client`'s {@link collectDefaultMetrics} captures exactly
 * those, plus we register a request-duration histogram with the
 * operator-blessed bucket layout. Both registries are scraped — the new
 * runtime metrics live behind a bearer-gated endpoint (see
 * prom-metrics.controller).
 *
 * HISTOGRAM BUCKETS (seconds): Prometheus client defaults extended with a 10s
 * tail so genuinely slow requests are still bucketed rather than collapsing
 * into +Inf. PII is deliberately excluded from labels — only `method`,
 * `route` (the normalised Express route pattern), and `status_code`.
 */

/** Request-duration histogram buckets, in SECONDS. */
export const HTTP_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Bounded label set — never include userId/email or other high-cardinality PII. */
export const HTTP_HISTOGRAM_LABELS = ['method', 'route', 'status_code'] as const;

/**
 * A dedicated registry keeps the prom-client metrics isolated from any other
 * default global registry usage and makes the unit tests deterministic — each
 * test can build a fresh registry instead of fighting shared global state.
 */
export const promRegistry = new Registry();

let defaultsRegistered = false;

/**
 * Register the Node.js default collectors (process CPU, memory, event-loop
 * lag, GC, handles) on {@link promRegistry}. Idempotent: prom-client throws on
 * duplicate metric registration, so a guard makes a second call a safe no-op —
 * important because the app may be re-bootstrapped within a single test run.
 */
export function registerDefaultMetrics(register: Registry = promRegistry): void {
  if (register === promRegistry && defaultsRegistered) {
    return;
  }
  collectDefaultMetrics({ register });
  if (register === promRegistry) {
    defaultsRegistered = true;
  }
}

/**
 * Build (or reuse) the HTTP request-duration histogram on the given registry.
 * Returns the histogram so callers/tests can observe directly.
 */
export function buildHttpHistogram(
  register: Registry = promRegistry,
): Histogram<(typeof HTTP_HISTOGRAM_LABELS)[number]> {
  const existing = register.getSingleMetric('http_request_duration_seconds');
  if (existing) {
    return existing as Histogram<(typeof HTTP_HISTOGRAM_LABELS)[number]>;
  }
  return new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds by method, route and status code.',
    labelNames: HTTP_HISTOGRAM_LABELS as unknown as string[],
    buckets: HTTP_DURATION_BUCKETS_SECONDS,
    registers: [register],
  });
}

/** The process-wide histogram used by {@link promHttpMiddleware}. */
export const httpRequestDurationSeconds = buildHttpHistogram();

/**
 * Normalise an Express route to bound `route`-label cardinality. Prefers the
 * matched route pattern (`/api/users/:id`); falls back to the raw path with
 * UUIDs and numeric ids collapsed to `:id`.
 */
export function normaliseRouteLabel(req: Request): string {
  const pattern = (req as Request & { route?: { path?: string } }).route?.path;
  const base = pattern && pattern.length > 0 ? pattern : req.path;
  if (!base) {
    return 'unknown';
  }
  return base
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    )
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/**
 * Express-style middleware that observes request duration into the prom-client
 * histogram. Registered FIRST in the chain so it measures the full lifecycle
 * (including auth rejections). It records on the response `finish` event so the
 * final status code is known.
 *
 * @param histogram injectable for tests; defaults to the process-wide instance.
 */
export function promHttpMiddleware(
  histogram: Histogram<(typeof HTTP_HISTOGRAM_LABELS)[number]> = httpRequestDurationSeconds,
) {
  return function promHttpMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const endTimer = histogram.startTimer({ method: req.method.toUpperCase() });
    res.on('finish', () => {
      endTimer({
        route: normaliseRouteLabel(req),
        status_code: String(res.statusCode),
      });
    });
    next();
  };
}

/** Serialise the prom-client registry to Prometheus text exposition format. */
export function renderPromMetrics(register: Registry = promRegistry): Promise<string> {
  return register.metrics();
}
