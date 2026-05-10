# Admin console — PR sequence and gap reconciliation

Companion to [`control-room-spec.md`](./control-room-spec.md) and
[`deployment-and-rbac.md`](./deployment-and-rbac.md). This doc is the
single source of truth for which future runtime PR closes which gap
from `control-room-spec.md` §11. It supersedes the PR-numbered map in
the now-closed PR #127 (`docs/admin-web-dashboard.md`) §5.2 / §12.

Migrated from the superseded PR #127 sections §5.2 and §12, reconciled
against the canonical gap inventory in `control-room-spec.md` §11.A–O
and the rollout phases in `control-room-spec.md` §17. Where the source
spec conflicts with the canonical control-room spec, the control-room
spec wins.

---

## 1. Why this file exists

PR #127's §12 listed PRs **#117 through #126** as the runtime work
backing the admin web dashboard. That numbering is **stale**. The
`growth-project-backend` repo currently has open draft PRs **#117
through #129** allocated to other in-flight work — AI Program Builder,
Team Mode, the expansion roadmap, masterminds, the coach-experience
wave, commerce / marketplace, engagement / retention, and the admin
spec PRs themselves. The numbers PR #127 reserved have already been
spent on unrelated scopes.

Re-using those numbers for admin-console runtime work would either
collide on merge or silently mis-attribute scope in the merged history.
Neither is acceptable.

This file does three things:

1. Acknowledges the conflict explicitly and retires PR #127's §12 PR
   numbering.
2. Re-allocates each `control-room-spec.md` §11.A–O gap to a
   **placeholder PR slot** (`TBD-admin-A`..`TBD-admin-O`). The actual
   PR number is assigned at branch-cut time, after the in-flight PRs
   above merge or close. No real number is invented in this doc.
3. Maps each gap to its rollout phase from `control-room-spec.md` §17,
   names the new endpoints, tables/migrations, and env vars, and gives
   a one-line description so the runtime author has a contract.

The advisory capability matrix in
[`deployment-and-rbac.md`](./deployment-and-rbac.md) §3 already
references the §11 gap letters (not PR numbers); no rewrite there is
required.

---

## 2. Acknowledged conflict with PR #127 §12

PR #127's §12 table is reproduced below for traceability and is
**retired**. The numbers in the left column belong to other scopes
already in flight in this repo and are no longer available for
admin-console runtime work.

| PR # in #127 §12 | Original purpose claimed by #127 | Real scope on that PR number today |
|---|---|---|
| #117 | Pagination + Stripe/Supabase/migration probes | AI Program Builder / Team Mode tranche |
| #118 | Archive/unarchive coach record | Expansion roadmap tranche |
| #119 | AI cost + recent calls | Masterminds tranche |
| #120 | Marketplace offers + moderation | Coach-experience wave |
| #121 | Payouts + disputes | Commerce / marketplace tranche |
| #122 | Admin GDPR (export + admin-targeted scrub) | Engagement / retention tranche |
| #123 | Mastermind applications | Admin spec PR (this doc family) |
| #124 | Support tickets + macros | Admin spec PR (this doc family) |
| #125 | Feature-flag service + 2-op approval | Commerce / marketplace tranche |
| #126 | Programmatic smoke + readiness | Engagement / retention tranche |

The right-hand column is paraphrased from the live draft PR set in
`growth-project-backend` (PRs #117–#129). The exact in-flight scope
per PR is tracked in those PRs' own descriptions and is not restated
here — this doc only needs to record that the numbers are taken.

Two further notes:

- Several PR #127 §12 rows describe scope that **does not belong to
  the admin console at all** under the canonical spec. Those rows
  have moved out of admin-console-runtime and are listed in §5
  ("What is NOT in scope") below.
- The remaining PR #127 §12 rows that genuinely correspond to
  admin-console runtime work have been re-mapped onto the
  `control-room-spec.md` §11 gap inventory and given placeholder slots
  in §3 below.

---

## 3. Gap → placeholder PR slot map

Each row corresponds to a single gap from `control-room-spec.md` §11.
The placeholder slot (`TBD-admin-A` etc.) is what runtime authors and
the docs-only sub-PR refer to until the real PR number is cut. When
the runtime PR opens, its real number is recorded back into this table
and into the relevant module README per the operator-handoff contract
in `control-room-spec.md` §19.

Phase numbers refer to `control-room-spec.md` §17. Source references
in the "Cross-ref" column point at PR #127 §12 where a table name or
env var was first reserved, so the runtime author can see what was
already spec'd before the renumbering.

| Slot | Gap | Phase | New endpoint(s) | New tables / migrations | New env | Description | Cross-ref |
|---|---|---|---|---|---|---|---|
| `TBD-admin-A` | §11.A | 4 | `GET /api/admin/finance/mrr` | `Price` mirror (or extension on `CoachSubscription`) — see §11.D / `TBD-admin-D` | none | MRR / ARR endpoint with `by_status`, `by_plan`, `by_coach` breakdown sourced from `CoachSubscription` × current `Price`. | PR #127 §12 had no direct row; the math reservation lived in §3.2 of #127 and ARR / MRR was implicitly assumed under #117. Now isolated. |
| `TBD-admin-B` | §11.B | 4 | `GET /api/admin/finance/coach-cohorts?granularity=&since=` | none (read-only join over `User`, `CoachSubscription`) | none | Coach cohort delta — month buckets of `{added, lost, net, retained}` plus retention curves. | New under #128; #127 had no equivalent. |
| `TBD-admin-C` | §11.C | 6 | `GET /api/admin/integrations/webhook-lag`, `GET /api/admin/integrations/supabase-health`, `GET /api/admin/integrations/sentry-rate` | none (probes read existing tables / external calls) | optional `SENTRY_GRAPHQL_TOKEN` if the Sentry probe ships in outbound mode (preferred local 5xx counter has none) | Three new probes feeding the Overview health strip and the Health & Integrations screen. | Originally bundled into #127 §12 PR #117 alongside pagination; split out here so the probes ship independently of the pagination work. |
| `TBD-admin-D` | §11.D | 3 | none directly — schema + Stripe `price.*` webhook handler | `Price` table (`stripe_price_id`, `unit_amount_cents`, `interval`, `product_name`, …); Stripe webhook handler additions | none | Stripe `Price` mirror. Required by `TBD-admin-A` (per-plan / per-coach MRR) and the Coaches table plan column. | Not separately listed in #127 §12; reserved here as a hard prerequisite for `TBD-admin-A`. |
| `TBD-admin-E` | §11.E | 2 | `GET /api/admin/coaches/activity?since_days=` | none (aggregation over `CoachMessage`, `LoggedFoodEntry`, `WorkoutLog`) | none | Bulk roster activity in one payload, keyed by `coach_user_id`. Prevents N+1 fan-out on the Coaches table. | Implicit under #127 §12 PR #117; broken out here as its own slot. |
| `TBD-admin-F` | §11.F | 2 | middleware update (no new route); read surfaced by existing `/api/admin/coaches`, `/api/admin/users`, `/api/admin/search` | `User.last_seen_at` column + idempotent middleware update on auth-bearing requests | none | `last_seen_at` for the "ghost coach" filter and the universal-search last-seen chip. | Implicit under #127 §12 PR #117. |
| `TBD-admin-G` | §11.G | 5 | `POST /api/admin/users/:id/send-password-reset` | none (proxies Supabase admin) | none — relies on existing Supabase admin credentials | Operator-initiated password reset. Audit'd. | Not in #127 §12 by name. |
| `TBD-admin-H` | §11.H | 5 | `POST /api/admin/users/:id/entitlements/override` | `EntitlementOverride` table (Phase-2 of `docs/entitlements.md`) | none | Suspend / unsuspend via entitlement override. Audit'd. | Not in #127 §12; `entitlements.md` Phase-2. |
| `TBD-admin-I` | §11.I | 5 | `POST /api/admin/clients/:id/reassign-coach`, `POST /api/admin/users/:id/restore` | none (uses existing relationship + soft-delete columns) | none | Reassign coach (today: SQL only) and restore soft-deleted before GDPR worker runs. Audit'd. | Not in #127 §12; partially adjacent to PR #122's "admin GDPR" row, but reassign is independent. |
| `TBD-admin-J` | §11.J | 2 | none new — projection change on existing `/api/admin/search` and `/api/admin/clients` | none (reads `User.is_deleted` and the GDPR-worker flag already wired by `GdprScrubService`) | none | Surface `scrubbed` chip in universal search and the Clients table. One-line projection change. | Not in #127 §12. |
| `TBD-admin-K` | §11.K | 3 | `GET /api/admin/users/:id/timeline?since=&limit=&cursor=` | none (cursor-aware aggregator over `AuditLog`, `ActivityEvent`, `Invoice`, `PaymentFailure`, `CoachMessage` counts) | none | Activity timeline aggregator for the person profile. One endpoint, one cursor; the screen does not stitch. | Not in #127 §12; replaces the implicit per-screen stitching that #127 §4 left to the frontend. |
| `TBD-admin-L` | §11.L | 6 | `POST /api/admin/finance/past-due/:coach_user_id/remind` | none (uses existing `Invoice` / `PaymentFailure` and the transactional email module) | none — uses existing transactional provider env | Operator-triggered dunning reminder. Audit'd. Optional Phase-3 within Phase 6. | Not in #127 §12 by name. |
| `TBD-admin-M` | §11.M | 6 | `GET /api/admin/finance/retention?granularity=month` | none (matrix join over `User` + `CoachSubscription` + `Invoice`) | none | Cohort retention matrix (coaches added in month M paid in month M+1..M+12). | Not in #127 §12 by name. |
| `TBD-admin-N` | §11.N | 5 | `GET /api/admin/support/flags`, `POST /api/admin/support/flags`, `POST /api/admin/support/flags/:id/clear` | `SupportFlag` table (`user_id`, `flag`, `reason`, `set_by`, `set_at`, `cleared_at`, `cleared_by`) | none | Operator-set / operator-cleared flags on humans (e.g. `payment_at_risk`, `manual_review`, `do_not_contact`). Audit'd, append-only audit row on set/clear. **Distinct from `SupportTicket`** — see §5. | #127 §12 PR #124 listed `SupportTicket` / `SupportMacro`; that is a different scope (out of admin-console runtime). The flags table is the admin-console-runtime piece. |
| `TBD-admin-O` | §11.O | 6 | `POST /api/admin/search/export` | none (extends `src/admin/reports/` machinery) | none — reuses the existing reports CSV signing config | Bulk export of universal-search results as a signed-URL CSV. Inherits the privacy contract — never per-record activity bodies. | Not in #127 §12 by name. |

A few cross-cutting rules apply to every slot above (same as PR #127
§5.2 imposed on its now-stale rows):

- Every new controller class is gated by
  `JwtAuthGuard + RolesGuard + @Roles('owner')`. No exceptions.
- Every state-changing call lands an `AuditLog` row through
  `AuditService.write`. New action constants are added to
  `src/audit/audit.actions.ts` with a short comment per existing
  convention.
- List endpoints use the `{ data, ... }` envelope used by
  `/api/admin/reports/*`. Probe endpoints use a flat object with
  explicit `status`, mirroring the federation `finance.status` pattern.
- Degraded states surface as explicit `status` values, **never** as
  zero or null. Same rule the federation layer follows.
- Every new endpoint adds a guard-wiring assertion to
  `test/throttler.module.spec.ts`'s walked controller list.

---

## 4. Phase ↔ slot rollup

Cross-reference of `control-room-spec.md` §17 phases to the slots
above. Every phase is one frontend PR plus zero or more runtime PRs;
the docs-only sub-PR that flips a §11 row to "shipped in #N" lands at
the end of the phase per `control-room-spec.md` §19.

| Phase | Week | Slots that close in this phase | Notes |
|---|---|---|---|
| 0 | now | (none — docs) | This file plus `control-room-spec.md` and `deployment-and-rbac.md`. |
| 1 | week 1 | (none new from §11) | Overview and Universal search hooked up against already-shipped endpoints. No gap closes here. |
| 2 | week 2 | `TBD-admin-E`, `TBD-admin-F`, `TBD-admin-J` | Coaches + Clients table density: bulk roster activity, `last_seen_at` middleware, `scrubbed` chip projection. |
| 3 | week 3 | `TBD-admin-D`, `TBD-admin-K` | Person profile and the supporting `Price` mirror + activity timeline aggregator. |
| 4 | week 4 | `TBD-admin-A`, `TBD-admin-B` | Finance screen — MRR / ARR endpoint and coach-cohort delta. |
| 5 | week 5 | `TBD-admin-G`, `TBD-admin-H`, `TBD-admin-I`, `TBD-admin-N` | Support flags + reassign / restore / suspend + password reset. |
| 6 | week 6 | `TBD-admin-C`, `TBD-admin-L`, `TBD-admin-M`, `TBD-admin-O` | Health probes, dunning reminder, cohort retention, bulk universal-search export. |
| 7 | week 7 | (none new from §11) | Audit-on-read action `admin.profile.read`, sub-OWNER triad reservation, type-the-email + 2FA gates. No new gap closes; hardening only. |

The flag `ADMIN_CONSOLE_V2_ENABLED` defaults off and never reaches
non-OWNER tokens. Phases gate on the flag, not on customer-visible
exposure. Same posture as `control-room-spec.md` §17.

---

## 5. What is NOT in scope (and where it went)

PR #127 §12 conflated three separable concerns: admin-console runtime
endpoints, in-flight commerce / marketplace product work, and
in-flight engagement / retention product work. The canonical spec
(#128) drops the latter two from the admin-console PR sequence. The
admin console **consumes** these surfaces when they ship from their
own PRs; it does not re-implement them.

The following items from PR #127 §12 are **explicitly out of scope**
for the admin-console runtime PRs above:

- **AI cost and recent calls** (`AICall` table; PR #127 §12 PR #119).
  Lives on the AI Program Builder track. The admin console reads
  `/api/admin/ai/cost` and `/api/admin/ai/recent` when they ship and
  renders them on the AI panel per `deployment-and-rbac.md` §3
  (`view:ai_audit` capability). No admin-console runtime PR
  re-creates the table or the endpoints.
- **Marketplace offers + moderation** (`Offer`,
  `OfferModerationEvent`; PR #127 §12 PR #120). Lives on the commerce
  / marketplace track. The admin console renders an "approve / reject"
  affordance via `act:offer_moderation` against whichever endpoints
  that track ships; no admin-console runtime PR introduces the table.
- **Payouts and disputes** (`Payout`, `Dispute`,
  `STRIPE_CONNECT_*`; PR #127 §12 PR #121). Lives on the commerce /
  marketplace track. The admin console renders a "mark paid"
  affordance via `act:payouts` only; no admin-console runtime PR
  introduces the table or the env vars.
- **Mastermind applications** (`MastermindApplication`; PR #127 §12
  PR #123). Lives on the masterminds track. The admin console
  consumes whatever list / accept / reject endpoints land there; no
  admin-console runtime PR introduces the table.
- **Support tickets and macros** (`SupportTicket`, `SupportMacro`; PR
  #127 §12 PR #124). Lives on the engagement / retention track and
  replaces the email-only intake described in
  `docs/help/contact-support.md`. The admin console's Support screen
  renders `act:support` actions against those endpoints. **Note the
  distinction** from `TBD-admin-N` above: `SupportFlag` (operator-set
  flags on humans, gap §11.N) is admin-console-runtime; `SupportTicket`
  / `SupportMacro` (the customer-facing ticketing system) is not.
- **Feature-flag service + two-operator approval** (`FeatureFlag`,
  `FeatureFlagApproval`, `FEATURE_FLAGS_SLACK_WEBHOOK`; PR #127 §12 PR
  #125). Lives on the commerce / marketplace track (where flag-driven
  pricing experiments originated). The admin console renders
  `act:flag_rollout` toggles against the shipped service; no
  admin-console runtime PR introduces the table or the webhook env.
- **Programmatic smoke + readiness** (PR #127 §12 PR #126). Lives on
  the engagement / retention track's release-readiness work. The
  admin console's Settings → Release & Readiness panel reads
  `/api/admin/release/smoke` and `/api/admin/release/readiness` when
  they ship; no admin-console runtime PR introduces the runner token
  or the endpoint.
- **Pagination on `/api/admin/users` + `/api/admin/subscriptions` +
  Stripe-webhook freshness probe + Supabase JWKS probe + migration-
  drift probe** (PR #127 §12 PR #117). The probes are now
  `TBD-admin-C` (gap §11.C). The pagination work is folded into the
  in-flight admin-spec tranche; it is not blocked on this doc and
  does not re-open as a new PR here.
- **Archive / unarchive coach record** (PR #127 §12 PR #118). Not in
  the canonical `control-room-spec.md` §11 gap inventory — the
  control-room spec uses suspend (`TBD-admin-H`) plus reassign
  (`TBD-admin-I`) instead. Archive/unarchive at the coach-record
  level is not added to the admin-console runtime sequence.
- **Admin GDPR (export listing + admin-targeted scrub trigger)** (PR
  #127 §12 PR #122). The destructive scrub endpoint already exists
  (`POST /api/admin/gdpr/scrub`) and the consent matrix already exists
  (`GET /api/admin/clients/:id/consent`). The remaining piece — a
  list of in-flight data-export requests — is not in
  `control-room-spec.md` §11 and is not added to the admin-console
  runtime sequence. If it becomes necessary, a new gap row §11.P is
  the right place to add it.

The principle is: **the admin console is a consumer of platform
surfaces, not a re-implementation of them.** Scope that originated on
another track stays on that track. The admin-console runtime PRs in §3
above are limited to the missing endpoints the canonical
`control-room-spec.md` actually requires — nothing more.

---

## 6. Merge order

The merge order is the phase order. Within a phase, runtime slots can
land in any order — none of them have inter-slot dependencies inside a
single phase, except `TBD-admin-A` which depends on `TBD-admin-D`
landing in the prior phase (Phase 3 → Phase 4). When two slots in the
same phase touch overlapping files, the second author rebases.

| Week | Phase | Slots merging this week | Frontend PR | Docs sub-PR |
|---|---|---|---|---|
| week 1 | 1 | (none) | Overview + Universal search wired against shipped endpoints | (none — no §11 row closes) |
| week 2 | 2 | `TBD-admin-E`, `TBD-admin-F`, `TBD-admin-J` | Coaches + Clients tables | one docs sub-PR closing §11.E, §11.F, §11.J |
| week 3 | 3 | `TBD-admin-D`, then `TBD-admin-K` | Person profile | one docs sub-PR closing §11.D, §11.K |
| week 4 | 4 | `TBD-admin-A` (after `TBD-admin-D`), `TBD-admin-B` | Finance screen | one docs sub-PR closing §11.A, §11.B |
| week 5 | 5 | `TBD-admin-G`, `TBD-admin-H`, `TBD-admin-I`, `TBD-admin-N` | Support flags + person-profile mutators | one docs sub-PR closing §11.G–I, §11.N |
| week 6 | 6 | `TBD-admin-C`, `TBD-admin-L`, `TBD-admin-M`, `TBD-admin-O` | Health probes + Finance Phase-3 + bulk export | one docs sub-PR closing §11.C, §11.L, §11.M, §11.O |
| week 7 | 7 | (none from §11) | Audit-on-read + sub-OWNER triad + 2FA gates | docs sub-PR for §15 hardening notes only |

Cross-phase dependency: `TBD-admin-A` (gap §11.A) must not merge
before `TBD-admin-D` (gap §11.D). The MRR / ARR endpoint cannot
compute per-plan or per-coach breakdowns without the `Price` mirror.
If the `Price` mirror slips, `TBD-admin-A` slips with it; the Finance
screen renders the existing `/api/admin/metrics` cash-collected card
and hides MRR / ARR cards under the same `not_yet_available` posture
the rest of the metrics surface uses.

When a runtime slot opens against the live repo, replace the
`TBD-admin-X` placeholder in §3 with the real `#N` in a docs-only
sub-PR, per the operator-handoff contract in `control-room-spec.md`
§19. The same sub-PR moves the closed §11 row from §11.A–O into
§11.0 in `control-room-spec.md`.

---

## 7. What this doc does NOT do

- Does not allocate a real PR number to any admin-console runtime
  slot. Real numbers are cut at branch-cut time, after the in-flight
  PRs #117–#129 in `growth-project-backend` have merged or closed.
- Does not introduce, modify, or delete any runtime source under
  `src/`.
- Does not introduce, modify, or delete any Prisma schema or
  migration file. The new tables named in §3 are reservations the
  runtime authors implement when their slot opens; this doc only
  records the names so two authors don't pick conflicting names for
  the same concept.
- Does not introduce or modify any environment variable. Env vars
  named in §3 are likewise reservations for the runtime authors.
- Does not modify CI, Fly, or smoke configuration.
- Does not touch `new-website` or its repository.
- Does not modify PR #127 or PR #128. PR #127 is recommended for
  closure unmerged once PR #128 (the canonical spec) merges; PR #128
  is the source of the §11 gap inventory this doc reconciles against.

The only side effect of merging the PR that introduces this file is
the existing row in [`README.md`](./README.md) pointing here.
