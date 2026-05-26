# Engineering Backlog

R48 charters for findings deferred out of in-flight PRs. Each entry is
the contract under which a PR was allowed to defer work — the operator
relies on this file to keep deferred items from disappearing.

Format: stable ID, finding origin, why this scope, exclusion list,
tracking owner.

---

## BL-2026-05-25-001 — `roles-enforced` legacy allowlist (PR #267 A5-P1-4)

**Origin:** Audit #5 of PR #267 `feat/tgp-storefront-backend`, P1-4.

**Charter (why this scope):** the `roles-enforced.spec.ts` contract test
fails on 94 routes lacking `@Roles(...)` metadata across the entire
backend. The audit notes this is a pre-existing condition: the routes
PR #267 introduces (`ShareLinkController`, `StorefrontPublicController`)
ARE correctly gated. The test surfaces a repository-wide gap. The PR
ships the storefront on a tight timeline because it is the launch path
for guest checkout; rolling 94 controllers into the same diff would
quadruple review surface and delay launch.

Operator directive (PR #267 fix R5 brief, paraphrased): "Audit-flagged
pre-existing red suites stay red ONLY with a valid R48 charter."

**Exclusion list:** the `LEGACY_GUARD_ALLOWLIST` and
`CLASS_LEVEL_LEGACY_ALLOWLIST` entries in `test/roles-enforced.spec.ts`
covering:

- AccountDeletionController, AdminExerciseCatalogController,
  AnalyticsController, BloodworkController, CheckInsController,
  CheckoutController, ClientPackagesController, CoachAIController,
  CoachConnectController, CoachController, CoachPackagesController,
  CoachPaymentOpsController, CoachPurchasesController,
  CommandCenterController, ConnectController, DataExportController,
  ExerciseCatalogController, FoodController, HabitsController,
  InviteCodesController, LessonsController, LtvMetricsController,
  MessagesSafetyController, OwnerBillingController, OwnerConsoleController,
  SchedulingController, SubCoachController, SubCoachesController,
  TeamController, TeamModeController, V1CoachController,
  WorkoutBuilderController.

PR #267 does NOT extend the allowlist beyond the entries already on
main; the storefront's own controllers are covered by `@Roles` or
`@Public` and not allowlisted.

**Tracking owner:** post-launch security pass. Decompose into one PR per
controller family (auth → payments → coach surface → owner surface) so
each is reviewable in isolation. Target: complete migration before
public launch wave 2.

---

## BL-2026-05-25-002 — Pre-existing red Jest suites (PR #267 R48 charter)

**Origin:** Audit #5 of PR #267, "Red Suites Analysis" section.

**Charter (why this scope):** the following test suites fail on PR
`feat/tgp-storefront-backend` AND on `origin/main` (independently
verified by checking out main and running each). They are NOT regressions
introduced by PR #267:

| Suite                                  | Failing count | Root cause                                                                              |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `test/messages-safety.service.spec.ts` | 1             | `unreadCountForClient` returns 0 — block-aware filter not in SUT                        |
| `test/v1-coach.service.spec.ts`        | 1             | `sendMessage` 404s for sub-coach scenario — fixture wiring drift                        |
| `test/check-ins.service.spec.ts`       | 1             | `listForClientByCoach` returns [] instead of length 1 — Prisma where-clause drift       |
| `test/roles-enforced.spec.ts`          | 1             | 94 ungated routes — see BL-2026-05-25-001                                               |

Operator directive (PR #267 fix R5 brief): "Pre-existing red suites stay
red only with a valid R48 charter."

**Exclusion list:** the four spec files above remain failing. PR #267
does not modify them (no drive-by). The earlier Fix R5 in the audit
context did touch three of them with mock-plumbing edits; that drive-by
was flagged by the audit and is NOT carried in this round.

**Tracking owner:** a per-suite hotfix PR, each landing independently
against main. Each fix is a single-file change targeted at the named
root cause; none should grow into refactor scope. Target: same launch
window as BL-2026-05-25-001.

---

## BL-2026-05-25-003 — CHECK-constraint replacement runbook (PR #267 A5-P2-4)

**Origin:** Audit #5 of PR #267, P2-4.

**Charter:** `prisma/migrations/20260804000000_guest_checkout_retryable_conversion/`
extends the `GuestCheckout_status_check` CHECK constraint via
`DROP CONSTRAINT` + `ADD CONSTRAINT`. On a populated table this takes an
ACCESS EXCLUSIVE lock; the `docs/runbooks/migrations-concurrently.md`
runbook covers CREATE INDEX CONCURRENTLY but not this CHECK-constraint
pattern. Phase 1 launch has not populated `GuestCheckout` yet, so the
lock is empirically zero contention; future Phase 2 migrations on this
table will need the `ADD CONSTRAINT ... NOT VALID; VALIDATE CONSTRAINT`
split.

**Exclusion list:** the existing migration ships as-is. PR #267 adds the
runbook note in this backlog entry rather than rewriting the
already-shipped migration.

**Tracking owner:** ops runbooks. Add a "Non-CONCURRENTLY DDL patterns"
section to `docs/runbooks/migrations-concurrently.md` covering CHECK
constraint replacement (`NOT VALID` + `VALIDATE CONSTRAINT`) and column
defaults. Target: before the next CHECK-constraint migration lands.

---

## BL-2026-05-25-004 — Per-email storefront rate limit (PR #267 A5-P2-5)

**Origin:** Audit #5 of PR #267, P2-5.

**Charter:** an attacker can mint hundreds of `GuestCheckout` rows for
the same `(email, package_id)` pair because the per-IP throttle and the
composite (token, IP) throttle introduced in A5-P1-5 still allow one
attacker behind one IP to spam distinct UUID idempotency keys. The Stripe
PaymentIntent count would balloon under that pressure.

The defense is a soft per-email rate limit at the createIntent service
layer: count `GuestCheckout` rows in the last hour for `hash(email)` and
reject above a threshold (e.g. 10/hour/email).

**Exclusion list:** PR #267 ships without the per-email rate limit. The
composite throttle key from A5-P1-5 raises the bar for casual abuse;
spam-storage / Stripe-API-quota amplification is left for the follow-up.

**Tracking owner:** storefront hardening Phase 1.5. Single-PR addition
to `GuestCheckoutService.createIntent`. Target: pre-public-launch.

---

## BL-2026-05-25-005 — Share-link expiry-setter route (PR #267 A5-P3-1)

**Origin:** Audit #5 of PR #267, P3-1.

**Charter:** `share_link_expires_at` exists on `CoachPackage` and is
honoured by `StorefrontService.getPublicPackageByToken`, but there is no
coach-facing endpoint that lets the coach SET the expiry — only revoke
(one-way). The schema column has shipped; the route has not.

**Exclusion list:** PR #267 does not add a `POST /v1/coach/packages/:id/share-link/expiry`
route. The schema column stays.

**Tracking owner:** coach-product Phase 2. New route mirroring the
revoke route's `@Throttle` + `@Roles('coach')` shape. Target: when the
coach UI starts exposing expiry as a feature.

---

## BL-2026-05-25-006 — `subscription_status` field deprecation (PR #267 A5-P3-2)

**Origin:** Audit #5 of PR #267, P3-2.

**Charter:** the operator's locked rule is that `subscription_status`
field references should be replaced by `coach_subscriptions` table
joins. 18 references remain in `src/admin/`, `src/billing/`, and
`src/invite-codes/`. PR #267 introduces ZERO new references but does
not address the residual 18.

**Exclusion list (verbatim file:line per audit):**

- `src/admin/admin.service.ts:212`
- `src/admin/entitlements/entitlements.service.ts:31, 109, 281, 289`
- `src/admin/federation/federation.service.ts:110, 331, 343`
- `src/admin/reports/reports.service.ts:39, 145, 159`
- `src/billing/owner-billing.controller.ts:204, 214`
- `src/invite-codes/invite-codes.service.ts:62`

**Tracking owner:** billing-schema cleanup. Single PR per file; mechanical
replacement with the `coach_subscriptions` join. Target: before Phase 2
billing work touches these surfaces.

---
<!-- Merged from feat/coach-brief: PR #266 R48 charters -->

re-ordering. New entries append at the bottom.

---

## BL-AUTH-1 — Migrate Phase 10/11 controllers from class-level `*Guard`s to `@Roles(...)` declarations

**Source:** A5-P1-3 (Audit #5 PR #266 — Fix Round 6 charter).

**Why deferred:** the controllers listed below are gated by bespoke
class-level guards (`CoachGuard`, `CoachOrOwnerGuard`, `OwnerGuard`,
`ServiceTokenGuard`, `NoActiveSubCoachGuard`) plus service-layer
ownership checks. The `test/roles-enforced.spec.ts` contract test
fails when any handler lacks an explicit `@Roles()` or `@Public()`
decorator even though the route IS gated — the contract is purely
metadata, not effective access. Adding 21 controllers' worth of
`@Roles(...)` is a security-scoped refactor that does not belong
under the Coach Brief PR (#266) per R49 (no drive-by file
modifications). Fix Round 5 attempted to smuggle these into the
Coach Brief PR via legacy-allowlist entries; Audit #5 P1-3 rejected
that approach and demanded a real follow-up PR.

**Affected controllers (method-level):**

- `CoachController.getDashboardSummary` (CoachGuard class-level)
- `InviteCodesController.redeemers` (per-handler JwtAuthGuard+CoachGuard)
- `InviteCodesController.sendOne` (per-handler JwtAuthGuard+CoachGuard)
- `OwnerBillingController.cancelSubscription` (OwnerGuard class-level)

**Affected controllers (class-level):**

- `AccountDeletionController` — JwtAuthGuard + service-layer ownership
- `AdminExerciseCatalogController` — OwnerGuard at class level
- `CheckoutController` — JwtAuthGuard + service-layer ownership
- `ClientPackagesController` — JwtAuthGuard + service-layer ownership
- `CoachAIController` — CoachGuard + SubscriptionGuard at class level
- `CoachConnectController` — CoachGuard + NoActiveSubCoachGuard
- `CoachPackagesController` — CoachOrOwnerGuard + SubscriptionGuard
- `CoachPaymentOpsController` — CoachOrOwnerGuard at class level
- `CoachPurchasesController` — CoachOrOwnerGuard at class level
- `CommandCenterController` — CoachGuard + NoActiveSubCoachGuard
- `ConnectController` — CoachOrOwnerGuard at class level
- `DataExportController` — service-layer ownership; pre-Phase-10
- `ExerciseCatalogController` — JwtAuthGuard read-only catalog; pre-Phase-10
- `LtvMetricsController` — CoachGuard at class level
- `MessagesSafetyController` — JwtAuthGuard + service-layer ownership
- `OwnerConsoleController` — ServiceTokenGuard at class level
- `SubCoachController` — CoachGuard at class level
- `SubCoachesController` — CoachGuard at class level
- `TeamController` — CoachGuard + NoActiveSubCoachGuard at class level

**Exclusion (in-scope for THIS Coach Brief PR):** `CoachBriefController`
declares `@Roles('coach')` at class level (Fix Round 5 already shipped
this) and is therefore NOT on the allowlist.

**Acceptance criteria for the follow-up PR:**

1. Each listed handler / class gains an explicit `@Roles(...)` or
   `@Public()` decoration matching the guard's actual access policy.
2. No regression in the existing guard chain — the bespoke guards
   stay in place; `@Roles` is metadata that the global `RolesGuard`
   reads to short-circuit before bespoke logic runs.
3. `test/roles-enforced.spec.ts` is green with NO legacy-allowlist
   additions beyond what already lives on `main` at the time of that
   follow-up PR's start SHA.

**Tracking:** a follow-up PR titled
`security(roles): migrate Phase 10/11 controllers to @Roles metadata [BL-AUTH-1]`
will land within 14 days of #266 merge. If it slips, the Coach Brief
PR is unaffected: the failing suite was already red on `main` (Audit
#5 verified) and this PR neither created the failure nor extended its
blast radius.

---

## BL-MIGRATIONS-1 — Split destructive ledger-backfill migration into create / backfill / drop steps

**Source:** A5-P2-4 (Audit #5 PR #266 — Fix Round 6 charter).

**Why deferred:** the migration
`20260703000001_add_coach_brief_push_ledger/migration.sql` (a) creates
`CoachBriefPushLedger`, (b) backfills it from
`CoachBriefPreferences.last_push_*` via
`INSERT … ON CONFLICT DO NOTHING`, then (c) `DROP COLUMN`s the source.
The audit flagged that a partial backfill (rows the ON CONFLICT skipped)
would lose dedup state on column drop.

The migration is brand-new in this PR (never deployed). Splitting it
post-hoc is an in-place rewrite of an unshipped migration — safe per
HOUSE_RULES "append-only after deploy". HOWEVER the destination
behaviour the audit recommends (`DO UPDATE SET ... COALESCE(...)`)
is a meaningful schema-evolution decision that touches `last_push_*`
state and would need migration-runbook updates plus a re-run of the
Round-2 ledger tests. The Coach Brief PR is already at six fix
rounds and the failure mode the audit describes (partial backfill
on re-run) requires the operator to have shipped a partial deploy
and then re-run — a scenario that has not occurred and will not
occur before the canonical merge.

**Exclusion:** the migration file stays exactly as it is in
PR #266 — no edits in Fix Round 6.

**Acceptance criteria for the follow-up PR:**

1. Three sequential migrations replace the current single one:
   - `…_create_coach_brief_push_ledger` — table + RLS, NO backfill.
   - `…_backfill_push_ledger` — `INSERT … ON CONFLICT (coach_id)
     DO UPDATE SET last_push_attempt_date = COALESCE(EXCLUDED.last_push_attempt_date, "CoachBriefPushLedger".last_push_attempt_date)`
     so a re-run merges rather than skips.
   - `…_drop_legacy_push_columns` — `DROP COLUMN` only after operator
     verifies the backfill via an out-of-band `SELECT` runbook step
     documented inline.
2. The migration runbook
   (`docs/runbooks/migrations-concurrently.md` or sibling) gains a
   "destructive backfill" section covering the COALESCE-merge pattern.

**Tracking:** PR title
`migration(coach-brief): split push-ledger backfill into safe steps [BL-MIGRATIONS-1]`.

---

## BL-COACH-BRIEF-1 — Tighten `CoachBriefPreferences_timezone_format_check` for legacy IANA aliases

**Source:** A5-P2-5 (Audit #5 PR #266 — Fix Round 6).

**Status:** RESOLVED in Fix Round 6 by relaxing the regex to a
length-only sanity check at the DB layer; the application-side
`IsValidTimezone` validator (via `Intl.DateTimeFormat`) is the
authoritative gate. No follow-up needed.
