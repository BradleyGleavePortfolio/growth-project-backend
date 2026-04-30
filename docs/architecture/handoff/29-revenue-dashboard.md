# Handoff brief — Coach revenue dashboard aggregation (B8)

**Roadmap row:** #29.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/revenue-dashboard.md`](../../specs/revenue-dashboard.md).
**Cross-references:** PR #119 (parent roadmap), the existing
billing module (`src/billing/`), the existing OWNER metrics
(`docs/metrics.md`), `docs/admin-reports.md`,
`docs/entitlements.md`.

> Coach-side metrics. **Not** OWNER-side. The OWNER metrics
> already exist; this is the *coach's* view of their *own*
> business.

## WHY

A coach has no in-platform answer to "how much money am I making
this month?" today. The `Invoice`, `CoachSubscription`, and
`PaymentFailure` tables carry the data, but only the OWNER
metrics surface aggregates them — and that surface is platform-
wide. The strategy memo's B8 calls for MRR, active clients,
churn, ARPU, and a 12-week chart.

This item is the coach-side analogue of the OWNER mini-admin
board, and the gating dependency for several A-level expansion
items (A1 Coach Revenue Engine, A7 Outcome Graph).

## WHEN

- Local `Invoice`/`CoachSubscription` mirror has been
  reconciled against Stripe in staging for one full billing
  cycle without drift.
- KPI definitions are signed off by the founder.
- The OWNER metrics doc (`docs/metrics.md`) is treated as the
  canonical taxonomy this spec extends, not forks.

## WHERE

- New module: `src/coach-revenue/`.
- New table: `CoachRevenueDailyRollup`.
- New routes: `/api/coach/revenue/overview`,
  `/api/coach/revenue/timeseries`,
  `/api/coach/revenue/clients`.
- Reads (live for `/overview`): `CoachSubscription`, `Invoice`,
  `PaymentFailure`, `User`.

## WHO

- **Sign-off:** founder for KPI defs and reconciliation
  tolerance; backend lead for the rollup table.
- **On the hook:** backend platform.
- **Downstream:** coach console; future A1 Coach Revenue
  Engine.

## WHAT

- **Already exists:** billing module, Stripe webhook receiver,
  the OWNER mini-admin board (platform-wide), the OWNER reports
  CSV surface.
- **Net-new:** one rollup table, one module with three routes,
  one feature flag (`COACH_REVENUE_DASHBOARD_ENABLED`), a
  reconciliation sub-flag, daily cron, three PostHog events
  including `revenue_dashboard.reconciliation_drift_detected`.
- **Non-goals:** no real-time dashboard; no CSV export in v1;
  no Stripe-API live reads (mirror is source of truth); no
  forecasting model; no currency conversion.

## HOW

PR-1 migration + aggregation pure functions + unit tests. PR-2
cron + lock + overview route. PR-3 timeseries + clients routes.
PR-4 design-partner allow-list. PR-5 platform-wide.

## Risks (top three)

1. **Stripe drift** — daily reconciliation sub-job samples 5%
   of yesterday's rollups; weekly OWNER report.
2. **Currency mismatch** — every KPI is reported per-currency;
   console renders the dominant currency and lists the others.
3. **Cron cost at platform scale** — incremental per-coach
   updates only since last rollup; sample-based reconciliation.

## Cross-references

- Spec: [`../../specs/revenue-dashboard.md`](../../specs/revenue-dashboard.md).
- Upstream: existing billing + OWNER metrics surfaces.
- Future consumer: A1 Coach Revenue Engine.
