# Admin Web Dashboard — Enterprise Spec (Draft)

Status: **draft, docs-only**. No runtime, schema, env, migration, or CI
changes ship with this document. The web app described here does not
exist in this repository today; this spec is the source of truth for
the upcoming `tgp-admin-web` (working name) front-end project until that
repository is created and a stub link replaces the body of this file.

This file describes the **OWNER-only** admin web dashboard: a private,
enterprise-grade operator console for The Growth Project. It is
deliberately separate from:

- The mobile app (`tgp-mobile`) — coach + student native experience.
- The coach console BFF (`tgp-coach-console`) — a coach-facing web tool
  consuming `/api/v1/*`. See
  [`coach-console-integration.md`](./coach-console-integration.md).
- The marketing site / `new-website` repo — public, unauthenticated
  trust + acquisition surface. **`new-website` is out of scope here and
  must not absorb any admin functionality.**

The admin dashboard is **admin-only by definition**. Coach and student
tokens MUST receive a clean 403 from the BFF gate; there is no
"degraded" or read-only client view of this surface.

---

## 1. Audience and goals

### 1.1 Primary audience

| Persona | What they need from the dashboard |
|---|---|
| **CEO / founder (Bradley)** | A single Monday-morning view of revenue, growth, churn, AI cost burn, federation health, and any incident the on-call missed. Read-mostly, with a small set of strategic actions (pricing experiments, feature-flag rollouts, mastermind acceptance). |
| **C-suite / executives** | Same KPI surface as the founder, scoped to their function (CFO → revenue/billing/finance federation; COO → support queue + readiness; CTO → integrations health, audit, AI cost). Exports to CSV/JSON for board prep. |
| **TGP operators (ops / billing / support leads)** | Day-job surface: dunning the past-due list, promoting/demoting users, archiving abusive accounts, processing GDPR delete requests, moderating marketplace offers, paying out coach earnings, triaging the support queue. |
| **Customer-success / coach-success** | Coach roster view, mastermind applications, coach health (subscription, last login, roster activity), and 1:1 outreach drafting. |
| **Engineering on-call** | Fast incident-mode read of integrations, smoke status, recent audit entries, recent feature-flag changes, and current rollout state. |

### 1.2 Non-goals

- **Not** a coach- or client-facing surface. No coach ever signs in here.
- **Not** a billing system of record. Stripe is the source of truth;
  this dashboard mirrors via the `CoachSubscription` / `Invoice` /
  `PaymentFailure` tables and the Stripe Customer Portal. We do not
  implement charge/refund here — we link to Stripe.
- **Not** a CRM. We render account state and let operators take
  in-band actions; we do not store sales pipelines, deal stages, or
  prospecting notes.
- **Not** a replacement for the mobile app or coach console.
- **Not** a public marketing site. `new-website` stays the unauthenticated
  surface for `/privacy`, `/terms`, `/security`, `/status`, `/download/*`,
  `/signup`, and `/help/*` (the coach self-serve help is server-rendered
  by this backend per [`help/`](./help/README.md)).

### 1.3 Shape and deployment

- **Web app first.** Single-page application served from a private
  hostname (e.g. `https://admin.thegrowthproject.app`). All API calls go
  to the existing fitness backend `/api/admin/*` surface with the
  operator's Supabase OWNER JWT in the `Authorization` header. No new
  backend hostnames; no new auth model.
- **Optional admin mobile companion** (Phase 2+). A read-mostly native
  surface for incident triage and approvals on the go. Same
  `/api/admin/*` endpoints, same OWNER JWT, no special-case
  authentication. Out of scope for the v1 cut. See §17.
- **Distinct from `new-website`.** The admin app is private, gated, and
  bundles separately. `new-website` deploys to its own surface and
  serves anonymous traffic only. Cross-linking from `new-website` into
  the admin app is forbidden — operators reach the dashboard via a
  bookmark or SSO portal, not a public link.

---

## 2. Authentication, RBAC, and tenancy

### 2.1 Login

- Supabase email/password sign-in, identical to the mobile/coach flow.
- The dashboard reads the JWT, asserts `role === 'owner'` client-side
  for routing, and then **trusts the server** for every authorization
  decision. The class-level `@Roles('owner')` guard on every
  `/api/admin/*` controller is the only authorization that matters.
- Non-OWNER tokens hitting any admin route get a clean 403; the UI
  renders a "this dashboard is restricted to platform owners" page and
  surfaces a "request access" mailto. No partial views.

### 2.2 Role gates inside the dashboard

All operators authenticated here are OWNERs. The dashboard does NOT
introduce a new sub-role layer in the database — it derives a
**capability matrix** client-side from a small set of OWNER-managed
flags exposed via a new (future) `/api/admin/operators` endpoint
(see §11). Until that endpoint ships, every OWNER sees every panel and
the audit log is the accountability mechanism.

| Capability | What it gates | Default for OWNER |
|---|---|---|
| `view:revenue` | Billing/finance KPI tiles, revenue charts | on |
| `view:audit` | Audit log reader and exports | on |
| `view:ai_audit` | AI prompts/responses inspector | on |
| `act:promote` | `POST /admin/users/:id/promote` form | on |
| `act:gdpr_scrub` | Trigger `/admin/gdpr/scrub` (always with confirmation) | on |
| `act:flag_rollout` | Toggle feature flags (when flag service ships) | on |
| `act:payouts` | Run coach payouts (when payouts ship) | on |
| `act:offer_moderation` | Approve / reject marketplace offers (when marketplace ships) | on |

The matrix is **advisory** until it is server-enforced. The first
implementation simply hides UI affordances; the backend is the only
hard gate.

### 2.3 Tenancy

There is no per-tenant scoping. OWNER is the platform-wide superuser by
design. Every screen carries a global `Environment: production` /
`Environment: staging` pill driven by the API base URL the dashboard is
configured against; production and staging are separate browser
sessions and separate URLs.

### 2.4 Audit logging of operator actions

Every state-changing call from the dashboard already lands an
`AuditLog` row through `AuditService.write` on the backend (see
[`audit-and-gdpr.md`](./audit-and-gdpr.md) §"Currently wired sensitive
actions"). The dashboard does not need to log anything client-side; it
reads `/api/admin/audit-log` to render the activity stream. The
dashboard MUST attach a `X-Operator-Action: <verb>` header on
state-changing calls so the backend can echo it into
`metadata.via=admin_console` for forensic clarity. (Backend support is
part of the future PRs in §12.)

---

## 3. Information architecture

### 3.1 Sidebar (top level)

```
Overview
Revenue & Billing
Coaches
Customers
Marketplace
Payouts
AI & Audit
Health & Integrations
Reports & Exports
Privacy & GDPR
Feature Flags
Release & Readiness
Mastermind
Support
Settings
```

Each top-level entry is a route; deep-linking is mandatory (operators
share URLs with each other when triaging). No modals that hide state
in URL params.

### 3.2 Top bar

- Global search (`/api/admin/search?q=`) — single field, returns hits
  across fitness Postgres + finance backend with explicit product pills.
  Same backend the existing console alias uses.
- Environment pill (`prod` / `staging` / `local`).
- Operator avatar → sign out, "switch environment" (just a different
  URL), "view my recent actions" (filters audit log by
  `actor_user_id=me`).
- "Incident mode" toggle (bookmark): pins the Health & Integrations
  panel and the most recent 50 audit entries to the bottom of every
  screen until disabled.

### 3.3 Top-level Overview screen

The **Overview** screen is the C-suite landing view. It aggregates
existing endpoints:

| Tile | Source | Notes |
|---|---|---|
| Active coaches (7d) | `/api/admin/metrics?since_days=7` | Same counter the README documents. |
| Active clients (7d) | `/api/admin/metrics?since_days=7` | |
| MRR (mirrored) | derived from `CoachSubscription` rows in `metrics-overview` | Sourced from Stripe webhook mirror — never synthesized. |
| Past-due count | `/api/admin/reports/billing-past-due` (count only) | Click-through to the dunning worklist. |
| Finance federation health | `/api/admin/finance/health` | Pill: ok / not_found / not_configured / auth_unconfigured / degraded. |
| AI cost burn (7d) | future endpoint (see §12, PR #119) | Until shipped, tile shows `not_yet_available` with a link to this spec. |
| Open support tickets | future endpoint (see §12, PR #124) | Tile hidden until shipped. |
| Mastermind applications pending | future endpoint (see §12, PR #123) | Tile hidden until shipped. |
| Recent activity | `/api/admin/audit-log?limit=20` | Last 20 audit rows. |

Tiles render `unknown` / `not_yet_available` / `not_configured` as
explicit pills, never as zero. **No synthetic data.** This rule is
inherited verbatim from `metrics.md` and `admin-reports.md` and is the
single most important UI invariant.

---

## 4. Screen-by-screen spec

For each screen below: KPI cards (top), primary table, row actions,
side detail panel, and the API the screen depends on. Endpoints
prefixed with `(future)` are not yet built — see §12 for the PR map.

### 4.1 Revenue & Billing

**Purpose:** the CFO landing page, plus the daily dunning worklist.

**KPI cards:**
- MRR (mirrored), MRR delta (30d), trial→paid conversion (90d window),
  churn rate (30d, voluntary vs involuntary), past-due count, average
  invoice value.

**Tables:**
- `Past-due` — `/api/admin/reports/billing-past-due`. Columns: coach
  name, email, plan, amount due, days past due, last attempt,
  Stripe customer link.
- `Recent invoices` — `/api/admin/reports/billing-recent` (future).
- `Subscriptions by status` — grouped read over `CoachSubscription`
  (future endpoint; see §12, PR #117).

**Row actions:**
- "Open in Stripe" — outbound link to the Stripe dashboard.
- "Send dunning email" — wraps the existing operator-side email
  template; future endpoint, gated behind a confirm dialog.
- "Pause / resume subscription" — links to Stripe Customer Portal via
  `/api/v1/admin/coaches/:id/start-subscription` (already exists for
  start) and a future portal-session admin endpoint for pause/resume.
- "Mark grandfathered" — triggers the same backfill the
  `npm run backfill:coach-subscriptions` script uses (future endpoint).

**Confirmations:** every state-changing row action requires a
type-to-confirm modal echoing the coach email and the action verb.

### 4.2 Coaches

**Purpose:** the customer-success landing surface.

**KPI cards:** total coaches, active (7d), trialing, paid, past_due,
canceled, archived, average roster size, top-decile roster size,
% of coaches with `subscription.status='grandfathered'`.

**Tables:**
- `All coaches` — `/api/admin/coaches`. Columns: name, email, plan,
  subscription status, roster size, last activity (7d), invite code.
- `Coach detail` (drawer / right panel) — `/api/admin/coaches/:id` for
  the 7-day activity rollup, plus
  `/api/admin/coaches/:id/overview` (federation alias) for the
  fitness+finance side-by-side, plus
  `/api/admin/coaches/:id/entitlements` for the bundle/status block.

**Row actions:**
- Promote a student to coach (`POST /admin/users/:id/promote`).
- Demote a coach to student (same endpoint, role=student).
  Self-demotion already rejected server-side (400).
- Archive a coach (future endpoint, see §12, PR #118).
- Open coach in finance backend (deep link via federation `account_id`).
- Send invite-link reminder email (future).

### 4.3 Customers

**Purpose:** support and roster-of-rosters view.

**KPI cards:** total clients, active (7d), DAU/WAU/MAU split (sourced
from `/api/admin/product/usage` when finance configured), archived,
GDPR pending.

**Tables:**
- `All clients` — `/api/admin/users?role=student&limit=200`. The
  current endpoint caps at 200; for the listing screen we need a
  paginated variant (future endpoint, see §12, PR #117).
- `Client detail` — `/api/admin/clients/:id` (federation alias) +
  `/api/admin/clients/:id/entitlements` +
  `/api/admin/clients/:id/consent` (consent matrix).

**Row actions:** archive, restore, trigger data export (writes
`DataExportRequest` + emails the user — backend already supports this
via `POST /users/me/data-export`; the admin variant operates on a
target user-id and is a future endpoint, §12 PR #122).

### 4.4 Marketplace & offer moderation

**Purpose:** review and moderate coach-authored marketplace offers.

This module **does not exist yet** in the backend (no `Offer` table, no
`/api/admin/marketplace/*` routes). The screen is specified here so the
backend PRs in §12 land into a consistent UI shape.

**KPI cards:** offers pending review, offers live, offers rejected
(30d), average review SLA.

**Tables:**
- `Pending` — (future) `/api/admin/marketplace/offers?status=pending`.
- `Live` — (future) `/api/admin/marketplace/offers?status=live`.
- `Rejected` — (future) with reason.

**Row actions:** approve, reject (with reason text), request changes,
takedown (with audit reason). Every action lands an audit row via the
existing `AuditService` pattern.

**Hidden until backend ships.** The sidebar entry renders a
`coming soon (PR #120)` placeholder until the endpoints exist; the
spec is here so wiring is mechanical when the PR lands.

### 4.5 Payouts & disputes

**Purpose:** pay coaches their share, handle Stripe disputes.

This module also does not exist yet. The screen specifies the operator
flow so the backend can be built against it.

**KPI cards:** payouts due this week, payouts paid (30d), open disputes,
disputes won/lost (90d).

**Tables:**
- `Payouts queue` — (future) `/api/admin/payouts?status=pending`.
- `Disputes` — (future) `/api/admin/payouts/disputes` (Stripe-sourced).

**Row actions:** mark paid (records a `Payout` row + audit), open
Stripe dispute, attach evidence URL.

**Hidden until backend ships** (§12, PR #121).

### 4.6 AI & Audit

**Purpose:** combined CTO/compliance landing.

**KPI cards:** AI calls (24h / 7d), tokens consumed, estimated cost
(7d), guardrail-suppressed responses (7d), fallback responses (7d).
All tiles depend on a future AI-cost endpoint (§12, PR #119); until
shipped, tiles render `not_yet_available`.

**Tables:**
- `Recent AI prompts/responses` — future `/api/admin/ai/recent`.
- `Audit log` — `/api/admin/audit-log` with filter chips for
  `action`, `target_user_id`, `tenant_coach_id`, `since_days`. The
  filter list mirrors the `AuditAction` constants documented in
  [`audit-and-gdpr.md`](./audit-and-gdpr.md).
- `Audit export` — `/api/admin/reports/audit-summary?format=csv`.

**Row actions on audit:** "open target user" (deep links to coach/client
detail), "open actor" (same), "copy as JSON" for incident postmortems.

### 4.7 Health & Integrations

**Purpose:** real-time read of every integration the platform depends on.

**KPI cards / pills:**
- Finance federation: `/api/admin/finance/health` →
  `ok` / `not_found` / `not_configured` / `auth_unconfigured` /
  `degraded`. Same status semantics as
  [`federation/README.md`](../src/admin/federation/README.md).
- Stripe webhook freshness: derived from the latest
  `StripeProcessedEvent`. Future endpoint (§12, PR #117).
- Supabase auth (JWKS reachable): inferred from successful API calls;
  a dedicated probe endpoint is a future addition (§12, PR #117).
- PostHog: future probe.
- Last security deploy: `/api/system/trust-meta` (already exists, public).
- Migration drift: future endpoint that compares Prisma migration list
  vs `_prisma_migrations` table (§12, PR #117).

**Tables:**
- `Integrations status` — `/api/admin/integrations/status` (already
  exists; only `finance_federation` populated today).
- `Recent webhook deliveries` — future.

**No row actions.** This screen is read-only by design. Restart
actions live in Fly / kubectl / GitHub Actions, not here.

### 4.8 Finance federation

**Purpose:** the Healthie/EHR-style cross-product pane.

This is the existing console alias surface, lifted into a first-class
screen:

- Search bar → `/api/admin/search?q=`.
- Click a hit → drawer with `/api/admin/clients/:id` or
  `/api/admin/coaches/:id/overview`.
- Bundle / per-product status chips from
  `/api/admin/clients/:id/entitlements` etc.
- Product-usage tile from `/api/admin/product/usage` (rendered as
  `degraded` pill when `status !== 'ok'`).

This screen depends entirely on already-merged endpoints (PR #79 + #80).
It can ship in the v1 cut without any new backend PR.

### 4.9 Reports & Exports

**Purpose:** the CSV/JSON downloader the CFO actually uses for board
prep.

This screen is a thin wrapper around `/api/admin/reports`:

- Lists every report in the manifest.
- For each, renders a "format" toggle (`json` / `csv`), the relevant
  filters (`since_days`, `action`, etc.), and a "download" button.
- Recent downloads live in browser localStorage with the operator's
  email — never in the backend.

Reports already shipped (PR baseline, see §12):
`metrics-overview`, `coaches`, `clients`, `billing-past-due`,
`product-usage`, `federation-health`, `audit-summary`. Future reports
are added by the backend without any UI change beyond a manifest
re-render.

### 4.10 Privacy & GDPR

**Purpose:** the operator path for honoring delete / export requests
end-to-end.

**Sections:**
- Pending data-export requests (future
  `/api/admin/data-export-requests` listing endpoint, §12 PR #122).
- "Run GDPR scrub" — wraps `/admin/gdpr/scrub`. Always defaults to
  `dry_run=true`; switching off the dry-run requires a type-to-confirm
  modal that echoes the candidate count first.
- Per-user soft-delete trigger (admin-side variant of
  `DELETE /users/me/account`, §12 PR #122).
- Consent matrix viewer for any client (`/api/admin/clients/:id/consent`).

**Confirmation pattern:** every destructive action shows the candidate
count first, then a type-to-confirm modal echoing the count and the
operator's email, then writes an audit row attributed to the operator.

### 4.11 Feature flags & entitlements

**Purpose:** turn features on and off without a deploy.

The backend does not have a database-driven flag service today (env
vars are the only flag mechanism). This screen specifies the UI that
matches the future `/api/admin/feature-flags` endpoint (§12, PR #125):

- List of flags with current value, last-changed-by, last-changed-at.
- Toggle (boolean) or value editor (string/number) per flag.
- "Roll out to N% of users" slider for percentage flags.
- Every change writes an audit row + a `feature_flag_changed`
  notification to a Slack webhook (configured server-side).

**Hard gate:** flags affecting billing, GDPR, or auth require a second
operator's approval before they take effect. The UI shows the
"awaiting second-approver" state; the backend enforces it.

The entitlements section is read-only and surfaces the bundle-override
table described in [`entitlements.md`](./entitlements.md) §"Phase-2
override-table" — this is documented as additive and mechanical.

### 4.12 Release & readiness

**Purpose:** the engineering-on-call landing surface.

**Tiles:**
- Last deploy time + commit SHA (from
  `/api/system/trust-meta` — already exists).
- Smoke status (last green / last red — future endpoint that pings
  `scripts/smoke.ts` programmatically, §12 PR #126).
- Migration baseline check (future, §12 PR #117).
- Pending readiness checklist for the next deploy
  (`docs/staging-execution-tracker.md` — link out, no in-app editor).
- Operator workflow link to the `release.sh` runbook in
  [`deploy-runbook.md`](./deploy-runbook.md).

This screen is read + link-out only. Deploys are run from CI; the
dashboard never invokes a deploy.

### 4.13 Mastermind applications

**Purpose:** review applications for the high-touch mastermind tier.

Backend not yet built. Screen specifies the operator review flow:

- KPI: pending applications, accepted (30d), rejected (30d).
- Table of pending applications with applicant detail drawer.
- Row actions: accept, reject (with reason), request more info.

Hidden until §12 PR #123 ships.

### 4.14 Support queue

**Purpose:** triage the inbound support email/intake from
`docs/help/contact-support.md`.

Today, support intake routes to email (see `docs/help/support-config.md`).
This screen specifies a future in-product queue (§12, PR #124):

- Inbox of support tickets with status (`new`, `in_progress`,
  `awaiting_user`, `resolved`).
- Drawer with conversation thread.
- Macros for common responses (operator-managed, server-stored).
- Audit row written per status change.

Hidden until backend ships.

### 4.15 Optional admin mobile companion (Phase 2+)

A read-mostly native app that consumes the same `/api/admin/*` surface
with the OWNER JWT. Scope:

- Overview tiles (read-only).
- Audit log stream (read-only).
- Federation health + integrations status (read-only).
- Approve / reject mastermind applications (the only write surface).
- Push notifications for: a new past-due invoice, a federation
  `degraded` transition lasting > 5 minutes, a security-relevant audit
  action (e.g. `user.role_changed` to `owner`).

**Out of scope for v1.** Listed here so the API surface stays compatible
with a future native consumer; specifically, every admin endpoint must
keep returning JSON envelopes that are practical to render on a phone
(no HTML, no streaming).

---

## 5. Backend dependency map

### 5.1 Already shipped (the v1 cut can rely on these)

| Surface | Endpoint | Source |
|---|---|---|
| Promotion / inventory | `/api/admin/coaches`, `/api/admin/coaches/:id`, `/api/admin/users`, `/api/admin/users/:id/promote` | `src/admin/admin.controller.ts` |
| Metrics counters | `/api/admin/metrics?since_days=` | `src/admin/admin.controller.ts` |
| Audit log read | `/api/admin/audit-log` | `src/admin/admin.controller.ts` |
| GDPR scrub trigger | `POST /api/admin/gdpr/scrub` | `src/admin/admin.controller.ts` |
| Consent matrix | `GET /api/admin/clients/:id/consent` | `src/admin/admin.controller.ts` |
| Cross-product search / lookup | `/api/admin/federation/*`, `/api/admin/search`, `/api/admin/coaches/:id/overview`, `/api/admin/clients/:id`, `/api/admin/clients/:id/unified` | `src/admin/federation/`, `src/admin/console/` |
| Entitlement reads | `/api/admin/clients/:id/entitlements`, `/api/admin/coaches/:id/entitlements` | `src/admin/console/` (entitlements types in `src/admin/entitlements/`) |
| Federation health | `/api/admin/finance/health`, `/api/admin/integrations/status` | `src/admin/console/` |
| Product usage | `/api/admin/product/usage` | `src/admin/console/` |
| Reports manifest + CSV/JSON | `/api/admin/reports`, `/api/admin/reports/{metrics-overview,coaches,clients,billing-past-due,product-usage,federation-health,audit-summary}` | `src/admin/reports/` |
| Trust meta (public, but useful) | `/api/system/trust-meta` | `src/system/` |
| Coach billing portal-session admin (start) | `/api/v1/admin/coaches/:id/start-subscription` | `src/v1/` |

### 5.2 Future endpoints required (PR map)

The screens marked `(future)` above depend on the following future
backend PRs. PR numbers are placeholders the parent agent uses to
sequence work; each one is small, additive, and OWNER-gated.

| PR | Surface | Why |
|---|---|---|
| **#117** | Pagination + status grouping for `/api/admin/users`, `/api/admin/subscriptions`, plus a Stripe-webhook freshness probe + a Supabase JWKS probe + a migration-drift probe rolled into `/api/admin/integrations/status`. | Today's `/api/admin/users` caps at 200 and the Customers screen needs server-side paging. Health & Integrations needs more probes. |
| **#118** | `POST /api/admin/coaches/:id/archive` + `POST /api/admin/coaches/:id/unarchive`. | Archive/restore from the Coaches screen without a SQL operator. The audit actions already exist (`coach.client_archived` etc.); this extends them to the coach record itself. |
| **#119** | `/api/admin/ai/cost?since_days=`, `/api/admin/ai/recent`. | Powers the AI tiles on Overview and the AI & Audit screen. Backed by an additive `AICall` mirror table. |
| **#120** | `/api/admin/marketplace/offers` (CRUD + moderation actions). | Marketplace screen. Requires an `Offer` table; migration is additive. |
| **#121** | `/api/admin/payouts`, `/api/admin/payouts/disputes`. | Payouts screen. Requires `Payout` table; integrates with Stripe Connect on the backend. |
| **#122** | `/api/admin/data-export-requests` listing + admin-targeted soft-delete + admin-targeted data-export trigger. | Privacy & GDPR screen end-to-end without a SQL operator. |
| **#123** | `/api/admin/mastermind/applications` (CRUD + accept/reject). | Mastermind screen. Additive table. |
| **#124** | `/api/admin/support/tickets` + thread + macros. | Support queue. Replaces the current email-only intake path described in `docs/help/contact-support.md`. |
| **#125** | `/api/admin/feature-flags` (read + write + audit + percentage rollouts + two-operator approval). | Replaces the env-var-only flag mechanism with a database-backed flag service. **Note:** `BILLING_ENFORCEMENT`, `ALLOW_SELF_SERVICE_BECOME_COACH`, `GDPR_SCRUB_DRY_RUN` stay env-var-driven for safety until this PR lands. |
| **#126** | `/api/admin/release/smoke` (programmatic ping of `scripts/smoke.ts` running in a sandboxed CI runner) + `/api/admin/release/readiness` (returns the unmet items from `staging-execution-tracker.md`). | Release & Readiness screen. |

Every PR above must:
- Reuse `JwtAuthGuard + RolesGuard + @Roles('owner')` at controller class
  level. No exceptions.
- Land an `AuditLog` row through `AuditService.write` for every
  state-changing call. The action constants live in
  `src/audit/audit.actions.ts`; new actions are added there with a
  short comment per existing convention.
- Wrap responses in the `{ data, ... }` envelope used by
  `/api/admin/reports/*` for every list endpoint, and in a flat object
  with explicit `status` for every probe endpoint (mirroring the
  federation `finance.status` pattern).
- Surface degraded states as explicit `status` values, **never** as
  zero or null. This is the same rule the federation layer already
  follows.

### 5.3 What stays out of `/api/admin/*`

- Coach BFF reads and writes (`/api/v1/*`) — those serve the coach
  console and remain subscription-gated for coach tokens.
- Public unauthenticated surfaces (`/privacy`, `/terms`, `/security`,
  `/status`, `/download/*`, `/signup`, `/help/*`, `/join/:code`,
  `/invite/:code`). These belong to `new-website` (or, where they are
  server-rendered, to this backend's `public-pages/`, `help/`, and
  `invite-landing/` modules).
- Coach-self-service billing (`/api/v1/coach/me/billing/*`,
  `/api/coach/billing/*`). The dashboard never renders these for
  coaches; it only reads the OWNER-side `/api/v1/admin/coaches/:id/...`
  variants when surfacing coach billing state.

---

## 6. UX patterns

### 6.1 KPI tiles

- Always show a value, a delta vs a comparison window, a sparkline, and
  a status pill.
- Status pill values are **always** drawn from the explicit `status`
  field on the source endpoint. Pills: `ok`, `degraded`,
  `not_configured`, `auth_unconfigured`, `not_yet_available`,
  `not_found`, `unknown`. Each maps to one color and one icon. The pill
  text is the source of truth for tooltips — no UI-only re-labeling.
- Empty state is a tile that says `not_yet_available` and links to this
  spec. **Never** zero with a green check.

### 6.2 Tables

- Server-side pagination with cursor-based paging where the backend
  supports it (audit log) and offset/limit elsewhere.
- Column persistence per operator (browser localStorage, keyed by
  user-id). No server-side preferences in v1.
- Bulk actions are not in v1. Operators do one-at-a-time with a
  confirm modal. A bulk-action surface can be added in Phase 2 once
  audit-log volume telemetry confirms it is useful.

### 6.3 Drawers / detail panels

- Slide-in from the right with a deep-linkable URL fragment
  (`?detail=user_<id>`).
- Always preserve list scroll position when the drawer closes.
- The drawer is the only place individual record edits happen.
  Top-level tables are read + filter only.

### 6.4 Confirmations

- "Type-to-confirm" for any destructive or irreversible action: the
  modal asks the operator to type the email of the target (for per-user
  actions) or the report name (for bulk operations) before the
  "Confirm" button enables.
- Confirmations show what audit row will be written (`action`,
  `target_user_id`, the small payload) so the operator knows what
  trail they are leaving.
- A 5-second client-side cooldown after every state-changing action
  prevents double-submits; the backend already returns idempotent
  responses for retries on the same call.

### 6.5 Empty / degraded states

- Federation `degraded` → "finance temporarily unavailable, retry"
  pill, fitness block still rendered, audit-log link to the relevant
  probe row.
- Reports `not_configured` → render a "set this env var to enable"
  hint pointing at [`deploy-runbook.md`](./deploy-runbook.md).
- AI tiles `not_yet_available` → link to this spec §5.2 PR #119.

### 6.6 Errors

- 401 → redirect to login.
- 403 → "this action requires a higher capability" panel with a
  request-access mailto. (No silent hide.)
- 5xx → toast plus an "open backend on-call" link to the integrations
  screen.

---

## 7. Audit + safety contract

The dashboard does not bypass any backend safety. Specifically:

- Self-demotion is rejected server-side (`400 Cannot demote yourself`)
  and the dashboard surfaces this as a banner on the user's own
  detail page, not as a click-time error.
- GDPR scrub defaults to `dry_run=true` and the destructive variant
  requires a type-to-confirm modal echoing the candidate count.
- Feature-flag toggles affecting billing / GDPR / auth require a
  second OWNER approval (server-enforced when §12 PR #125 ships;
  UI-stubbed until then).
- Every `POST` / `DELETE` / `PATCH` from the dashboard sends a
  `X-Operator-Action: <verb>` header so the audit row carries
  `metadata.via=admin_console` for filtering.
- The "act-as" pattern (operator impersonating a coach to debug) is
  **explicitly out of scope**. We don't implement it. If a coach needs
  hands-on help, the operator joins a screen-share with the coach in
  their own session.

---

## 8. Tests

The dashboard's own test suite (will live in `tgp-admin-web` once that
repo exists):

- Unit: KPI tile pill mapping (every `status` value must map to a
  defined pill; failing CI when a new value lands without a UI map).
- Unit: confirm-modal echo logic.
- Integration: every screen with a fixture API server returning the
  documented envelope shapes.
- Smoke: a single happy-path test that signs in with an OWNER token,
  loads Overview, opens the audit log, and downloads
  `billing-past-due` as CSV.

Backend-side tests for the dependency map endpoints already live in
`test/finance-admin.client.spec.ts`,
`test/federation.service.spec.ts`,
`test/throttler.module.spec.ts` (guard wiring), and per-PR specs as
the future endpoints in §5.2 land. Every new admin endpoint MUST add
a guard-wiring test to `test/throttler.module.spec.ts`'s walked list.

---

## 9. Rollout

### 9.1 Pre-flight (before the v1 cut goes live)

1. Stand up `tgp-admin-web` repository with the IA in §3.1 and the
   screens that depend only on already-merged endpoints
   (Overview-lite, Coaches, Customers, AI & Audit (audit only),
   Health & Integrations (federation only), Reports & Exports,
   Privacy & GDPR (consent + scrub), Finance federation).
2. Configure private hostname and TLS (e.g.
   `admin.thegrowthproject.app`).
3. Bookmark-only access; no public link from `new-website` or the
   coach console.
4. OWNER bootstrap is unchanged — operators sign in with their
   existing Supabase OWNER credentials.

### 9.2 Phased rollout

| Phase | Surface | Gate |
|---|---|---|
| v1 | Overview-lite, Coaches, Customers, AI & Audit (audit only), Health & Integrations, Reports & Exports, Privacy & GDPR, Finance federation | Already-merged endpoints only |
| v1.1 | Pagination + new probes | After §12 PR #117 |
| v1.2 | Archive coach action | After §12 PR #118 |
| v2 | AI tiles, Marketplace, Payouts, Mastermind, Support | After §12 PRs #119–#124 |
| v2.5 | Feature flags, Release & Readiness | After §12 PRs #125–#126 |
| v3 | Optional admin mobile companion | After v2.5 stabilizes |

### 9.3 Operator handoff

When the v1 admin web app is ready:
- Add a row to [`docs/README.md`](./README.md) operator runbook table
  pointing here (the docs-only PR that introduces this file does
  exactly that).
- Add the dashboard URL + bookmark instructions to
  [`docs/deploy-runbook.md`](./deploy-runbook.md) §"Operator workflow".
- Train operators using
  [`docs/e2e-qa-runbook.md`](./e2e-qa-runbook.md)-style scripted
  exercises against staging.
- Sunset the ad-hoc `curl` recipes in
  [`docs/admin-reports.md`](./admin-reports.md) gradually — they stay
  authoritative for headless / scripted use, but the dashboard becomes
  the default surface.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Operators take destructive actions by mistake (delete / archive / scrub). | Type-to-confirm modal on every destructive action; default `dry_run=true` for GDPR scrub; second-operator approval for billing/auth flag changes. |
| Dashboard becomes a synthetic-data surface (UI fills in zeros for `degraded` / `not_configured`). | Hard rule: every tile renders the explicit `status` value as a pill. CI test that fails when a new status string is referenced without a UI mapping. Inherited verbatim from `metrics.md` and `admin-reports.md`. |
| Scope creep into a CRM / coach-help-desk product. | This file is the line. Anything that is not "an OWNER triaging the platform" goes elsewhere (the coach console, mobile, `new-website`, or a separate tool). |
| Drift between this spec and the backend reality. | Same `route-doc-drift.spec.ts` regression pattern PR #78 introduced; extend it to assert that every endpoint in §5.1 / §5.2 is referenced from this file when it ships. |
| Confusion with `new-website`. | This document is explicit: admin web is private, gated, and must not be linked from the public site. The two repos share zero hostnames. |
| OWNER credential compromise = full dashboard access. | Inherited from the existing OWNER trust model. Mitigations: every action audited with `actor_email_snapshot`; the future feature-flag screen uses two-operator approval for sensitive flags. SSO / hardware-key enforcement is a Phase 3 hardening item and is tracked separately. |
| Admin mobile companion app accidentally exposes write surfaces beyond approve/reject. | Mobile companion is **read-only** plus mastermind approve/reject. Every other action requires the desktop UI. Enforced server-side by inspecting the future `X-Operator-Surface: admin-mobile` header and refusing the write set documented in §17. |

---

## 11. Operator capability matrix (advisory until backend-enforced)

The matrix below is the v1 client-side scope used to hide affordances.
It is **not** the authorization boundary — `/api/admin/*` controllers
remain class-gated by `@Roles('owner')` and that is the only hard gate.

| Capability | Endpoints it implies | UI affordance |
|---|---|---|
| `view:overview` | `/admin/metrics`, `/admin/audit-log`, `/admin/finance/health` | Renders Overview |
| `view:revenue` | `/admin/reports/billing-past-due`, future `/admin/subscriptions` | Renders Revenue & Billing |
| `view:audit` | `/admin/audit-log`, `/admin/reports/audit-summary` | Renders AI & Audit |
| `view:ai_audit` | future `/admin/ai/recent` | Renders AI & Audit AI panel |
| `view:health` | `/admin/finance/health`, `/admin/integrations/status` | Renders Health & Integrations |
| `act:promote` | `/admin/users/:id/promote` | "Promote / demote" button on Coaches and Customers |
| `act:gdpr_scrub` | `/admin/gdpr/scrub` | "Run scrub" button on Privacy & GDPR |
| `act:flag_rollout` | future `/admin/feature-flags` | Toggles on Feature Flags |
| `act:offer_moderation` | future `/admin/marketplace/offers/...` | Approve/reject on Marketplace |
| `act:payouts` | future `/admin/payouts/...` | Mark-paid on Payouts |
| `act:support` | future `/admin/support/tickets/...` | Ticket actions on Support |

When the future `/api/admin/operators` endpoint (§12 PR not yet
allocated; tracked separately) ships, this matrix becomes
server-enforced and operators are added/removed via a dedicated
"Operators" section under Settings.

---

## 12. PR sequencing summary

The PR map in §5.2 is restated here for the parent agent's planning
convenience. Every entry is OWNER-gated, additive (no destructive
migration), audit-logged, and respects the explicit-status convention.

| PR | Purpose | Repo | New tables | New env |
|---|---|---|---|---|
| #117 | Pagination + Stripe/Supabase/migration probes | backend | none | none |
| #118 | Archive/unarchive coach record | backend | none | none |
| #119 | AI cost + recent calls | backend | `AICall` | optional `AI_COST_RETENTION_DAYS` |
| #120 | Marketplace offers + moderation | backend | `Offer`, `OfferModerationEvent` | none |
| #121 | Payouts + disputes | backend | `Payout`, `Dispute` | `STRIPE_CONNECT_*` |
| #122 | Admin GDPR (export listing + admin-targeted scrub/export) | backend | none (uses existing) | none |
| #123 | Mastermind applications | backend | `MastermindApplication` | none |
| #124 | Support tickets + macros | backend | `SupportTicket`, `SupportMacro` | none |
| #125 | Feature-flag service + 2-operator approval | backend | `FeatureFlag`, `FeatureFlagApproval` | optional `FEATURE_FLAGS_SLACK_WEBHOOK` |
| #126 | Programmatic smoke + readiness | backend | none | optional `SMOKE_RUNNER_TOKEN` |

The admin web app itself is a separate front-end repo (`tgp-admin-web`,
to be created) and is not part of this backend's PR sequence.

---

## 13. Acceptance criteria

The v1 dashboard ships when all of the following hold:

1. An OWNER can sign in at the private hostname with their existing
   Supabase credentials and reach Overview without any backend change.
2. Every screen in §4 that depends only on already-merged endpoints
   renders correctly against staging and production.
3. Every state-changing action surfaces a type-to-confirm modal echoing
   the audit row that will be written.
4. Every KPI tile renders the explicit `status` pill from its source
   endpoint and **never** synthesizes a zero or a green check.
5. Non-OWNER tokens hitting any dashboard route receive the 403 panel
   with the request-access mailto.
6. The dashboard is reachable only from a private hostname; no link
   from `new-website` or the coach console points to it.
7. `npm run smoke:staging` and `npm run smoke:prod` continue to pass on
   the backend (the dashboard does not exercise smoke directly; it is a
   client of the same API).
8. The runbook table in [`docs/README.md`](./README.md) gains a row
   pointing here, and the deploy runbook gains a "operators reach the
   dashboard via this URL" note.
9. The capability matrix in §11 is documented and (server-enforced
   variants pending) at least matches the UI affordance set the
   dashboard ships with.
10. No runtime, schema, env, or CI changes ship with this docs-only PR.
    The dashboard ships from its own repository on its own pipeline.

---

## 14. Cross-references

- [Repository root README](../README.md) — env vars, structures, route
  contracts, deployment, smoke contract.
- [`audit-and-gdpr.md`](./audit-and-gdpr.md) — audit log schema and
  every wired action; consent layer; data export and soft-delete
  endpoints.
- [`admin-reports.md`](./admin-reports.md) — operator-side reports
  manifest the dashboard's Reports & Exports screen renders against.
- [`metrics.md`](./metrics.md) — counter shape behind the metrics
  tiles.
- [`entitlements.md`](./entitlements.md) — bundle / per-product status
  block rendered on coach and client detail drawers.
- [`coach-console-integration.md`](./coach-console-integration.md) —
  the *coach* console BFF contract; described here only to make the
  separation between coach and admin surfaces explicit.
- [`deploy-runbook.md`](./deploy-runbook.md) — env validation tiers,
  feature-flag rollout order, federation token rotation.
- [`src/admin/README.md`](../src/admin/README.md),
  [`src/admin/federation/README.md`](../src/admin/federation/README.md),
  [`src/admin/console/README.md`](../src/admin/console/README.md) —
  the live admin endpoint contracts the dashboard renders against.

---

## 15. Open questions

1. Hostname: `admin.thegrowthproject.app` or
   `console.thegrowthproject.app`? Resolve before the front-end repo is
   created. (The latter conflicts with `tgp-coach-console`'s naming;
   recommend `admin.`.)
2. SSO: do we add Google Workspace SSO on top of Supabase email/password
   for OWNER accounts, or stay on Supabase only with hardware-key 2FA?
   Phase 3 hardening question; not blocking v1.
3. Multi-environment switcher: separate browser sessions per
   environment (current default) or in-app environment switcher? The
   blast-radius argument favors separate sessions; revisit only if
   operator feedback says otherwise.
4. Two-operator approval for feature flags: which flag categories
   trigger it? Initial list is billing / GDPR / auth; refine when §12
   PR #125 lands.

---

## 16. What this document does NOT do

- Edit any runtime source under `src/`.
- Edit any Prisma schema or migration.
- Add or modify any environment variable.
- Modify CI, Fly, or smoke configuration.
- Touch `new-website` or its repository.
- Create the `tgp-admin-web` repository — that is a separate, future
  step the parent agent sequences after the v1 endpoint dependency map
  in §5.1 is verified green on production.

The only side effect of merging the PR that introduces this file is one
new row in [`docs/README.md`](./README.md) pointing here.

---

## 17. Optional admin mobile companion — wire contract

Documented here so the §5.1 endpoints stay forward-compatible.

- Same hostname, same OWNER JWT, no new auth model.
- Mobile companion sends `X-Operator-Surface: admin-mobile` on every
  call. The backend whitelists the read set + the mastermind
  approve/reject pair when this header is present and refuses every
  other write. Until that backend check lands, the mobile companion is
  not deployed.
- Push notifications are subscribed via the existing Supabase /
  notifications module — the companion app registers its push token
  the same way the mobile coach app does.
- Notification triggers (sent server-side, not client-polled):
  - `past_due_invoice_new` — a new `PaymentFailure` row landed.
  - `federation_degraded_sustained` — `/admin/finance/health` returned
    `degraded` for ≥ 5 minutes continuously.
  - `audit_high_risk` — an audit row with action ∈
    `{user.role_changed → owner, billing.subscription_canceled,
    feature_flag_changed (when it ships)}`.
- Notifications carry a deep link to the equivalent web-dashboard
  screen for full context.
