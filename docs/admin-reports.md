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
attachment`.

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
  zeroed-out chart.

## Limits

| Report | Default limit | Max limit |
|---|---|---|
| `clients` | 1000 | 5000 |
| `audit-summary` | 1000 rows in the last 30 days | 5000 / 365 days |
| `metrics-overview` | n/a | `since_days` clamped to 365 |
| Other reports | full set | n/a — bounded by underlying tables |

For larger audit dumps (e.g. an annual compliance review), call
`audit-summary` repeatedly with paginated `since_days` windows rather
than raising the limit.

## Failure modes

| Symptom | Likely cause | What to do |
|---|---|---|
| `403` on every report path | Token role is not `owner` | Check the `role` claim on the JWT — only `owner` accounts reach `/admin/*`. |
| `product-usage` returns `status: not_configured` | `FINANCE_API_BASE_URL` / `FINANCE_SERVICE_TOKEN` missing in the deployed env | Set the secrets per `docs/deploy-runbook.md`. The status field tells the truth — no synthetic chart will appear. |
| `federation-health.probe.outcome: degraded` with `reason: timeout` | Finance backend slow or rolling | Re-run after a minute; persistent → page finance backend on-call. |
| `billing-past-due` is empty but Stripe shows past_due invoices | The Stripe webhook hasn't reached the mirror yet | Check `paymentFailure` rows / Stripe dashboard delivery log. The mirror is the source of truth for this report. |

## Related

- Live admin endpoints: `src/admin/admin.controller.ts`
  (`/admin/metrics`, `/admin/audit-log`, `/admin/coaches`, etc.)
- Federation contract: `src/admin/federation/README.md`
- Console aliases: `src/admin/console/README.md`
- Metrics provenance: [`docs/metrics.md`](./metrics.md)
- Audit/GDPR: [`docs/audit-and-gdpr.md`](./audit-and-gdpr.md)
