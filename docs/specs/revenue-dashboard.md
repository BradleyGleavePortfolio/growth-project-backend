# Spec — Coach revenue dashboard aggregation (B8)

**Roadmap row:** #29.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/29-revenue-dashboard.md`](../architecture/handoff/29-revenue-dashboard.md).
**Cross-references:** PR #119 (roadmap row #29), the existing
billing module (`src/billing/`), the existing OWNER metrics
(`src/admin/metrics.service.ts` and `docs/metrics.md`),
`docs/admin-reports.md` (the OWNER reports surface), the
entitlements doc (`docs/entitlements.md`).

> Coach-side metrics. **Not** OWNER-side. The OWNER metrics
> already exist; this spec is the *coach's* view of their *own*
> business.

---

## WHY

The strategy memo describes B8 as: "pull from Stripe + billing
tables → MRR, active clients, churn, ARPU + 12-week chart." Today
a coach has no in-platform answer to "how much money am I making
this month?" — the `Invoice`, `CoachSubscription`, and
`PaymentFailure` tables (`prisma/schema.prisma:225-280`) carry the
data, but only the OWNER metrics surface aggregates them, and
that surface is platform-wide rather than per-coach.

The revenue dashboard is the coach-side analogue of the OWNER
mini-admin board. It is also the **gate** for several of the
A-level expansion items (A1 Coach Revenue Engine, A7 Outcome
Graph) — both of which need a stable per-coach revenue
projection to be useful.

## WHEN

Trigger conditions:

1. The `CoachSubscription` and `Invoice` mirrors have been
   reconciled against Stripe in staging for at least one full
   billing cycle without drift (a known concern called out in
   the blueprint as "reconcile against Stripe carefully").
2. The OWNER metrics doc (`docs/metrics.md`) is the canonical
   counter taxonomy; this spec extends it without forking.
3. The KPI definitions below are signed off by the founder.

## WHERE

- New module: `src/coach-revenue/` —
  `coach-revenue.module.ts`,
  `coach-revenue.service.ts`,
  `coach-revenue.controller.ts`,
  `aggregations/`.
- New table: `CoachRevenueDailyRollup` (one row per
  `(coach_id, day)`).
- New routes (paths under `/api/`):
  - `GET /coach/revenue/overview` — current snapshot.
  - `GET /coach/revenue/timeseries?weeks=12` — 12-week chart.
  - `GET /coach/revenue/clients` — per-client revenue, paginated.
- Reads (live, on `/overview`):
  - `CoachSubscription`
  - `Invoice`
  - `PaymentFailure`
  - `User` (count of active clients).
- Writes:
  - `CoachRevenueDailyRollup` — populated by a daily cron job.

## WHO

- **Sign-off:** founder for the KPI definitions and the
  reconciliation tolerance; backend lead for the rollup table.
- **On the hook:** backend platform.
- **Downstream consumers:** coach console; future A1 (Coach
  Revenue Engine).

## WHAT

### Already exists

- The billing module (`src/billing/`), Stripe webhook receiver,
  `Invoice`, `CoachSubscription`, `PaymentFailure`.
- The OWNER metrics endpoint (`/api/admin/metrics`) — the
  *platform* view.
- The OWNER admin-reports CSV surface
  (`docs/admin-reports.md`) — for OWNER-side audits.

### Net-new

- One rollup table.
- One module with three routes.
- One feature flag, `COACH_REVENUE_DASHBOARD_ENABLED`.
- A daily cron job that produces the rollup.
- Three PostHog events:
  `revenue_dashboard.{viewed,exported,reconciliation_drift_detected}`.

### Non-goals

- Not a real-time dashboard. The 12-week chart reads the rollup;
  the overview reads live tables but is bounded to the current
  month.
- Not a CSV export. The OWNER reports surface already has CSV;
  the coach view is JSON-only in v1. CSV export is v2.
- Not Stripe-API live reads. All reads come from the local
  `Invoice` / `CoachSubscription` mirror, which is the existing
  source of truth per the README.
- Not a forecasting model. KPIs are descriptive, not predictive.
- Not currency conversion. `Invoice.currency` is reported per
  invoice; the dashboard groups by currency in the v1 contract.

## HOW

Smallest first PR (PR-1):

- Adds the `CoachRevenueDailyRollup` model + migration.
- Adds the empty module shell.
- Adds the aggregation pure functions and unit tests against
  fixture invoices.

PR-2 wires the cron job (BullMQ on `REDIS_URL`) and the
overview route.

PR-3 wires the timeseries and per-client routes.

PR-4 turns the flag on for design partners; PR-5 platform-wide
once one billing cycle of rollup data is verified clean.

## KPI definitions

For the `/overview` snapshot:

- **MRR (current period, USD-equivalent at invoice time, minor
  units, reported per-currency):** sum of
  `CoachSubscription.amount_per_period_minor_units` for active +
  trialing subscriptions for *this coach's clients*. (Note: the
  current schema does not carry an explicit `amount_per_period`
  on `CoachSubscription`; it is derived from
  `Invoice.amount_paid_cents` for the most recent paid invoice.
  Spec confirms this derivation; if the runtime PR adds the
  column, the derivation is replaced.)
- **Active clients:** count of `User WHERE coach_id = self AND
  role = 'student' AND deleted_at IS NULL`.
- **ARPU:** MRR ÷ active clients (zero when active clients = 0;
  not NaN).
- **Churn (30d):** count of `User WHERE coach_id = self AND
  deleted_at IN (last 30 days) AND role_was = 'student'`.
- **Payment failures (30d):** count of `PaymentFailure WHERE
  coach_id = self AND created_at IN (last 30 days)`.

For the 12-week timeseries, each `(coach_id, week)` row carries:

- `mrr_end_of_week_minor_units`
- `active_clients_end_of_week`
- `new_clients_this_week`
- `churned_clients_this_week`
- `invoices_paid_minor_units`
- `failed_payments`

The KPI list above is the *contract*; the rollup table denormalizes
each one as its own column for cheap read.

## Data model sketch

```prisma
model CoachRevenueDailyRollup {
  id                          String   @id @default(uuid())
  coach_id                    String
  coach                       User     @relation("CoachRevenueRollupCoach", fields: [coach_id], references: [id])
  day                         DateTime @db.Date
  // Snapshot KPIs at end-of-day.
  mrr_minor_units             Int      @default(0)
  currency                    String   @default("usd")
  active_clients              Int      @default(0)
  new_clients                 Int      @default(0)
  churned_clients             Int      @default(0)
  invoices_paid_minor_units   Int      @default(0)
  failed_payments             Int      @default(0)
  // Reconciliation hooks.
  computed_at                 DateTime @default(now())
  reconciliation_diff         Int?     // |mirror - stripe-api| on the day this row was computed; null when not checked
  notes                       Json?    // operator-readable diagnostic for outlier rows

  @@unique([coach_id, day], name: "CoachRevenueDailyRollup_unique")
  @@index([coach_id, day])
  @@index([day])
}
```

The `reconciliation_diff` column is the **drift detector** for the
"reconcile against Stripe carefully" requirement: a daily job
samples N rows and checks the local `Invoice` mirror against the
Stripe API; non-zero diffs are alerted.

## API sketch

```
GET /api/coach/revenue/overview
→ 200 {
    asOf: ISO_TIMESTAMP,
    mrr: { minorUnits: int, currency: string }[],   // grouped by currency
    activeClients: int,
    arpu: { minorUnits: int, currency: string }[],
    churn30d: int,
    paymentFailures30d: int,
    nextRenewalAt: ISO_TIMESTAMP | null,
    pastDue: boolean,
  }
  COACH only. Reads live tables; cached in-memory for 60s per
  coach. Returns 200 with empty/zero values for a coach with no
  billing yet (not 404).

GET /api/coach/revenue/timeseries?weeks=12
→ 200 {
    weeks: Array<{
      weekStart: ISO_DATE,
      mrrMinorUnits: int,
      currency: string,
      activeClients: int,
      newClients: int,
      churnedClients: int,
      invoicesPaidMinorUnits: int,
      failedPayments: int,
    }>
  }
  Reads CoachRevenueDailyRollup, aggregates to week buckets.

GET /api/coach/revenue/clients?cursor=...&limit=50
→ 200 {
    clients: Array<{
      clientId: string,
      displayName: string,
      ltvMinorUnits: int,
      currency: string,
      monthlyMinorUnits: int,
      pastDue: boolean,
      lastPaidAt: ISO_TIMESTAMP | null,
    }>,
    nextCursor: string | null
  }
  Per-client revenue contribution; paginated; sorted by
  ltvMinorUnits desc.
```

Throttle: `60 req/min`.

## Cron job

- Schedule: daily at 02:00 UTC. Single-instance lock (Redis
  SETNX, mirroring #22).
- Per-coach iteration over the prior day's data; upserts
  `CoachRevenueDailyRollup`.
- Reconciliation sub-job runs daily at 03:00 UTC: sample 5% of
  yesterday's rollups, fetch corresponding `Invoice` rows from
  Stripe API, compute diff, write to `reconciliation_diff`.
  Diff > $1 triggers a Sentry breadcrumb + PostHog
  `revenue_dashboard.reconciliation_drift_detected`.

## Rollout / feature flags

- **Env var:** `COACH_REVENUE_DASHBOARD_ENABLED=true|false` (default `false`).
- **Reconciliation toggle:** `COACH_REVENUE_RECONCILIATION_ENABLED`
  (default `false` — wired only after the first cycle proves the
  rollup table is sane).
- **Kill-switch behavior:** routes return 404 when off; cron job
  exits at the lock. Rollup rows persist; no migration needed to
  retry.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Cron job lit; 14 days of rollup data accumulate.
  3. Reconciliation lit; alert on drift.
  4. Read routes lit for design partners.
  5. Platform-wide.

## RBAC and privacy

- COACH role required.
- Tenancy: a coach reads only their own rollups and only their
  own clients' invoices.
- The dashboard does **not** surface card-last4 / billing email /
  any payment-instrument detail (that lives in the existing
  billing surface, intentionally siloed).
- OWNER never reads via this surface; the OWNER metrics endpoint
  is the existing OWNER view.
- Audit log: not on read (volume); on `revenue_dashboard.exported`
  (when v2 ships export).
- GDPR scrub: rollups for a deleted coach are cascaded; rollups
  reference `coach_id` only, no client PII.

## Tests

- **Unit (`test/coach-revenue-aggregations.spec.ts`):**
  - MRR derivation from fixture invoices.
  - ARPU = 0 when no clients (not NaN).
  - Per-currency grouping.
  - Off-by-one on month / week boundaries (UTC vs coach
    timezone).
- **Integration (`test/coach-revenue-routes.int-spec.ts`):**
  - Cross-coach 403.
  - 200 with zero values for a fresh coach.
  - Pagination correctness in `/clients`.
- **Cron-job integration:**
  - Idempotent re-run produces the same rollup row.
  - Lock prevents concurrent runs.
- **Reconciliation:**
  - Drift > threshold writes to `reconciliation_diff` and emits
    the PostHog event.
- **Smoke:** the design-partner cohort's overview returns
  values consistent with the OWNER admin-reports CSV.

## Risks

1. **Stripe drift.** The local mirror diverges from Stripe; the
   coach sees a wrong number. *Mitigation:* daily reconciliation
   sub-job; visible drift counter; weekly OWNER report.
2. **Currency mismatch.** A coach has invoices in two
   currencies; ARPU becomes meaningless if blindly summed.
   *Mitigation:* every KPI is reported per-currency. The console
   renders the dominant currency and displays the others.
3. **Timezone confusion.** "Today" in coach time vs UTC produces
   off-by-one bugs at month boundaries. *Mitigation:* the rollup
   is in UTC; the overview surfaces day boundaries to the
   client; coach-side display uses coach timezone for chart
   axes only.
4. **Cron cost.** A platform-wide daily roll-up over thousands
   of coaches may grow expensive. *Mitigation:* the cron is
   per-coach incremental (only days since last rollup); the
   reconciliation samples 5%, not 100%.
5. **PII leakage in `/clients`.** A buggy join exposes another
   coach's clients. *Mitigation:* explicit cross-coach test;
   re-uses the existing roster guard.

## Dependencies

- **`Invoice` / `CoachSubscription` mirror:** reads.
- **OWNER metrics doc (`docs/metrics.md`):** taxonomy extension.
- **Future A1 (Coach Revenue Engine):** depends on this surface.
- **#22 at-risk detector:** the at-risk count surfaces in the
  overview as a count alongside payment failures (read-only,
  cross-link to the at-risk dashboard).

## Acceptance criteria

- [ ] Migration applied.
- [ ] Cron job runs daily; rollups accumulate.
- [ ] Reconciliation runs daily and surfaces drift.
- [ ] Three routes return the standard envelope.
- [ ] Cross-coach 403 covered.
- [ ] OWNER metrics doc extended with the new event family.
- [ ] Design-partner cohort confirms the numbers match their
      external sources within tolerance.

## Operator handoff

- **Kill-switch:** `COACH_REVENUE_DASHBOARD_ENABLED=false`.
- **Reconciliation kill-switch:**
  `COACH_REVENUE_RECONCILIATION_ENABLED=false`.
- **Drift alert:** OWNER report
  `/api/admin/reports/coach-revenue-drift` lists rollups whose
  `reconciliation_diff` exceeds the threshold.
- **Rollback:** if the rollup table is corrupted, truncate
  `CoachRevenueDailyRollup` and re-run the backfill script
  (cron computes idempotently).
- **Runbook entry:** added under "Background jobs" + "Coach-side
  surfaces."
