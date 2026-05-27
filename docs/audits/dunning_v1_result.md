# Dunning v1 — Result

## TL;DR

Replaced the v0 single-window failure tracker with a webhook-driven, configurable cadence (Day 0/3/7/14 default), idempotent per-step `DunningAttempt` rows, terminate-on-subscription-deleted, an admin override controller, and four new cadence-specific email templates. Structured JSON logs + in-process metrics counters wired on every transition. All 249 test suites pass (2892 tests, 0 failures) and `npx tsc --noEmit` is clean.

PR: <https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/281>

## Schema diff summary

Additive only — no conflict surface with the CNAME subagent's `CustomDomain` work.

* **`DunningState`** — new columns:
  * `step_index Int @default(-1)` — highest cadence step fired
  * `next_attempt_at DateTime?` — denormalized earliest pending attempt
  * `entered_at DateTime?`, `recovered_at DateTime?`, `escalated_at DateTime?`
  * New index `@@index([status, next_attempt_at])`
* **`DunningAttempt`** — new model. One row per scheduled cadence step.
  * `id`, `dunning_state_id` (FK cascade), `step_index Int`, `kind String` (soft/urgent/final/recovered/cancelled), `scheduled_for`, `status` (pending/sent/failed/skipped/cancelled), `sent_at`, `email_idempotency_key String? @unique`, `provider_message_id`, `failure_reason`, `created_at`, `updated_at`
  * `@@unique([dunning_state_id, step_index])`
  * `@@index([status, scheduled_for])` (tick scan)
  * `@@index([dunning_state_id, status])`
* Migration `prisma/migrations/20261001000000_dunning_v1/migration.sql` — forward-only DDL, no data backfill required (existing rows continue with `step_index = -1`).

## Code changes

* `src/checkout/dunning.service.ts` — rewritten (≈990 lines): cadence config, `recordFailure` / `recordResolution` / `terminate` / `tick` / admin override methods (`adminAdvance`, `adminReset`, `adminCancel`, `adminTriggerImmediate`, `getAdminView`), `DunningMetrics` counters, structured `logEvent`.
* `src/checkout/checkout-webhook-handler.service.ts` — routes `invoice.payment_succeeded` to the resolution path (alias of `invoice.paid`); calls `DunningService.terminate()` on `customer.subscription.deleted`.
* `src/checkout/payment-ops.controller.ts` — 6 new admin endpoints under `/v1/admin/payments/dunning/...`.
* `src/email/email.types.ts` — append-only enum additions (4 templates).
* `src/email/email.service.ts` — 4 new subject entries (append-only).
* `src/email/templates/payment-reminder-soft.hbs`, `payment-reminder-urgent.hbs`, `payment-final-notice.hbs`, `payment-recovered.hbs` — NEW. Existing `payment-reminder.hbs` and `dunning-final.hbs` untouched.

## Tests

* `test/dunning.service.spec.ts` rewritten — 18 cases across cadence scheduling, idempotency, tick lifecycle, resolution, termination, admin override, sweeper grace-expired path, and admin view rendering.
* `test/checkout-webhook-fee-split.spec.ts` integration stub extended with `dunningAttempt` + `user` surfaces.

## PR URL

https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/281

## Verification

* `npx tsc --noEmit` — exit 0
* `npx jest --runInBand` — 249/249 suites, 2892 passed, 16 skipped, 5 todo, 0 failed
* Commit author: `Dynasia G <dynasia@trygrowthproject.com>` on branch `feat/dunning-v1-rewrite`

---

# PR #281 Refix — P1+P2 closure (2026-05-26)

Audit ([pr281_audit.md](/home/user/workspace/audits/pr281_audit.md)) flagged 1 P1 + 4 P2s after the v1 land. This refix closes all five on the same branch (`feat/dunning-v1-rewrite`), pushed as two commits.

## TL;DR

P1-1, P2-1, P2-2, P2-3, P2-4 all closed. 8 new regression tests, all green. Full suite: 2900 passed, 0 failed. `npx tsc --noEmit` clean. No P3s touched (R52 scope discipline).

## Commits

| Hash | Scope | Files |
|------|-------|-------|
| `0f1162b5` | P1-1 + P2-1 + P2-2 + P2-3 (service-side + schema) | `prisma/schema.prisma`, `prisma/migrations/20261002000000_dunning_v1_send_retry_cas/migration.sql`, `src/checkout/dunning.service.ts`, `test/dunning.service.spec.ts` |
| `0a044da0` | P2-4 (template copy + subjects) | `src/email/email.service.ts`, `src/email/templates/dunning-final.hbs`, `src/email/templates/payment-final-notice.hbs`, `test/dunning.service.spec.ts` |

## What was fixed

### P1-1 — `tick()` / `recordResolution()` race
`fireAttempt()` now claims the row atomically via `updateMany({where:{id, status:'pending'}, data:{status:'sending'}})` — `count === 0` ⇒ "raced", abort the send and bump `dunning_send_race_total`. `recordResolution()` only flips `status='pending'` to cancelled; in-flight (`'sending'`) or already-failed rows get `superseded_at` stamped for audit instead of having their state clobbered. Net effect: no path can mark an attempt cancelled after its email has been handed to SES.

### P2-1 — Day 14 stale cancellation_date
Day 14 step now calls a new `refreshCancellationView()` helper that re-reads the Stripe subscription. If `cancel_at_period_end === false` (user paid out-of-band, or admin reversed), the dunning-final is **skipped** and the attempt closed as cancelled. If still pending cancel, the fresh `cancel_at` overrides the stale Day-0 `cancellation_date` in the template variables.

### P2-2 — `adminReset()` unrecoverable
`adminReset()` now `deleteMany`'s all attempts (any status) for the purchase and zeroes the state baseline (`failure_count=0`, `last_failure_at=null`, `grace_period_ends_at=null`, `cancel_scheduled_at=null`). A new `isResetReArm` detector in `recordFailure()` (active state + `step_index=-1` + 0 attempts) treats the next failure as a fresh Day-0 window. Cadence restarts cleanly.

### P2-3 — `tick()` never retries failed
`tick()` is now a two-pass query: pending attempts due, plus `status='failed'` attempts with `next_retry_at <= now`. `fireAttempt()` retry path bumps `retry_count`, sets `next_retry_at = now + 1h * 4^retry_count` (capped to 3 retries), then on the 4th failure flips to `status='failed_permanent'` and bumps `dunning_attempt_failed_permanent_total`. Transient SES outages no longer drop a reminder. New metric `dunning_attempt_retry_succeeded_total` covers the happy path.

### P2-4 — duplicate "Final notice" copy
Day 7 (`payment-final-notice.hbs`) rewritten as "A second heads-up about your payment" — urgent but recoverable, names the cutoff date, no "final notice" string anywhere. Day 14 (`dunning-final.hbs`) rewritten as the actual cancellation notice: "Your subscription is ending {{cancellation_date}}". Subjects in `email.service.ts` updated to match. Tone conforms to `design-system/00-stillwater-standard.md`: declarative, lowercase-by-default, no exclamation points.

## Schema migration

`prisma/migrations/20261002000000_dunning_v1_send_retry_cas/migration.sql` adds:
- `DunningAttempt.retry_count INT NOT NULL DEFAULT 0`
- `DunningAttempt.next_retry_at TIMESTAMPTZ NULL`
- `DunningAttempt.superseded_at TIMESTAMPTZ NULL`
- index on `(status, next_retry_at)` for the tick retry-pass query
- enum values `'sending'`, `'failed_permanent'` documented in schema comment

## New regression tests (in `test/dunning.service.spec.ts`)

| Test | Asserts |
|------|---------|
| P1-1 race — concurrent resolution | recordResolution between findMany and CAS claim leaves the sent row alone, does NOT cancel an in-flight `sending` row |
| P1-1 race — pre-claim cancellation | when the row is already cancelled before CAS, the send is blocked and `dunning_send_race_total` increments |
| P2-1 Day 14 — subscription no longer pending cancel | dunning-final is skipped if Stripe `cancel_at_period_end` is false at Day 14 |
| P2-1 Day 14 — fresh cancel_at | template uses the refreshed `cancel_at`, not the Day-0 cached `cancellation_date` |
| P2-2 adminReset — re-arm | reset + new failure produces a fresh full set of Day-0 pending attempts |
| P2-3 retry — happy path | a failed attempt is retried once `next_retry_at` elapses; a transient SES outage no longer drops the reminder |
| P2-3 retry — exhaustion | after `DUNNING_MAX_SEND_RETRIES` failures the attempt is `failed_permanent` and `dunning_attempt_failed_permanent_total` bumps |
| P2-4 templates | Day 7 contains no "final notice" string, Day 14 carries the terminal framing, H1s differ, no `!` in either body |

26/26 dunning tests pass (18 prior + 8 new). Prisma stub extended for `id`, `status.in`, `count`, `next_retry_at` ordering. Stripe stub gained `retrieveSubscription` for P2-1.

## Verification (post-refix)

* `npx tsc --noEmit` — exit 0, clean
* `npx jest --runInBand` — **249/249 suites, 2900 passed, 16 skipped, 5 todo, 0 failed**
* Branch: `feat/dunning-v1-rewrite`, head `0a044da0`
* Commit author on both: `Dynasia G <dynasia@trygrowthproject.com>` — no `Co-Authored-By` trailers

## Skipped / out of scope

P3s untouched (R52). PR #282 textual conflicts untouched (explicit constraint). No commits to a different branch (R56).
