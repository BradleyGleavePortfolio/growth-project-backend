import type { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * prom-metrics — official `prom-client` registry (Node.js runtime internals via
 * collectDefaultMetrics + a request-duration histogram) behind the bearer-gated
 * endpoint. Labels are bounded to method/route/status_code (no PII).
 */

/** Request-duration histogram buckets, in SECONDS. */
export const HTTP_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Bounded label set — never include userId/email or other high-cardinality PII. */
export const HTTP_HISTOGRAM_LABELS = ['method', 'route', 'status_code'] as const;

/** Dedicated registry keeps prom-client metrics isolated + tests deterministic. */
export const promRegistry = new Registry();

let defaultsRegistered = false;

/** Register the Node.js default collectors. Idempotent (prom-client throws on
 * duplicate registration; some suites re-bootstrap the app). */
export function registerDefaultMetrics(register: Registry = promRegistry): void {
  if (register === promRegistry && defaultsRegistered) {
    return;
  }
  collectDefaultMetrics({ register });
  if (register === promRegistry) {
    defaultsRegistered = true;
  }
}

/** Build (or reuse) the HTTP request-duration histogram on the given registry. */
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
    labelNames: [...HTTP_HISTOGRAM_LABELS],
    buckets: HTTP_DURATION_BUCKETS_SECONDS,
    registers: [register],
  });
}

/** The process-wide histogram used by {@link promHttpMiddleware}. */
export const httpRequestDurationSeconds = buildHttpHistogram();

/**
 * Normalise a route to bound `route`-label cardinality: prefer the matched
 * pattern, else collapse UUIDs/numeric ids in the raw path to `:id`.
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
 * Middleware that observes request duration into the histogram. Registered FIRST
 * so it measures the full lifecycle (incl. auth rejections); records on `finish`
 * when the status is known. The histogram is injectable for tests.
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
