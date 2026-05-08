import { Injectable, OnModuleInit } from '@nestjs/common';

/**
 * MetricsService — in-process Prometheus metrics store.
 *
 * Exposes HTTP request counters, latency histograms, and (optionally) DB /
 * Redis query counters.  The `/metrics` endpoint served by MetricsController
 * serialises everything in the Prometheus text exposition format (version 0.0.4).
 *
 * WHY roll our own instead of @willsoto/nestjs-prometheus?
 * @willsoto/nestjs-prometheus is not currently in package.json and adding it
 * requires a new dep + peerDep on prom-client.  prom-client is also not a
 * current dep.  Rolling a minimal compliant implementation keeps the diff
 * minimal, avoids a TypeScript-version mismatch between prom-client and the
 * project, and satisfies the quality bar.  The output format is fully
 * compatible with Prometheus scrapers.  Future work: drop-in replace with
 * prom-client if richer SDK features (push gateway, exemplars) are needed.
 *
 * HISTOGRAM BUCKETS: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] ms
 * (as specified in the Phase 10 brief).
 */

// Latency histogram buckets in milliseconds.
export const LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface CounterVec {
  name: string;
  help: string;
  labels: string[];
  counts: Map<string, number>;
}

interface HistogramVec {
  name: string;
  help: string;
  labels: string[];
  // bucket upper bounds (ms)
  buckets: number[];
  // key: label-string, value: array aligned with buckets (cumulative count per bucket)
  bucketCounts: Map<string, number[]>;
  sums: Map<string, number>;
  totals: Map<string, number>;
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly counters: CounterVec[] = [];
  private readonly histograms: HistogramVec[] = [];

  // ---- Public metrics references ----
  private httpRequestsTotal!: CounterVec;
  private httpRequestDurationMs!: HistogramVec;
  private dbQueryTotal!: CounterVec;
  private redisOpTotal!: CounterVec;

  onModuleInit(): void {
    this.httpRequestsTotal = this.addCounter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests by method, route and status code.',
      labels: ['method', 'route', 'status'],
    });

    this.httpRequestDurationMs = this.addHistogram({
      name: 'http_request_duration_ms',
      help: 'HTTP request latency in milliseconds.',
      labels: ['method', 'route', 'status'],
      buckets: LATENCY_BUCKETS,
    });

    this.dbQueryTotal = this.addCounter({
      name: 'db_query_total',
      help: 'Total number of database queries by model and operation.',
      labels: ['model', 'operation'],
    });

    this.redisOpTotal = this.addCounter({
      name: 'redis_op_total',
      help: 'Total number of Redis operations by command.',
      labels: ['command'],
    });
  }

  private addCounter(def: { name: string; help: string; labels: string[] }): CounterVec {
    const c: CounterVec = { ...def, counts: new Map() };
    this.counters.push(c);
    return c;
  }

  private addHistogram(def: {
    name: string;
    help: string;
    labels: string[];
    buckets: number[];
  }): HistogramVec {
    const h: HistogramVec = {
      ...def,
      bucketCounts: new Map(),
      sums: new Map(),
      totals: new Map(),
    };
    this.histograms.push(h);
    return h;
  }

  /** Read env at call-time so tests can toggle METRICS_ENABLED between cases. */
  private get enabled(): boolean {
    return (process.env.METRICS_ENABLED ?? 'on').toLowerCase() !== 'off';
  }

  private incCounter(vec: CounterVec, labels: Record<string, string>): void {
    if (!this.enabled) return;
    const key = labelKey(labels);
    vec.counts.set(key, (vec.counts.get(key) ?? 0) + 1);
  }

  private observeHistogram(
    vec: HistogramVec,
    labels: Record<string, string>,
    value: number,
  ): void {
    if (!this.enabled) return;
    const key = labelKey(labels);
    // Cumulative counts per bucket (Prometheus convention: each bucket counts
    // all observations <= upper bound)
    let buckets = vec.bucketCounts.get(key);
    if (!buckets) {
      buckets = new Array<number>(vec.buckets.length).fill(0);
      vec.bucketCounts.set(key, buckets);
    }
    for (let i = 0; i < vec.buckets.length; i++) {
      if (value <= vec.buckets[i]) {
        buckets[i]++;
      }
    }
    vec.sums.set(key, (vec.sums.get(key) ?? 0) + value);
    vec.totals.set(key, (vec.totals.get(key) ?? 0) + 1);
  }

  /** Called by LoggingInterceptor on every HTTP request. */
  recordRequest(method: string, route: string, status: number, latencyMs: number): void {
    const labels = {
      method: method.toUpperCase(),
      route: normaliseRoute(route),
      status: String(status),
    };
    this.incCounter(this.httpRequestsTotal, labels);
    this.observeHistogram(this.httpRequestDurationMs, labels, latencyMs);
  }

  /** Called by PrismaMiddleware on every query. */
  recordDbQuery(model: string, operation: string): void {
    this.incCounter(this.dbQueryTotal, { model, operation });
  }

  /** Called by redis-aware code (throttler storage, etc.) on every op. */
  recordRedisOp(command: string): void {
    this.incCounter(this.redisOpTotal, { command });
  }

  /**
   * Serialise all metrics into Prometheus text format (exposition 0.0.4).
   * A Prometheus scraper (Grafana Agent, prom/prometheus) can consume this
   * directly at GET /metrics.
   */
  render(): string {
    if (!this.enabled) return '# Metrics disabled (METRICS_ENABLED=off)\n';

    const lines: string[] = [];

    for (const c of this.counters) {
      lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      for (const [labelStr, count] of c.counts) {
        lines.push(`${c.name}{${labelStr}} ${count}`);
      }
    }

    for (const h of this.histograms) {
      lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);

      // Collect all label keys that have data
      const allKeys = new Set([...h.sums.keys()]);
      for (const labelStr of allKeys) {
        const buckets = h.bucketCounts.get(labelStr) ?? [];
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(
            `${h.name}_bucket{${labelStr},le="${h.buckets[i]}"} ${buckets[i] ?? 0}`,
          );
        }
        // +Inf bucket = total count
        lines.push(
          `${h.name}_bucket{${labelStr},le="+Inf"} ${h.totals.get(labelStr) ?? 0}`,
        );
        lines.push(`${h.name}_sum{${labelStr}} ${h.sums.get(labelStr) ?? 0}`);
        lines.push(`${h.name}_count{${labelStr}} ${h.totals.get(labelStr) ?? 0}`);
      }
    }

    return lines.join('\n') + '\n';
  }
}

/**
 * Normalise a parameterised Express route string (e.g. `/api/users/:id/weight`)
 * to keep the cardinality of the `route` label bounded.  Raw `req.path` values
 * (with real IDs substituted) would create one time-series per unique user and
 * blow up the Prometheus TSDB.
 */
function normaliseRoute(route: string): string {
  if (!route) return 'unknown';
  // Express route params are already normalised (`:id`, `:userId`).
  // req.path (actual URL) needs UUID / numeric ID stripping.
  return route
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    )
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}
