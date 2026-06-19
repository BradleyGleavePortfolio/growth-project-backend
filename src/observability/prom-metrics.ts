import type { NextFunction, Request, Response } from 'express';
import {
  collectDefaultMetrics,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * prom-metrics — official `prom-client` registry that complements the
 * hand-rolled {@link MetricsService}. It adds the Node.js runtime internals
 * (process CPU, resident memory, event-loop lag, GC) via collectDefaultMetrics
 * plus a request-duration histogram, exposed behind a bearer-gated endpoint.
 * Buckets are the Prometheus defaults + a 10s tail; labels are bounded to
 * method/route/status_code (no PII).
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

/**
 * Register the Node.js default collectors on {@link promRegistry}. Idempotent:
 * a guard makes a second call a safe no-op (prom-client throws on duplicate
 * registration, and some test suites re-bootstrap the app).
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
    labelNames: HTTP_HISTOGRAM_LABELS as unknown as string[],
    buckets: HTTP_DURATION_BUCKETS_SECONDS,
    registers: [register],
  });
}

/** The process-wide histogram used by {@link promHttpMiddleware}. */
export const httpRequestDurationSeconds = buildHttpHistogram();

/**
 * Normalise an Express route to bound `route`-label cardinality: prefer the
 * matched pattern (`/api/users/:id`), else collapse UUIDs/numeric ids in the
 * raw path to `:id`.
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
 * histogram. Registered FIRST so it measures the full lifecycle (including auth
 * rejections); records on the response `finish` event when the status is known.
 * The histogram is injectable for tests; defaults to the process-wide instance.
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
