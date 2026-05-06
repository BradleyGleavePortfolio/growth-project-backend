# admin/reports

OWNER-only operational reports surface for the admin console. Exposes the
same authoritative data the live admin endpoints already serve, but
packaged as CSV/JSON downloads with a stable column set so the operator
can hand a file to finance/legal/support without screen-scraping the
console.

## Purpose

- **Self-describing dumps.** Every report response carries
  `generated_at`, the report `name`, and (when applicable) the `window`
  it was computed against. CSV files name themselves
  `<report>-YYYYMMDD.csv` via `Content-Disposition` so a browser
  download lands in a predictable place.
- **No fabricated numbers.** Every value is either:
  - a Prisma read off the source-of-truth Postgres row (users,
    coach profiles, subscriptions, audit log), or
  - a passthrough of the existing `MetricsService.getOverview()`
    counters (which themselves derive from Postgres + the Stripe
    Invoice mirror), or
  - a passthrough of the `FinanceFederationService` envelopes which
    explicitly carry their own `status` / `reason` / `detail` when
    the upstream is degraded.
- **Consistent envelope.** JSON responses are
  `{ report, generated_at, window, data }`. CSV responses flatten
  either rows-of-objects (column-oriented) or a single object (key/value).

## Endpoints

All routes are mounted under `/api/admin/reports/*` and guarded by
`@UseGuards(JwtAuthGuard, RolesGuard) @Roles('owner')`. Coach/student
tokens get a clean 403; unauthenticated requests get 401.

| Method | Path | Format | Source | Notes |
|---|---|---|---|---|
| `GET` | `/admin/reports` | JSON | static | Manifest of available reports + supported formats. |
| `GET` | `/admin/reports/metrics-overview?since_days=&format=` | JSON / CSV | `MetricsService.getOverview` | Same payload as `/admin/metrics`. CSV is key/value flattened. `since_days` clamped to (0, 365]. |
| `GET` | `/admin/reports/coaches?format=` | JSON / CSV | `prisma.user (role=coach) + coach_profile + students` | Per-coach roster snapshot with derived `client_count` / `active_client_count`. No per-record activity counters. |
| `GET` | `/admin/reports/clients?limit=&format=` | JSON / CSV | `prisma.user (role=student) + coach.email` | Client roster with tenancy join. `limit` clamped to [1, 5000], default 1000. **No activity counters** (privacy contract). |
| `GET` | `/admin/reports/billing-past-due?format=` | JSON / CSV | `prisma.coachSubscription (status=past_due)` | Daily dunning worklist. |
| `GET` | `/admin/reports/product-usage?format=` | JSON / CSV | `FinanceFederationService.getProductUsage` | Mirrors `/admin/product/usage`. Carries explicit `status` when finance is degraded. |
| `GET` | `/admin/reports/federation-health?format=` | JSON / CSV | `FinanceFederationService.getIntegrationsStatus` | Live finance probe envelope. |
| `GET` | `/admin/reports/audit-summary?action=&target_user_id=&tenant_coach_id=&since_days=&limit=&format=` | JSON / CSV | `prisma.auditLog` | Compliance review dump. `action` matches as a prefix. `since_days` defaults to 30 / clamped to [1, 365]. `limit` clamped to [1, 5000], default 1000. **`metadata` (Json) is intentionally omitted from the row shape** — fetch the live `/admin/audit-log` endpoint for the full record. |
| `GET` | `/admin/reports/ptm-signal-weights?format=` | JSON / CSV | `PtmWeightedService.getCurrentWeights` | Current trained weights of the PTM weighted v2 engine. Below the activation threshold (`PTM_WEIGHTED_ACTIVATION_OUTCOMES`, default 20) or with an empty cohort the response carries `basis: 'heuristic_v1'`, an empty `data` array, and a `reason` field (`below_activation_threshold` or `empty_cohort`). When active the response carries `basis: 'weighted_v2'` and one row per learned weight with `signal_type`, `weight`, `training_count`, `training_max`, `success_avg`, `failure_avg`, `basis`. |
| `GET` | `/admin/reports/transformation-scorecard?user_id=&coach_id=&since_days=&format=` | JSON / CSV | `prisma.user + checkIn + weightLog + workoutSession + clientSignal + coachMessage + ptmPrediction + clientOutcome + (diagnosticSubmission?) + (buildWeekEnrollment?)` | Phase 5 — per-client transformation snapshot. With `user_id` returns one row; with `coach_id` returns that coach's roster (clamped to 1000); with neither walks every student (clamped to 1000). `since_days` defaults to 90 / clamped to [7, 365] but **only scopes the rolling-window counters** — identity, latest check-in, lifetime weight extremes, and PTM scores are not bounded by it. Phase-3 `DiagnosticSubmission` and Phase-4 `BuildWeekEnrollment` reads are **defensive**: missing tables / failed reads render the corresponding columns as `null` rather than failing the report. |

## CSV format

`csv.ts` is a small RFC 4180 serializer used by every report:

- Fields containing `,`, `"`, `\r`, or `\n` are wrapped in double quotes;
  embedded quotes become `""`.
- `null` / `undefined` become an empty cell.
- `Date` values serialize via `toISOString()`.
- Nested objects are JSON-encoded into a single cell (used by the
  metrics-overview / product-usage / federation-health key/value forms).
- Line terminator is CRLF; the file ends with CRLF.

The CSV response also sets `Cache-Control: no-store` since each report
is a point-in-time snapshot and an intermediary cache would mislead the
operator.

## Privacy and tenancy rules

- The report controller is class-gated by `@Roles('owner')`. There is no
  per-coach or per-client report variant — coach/student tokens cannot
  reach this surface.
- The clients report **omits all per-record activity counters** (food
  logs, workouts, messages, etc.). The flat CSV is for tenancy
  bookkeeping, not behavioral analytics. The coach-detail endpoint
  (`/admin/coaches/:id`) is the documented way to get 7-day activity
  for a coach's roster.
- The audit-summary report omits the `metadata` Json column to keep CSV
  rows flat and predictable — per-action shapes differ (e.g. a role
  change carries `{from, to}` while a subscription update carries
  Stripe fields). Operators who need the raw metadata read it from
  `/admin/audit-log`.
- Coach/client emails are intentionally included — the OWNER role is
  the platform-wide superuser and these reports are the same data
  already returned by `/admin/coaches`, `/admin/users`, and
  `/admin/audit-log`.

## Failure modes

- Finance backend unreachable → `product-usage` and `federation-health`
  reports carry `status: not_configured` / `auth_unconfigured` /
  `degraded` with a `reason` from the federation contract. The CSV
  surfaces these as flat key/value rows; no field is zeroed out.
- Audit-log filter that matches nothing → empty `data: []` array, still
  with the envelope intact and the `window` carrying the resolved
  `since_days`.
- Limit overflow → server clamps silently to the documented maximums
  rather than returning 400, since "too generous" is not a contract
  violation.

## Tests

| Spec | Surface |
|---|---|
| `test/reports-csv.spec.ts` | RFC 4180 quoting, header/row generation, key/value flattening for nested objects. |
| `test/reports.service.spec.ts` | Envelope shape, Prisma projection, since_days clamp, audit metadata omission, finance degraded passthrough. |
| `test/reports.controller.spec.ts` | JSON/CSV branching, headers (Content-Type, Content-Disposition, Cache-Control), filter forwarding, manifest contents. |

Run with `npm test -- reports`.

## Operational notes

- These endpoints are read-only. They allocate at most one Postgres
  query per call (plus, for `product-usage` / `federation-health`, one
  HTTP request to the finance backend with the existing federation
  client's bounded timeout).
- CSV downloads are streamed as a single response body — no temp files
  on disk, no intermediate storage. A 5000-row clamp on `clients` and
  `audit-summary` keeps a single response well below 1 MB even for the
  widest column set.
- For larger audit dumps (e.g. an annual compliance review), call
  `/admin/reports/audit-summary` repeatedly with paginated date windows
  via `since_days` rather than raising the limit. The dataset is
  append-only, so the slices line up cleanly.
