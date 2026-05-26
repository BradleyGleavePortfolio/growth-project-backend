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
