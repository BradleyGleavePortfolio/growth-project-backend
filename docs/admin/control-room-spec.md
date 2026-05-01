# Admin Control Room — C-Suite / TGP Operator Spec

> **Status:** docs-only draft. No runtime code, schema, migrations, env,
> CI, or feature-flag changes are introduced by this document. It exists
> to define the **target shape** of the OWNER-facing admin console as a
> dense, Healthie/EHR-style operator control room and to reconcile it
> against the endpoints already shipped under `/api/admin/*`. Future PRs
> implement the gaps; this doc is the contract they are graded against.
>
> **Audience:** OWNER role only (TGP founders, exec staff, and named
> finance/ops operators). Coach and student tokens are 403'd at the
> class-level guard and never see this surface.
>
> **Companion docs:**
> [`docs/metrics.md`](../metrics.md),
> [`docs/admin-reports.md`](../admin-reports.md),
> [`docs/audit-and-gdpr.md`](../audit-and-gdpr.md),
> [`docs/entitlements.md`](../entitlements.md),
> [`src/admin/README.md`](../../src/admin/README.md),
> [`src/admin/federation/README.md`](../../src/admin/federation/README.md),
> [`src/admin/console/README.md`](../../src/admin/console/README.md),
> [`src/admin/reports/README.md`](../../src/admin/reports/README.md),
> [`src/admin/entitlements/README.md`](../../src/admin/entitlements/README.md).

## 1. Why a control room, not a settings page

The admin console is **not a configuration panel**. It is the single
operating-cockpit a C-suite operator opens at the start of every working
day to answer:

1. *Are the lights on?* — is finance reachable, are webhooks idle, is
   anyone past_due, are payment_failures clustered.
2. *Where did the business move?* — coaches added / lost since
   yesterday, ARR delta, MRR delta, client count delta, retention
   curves.
3. *Who is in trouble right now?* — coaches with churning rosters,
   clients whose subscription is past_due, integrations that are
   degraded, audit-log spikes.
4. *Look up any human in the system in one box* — coach, client,
   prospect, deleted user — and see their **entire** product timeline
   without flipping between fitness and finance consoles.

The bar is the Healthie / Athena / Epic operator console, not a SaaS
billing portal. **Density is a feature.** Whitespace, "wizard"-style
flows, and progressive-disclosure card layouts are explicitly rejected
for the daily-driver screens — the operator wants more numbers per
square inch, not fewer.

## 2. Information architecture

The console is a single-page application with the following top-level
nav, in this order, in the left rail:

```
[ Overview ]   <- KPI control room (default landing)
[ People   ]   <- universal search + person profile
[ Coaches  ]   <- coach roster, billing health, retention
[ Clients  ]   <- client roster, entitlements, activity
[ Finance  ]   <- billing, MRR/ARR, dunning, federation health
[ Product  ]   <- DAU/WAU/MAU, feature usage, AI usage
[ Support  ]   <- flagged accounts, SOS, manual interventions
[ Integrations ] <- finance federation, Stripe, Supabase, PostHog, Sentry
[ Audit    ]   <- audit log, role changes, GDPR scrub history
[ Reports  ]   <- one-click CSV/JSON exports (manifest-driven)
[ Settings ]   <- RBAC, feature flags, env posture (read-only)
```

Every screen except `Settings` is read/observe-first; mutating actions
are gated behind a confirmation modal (see §16) and route through an
endpoint that emits an `AuditLog` row.

The top bar carries **the universal person search** (see §6) and a
status strip with five always-visible pills: API health, finance
federation, Stripe webhook lag, Supabase auth, Sentry error rate. The
universal search is global keyboard-bindable (`/`); ⌘K opens a
command-palette superset that also navigates to screens.

## 3. Overview screen — the KPI control room

The default landing. Every number on this screen is an authoritative
counter; nothing is synthesized. (Same posture as
[`docs/metrics.md`](../metrics.md): "if a number is reported, the row
that produced it exists in Postgres.")

### 3.1 KPI cards (top row, six cards)

| Card | Meaning | Source today | Refresh |
|---|---|---|---|
| **ARR** | Annualized run-rate of active+trialing coach subscriptions in cents | `CoachSubscription.status ∈ {active, trialing}` × current `Price.unit_amount` × 12. **Today's `/api/admin/metrics` does not return this; gap §11.A.** | hourly |
| **MRR** | Sum of monthly-equivalent unit_amounts for the same set | Same source as ARR / 12. **Gap §11.A.** | hourly |
| **Coach count** | `User` rows with `role = 'coach'` | `/api/admin/metrics` `users.coaches` (live) | live |
| **Client count** | `User` rows with `role = 'student'` | `/api/admin/metrics` `users.clients` (live) | live |
| **Coaches Δ (30d)** | `coaches_added - coaches_lost` over the window | **Gap §11.B** — needs new derived endpoint | daily |
| **Cash collected (30d)** | `Σ Invoice.amount_paid_cents` where `paid_at >= since` | `/api/admin/metrics` `billing.invoices_paid_amount_cents_in_window` | live |

The card row is sticky; the `since_days` selector at the top right (7 /
30 / 90 / 365 / custom) re-queries every "in window" card. The default
is 30, matching the existing endpoint. The window is reflected in URL
state so the screen is shareable.

### 3.2 ARR / MRR math (canonical)

The math is documented here so finance and engineering can reconcile
without re-reading source:

```
mrr_cents      = Σ over CoachSubscription where status ∈ {active, trialing}
                 of price_unit_amount_cents * (12 / billing_period_months)
arr_cents      = mrr_cents * 12
billing_period = inferred from Price.recurring.interval; monthly = 1, yearly = 12
```

Trial subscriptions are counted in MRR/ARR — they are signed coaches
who have committed; the trialing-vs-active split is rendered as an
adjacent chip on the card. This matches how investor-facing reporting
treats trial seats. If a stakeholder requires "active-only" ARR, the
card supports a one-click toggle that hides trialing — the underlying
endpoint returns both.

A `mrr_cents_breakdown` block is returned alongside so the operator
can see how the number was built. **Today no endpoint computes this;
see §11.A for the new endpoint contract.**

### 3.3 Trend strip (full-width, six small charts)

Beneath the KPI cards, a strip of six sparkline-density charts
(weekly buckets, last 26 weeks, no animation, no legend chrome):

1. ARR — line
2. Coach count (cumulative) — area
3. Coaches added vs. lost (twin bars per week)
4. Active subs vs. past_due (stacked area)
5. Cash collected per week (bars)
6. Payment failures per week (bars)

Each chart is clickable → drills to the corresponding screen with the
window pre-applied.

### 3.4 Recent activity (right rail)

A live tail of the last 50 `AuditLog` rows the OWNER can act on (role
changes, GDPR scrubs, plan moves, billing webhook anomalies, manual
interventions). Hard-paginated with cursor-style "load older". This is
served by the existing `/api/admin/audit-log` route — no new endpoint
needed.

### 3.5 Health strip (top bar, always visible)

Five pills mapped to existing probes:

| Pill | Endpoint | Healthy | Degraded | Down |
|---|---|---|---|---|
| API | (BFF heartbeat — passive) | 2xx in last minute | latency p95 > 1s | no 2xx in 60s |
| Finance | `/api/admin/finance/health` | `status = ok` | `status ∈ {auth_unconfigured, degraded}` | `status ∈ {not_configured, network_error, http_error, timeout, malformed_response}` |
| Webhook | `Invoice` insert lag | < 5min | 5–60min | > 60min — **gap §11.C** |
| Supabase | JWKS reachability | last verify < 5min ago | last verify 5–60min | > 60min — **gap §11.C** |
| Sentry | server error rate | < 1/min | 1–10/min | > 10/min — **gap §11.C** |

## 4. Coaches screen

A dense, sortable, filterable table — Healthie roster style. Default
sort is "most active in last 7d desc". 200-row pages, virtualized.

### 4.1 Column inventory

| Col | Field | Source today | Notes |
|---|---|---|---|
| Coach | `User.name`, `User.email` | `/api/admin/coaches` | Linkified to `/admin/coaches/:id/overview` |
| Joined | `User.created_at` | `/api/admin/coaches` | Relative + absolute on hover |
| Role | `User.role` | `/api/admin/coaches` | Should always be `coach` here; if not, surface a warning chip |
| Plan | derived from `CoachSubscription.stripe_price_id` | **Gap §11.D** — joined view | Needs a price → plan-name lookup |
| Sub status | `CoachSubscription.status` | derivable | active / trialing / past_due / canceled — colored chip |
| Roster | client count | `/api/admin/coaches` `clientCount` | numeric, sortable |
| 7d msgs | last-7d coach messages | `/api/admin/coaches/:id` (per-row) | Aggregate column needs a list endpoint — **gap §11.E** |
| 7d logs | last-7d food logs from roster | `/api/admin/coaches/:id` (per-row) | Same gap |
| MRR | this coach's contribution | from §3.2 breakdown | Gap §11.A includes per-coach split |
| Last seen | `last_login_at` or last action | **Gap §11.F** | needed for "ghost coach" filter |
| Cash 30d | `Σ Invoice.amount_paid_cents` for this coach | derivable, gap §11.D | per-coach |
| Failed pays 30d | count `PaymentFailure` | derivable, gap §11.D | |
| Entitlements | bundle (fitness/finance/perf-os) | `/api/admin/coaches/:id/entitlements` | chip list |
| Finance status | per-coach finance federation status | `/api/admin/federation/coaches/lookup` | colored chip; `not_found` is healthy |

### 4.2 Filters

Faceted, applied via URL query string so views are shareable:

- `q` (free text — name + email)
- `status` (active / trialing / past_due / canceled / no_subscription)
- `plan` (multi-select)
- `joined_within` (24h / 7d / 30d / 90d / 365d / all)
- `min_clients` / `max_clients`
- `entitlement_bundle`
- `finance_status` (ok / degraded / not_found / unconfigured)
- `last_seen_within` ("ghost coach" filter)

### 4.3 Row actions (RBAC-gated, see §15)

- View overview → `/api/admin/coaches/:id/overview`
- Promote / demote → `POST /api/admin/users/:id/promote` (existing; AuditLog'd)
- Open in Stripe (deep link, customer id)
- Open in finance console (deep link, identity-mapped)
- Send password-reset (Supabase admin) — **gap §11.G**
- Suspend (set entitlement override → `suspended`) — **gap §11.H**
- Export this coach's data — uses `/api/admin/reports/coaches?format=csv` filtered

## 5. Clients screen

Dual-purpose: roster lookup, and the screen support uses to triage a
flagged user.

### 5.1 Columns

Coach + role + entitlement bundle + last activity + flagged-status +
finance product status + last log/message timestamps. Same density as
Coaches; same filter / sort discipline.

The columns deliberately omit per-record activity bodies — this is the
same privacy contract documented for the `clients` CSV in
[`docs/admin-reports.md`](../admin-reports.md).

### 5.2 Cohorts (saved filters)

These ship as named cohorts in the left filter rail, mirroring how
operators use the screen day-to-day:

- "New this week"
- "Inactive 14d"
- "Inactive 30d"
- "Past_due"
- "Without coach"
- "Subscribed but inactive 7d"
- "GDPR-scrubbed"
- "Soft-deleted within 30d"

### 5.3 Row actions

- Open profile (§7)
- View all messages (deep link into messaging admin)
- Reassign coach — **gap §11.I** (today: SQL only)
- Initiate GDPR scrub — already exists in `users` module via consent / GDPR endpoints
- Restore soft-deleted — **gap §11.I**

## 6. Universal person search (top bar)

The single most important UX surface in the console. EHR-grade.

### 6.1 Behavior

- One input. No tabs. No "what are you searching for" picker.
- Keyboard-first: focus on `/`, navigate with ↑/↓, open with ⏎,
  open-in-new-tab with ⌘⏎.
- Server-side debounced (250ms); each keystroke after the second
  triggers `GET /api/admin/search?q=…&limit=20`.
- Result rows render in three groups in this order: **Coaches**,
  **Clients**, **Other** (admin / OWNER / unknown). Inside each group
  results sort by relevance then most-recently-active.
- Each row shows: avatar/initial, name, email, role chip, products
  chip (`fitness`, `finance`, `both`), last-seen, and a status dot
  (active / past_due / suspended / scrubbed).
- A row's products chip is sourced from
  `/api/admin/federation/search` so finance-only humans appear even if
  they have no fitness Postgres row.

### 6.2 Today's surface

`/api/admin/search` is the console alias for `/api/admin/federation/search`
(see [`src/admin/console/README.md`](../../src/admin/console/README.md)).
The shape is sufficient for v1. The result row needs four enrichments
not present today:

- per-row last-seen — gap §11.F
- per-row sub status chip — gap §11.D (joined coach view)
- per-row entitlement bundle — already supplied by federation
- per-row "scrubbed" flag — `User.is_deleted` / GDPR worker flag —
  gap §11.J

### 6.3 Empty state

The empty state lists the four most recent administrative actions
("recent activity" mini-feed) so a fresh page never feels dead.

## 7. Person profile (the "patient chart")

Opens from any row click on Coaches, Clients, or universal search.
Single screen, dense, scrolls vertically. Layout (top → bottom):

1. **Header strip** — name, email, role, products, status, IDs (fitness
   user_id, finance account_id, Stripe customer id), copy-to-clipboard
   on each. Quick-action buttons (RBAC-gated): Promote, Suspend, Reset
   password, Initiate scrub, Open in Stripe, Open in finance console.
2. **Identity & metadata** — created_at, signup source (invite_code,
   google, email), last_seen, timezone, locale, marketing consent,
   data-residency flag.
3. **Subscription & billing** (if coach) — current plan, status,
   trial-end, current_period_end, cancel_at_period_end, MRR
   contribution, last 12 invoices (date / amount / status / receipt
   link), last 12 payment failures.
4. **Roster** (if coach) — clients table inline, filterable. Each row
   linkified to that client's profile.
5. **Coach link** (if client) — current coach, archived coaches,
   reassignment history.
6. **Entitlements** — bundle, per-product status, override history
   (when implemented per Phase-2 in [`docs/entitlements.md`](../entitlements.md)).
7. **Activity timeline** — single chronologically-merged feed of:
   `AuditLog` rows for/about this user, `ActivityEvent`,
   `CoachMessage` (counts only), `LoggedFoodEntry` (counts only),
   `Invoice` and `PaymentFailure`, `subscription_updated` PostHog
   events ingested via the audit/event tap. Hard-paginated cursor.
8. **Support flags** — open / closed flags, who set them, why (§10).
9. **Audit log (this user)** — `/api/admin/audit-log?target_user_id=…`
   (existing) rendered inline as a side panel.
10. **Raw record drawer** — collapsed-by-default, exposes the raw JSON
    of the federation lookup so engineers don't need a SQL session for
    routine inspection. Sensitive fields (Stripe customer secret,
    refresh_token if any) are redacted.

### 7.1 Today's data

The bulk of the profile is sourced from
`/api/admin/clients/:id/unified` and `/api/admin/coaches/:id/overview`,
which both delegate to `FederationService` (see
[`src/admin/console/README.md`](../../src/admin/console/README.md)).
The activity timeline aggregator (§7.7) is a new endpoint — see
**§11.K**.

## 8. Finance screen

Single-purpose: billing health, dunning, MRR/ARR drill.

### 8.1 Sections

- **Money this window** — gross collected, refunds (when implemented),
  net, count of paid invoices, count of failed payments.
- **Subscription state breakdown** — active / trialing / past_due /
  canceled chart + table.
- **Past-due dunning queue** — direct render of
  `/api/admin/reports/billing-past-due` (existing). One row per coach,
  with last-attempt date, amount, retries scheduled. Actions: send
  reminder (gap §11.L), open Stripe, mark on-hold.
- **MRR / ARR drill** — by plan, by month, by coach. Source: §11.A
  endpoint.
- **Federation health** —
  `/api/admin/integrations/status` (`finance_federation` block) and a
  link to the finance product's own admin console.
- **Cohort retention** (Phase 2) — coaches added in month M, paid in
  month M+1..M+12. Gap §11.M.

### 8.2 Refund handling

There is no refund mirror table today. Until one ships, the screen
shows refunds as "Inspect in Stripe" deep links rather than a
synthesized number. Same posture as the rest of the metrics surface.

## 9. Product usage screen

Source: `/api/admin/product/usage` (existing — proxies finance
`/usage/product`). Renders DAU / WAU / MAU + role split + EOD /
what-if / coach-notes / milestones counters. When the proxy is
degraded the screen renders a single explainer card showing the
upstream `status` field and prompts the operator to check
`/admin/integrations/status`.

Add per-product split charts for fitness counters (messages, logs,
workouts, AI invocations) sourced from `metrics-overview` and the
PostHog event taxonomy in [`docs/metrics.md`](../metrics.md). When
PostHog and Postgres counters disagree, the Postgres number is the
operator-of-record and PostHog is rendered with a "via PostHog"
caveat.

## 10. Support screen

Where ops sets and clears flags on humans without dropping into SQL.

### 10.1 Flag taxonomy (proposed)

- `payment_at_risk` — auto-set when `PaymentFailure` count ≥ 2 in 14d.
- `inactive_paid_coach` — auto-set when subscription `active` and roster `0`.
- `inactive_paid_client` — auto-set when subscription `active` and no
  log/message in 14d.
- `manual_review` — set by operator with a free-text reason.
- `gdpr_pending` — set automatically when a scrub is initiated; cleared
  by the worker.
- `do_not_contact` — operator-set; suppresses outbound email.

These are not in the schema today (see **gap §11.N**). The doc-only
proposal mirrors the existing append-only `AuditLog` and
`ActivityEvent` posture: flags get an audit row on set/clear, and the
flag table itself is read-mostly.

### 10.2 Screen layout

A queue: every flagged user, oldest-first, with the flag, who set it,
when, and the resolve action. Filter by flag + by coach + by tenant.

## 11. Endpoint inventory (today vs. gap)

This section is the **contract** future runtime PRs are graded against.
Doc-only — none of these are introduced here.

### 11.0 Already shipped (covers the spec partially)

- `GET /api/admin/metrics?since_days=` — counters
- `GET /api/admin/audit-log?…` — forensic feed
- `GET /api/admin/coaches`, `/api/admin/coaches/:id` — roster + 7d
- `GET /api/admin/users?role=&q=&limit=` — basic search
- `POST /api/admin/users/:id/promote` — promotion
- `GET /api/admin/federation/search`, `/clients/lookup`, `/coaches/lookup`
- `GET /api/admin/search` — console alias
- `GET /api/admin/coaches/:id/overview`, `/api/admin/clients/:id`,
  `/api/admin/clients/:id/unified`
- `GET /api/admin/clients/:id/entitlements`, `/api/admin/coaches/:id/entitlements`
- `GET /api/admin/finance/health`
- `GET /api/admin/integrations/status`
- `GET /api/admin/product/usage`
- `GET /api/admin/reports` (manifest + JSON/CSV per report)

### 11.A — MRR/ARR endpoint

`GET /api/admin/finance/mrr` returning:

```json
{
  "as_of": "ISO",
  "currency": "USD",
  "mrr_cents": 0,
  "arr_cents": 0,
  "by_status": { "active": 0, "trialing": 0 },
  "by_plan": [{ "stripe_price_id": "price_…", "name": "Pro", "count": 0, "mrr_cents": 0 }],
  "by_coach": [{ "coach_user_id": "…", "email": "…", "mrr_cents": 0 }]
}
```

Source: `CoachSubscription` × current Stripe `Price` cache
(needs a `Price` mirror table — see §11.D).

### 11.B — Cohort delta endpoint

`GET /api/admin/finance/coach-cohorts?granularity=month&since=…` →
month buckets of `{added, lost, net, retained}` with retention curves.
Source: `User.created_at` for coach role + `CoachSubscription.canceled_at`
+ `User.is_deleted` flag, joined.

### 11.C — Webhook / Supabase / Sentry health probes

Three new internal probes:

- `GET /api/admin/integrations/webhook-lag` — `now() - max(Invoice.created_at)` for the last hour
- `GET /api/admin/integrations/supabase-health` — last successful JWKS verification timestamp from a sliding counter
- `GET /api/admin/integrations/sentry-rate` — last-hour error count via Sentry GraphQL (or expose a local 5xx counter — preferred to avoid an outbound dep)

### 11.D — Price mirror

A `Price` (or extended `CoachSubscription`) table that stores
`stripe_price_id → unit_amount_cents → interval → product_name`. Today
the dashboard cannot show plan name or per-coach MRR without it. Adds
a `prisma migrate` schema row and a Stripe webhook handler for
`price.*` events.

### 11.E — Bulk roster activity

`GET /api/admin/coaches/activity?since_days=` returning a single
payload with `coach_user_id → {messages_7d, logs_7d, workouts_7d}` so
the table doesn't fan out into N requests. Today only the per-coach
detail endpoint computes these.

### 11.F — `last_seen_at` field

Add a `User.last_seen_at` column updated by an idempotent middleware
on auth-bearing requests. Required for the "ghost coach" filter and
the universal-search last-seen chip.

### 11.G — Password reset

`POST /api/admin/users/:id/send-password-reset` proxying Supabase
admin API. Audit'd. RBAC: see §15.

### 11.H — Suspend / unsuspend

`POST /api/admin/users/:id/entitlements/override` with `{ status: "suspended" | "active", reason }`.
Phase-2 of the entitlement override table already sketched in
[`docs/entitlements.md`](../entitlements.md). Audit'd.

### 11.I — Reassign / restore

- `POST /api/admin/clients/:id/reassign-coach` `{ coach_user_id }` — moves the `coach_id`
  link, archives existing coach relationship, audit'd
- `POST /api/admin/users/:id/restore` — clears soft-delete flag if not yet GDPR-scrubbed; rejected after worker has run

### 11.J — Soft-delete / scrubbed surfacing

Universal search and Clients table need a `scrubbed` chip. Source: the
existing GDPR scrub worker (`GdprScrubService`) and `User.is_deleted`
flag. Today the search route does not surface this; one-line
projection change.

### 11.K — Activity timeline aggregator

`GET /api/admin/users/:id/timeline?since=&limit=&cursor=` returning a
chronologically merged feed across `AuditLog`, `ActivityEvent`,
`Invoice`, `PaymentFailure`, `CoachMessage` (counts/aggregations
only — never bodies, per the privacy contract). One endpoint, one
cursor; the screen does not stitch.

### 11.L — Send dunning reminder

`POST /api/admin/finance/past-due/:coach_user_id/remind` — triggers a
templated email through whatever transactional provider is wired,
audit'd. Optional Phase-3.

### 11.M — Cohort retention

`GET /api/admin/finance/retention?granularity=month` — coach cohorts
× retention months matrix. Optional Phase-3.

### 11.N — Support flags

A `SupportFlag` table (`user_id`, `flag`, `reason`, `set_by`, `set_at`,
`cleared_at`, `cleared_by`) and CRUD endpoints under
`/api/admin/support/flags/*`. Audit'd. Read-mostly.

### 11.O — Bulk export of universal search results

`POST /api/admin/search/export` with the same filter set the table
supports, returning a signed-URL CSV. Hits the existing reports
machinery in `src/admin/reports/`.

## 12. UI / table / filter requirements

These are observable contracts for the frontend, regardless of
framework:

- All table screens use a single virtualized table component with:
  client-side sort, server-side filter+pagination, cursor pagination
  (no offset), URL-state-bound filters, sticky headers, sticky first
  column, density toggle (default: compact), CSV export of the current
  view (calls into the corresponding report endpoint).
- All numeric cells right-align. All currency cells render integer
  cents → display dollars with two decimals, never less.
- Status pills carry a tooltip with the underlying status string —
  e.g. the finance pill says `auth_unconfigured`, not just "degraded".
- Date cells render relative (`5m ago`) with absolute on hover
  (`2026-05-01T00:00:00Z`).
- All API errors render as a non-modal inline banner with the request
  id, HTTP status, and the underlying message. Never a silent failure.
- Screens degrade gracefully when finance is unreachable: the finance
  block on a person profile renders the underlying `finance.status`
  envelope ("not_configured", "timeout", etc.) and the rest of the
  screen still works. Same contract as the federation README.

## 13. Acceptance criteria

The console is "shippable" when, on a populated staging environment:

1. **Overview** loads in <1.5s p50 / <3s p95 over a 1k-coach,
   10k-client dataset.
2. **Universal search** returns to first paint in <300ms p50 for a 4-
   character query, and includes coaches, clients, and finance-only
   humans where applicable.
3. **Coaches** and **Clients** screens render 200 rows with all
   columns populated; filter changes re-query without a full reload.
4. **Person profile** for a coach renders identity, subscription, last
   12 invoices, last 12 payment failures, roster, entitlements, and a
   ≥30-day timeline. For a client: identity, coach link, entitlements,
   activity timeline.
5. **Audit log** is searchable by action and by user, paginated with
   `before` cursor, and the cursor is preserved in URL.
6. **Reports** screen lists every report from `/api/admin/reports`
   manifest and downloads each one in <10s for the seeded dataset.
7. **Finance health pill** flips correctly when finance is taken down
   in staging — `not_configured`, `auth_unconfigured`,
   `network_error`, `timeout`, `http_error`, `malformed_response`,
   `not_found`, `ok`.
8. **403 contract**: any non-OWNER token gets a clean 403 from every
   route; a coach token rendering the console URL gets a generic
   "OWNER required" page, not a partial render with empty data.
9. **Audit row**: every mutating action emits an `AuditLog` row whose
   `actor_user_id` is the OWNER who performed it.
10. **No synthetic numbers**: the metrics page in production matches
    the `/api/admin/metrics` payload byte-for-byte for shared fields,
    and any number not in that payload either comes from a documented
    new endpoint above or is rendered with a clear "via PostHog"
    caveat.

## 14. Tests

Per [`src/admin/README.md`](../../src/admin/README.md), the existing
admin surface is exercised through `test/e2e-saas-smoke.spec.ts`,
`test/dto-mass-assignment.spec.ts`, `test/throttler.module.spec.ts`,
and `test/invite-codes.service.spec.ts`. New tests required:

- **Guard sweep** — extend the existing controller-walking test to
  confirm every new admin route in §11 is class-gated by
  `JwtAuthGuard + RolesGuard + @Roles('owner')`.
- **MRR/ARR math** — unit test against a fixture of subscriptions +
  prices, including monthly + yearly intervals + trialing seats.
- **Cohort delta** — unit test for `coaches added vs. lost` over fixed
  windows including coaches who churned and re-signed.
- **Timeline aggregator** — integration test that the merged feed is
  correctly ordered, cursors round-trip, and never includes message
  bodies or food-log details.
- **Universal search export** — round-trip CSV against a small fixture
  and assert the privacy contract (no per-record activity bodies).
- **Federation degradation** — extend the federation tests to assert
  the OK / not_found / not_configured / auth_unconfigured / timeout /
  network_error / http_error / malformed_response branches all surface
  to the console without a 5xx.
- **Audit on every mutator** — for each new POST endpoint in §11, an
  e2e that the request emits an `AuditLog` row with the expected
  `action`, `actor_user_id`, and `target_user_id`.
- **RBAC**: smoke that coach + student tokens get 403 from every new
  route — symmetric to the existing `dto-mass-assignment.spec.ts`
  controller walk.

## 15. Privacy, RBAC, audit controls

- **OWNER-only at the class level.** Same posture as the existing
  admin module — every new route in §11 inherits
  `@UseGuards(JwtAuthGuard, RolesGuard) @Roles('owner')`. No per-row
  tenancy because OWNER is the platform-wide superuser. (See
  [`src/admin/README.md`](../../src/admin/README.md) §security.)
- **Sub-OWNER role split (Phase 2).** A future `OWNER_BILLING`,
  `OWNER_SUPPORT`, `OWNER_READONLY` triad sits below `owner`. Out of
  scope for v1; the doc reserves the names so a future enum addition
  is non-conflicting. The screens are designed to render correctly
  with action buttons hidden when an attribute-level capability is
  absent.
- **No PII in logs.** Server-side analytics already strips a deny-list
  of PII keys (see [`docs/metrics.md`](../metrics.md) §PII handling).
  All new endpoints inherit the same `AnalyticsService.capture`
  posture.
- **Audit row on every read of sensitive surfaces.** For Phase 2
  consider audit-on-read for the universal person profile (so a
  compliance officer can see "OWNER X opened user Y's chart at T").
  The doc reserves the audit action name `admin.profile.read` for it.
- **Append-only AuditLog.** No edits, no deletes; only inserts. Same
  contract as today.
- **Privacy contract for exports.** Same as `clients` CSV in
  [`docs/admin-reports.md`](../admin-reports.md): never per-record
  activity bodies in any bulk export. Search-export (§11.O) inherits
  this contract.
- **GDPR.** Soft-deleted users remain visible in the admin console
  with an explicit "scrubbed" chip until the worker fully scrubs PII.
  Restoring is allowed only before the worker has run; afterwards the
  row's PII is gone and `restore` is rejected (§11.I). Same contract
  as `GdprScrubService`.

## 16. Safety confirmations

Mutating actions never fire on a single click. The console requires:

1. **Dangerous-action modal** — for promote, demote, suspend, scrub,
   reassign-coach, restore. Shows the target user's identity, the
   action, and the audit reason field (required, free text).
2. **Type-the-email confirmation** — for irreversible actions (GDPR
   scrub initiation; demote-self is already rejected server-side).
3. **Out-of-band 2FA challenge** — for actions in the
   "high-risk" set: bulk export, plan-tier override, password reset
   for an OWNER. Implementation hooks into Supabase Auth MFA. Phase 2.
4. **Server-side double-submit guard.** Every mutator endpoint
   requires a `confirmation_token` echoed back from a 1-RPC GET that
   returns the human-readable diff; the token is single-use and
   short-lived. Prevents accidental replay through a stale tab.

Confirmations are rendered consistently — same modal component, same
copy template, no per-screen variant.

## 17. Rollout plan

The console is built behind a feature flag `ADMIN_CONSOLE_V2_ENABLED`
that defaults off. Rollout phases:

| Phase | Timeline | What ships | Gate |
|---|---|---|---|
| 0 | now | this doc | n/a |
| 1 | week 1 | Overview (§3) and Universal search (§6) hooked to existing endpoints; no new gaps from §11 | flag on for OWNERs only |
| 2 | week 2 | Coaches + Clients tables; rows linkified to existing federation endpoints; gaps §11.E and §11.F land | flag on for OWNERs only |
| 3 | week 3 | Person profile (§7) using existing federation + new timeline endpoint §11.K; price mirror §11.D | flag on for OWNERs only |
| 4 | week 4 | Finance screen (§8); MRR/ARR endpoint §11.A; cohort delta §11.B | flag on for OWNERs only |
| 5 | week 5 | Support flags (§10) + reassign / restore / suspend (§11.H/I); password reset §11.G | flag on for OWNERs only |
| 6 | week 6 | Health probes §11.C; cohort retention §11.M; reminder §11.L | flag on for OWNERs only |
| 7 | week 7 | Audit-on-read; sub-OWNER RBAC; type-the-email + 2FA gates | flag remains OWNER-only |

Each phase is a small set of PRs:

- One **runtime PR** behind the flag for the new endpoint(s).
- One **frontend PR** in the admin-console repo that consumes the new
  endpoint and updates the screen.
- One **docs PR** updating this spec to mark the gap closed.

The flag never reaches non-OWNER tokens — it's an OWNER-only kill
switch, not a customer-facing experiment.

## 18. Risks

- **Federation drift.** The fitness Postgres row and finance backend
  record can diverge in subtle ways (email casing, deleted-but-not-
  scrubbed rows). The current `finance.status` envelope mitigates by
  surfacing the divergence rather than papering over it. The risk is
  the operator misreading `not_found` as "missing" rather than
  "healthy"; the universal-search row treatment makes this explicit.
- **Stripe price drift.** Without a `Price` mirror (gap §11.D) the
  dashboard cannot reliably name plans or compute MRR. Until that
  ships, cards that depend on it should hide rather than show a stale
  number — the same posture used elsewhere in the metrics surface.
- **Per-coach activity fan-out.** Today the only per-coach activity
  endpoint is the single-coach detail; rendering the Coaches table
  with 7d msgs + 7d logs would fan out N+1 calls. §11.E exists
  specifically to prevent this anti-pattern from shipping.
- **PostHog ↔ Postgres skew.** Counters disagree when PostHog drops
  events. The console renders Postgres as authoritative and PostHog as
  decorated; a doc note next to any PostHog-sourced number prevents an
  exec from comparing apples to oranges.
- **PII surface area.** The dense-density goal pulls toward "show
  everything"; the privacy contract pushes back. The split is: the
  profile shows enriched per-row data but the bulk exports never carry
  per-record bodies. Confirmations gate destructive actions. Audit
  rows make a leak forensically traceable. None of these alone is
  enough; the combination is the floor.
- **Single-OWNER bus factor.** The console actively discourages a
  one-person operating posture: every mutator emits an `AuditLog`,
  every irreversible action requires a typed confirmation, and the
  Phase-2 sub-OWNER split splits the action space so no one role can
  drop a tenant by themselves.

## 19. Operator handoff

This spec lives at `docs/admin/control-room-spec.md` and is the source
of truth for the admin console's target shape. When a future runtime
PR closes a §11 gap:

1. Open a docs sub-PR that updates the gap row to "shipped in #N" and
   moves it from §11.A–O into §11.0.
2. Cite the new endpoint in the relevant module README
   (`src/admin/README.md`, `src/admin/console/README.md`,
   `src/admin/federation/README.md`, or `src/admin/reports/README.md`).
3. Note the change in `docs/metrics.md` if the endpoint introduces a
   new counter or PostHog event.
4. Add a row to `docs/admin-reports.md` if the endpoint is a new
   report or report format.
5. Confirm the `ADMIN_CONSOLE_V2_ENABLED` flag covers the new code
   path and the existing controller-walking test (§14) still passes.

The OWNER bootstrap path (`scripts/bootstrap-owners.ts`) is the only
mechanism that seeds the OWNER list — it is idempotent and safe to
re-run (see [`src/admin/README.md`](../../src/admin/README.md)
"Operational notes"). New OWNER additions in production go through
the operator workflow defined in `docs/deploy-runbook.md`, not
through ad-hoc DB writes.

---

**This is a docs-only draft.** No runtime code, schema, env, CI, or
migrations change in the PR that introduces this file. The contract
above is graded against future runtime PRs, not enforced by anything
in this repo today.
