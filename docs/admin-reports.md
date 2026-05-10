# Admin reports / exports runbook

OWNER-only operational exports for the admin console. This document is
the operator-facing companion to the developer notes in
[`src/admin/reports/README.md`](../src/admin/reports/README.md).

## When to use which report

| Scenario | Report | Format hint |
|---|---|---|
| Daily dunning worklist (who is past_due?) | `billing-past-due` | CSV → spreadsheet |
| Quarterly board metrics snapshot | `metrics-overview` | JSON → drop into deck |
| Compliance review (role changes / GDPR scrub history / etc.) | `audit-summary` filtered by `action` and `since_days` | CSV |
| Tenancy bookkeeping (which coach owns which client?) | `clients` | CSV |
| Coach roster + plan tier / invite_code rollup | `coaches` | CSV |
| Cross-product usage (DAU/WAU/MAU + product split, sourced from finance) | `product-usage` | JSON |
| Operator status pill / incident postmortem (is finance reachable?) | `federation-health` | JSON |
| PTM weighted v2 trained weights (which signals correlate with churn vs success?) | `ptm-signal-weights` | JSON for inspection, CSV for spreadsheet review |
| Per-client / per-coach transformation snapshot (body + engagement + PTM + finance + outcome) | `transformation-scorecard` | **PDF for client reviews**, CSV for spreadsheets, JSON for ad-hoc |

## Authentication

Every endpoint is `OWNER`-only. The admin console will already attach
the OWNER's Supabase JWT; for ad-hoc CLI use:

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports" | jq .
```

## Common recipes

**Pull the past-due dunning list as CSV and open it:**

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/billing-past-due?format=csv" \
  -o billing-past-due-$(date -u +%Y%m%d).csv
```

**Dump every role change in the last 90 days:**

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/audit-summary?action=user.role_changed&since_days=90&format=csv" \
  -o role-changes.csv
```

**Snapshot the metrics dashboard for a board pack:**

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/metrics-overview?since_days=30" | jq .
```

**Check whether finance was reachable when a metric looked off:**

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/federation-health" | jq '.data.integrations.finance_federation'
```

**Inspect the PTM weighted v2 trained weights (which signals correlate
with churn vs success?):**

```bash
# JSON — quick eyeball check.
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/ptm-signal-weights" | jq .

# CSV — for a side-by-side comparison across runs.
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/ptm-signal-weights?format=csv" \
  -o ptm-signal-weights-$(date -u +%Y%m%d).csv
```

Below the activation threshold the response carries
`basis: 'heuristic_v1'`, an empty `data` array, and a `reason` field
(`below_activation_threshold` or `empty_cohort`). See
[`docs/ptm.md`](./ptm.md) for the full algorithm and a worked example.

## Transformation scorecard (Phase 5)

Per-client (and per-coach rollup) snapshot composed from authoritative
live data — there are **no fabricated metrics**. Every numeric column
either reads off a source row directly or is derived from a small set of
those reads (weight delta = latest − earliest WeightLog, meal
consistency = distinct days with `meal_logged` ÷ 30).

### Formats

The transformation scorecard is the only report that supports three
output formats:

| Format | Content-Type | Use |
|---|---|---|
| `json` (default) | `application/json` | API / console ad-hoc |
| `csv` | `text/csv` | Spreadsheet import |
| `pdf` | `application/pdf` | Client reviews, printed handouts |

An unknown `format` value (e.g. `format=xlsx`) returns `400 Bad Request`
with a message listing the valid options. Other reports silently fall
back to JSON for unrecognised format values.

### Source-of-truth notes

| Source | Used for |
|---|---|
| `prisma.user` (+ `coach.email` join) | `user_id`, `email`, `name`, `role`, `coach_email`, `days_active` |
| Latest `prisma.checkIn` | `latest_mood`, `latest_energy`, `latest_sleep_hrs` |
| Earliest + latest `prisma.weightLog` | `starting_weight_lbs`, `current_weight_lbs`, `weight_delta_lbs` (already in lbs — no conversion) |
| `prisma.workoutSession` + `ExerciseSet` over the rolling 30-day window | `workout_volume_30d` (Σ reps × weight across recorded arrays) |
| `prisma.clientSignal` filtered to `signal_type = 'meal_logged'` | `meals_logged_30d` (distinct calendar days), `meal_consistency_pct_30d` |
| `prisma.coachMessage` filtered by sender direction in the rolling window | `messages_sent_30d`, `messages_received_30d` |
| Latest `prisma.ptmPrediction` | `ptm_risk_score`, `ptm_success_score`, `ptm_bucket` (via shared `bucketize()` from `src/ptm/ptm.types.ts`) |
| `prisma.clientOutcome` (`@unique user_id`) | `latest_outcome` |
| `prisma.diagnosticSubmission` (Phase 3, optional) | `diagnostic_overall_score`, `diagnostic_bucket` — defensive: missing table or read failure renders both as `null` |
| `prisma.buildWeekEnrollment` (Phase 4, optional) | `build_week_status` — defensive: missing table or read failure renders the cell as `null` |
| `FinanceAdminClient.lookupClient(email)` (optional, guarded by `FINANCE_API_BASE_URL`) | `wealth_velocity_score`, `net_worth_delta`, `milestones_hit` — fail-closed-graceful: unset env or any degraded outcome renders all three as `null` |

### Finance federation columns

Three columns sourced from the finance backend via `FinanceAdminClient`:

| Column | Finance field | Notes |
|---|---|---|
| `wealth_velocity_score` | `FinanceClientSummary.wealth_velocity_score` | Null when finance unconfigured or degraded |
| `net_worth_delta` | `FinanceClientSummary.net_worth` | Current net worth snapshot. Null when finance unconfigured or degraded |
| `milestones_hit` | `FinanceClientSummary.activity_last_7d.eod_submissions` | EOD submission count as milestone proxy. Null when finance unconfigured or degraded |

The lookup uses the existing `FinanceAdminClient` and honours the
`FINANCE_FEDERATION_TIMEOUT_MS` env var (default 2500 ms). On timeout,
network error, or when `FINANCE_API_BASE_URL` is unset, all three columns
render as `null`. The report never 500s due to finance federation state.

### Columns (frozen order)

```
user_id, email, name, role, coach_email,
days_active,
latest_mood, latest_energy, latest_sleep_hrs,
starting_weight_lbs, current_weight_lbs, weight_delta_lbs,
workout_volume_30d,
meals_logged_30d, meal_consistency_pct_30d,
messages_sent_30d, messages_received_30d,
ptm_risk_score, ptm_success_score, ptm_bucket,
latest_outcome,
diagnostic_overall_score, diagnostic_bucket,
build_week_status,
wealth_velocity_score, net_worth_delta, milestones_hit,
generated_at
```

`since_days` defaults to 90 / clamped to `[7, 365]` and **only scopes
the rolling-window counters** (workout volume, meals, messaging).
Identity columns, lifetime weight extremes, PTM scores, and finance
columns are not bounded by it.

### PDF layout

The PDF (`format=pdf`) renders one A4 page per client:

1. **Header bar** (oxblood background) — TGP wordmark, report title, date
2. **Client identity** — name, email, coach email, window
3. **Transformation Momentum: X/100** — computed as `(1 – ptm_risk_score) × 100`; displays "—/100" when PTM score unavailable
4. **Body section** — progress bar + data table (weights, workout volume, check-in stats)
5. **Income & Engagement section** — meals, consistency, messaging, build week, diagnostic
6. **Finance & PTM section** — PTM scores, outcome, wealth velocity, net worth delta, milestones
7. **Footer** — "Generated by The Growth Project Operator OS"

### Pull a single client's scorecard:

```bash
# JSON
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/transformation-scorecard?user_id=$CLIENT_ID&format=json" | jq .

# PDF (download)
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/transformation-scorecard?user_id=$CLIENT_ID&format=pdf" \
  -o scorecard-$CLIENT_ID-$(date -u +%Y%m%d).pdf
```

### Pull every client of a single coach as CSV (per-coach rollup):

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/transformation-scorecard?coach_id=$COACH_ID&since_days=30&format=csv" \
  -o transformation-scorecard-$(date -u +%Y%m%d).csv
```

### Pull every student on the platform as PDF:

```bash
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/transformation-scorecard?format=pdf" \
  -o transformation-scorecard-all-$(date -u +%Y%m%d).pdf
```

When a column reads `null` (CSV: empty cell) the source row legitimately
does not exist for that user. The composer never substitutes a `0`
placeholder for a missing value, so an operator can distinguish
"never logged a weight" from "logged a weight of 0 lbs".

## Output contract

JSON envelope (every report):

```json
{
  "report": "billing-past-due",
  "generated_at": "2026-04-28T12:34:56.000Z",
  "window": null,
  "data": [ /* rows or object */ ]
}
```

`window` is populated for time-bound reports
(`metrics-overview`, `audit-summary`) with `{ since_days, since }`. CSV
files name themselves `<report>-YYYYMMDD.csv` via `Content-Disposition:
attachment`. PDF files name themselves `<report>-YYYYMMDD.pdf`.

## What these reports DO NOT contain

- **No per-client activity counters in the `clients` report.** Use
  `/api/admin/coaches/:id` for the 7-day food-log / workout / message
  rollup over a coach's roster. Flat client CSVs are for tenancy
  bookkeeping only.
- **No raw `metadata` JSON in the `audit-summary` report.** Per-action
  shapes differ; fetch the live `/api/admin/audit-log` endpoint when
  you need the full record.
- **No synthetic numbers.** When the finance backend is unreachable,
  `product-usage` / `federation-health` carry `status: not_configured`
  / `auth_unconfigured` / `degraded` with a `reason` rather than a
  zeroed-out chart. The transformation scorecard finance columns render
  `null` rather than `0`.

## Limits

| Report | Default limit | Max limit |
|---|---|---|
| `clients` | 1000 | 5000 |
| `audit-summary` | 1000 rows in the last 30 days | 5000 / 365 days |
| `metrics-overview` | n/a | `since_days` clamped to 365 |
| `transformation-scorecard` | full student roster | 1000 clients per call |
| Other reports | full set | n/a — bounded by underlying tables |

For larger audit dumps (e.g. an annual compliance review), call
`audit-summary` repeatedly with paginated `since_days` windows rather
than raising the limit.

## Failure modes

| Symptom | Likely cause | What to do |
|---|---|---|
| `403` on every report path | Token role is not `owner` | Check the `role` claim on the JWT — only `owner` accounts reach `/admin/*`. |
| `400` on `transformation-scorecard` with `format=...` | Unknown format value | Use `json`, `csv`, or `pdf`. |
| `product-usage` returns `status: not_configured` | `FINANCE_API_BASE_URL` / `FINANCE_SERVICE_TOKEN` missing in the deployed env | Set the secrets per `docs/deploy-runbook.md`. The status field tells the truth — no synthetic chart will appear. |
| `federation-health.probe.outcome: degraded` with `reason: timeout` | Finance backend slow or rolling | Re-run after a minute; persistent → page finance backend on-call. |
| `transformation-scorecard` finance columns are all null | `FINANCE_API_BASE_URL` not set or finance backend degraded | Check `federation-health` report. Finance columns are fail-graceful — the rest of the scorecard remains usable. |
| `billing-past-due` is empty but Stripe shows past_due invoices | The Stripe webhook hasn't reached the mirror yet | Check `paymentFailure` rows / Stripe dashboard delivery log. The mirror is the source of truth for this report. |

## Related

- Live admin endpoints: `src/admin/admin.controller.ts`
  (`/admin/metrics`, `/admin/audit-log`, `/admin/coaches`, etc.)
- Federation contract: `src/admin/federation/README.md`
- Console aliases: `src/admin/console/README.md`
- Metrics provenance: [`docs/metrics.md`](./metrics.md)
- Audit/GDPR: [`docs/audit-and-gdpr.md`](./audit-and-gdpr.md)
