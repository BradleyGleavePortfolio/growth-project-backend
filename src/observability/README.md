# Observability Module

Production-grade observability for The Growth Project backend.  This module
owns structured logging, request tracing, Prometheus metrics, deep health
checks, and CPU profiling.  It must be the **first import in AppModule** so
the request-id middleware runs before every auth guard and audit interceptor.

---

## Purpose

A running NestJS process in production needs four things so problems can be
found and fixed quickly:

1. **Structured logs** — every line is a JSON object with a fixed shape so a
   log-aggregation backend (Better Stack, Datadog, etc.) can index it.
2. **Request tracing** — a unique `X-Request-ID` ties every log line from a
   single HTTP request together.  Support engineers copy the ID from a mobile
   client error response and pull all the server logs for that request.
3. **Metrics** — a Prometheus `/metrics` endpoint lets Grafana show request
   rates, error rates, and latency percentiles in real time.
4. **Health checks** — `GET /health/deep` lets ops tooling (uptime monitors,
   on-call alerts) distinguish a database outage from a process crash.

An optional **CPU profiler** endpoint (`GET /debug/profile`) is gated behind
the OWNER role and a feature flag so it is never accidentally exposed.

---

## Log shape

Every JSON log line contains these fields:

| Field | Type | Description |
|---|---|---|
| `timestamp` | string (ISO-8601 UTC) | When the line was emitted |
| `level` | `"log"` \| `"warn"` \| `"error"` \| `"debug"` \| `"verbose"` | Severity |
| `context` | string? | NestJS class / module name (e.g. `"HTTP"`, `"Bootstrap"`) |
| `request_id` | string? | X-Request-ID for the current HTTP request (set by middleware) |
| `user_id` | string? | Supabase UUID of the authenticated user (set by LoggingInterceptor) |
| `method` | string? | HTTP method (`"GET"`, `"POST"`, …) — on request-end lines only |
| `path` | string? | Raw request path — on request-end lines only |
| `status` | number? | HTTP status code — on request-end lines only |
| `latency_ms` | number? | Round-trip latency in milliseconds — on request-end lines only |
| `message` | string | Human-readable log message |

Example (pretty-printed for readability — the actual line is single-line JSON):

```json
{
  "timestamp": "2026-01-15T10:23:45.678Z",
  "level": "log",
  "context": "HTTP",
  "request_id": "3f7a9b1c2d4e5f60",
  "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "method": "GET",
  "path": "/api/me/weight",
  "status": 200,
  "latency_ms": 34,
  "message": "GET /api/me/weight 200"
}
```

### Redaction rules

The following key names (case-insensitive) are **always replaced with
`"[REDACTED]"`** before the line is written.  The list is enforced by
`redactObject` (recursive object walk) and `redactLogLine` (belt-and-suspenders
string replacement on the serialised JSON):

```
password, passwd, pass, secret, token, authorization, x-api-key,
api_key, apikey, access_token, refresh_token, id_token, client_secret,
private_key, privatekey, ssn, social_security,
bloodwork, blood_glucose, hba1c, cholesterol, triglycerides,
body_fat, bodyfat, fat_percentage, raw_bloodwork,
stripe_secret_key, stripe_webhook_secret, card_number, cvv, cvc, card_cvc, card_cvv
```

Allowed keys that will never be redacted even if they match a prefix of the
above names: `request_id`, `user_id`, `method`, `path`, `status`,
`latency_ms`, `timestamp`, `level`, `message`, `msg`.

---

## Request-ID contract

`RequestIdMiddleware` runs on every route before any guard or interceptor.

- **Incoming header present** (`X-Request-ID: <value>`): the value is sanitised
  (alphanumeric + hyphens only, max 128 chars) and used as the ID.  The mobile
  client, Fly's edge, or a test harness can supply an ID for end-to-end
  correlation.
- **No header**: a 16-byte cryptographic random hex string is generated.
- The resolved ID is:
  - Attached to `req.requestId`
  - Stored in `AppLoggerService.requestId` (module-scope thread-local)
  - Returned as `X-Request-ID` response header
  - Included in every error response body via `HttpExceptionFilter`

**Error response shape (all 4xx / 5xx):**

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found",
  "timestamp": "2026-01-15T10:23:45.678Z",
  "path": "/api/me/profile",
  "request_id": "3f7a9b1c2d4e5f60"
}
```

---

## Metrics

Served at `GET /metrics` (Prometheus text format 0.0.4).  No auth.

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` | Total HTTP requests |
| `http_request_duration_ms` | histogram | `method`, `route`, `status` | Request latency in ms |
| `db_query_total` | counter | `model`, `operation` | Prisma queries by model |
| `redis_op_total` | counter | `command` | Redis commands (when Redis is in use) |

Histogram latency buckets: **10, 25, 50, 100, 250, 500, 1000, 2500, 5000 ms**.

The `route` label uses the Express route pattern (e.g. `/api/users/:id`) rather
than the raw path so a single user's UUID does not create a new time-series.

---

## Sentry behaviour

Sentry is initialised in `src/instrument.ts` (imported first in `main.ts` so
it attaches to Node's `http` module before any request arrives).

- **`SENTRY_DSN` set**: all 5xx responses and unhandled exceptions are
  forwarded to Sentry.  4xx are deliberately skipped (validation errors and
  auth failures would flood the Sentry project with noise).
- **`SENTRY_DSN` unset**: Sentry is a no-op.  No error is thrown on boot.
- **Sample rates**:
  - `tracesSampleRate`: defaults to `SENTRY_TRACES_SAMPLE_RATE` (env) or `0.1`.
  - Error capture rate: `1.0` (every unhandled exception is captured).
- **PII stripping** (`beforeSend`): `Authorization` and `Cookie` headers are
  deleted from the event before transmission.

---

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/metrics` | None (public) | Prometheus metrics scrape endpoint |
| `GET` | `/health/deep` | None (public) | Deep readiness: DB + Redis check |
| `GET` | `/debug/profile` | OWNER role + `PROFILE_ENABLED=on` | 30-second V8 CPU profile (`.cpuprofile` download) |

The existing shallow health endpoints (`/health`, `/healthz`, `/readyz`) are in
`src/health/` and are unchanged.  `/health/deep` lives here because it depends
on the observability module's runtime configuration.

---

## Health check shapes

### `GET /health/deep`

Success (200):
```json
{
  "ok": true,
  "db": "up",
  "redis": "up",
  "uptime": 3600,
  "timestamp": "2026-01-15T10:23:45.678Z"
}
```

Redis unconfigured (no `REDIS_URL`) (200):
```json
{ "ok": true, "db": "up", "redis": "unconfigured", "uptime": 3600, "timestamp": "..." }
```

Failure (503):
```json
{
  "ok": false,
  "db": "down",
  "redis": "up",
  "uptime": 3600,
  "timestamp": "...",
  "errors": ["db: connection refused"]
}
```

---

## Environment variables

| Variable | Default | Tier | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | optional | Minimum log level: `error`, `warn`, `log`, `debug`, `verbose` |
| `LOG_FORMAT` | `json` | optional | `json` for machine-readable (production) or `pretty` for human-readable (development) |
| `METRICS_ENABLED` | `on` | optional | `on` enables the `/metrics` endpoint and counter tracking; `off` disables both |
| `PROFILE_ENABLED` | `off` | optional | `on` activates `GET /debug/profile`.  Requires OWNER role.  Leave `off` in production unless actively profiling |
| `SENTRY_DSN` | _(unset)_ | feature | Sentry project DSN.  When unset Sentry is a no-op |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | optional | Fraction of transactions sampled for Sentry Performance (0.0–1.0) |

---

## Prisma models touched

None.  This module adds no database tables.

---

## Test coverage

| File | What it asserts |
|---|---|
| `test/observability.spec.ts` | `redactObject`: passwords, tokens, bloodwork values are replaced with `[REDACTED]`; nested objects are walked; circular references are handled; original object is not mutated |
| | `redactLogLine`: password and authorization values in serialised JSON strings are stripped |
| | `MetricsService`: `render()` produces valid Prometheus text; `recordRequest` increments counters; histogram buckets are cumulative; disabled mode returns comment-only text |
| | `AppLoggerService`: emits JSON with required fields; includes `request_id` thread-local; redacts password in meta |
| | `RequestIdMiddleware`: generates hex id when header absent; honours incoming header; strips unsafe chars; truncates to 128 chars; resets `userId` on each request |
| | `HealthDeepController`: returns `ok:true` on DB success; returns `ok:false` + 503 on DB failure |

---

## Future work

- **Log shipping**: forward JSON stdout to [Better Stack Logs](https://betterstack.com/logs) via Fly's `[metrics]` block or a Fluent Bit sidecar.  The JSON shape is already compliant.
- **Metrics backend**: scrape `/metrics` with [Grafana Cloud](https://grafana.com/products/cloud/) or self-hosted Prometheus.  Add alert rules for: p99 latency > 1000ms, error rate > 1%, DB query count spikes.
- **Distributed tracing**: attach OpenTelemetry trace/span IDs to log lines and forward to a Jaeger or Tempo backend for cross-service waterfall views.
- **Sentry Performance**: bump `SENTRY_TRACES_SAMPLE_RATE` to `0.5` once traffic baselines are established.
- **prom-client**: replace the hand-rolled metrics implementation with `prom-client` (Node.js Prometheus client) and `@willsoto/nestjs-prometheus` for SDK features like push gateway, exemplars, and built-in Node.js process metrics (`process_cpu_seconds_total`, `process_resident_memory_bytes`).
- **Redis op metrics**: wire `MetricsService.recordRedisOp()` into the ioredis client used by the throttler to expose real Redis command counts.
- **Prisma query metrics**: wire `MetricsService.recordDbQuery()` into Prisma middleware (extension) to count queries per model.
