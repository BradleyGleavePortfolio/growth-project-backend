# Admin console — screens addendum

Companion to [`control-room-spec.md`](./control-room-spec.md). The
canonical control-room spec covers Overview, Coaches, Clients,
Universal search, Person profile, Finance, Product usage, and
Support across §3–§10. This addendum documents the additional
screens the superseded PR #127 carried in its §4 that did not
migrate into `control-room-spec.md` §3–§10 verbatim, so the console
has a complete screen inventory.

Each section below mirrors the structural posture of §3–§10 of the
canonical spec: purpose sentence, KPI cards or table columns, row
actions cross-referenced to the [`deployment-and-rbac.md`](./deployment-and-rbac.md)
§3 capability matrix, an endpoint split between "shipped today"
(citing §11.0 in the canonical spec) and "future gap" (cross-
referenced to the §11.A–O letters there and the PR numbers in
[`pr-sequence.md`](./pr-sequence.md)), and a small acceptance
criteria list.

**Important — consumer-only flag.** Screens #7 (Marketplace & Offer
Moderation), #8 (Payouts & Disputes), and #9 (Support Queue) are
**NOT** part of admin-console runtime. The marketplace / Stripe
Connect / commerce runtime is owned by the **#125 commerce wave**;
the support-ticket runtime is owned by the **#126 engagement /
retention wave**. The admin console **consumes** the moderation,
payout, and ticket endpoints those expansion PRs ship. Schema and
runtime contracts for those three screens live in the corresponding
expansion specs, not in this directory. Screens #1–#6 are first-
class admin-console screens and follow the same shipped/gap split
as the canonical spec.

---

## 1. AI & Audit

**Purpose.** Combined CTO/compliance landing surface that pairs AI
prompt/response inspection with the existing forensic audit-log
reader, plus one-click CSV export for incident postmortems.

### 1.1 KPI cards

| Card | Meaning | Source |
|---|---|---|
| AI calls (24h / 7d) | `count(AICall) since now-window` | future `/admin/ai/recent` (PR #119) |
| Tokens consumed (7d) | `Σ AICall.tokens` | future `/admin/ai/cost` (PR #119) |
| Estimated cost (7d) | tokens × per-model rate | future `/admin/ai/cost` (PR #119) |
| Guardrail-suppressed (7d) | `AICall.outcome='suppressed'` | future `/admin/ai/cost` (PR #119) |
| Fallback responses (7d) | `AICall.outcome='fallback'` | future `/admin/ai/cost` (PR #119) |

Until the AI endpoints ship every AI tile renders
`not_yet_available` with a tooltip pointing to `pr-sequence.md`.
The audit half is fully populated today.

### 1.2 Tables

- `Recent AI prompts/responses` — future
  `GET /admin/ai/recent?since=&limit=&cursor=`. Hard-paginated
  cursor; bodies redacted per the deny-list in `docs/metrics.md`
  §PII handling.
- `Audit log` — `GET /api/admin/audit-log` (shipped). Filter chips:
  `action`, `target_user_id`, `tenant_coach_id`, `since_days`. The
  vocabulary mirrors `AuditAction` in `docs/audit-and-gdpr.md`.
- `Audit summary export` —
  `GET /api/admin/reports/audit-summary?format=csv` (shipped
  manifest entry); inherits the no-synthetic-data invariant from
  `control-room-spec.md` §3.

### 1.3 Row actions (RBAC-gated)

- **Open target user / Open actor** — deep link into the §7 person
  profile in `control-room-spec.md`. Capability: `view:audit`
  (`deployment-and-rbac.md` §3).
- **Copy as JSON** — local clipboard write of the audit row, no
  API call. Capability: `view:audit`.
- **Export filtered audit** — calls
  `/api/admin/reports/audit-summary` with the active filter set.
  Capability: `view:audit`.
- **Inspect AI call** — opens the recent-call drawer (future).
  Capability: `view:ai_audit`.

The screen is read-only; no mutators, no confirmation modals.

### 1.4 Endpoint dependencies

- **Shipped today** (per `control-room-spec.md` §11.0):
  `GET /api/admin/audit-log`, `GET /api/admin/reports`,
  `GET /api/admin/reports/audit-summary` (CSV).
- **Future gap.** `GET /api/admin/ai/recent` and
  `GET /api/admin/ai/cost`, both rolled up under PR #119 in
  `pr-sequence.md` (new `AICall` mirror table).

### 1.5 Acceptance criteria

1. The audit half renders correctly against shipped
   `/api/admin/audit-log` with no AI dependency.
2. AI tiles render `not_yet_available` (never zero, never "—")
   until PR #119 lands; afterwards they populate with no UI-side
   change beyond hooking the data source.
3. Exporting the active audit filter produces a CSV byte-for-byte
   identical to a direct `GET /api/admin/reports/audit-summary`
   with the same query string.

---

## 2. Reports & Exports

**Purpose.** A thin, manifest-driven downloader for every report
the backend exposes under `/api/admin/reports`. The CFO uses it for
board prep; support uses it for one-off cohort pulls. No KPI cards
— the screen is a single table whose rows are reports.

### 2.1 Table columns

| Col | Field | Source | Notes |
|---|---|---|---|
| Report | `manifest[i].id` | `GET /api/admin/reports` (shipped) | Linkified to a description popover. |
| Description | `manifest[i].description` | shipped | One-line operator summary. |
| Formats | `manifest[i].formats` | shipped | Toggle: `json` / `csv` per manifest. |
| Filters | `manifest[i].filters` | shipped | Inline inputs (`since_days`, `action`, …); defaults match the manifest. |
| Last run (this session) | localStorage | client-only | Operator email + timestamp; never persisted server-side. |
| Download | n/a | shipped | One-click `GET /api/admin/reports/<id>?format=…&…` |

Reports already shipped per the manifest: `metrics-overview`,
`coaches`, `clients`, `billing-past-due`, `billing-recent` (when
present), `product-usage`, `federation-health`, `audit-summary`.
Future reports added backend-side appear here automatically on the
next manifest fetch — no UI change required.

### 2.2 Row actions (RBAC-gated)

Capability scales with report sensitivity per
`deployment-and-rbac.md` §3:

- `coaches`, `clients`, `metrics-overview`, `product-usage`,
  `federation-health` → `view:overview`.
- `billing-past-due`, `billing-recent` → `view:revenue`.
- `audit-summary` → `view:audit`.
- Future bulk-export-of-search → `act:bulk_export` (rendered on
  universal search, not here; gap §11.O in the canonical spec).
- **Re-run with different filters** — same capability as the
  report.
- **Copy URL with current filters** — local-only; produces a
  shareable URL for the next OWNER.

### 2.3 Endpoint dependencies

- **Shipped today** (per `control-room-spec.md` §11.0):
  `GET /api/admin/reports` (manifest + per-report JSON/CSV).
- **Future gap.** None for the v1 cut. New reports surface
  automatically as backend PRs add them.

### 2.4 Acceptance criteria

1. The screen lists every report in the live `/api/admin/reports`
   manifest with no hardcoded list — adding a report server-side is
   sufficient to make it appear.
2. Each report's CSV download completes in <10s for the seeded
   staging dataset (mirrors `control-room-spec.md` §13).
3. **No-synthetic-data invariant.** No report is computed
   client-side; every byte comes from `/api/admin/reports/<id>`.
   Errors surface inline with request id, HTTP status, and message
   per `control-room-spec.md` §12 — never a fabricated CSV.

---

## 3. Privacy & GDPR

**Purpose.** Operator surface for honoring delete and export
requests end-to-end. Wraps the existing `/admin/gdpr/scrub`
endpoint, surfaces scrubbed-row state on universal search and
Clients (closing gap §11.J of `control-room-spec.md`), and enforces
the type-the-email confirmation contract from the canonical spec
§16. Sectioned, not tiled — each section is a worklist, not a
counter.

### 3.1 Sections

| Section | Source |
|---|---|
| Pending data-export requests | future `GET /api/admin/data-export-requests` (gap, PR #122) |
| Scrub candidates (dry-run) | `POST /api/admin/gdpr/scrub` with `dry_run=true` (shipped) |
| Recently scrubbed (90d) | `GET /api/admin/audit-log?action=user.gdpr_scrubbed` (shipped) — closes §11.J |
| Per-user soft-delete | future admin-side variant of `DELETE /users/me/account` (gap, PR #122) |
| Consent matrix viewer | `GET /api/admin/clients/:id/consent` (shipped) |

Recently-scrubbed columns: `scrubbed_at`, `target_user_id`,
`actor_user_id` (operator), `metadata.reason`,
`metadata.worker_run_id` — all projections of `AuditLog` rows; no
new endpoint needed.

Scrubbed users continue to surface on universal search and Clients
with a `scrubbed` chip until the worker fully removes PII — the
`control-room-spec.md` §11.J surfacing requirement, satisfied by
reading the same audit rows.

### 3.2 Row actions (RBAC-gated)

- **Run scrub (dry-run)** — `POST /admin/gdpr/scrub` with
  `dry_run=true`. Capability: `act:gdpr_scrub`. No type-the-email
  required because nothing mutates.
- **Run scrub (live)** — `POST /admin/gdpr/scrub` with
  `dry_run=false`. Capability: `act:gdpr_scrub`. Requires the
  type-the-email confirmation modal per `control-room-spec.md` §16
  point 2: the OWNER types the candidate user's email exactly
  before the button enables, and the screen first echoes the
  dry-run candidate count.
- **Restore soft-deleted** — calls future
  `POST /api/admin/users/:id/restore` (gap §11.I in the canonical
  spec). Rejected server-side once the worker has scrubbed PII;
  the rejection surfaces inline.
- **Open person profile** — deep link into
  `control-room-spec.md` §7.

### 3.3 Endpoint dependencies

- **Shipped today** (§11.0): `POST /api/admin/gdpr/scrub`,
  `GET /api/admin/audit-log`, `GET /api/admin/clients/:id/consent`,
  `GET /api/admin/clients/:id`.
- **Future gap.** `GET /api/admin/data-export-requests` and admin-
  targeted soft-delete (PR #122 in `pr-sequence.md`);
  `POST /api/admin/users/:id/restore` (gap §11.I); scrubbed-chip
  projection on universal-search payloads (gap §11.J — one-line
  projection change).

### 3.4 Acceptance criteria

1. Dry-run round-trips against `/admin/gdpr/scrub` and renders the
   candidate count without mutating anything.
2. The live-scrub button is disabled until the operator types the
   candidate email exactly; on submit the request body carries the
   echoed email and an `AuditLog` row lands with the OWNER's
   `actor_user_id` (per `control-room-spec.md` §15).
3. Recently-scrubbed worklist matches a direct
   `GET /api/admin/audit-log?action=user.gdpr_scrubbed` byte-for-
   byte for shared fields.

---

## 4. Feature Flags & Entitlements

**Purpose.** Operator surface for turning features on and off
without a deploy. **Out of scope for v1.** Documented here so the
phase-7 row in `control-room-spec.md` §17 has a UI target the
future runtime PR #125 can render against. Cross-reference
`pr-sequence.md` for the exact PR row — the feature-flag service
PR number and the commerce-wave PR number both surface as #125 in
the `pr-sequence.md` index but are distinct runtime work items.

Single table of flags with an inline editor; no KPI cards. The
entitlements half is a read-only render of the override table
sketched in `docs/entitlements.md` §"Phase-2 override-table", not
an editor.

### 4.1 Table columns

| Col | Field | Source |
|---|---|---|
| Flag | `FeatureFlag.key` | future, PR #125 |
| Type | `FeatureFlag.type` (`bool` / `string` / `number` / `percent`) | future, PR #125 |
| Current value | `FeatureFlag.value` | future, PR #125 |
| Last changed at / by | `FeatureFlag.updated_at`, `last_changed_by` | future, PR #125 |
| Approval state | `FeatureFlagApproval.state` | future, PR #125 |
| Audit | linked `AuditLog` rows | shipped audit-log route, used as a viewer |

### 4.2 Row actions (RBAC-gated)

- **Toggle (bool) / edit value (string/number) / move rollout
  slider (percent)** — capability: `act:flag_rollout`
  (`deployment-and-rbac.md` §3).
- **Hard gate.** Flags affecting billing, GDPR, or auth require a
  second OWNER's approval before the change takes effect. The UI
  shows the "awaiting second-approver" state; the backend enforces
  it. The capability matrix entry controls the affordance, not the
  gate.
- **Rollback** — reverts to the prior `FeatureFlag.value`; same
  capability + same approval gate where applicable.
- **Open audit thread** — deep links into the §1 AI & Audit screen
  filtered to `feature_flag_changed` rows for this key.

### 4.3 Endpoint dependencies

- **Shipped today.** None for the editor surface. The audit thread
  reuses `GET /api/admin/audit-log` (§11.0). Entitlements read-only
  block consumes `GET /api/admin/clients/:id/entitlements` and
  `GET /api/admin/coaches/:id/entitlements` (both shipped).
- **Future gap.** Entirely PR #125 in `pr-sequence.md`:
  `GET /api/admin/feature-flags`,
  `PATCH /api/admin/feature-flags/:key`,
  `POST /api/admin/feature-flags/:key/approvals`; new tables
  `FeatureFlag`, `FeatureFlagApproval`; optional
  `FEATURE_FLAGS_SLACK_WEBHOOK`.

### 4.4 Acceptance criteria

1. The screen is hidden behind `ADMIN_CONSOLE_V2_ENABLED` and the
   sidebar entry renders a `coming soon (PR #125)` placeholder
   until the runtime endpoints exist (matches `control-room-spec.md`
   §17 phase 7).
2. Once shipped, every flag change emits an `AuditLog` row with
   `action = feature_flag_changed` and the OWNER's
   `actor_user_id`, matching the audit invariant in
   `control-room-spec.md` §15.
3. Billing / GDPR / auth-class flags render the
   "awaiting second-approver" state and refuse the change until a
   second OWNER approves — UI affordance only; the backend is the
   authorization boundary.

---

## 5. Release & Readiness

**Purpose.** Engineering-on-call landing surface. Pairs the
already-public deploy metadata from `/api/system/trust-meta` with
programmatic smoke-test status and the §11.C health probes from
`control-room-spec.md` so an on-call has a single page at incident
time. Read + link-out only — deploys are run from CI, not the
dashboard.

### 5.1 KPI tiles

| Tile | Meaning | Source |
|---|---|---|
| Last deploy | timestamp + commit SHA + environment | `GET /api/system/trust-meta` (shipped, public) |
| Smoke (last green / last red) | timestamp + failed-step name | future, PR #126 |
| Webhook lag | `now() - max(Invoice.created_at)` | gap §11.C |
| Supabase reachability | last successful JWKS verification | gap §11.C |
| Sentry rate | last-hour 5xx count | gap §11.C |
| Migration drift | Prisma list vs `_prisma_migrations` | gap §11.C / PR #117 |

### 5.2 Tables

- `Recent smoke runs` — future
  `GET /api/admin/smoke/runs?limit=` (PR #126). Status, duration,
  failed step (if any).
- `Pending readiness checklist` — link out to
  `docs/staging-execution-tracker.md`. No in-app editor.
- `Operator workflow` — link out to `docs/deploy-runbook.md`.
  Reference link only.

### 5.3 Row actions (RBAC-gated)

- **Run smoke now** — `POST /api/admin/smoke/run` (gap, PR #126).
  Capability: derived from `view:health` plus a Phase-2
  `act:run_smoke` reservation (not yet present in
  `deployment-and-rbac.md` §3; reserved for `control-room-spec.md`
  §17 phase 6).
- **Open smoke logs / open deploy in CI** — outbound deep links;
  client-only, no API calls.

The "run smoke" button triggers a read-only smoke run, not a
deploy. The screen has no destructive actions.

### 5.4 Endpoint dependencies

- **Shipped today** (§11.0): `GET /api/admin/integrations/status`,
  `GET /api/admin/finance/health`, `GET /api/system/trust-meta`
  (public, used here as a read).
- **Future gap.** `GET /api/admin/integrations/webhook-lag`,
  `GET /api/admin/integrations/supabase-health`,
  `GET /api/admin/integrations/sentry-rate` (all gap §11.C);
  migration-drift probe (PR #117); `POST /api/admin/smoke/run` and
  `GET /api/admin/smoke/runs` (PR #126).

### 5.5 Acceptance criteria

1. The deploy tile populates today against shipped
   `/api/system/trust-meta` with no other dependency.
2. Health probes flip from `pending` to live values as the §11.C
   probes ship; the screen never synthesizes a green check
   (matches §3.5 health-strip posture in `control-room-spec.md`).
3. The smoke section is hidden behind `ADMIN_CONSOLE_V2_ENABLED`
   and renders a `coming soon (PR #126)` placeholder until the
   smoke endpoint ships.

---

## 6. Mastermind Applications

**Purpose.** Review queue for incoming applications to the high-
touch mastermind tier. The only screen on which the optional admin
mobile companion (see `deployment-and-rbac.md` §5) is permitted to
perform writes — specifically the approve/reject pair, gated by
`X-Operator-Surface: admin-mobile`.

### 6.1 KPI cards

| Card | Meaning | Source |
|---|---|---|
| Pending applications | `count where status='pending'` | future, PR #123 |
| Accepted (30d) | `count where status='accepted' and decided_at >= now-30d` | future, PR #123 |
| Rejected (30d) | same with `status='rejected'` | future, PR #123 |
| Average review SLA | `avg(decided_at - created_at)` | future, PR #123 |

### 6.2 Table columns

| Col | Field | Notes |
|---|---|---|
| Applicant | `MastermindApplication.applicant_user_id` joined to `User` | Linkified to `control-room-spec.md` §7. |
| Submitted | `MastermindApplication.created_at` | Relative + absolute on hover (per §12 of canonical spec). |
| Status | `MastermindApplication.status` | `pending` / `accepted` / `rejected` / `more_info` chip. |
| Reviewer | `MastermindApplication.decided_by` | OWNER who decided; null while pending. |
| Decided at | `MastermindApplication.decided_at` | null while pending. |
| Reason | `MastermindApplication.reason` | Free text; truncated with hover. |

The `MastermindApplication` table is named in PR #127 §12 and
carried forward as PR #123 in `pr-sequence.md`.

### 6.3 Row actions (RBAC-gated)

- **Approve / Reject (with reason) / Request more info** —
  `POST /api/admin/mastermind-applications/:id/{approve,reject,request-info}`
  (future, PR #123). All audit'd. Capability: a future
  `act:mastermind_review` reservation (Phase-2 addition to
  `deployment-and-rbac.md` §3; until then, every OWNER sees the
  affordance).
- **Open applicant profile** — deep link into
  `control-room-spec.md` §7.

All three mutators are wrapped by the `control-room-spec.md` §16
dangerous-action modal (target identity + reason field). The admin
mobile companion is permitted to call only approve and reject, per
the `X-Operator-Surface: admin-mobile` whitelist documented in
`deployment-and-rbac.md` §5.

### 6.4 Endpoint dependencies

- **Shipped today.** None. Hidden behind `ADMIN_CONSOLE_V2_ENABLED`
  until PR #123 lands.
- **Future gap.** Entirely PR #123: new table
  `MastermindApplication`;
  `GET /api/admin/mastermind-applications?status=&since_days=&cursor=`;
  the three mutator routes above; reserved audit actions
  `mastermind.application_{approved,rejected,more_info_requested}`.

### 6.5 Acceptance criteria

1. The screen renders a `coming soon (PR #123)` placeholder until
   the runtime ships, mirroring the hidden-screen posture from
   PR #127 §4.13 and `control-room-spec.md` §17.
2. Once shipped, each of the three mutators emits an `AuditLog`
   row with the OWNER's `actor_user_id` and the application id as
   `target_resource_id` (per `control-room-spec.md` §15).
3. The admin mobile companion can call approve/reject (and only
   those two) when `X-Operator-Surface: admin-mobile` is set; any
   other write attempt from that surface is refused server-side
   per `deployment-and-rbac.md` §5.

---

## 7. Marketplace & Offer Moderation — CONSUMER-ONLY

**Not part of admin-console runtime.** The marketplace runtime —
`Offer`, `OfferModerationEvent`, public coach-storefront read
paths, moderation hooks — is owned by the **#125 commerce wave**
(specifically the Coach Storefronts and Offers work). The admin
console **consumes** the moderation endpoints PR #125 ships and
renders them inside this screen; it does not own them, define
their schema, or control their deploy cadence. The runtime
contract lives in the #125 commerce expansion spec.

**Purpose.** Operator review of coach-authored marketplace offers
once the commerce-wave runtime ships. Until then the sidebar entry
renders a `coming soon (PR #125, commerce wave)` placeholder.

### 7.1 KPI cards (consumed)

- Offers pending review —
  `GET /api/admin/marketplace/offers?status=pending` (owned by
  PR #125).
- Offers live — same with `status=live`.
- Offers rejected (30d) — same with
  `status=rejected&since_days=30`.
- Average review SLA — derived field on the same payload.

### 7.2 Table columns (consumed)

| Col | Source (consumed) |
|---|---|
| Offer | `Offer.title`, `Offer.coach_user_id` joined to `User` |
| Coach | linkified to `control-room-spec.md` §7 |
| Submitted | `Offer.submitted_at` |
| Status | `Offer.moderation_status` |
| Last action | latest `OfferModerationEvent` |
| Reviewer | latest `OfferModerationEvent.actor_user_id` |

### 7.3 Row actions (RBAC-gated, consumed)

- **Approve / reject (with reason) / request changes** —
  `POST /api/admin/marketplace/offers/:id/{approve,reject,request-changes}`
  (owned by PR #125). Capability: `act:offer_moderation`
  (`deployment-and-rbac.md` §3).
- **Takedown (with audit reason)** —
  `POST /api/admin/marketplace/offers/:id/takedown`. Same
  capability. Type-the-email confirmation per
  `control-room-spec.md` §16 because takedown is destructive on
  the coach-facing surface.

### 7.4 Endpoint dependencies

- **Shipped today.** None.
- **Owned by PR #125 (commerce wave), not by admin-console PRs.**
  Consumer hooks only here; the admin console does not gate or
  block PR #125 and is not blocked by a missed PR #125 milestone —
  the screen simply remains in `coming soon` state.

### 7.5 Acceptance criteria

1. Sidebar entry is a `coming soon (PR #125, commerce wave)`
   placeholder until the commerce-wave endpoints ship.
2. Every moderation action emits an `AuditLog` row server-side via
   PR #125's `AuditService.write` calls — not duplicated client-
   side.
3. Consumer surface degrades gracefully when the commerce runtime
   is unreachable: the screen surfaces the inline error banner per
   `control-room-spec.md` §12, never a synthesized moderation
   state.

---

## 8. Payouts & Disputes — CONSUMER-ONLY

**Not part of admin-console runtime.** The payouts and disputes
runtime — `Payout`, `Dispute`, Stripe Connect onboarding, payout
ledger, dispute state machine — is owned by the **#125 commerce
wave** (Stripe Connect / payouts work). The admin console consumes
the resulting endpoints; it does not own Stripe Connect or the
payout ledger.

**Purpose.** Operator surface for paying coaches their share and
handling Stripe disputes once the commerce-wave runtime ships.
Until then the sidebar entry renders a
`coming soon (PR #125 / Stripe Connect)` placeholder.

### 8.1 KPI cards (consumed)

- Payouts due this week — `GET /api/admin/payouts?status=pending`.
- Payouts paid (30d) — same with `status=paid&since_days=30`.
- Open disputes — `GET /api/admin/payouts/disputes?status=open`.
- Disputes won/lost (90d) — same with `since_days=90`.

### 8.2 Table columns (consumed)

| Col | Source (consumed) |
|---|---|
| Coach | `Payout.coach_user_id` joined to `User`, linkified to §7 |
| Amount | `Payout.amount_cents` (right-aligned, two decimals per `control-room-spec.md` §12) |
| Status | `Payout.status` chip |
| Period | `Payout.period_start` / `period_end` |
| Stripe transfer | `Payout.stripe_transfer_id` outbound link |
| Last action | latest event in the payout/dispute history |

### 8.3 Row actions (RBAC-gated, consumed)

- **Mark paid** — `POST /api/admin/payouts/:id/mark-paid` (owned
  by PR #125). Capability: `act:payouts`
  (`deployment-and-rbac.md` §3). Wrapped by the §16 dangerous-
  action modal.
- **Open Stripe dispute** — outbound link; client-only.
- **Attach evidence URL** —
  `POST /api/admin/payouts/disputes/:id/evidence`. Same capability.

### 8.4 Endpoint dependencies

- **Shipped today.** None.
- **Owned by PR #125 (commerce wave / Stripe Connect).** Consumer
  surface only here.

### 8.5 Acceptance criteria

1. Sidebar entry is a `coming soon (PR #125 / Stripe Connect)`
   placeholder until the commerce-wave endpoints ship.
2. Currency cells render integer cents → display dollars with two
   decimals, never less, per `control-room-spec.md` §12.
3. Mark-paid emits an `AuditLog` row server-side via PR #125's
   `AuditService.write` — not duplicated client-side. Consumer
   surface degrades gracefully when the commerce runtime is
   unreachable.

---

## 9. Support Queue — CONSUMER-ONLY

**Not part of admin-console runtime.** The support-ticket runtime —
`SupportTicket`, `SupportMacro`, intake routing, conversation
thread, macro management — is owned by the **#126 engagement /
retention wave**. The admin console consumes the resulting
endpoints; it does not own the ticket store or the macro library.

This screen is **distinct from** the §10 Support screen in
`control-room-spec.md`, which covers the in-platform `SupportFlag`
taxonomy (auto-flagged users, manual review flags, GDPR pending,
…). The flag taxonomy is owned by admin-console runtime (gap §11.N
in the canonical spec); the ticket queue documented here is not.

**Purpose.** Operator triage of inbound support tickets — inbox,
conversation thread, macros, audit trail — once the engagement-
wave runtime ships. Until then the sidebar entry renders a
`coming soon (PR #126, engagement / retention)` placeholder and
intake continues to route to email per
`docs/help/support-config.md`.

### 9.1 Table columns (consumed)

| Col | Source (consumed) |
|---|---|
| Ticket | `SupportTicket.id`, `SupportTicket.subject` |
| Requester | `SupportTicket.user_id` joined to `User`, linkified to §7 |
| Status | `SupportTicket.status` chip (`new` / `in_progress` / `awaiting_user` / `resolved`) |
| Assignee | `SupportTicket.assignee_user_id` |
| Updated | `SupportTicket.updated_at` |
| Last message | derived (from the conversation thread) |

### 9.2 Row actions (RBAC-gated, consumed)

- **Open thread** — `GET /api/admin/support/tickets/:id` (owned by
  PR #126). Capability: `act:support`
  (`deployment-and-rbac.md` §3).
- **Reply with macro** —
  `POST /api/admin/support/tickets/:id/reply` with a `macro_id`.
  Same capability.
- **Change status / assign / reassign** —
  `PATCH /api/admin/support/tickets/:id`. Same capability. Audit
  row emitted server-side per PR #126 (not duplicated by the
  console).
- **Open requester profile** — deep link into
  `control-room-spec.md` §7.

### 9.3 Endpoint dependencies

- **Shipped today.** None for the ticket surface. The §10 Support
  screen in `control-room-spec.md` (flag-based, not ticket-based)
  uses gap §11.N — admin-console runtime, not engagement-wave.
- **Owned by PR #126 (engagement / retention wave).** Consumer
  surface only here.

### 9.4 Acceptance criteria

1. Sidebar entry is a `coming soon (PR #126, engagement /
   retention)` placeholder until the engagement-wave endpoints
   ship.
2. The screen does not duplicate or fork the §10 Support flag
   taxonomy from `control-room-spec.md` — flags and tickets are
   separate concepts and live on separate screens.
3. Consumer surface degrades gracefully when the engagement
   runtime is unreachable; the screen surfaces the inline error
   banner per `control-room-spec.md` §12, never a synthesized
   ticket state. Status changes emit an `AuditLog` row server-side
   via PR #126's `AuditService.write` — not duplicated client-side.

---

## Cross-references

- `control-room-spec.md` §3–§10 — the canonical screen set this
  addendum complements.
- `control-room-spec.md` §11.0 — the shipped endpoint inventory
  cited by every "shipped today" row above.
- `control-room-spec.md` §11.A–O — the gap letters cross-referenced
  for screens #1–#6.
- `control-room-spec.md` §16 — type-the-email and dangerous-action
  modal contract used by screens #3 and #6.
- `control-room-spec.md` §17 phase 7 — the rollout slot screen #4
  (Feature Flags) targets.
- `deployment-and-rbac.md` §3 — the advisory capability matrix
  every row action above cross-references.
- `deployment-and-rbac.md` §5 — the optional admin mobile companion
  contract that permits screen #6's approve/reject from the mobile
  surface.
- `pr-sequence.md` — the PR-number map (PR #117–#126) that closes
  the future gaps cited above.

---

**This is a docs-only addendum.** No runtime code, schema, env, CI,
or migrations change in the PR that introduces this file. The
contracts above are graded against future runtime PRs, not enforced
by anything in this repo today.
