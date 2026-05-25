# BACKLOG

Stable-ID register of tracked-but-deferred work. Every R48 charter in
a fix-round report should link here so the same item is never charters
twice and progress is visible to the operator without grepping closed
PRs.

Each entry uses a stable ID (`BL-<class>-<n>`) so cross-references survive
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
