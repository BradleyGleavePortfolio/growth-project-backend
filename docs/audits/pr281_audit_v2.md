# PR #281 Dunning v1 — Re-audit at refixer HEAD

**Verdict: CLEAN — 0 / 0 / 0 / 5**
(P0 / P1 / P2 / P3)

- HEAD: `0a044da0` (fix(dunning): differentiate Day 7 / Day 14 template copy per Stillwater Standard)
- Base: `origin/main` = `b552df28` (PR #280 custom-domain removal — merged)
- Worktree: `/home/user/workspace/tgp/backend-281-audit-v2` (READ-ONLY, detached)
- Refixer commits: `0f1162b5` (P1-1 + P2-1 + P2-2 + P2-3) + `0a044da0` (P2-4)
- Files changed (excluding PR #280's custom-domain deletion noise): 9 dunning-relevant
  - schema + 2 migrations
  - `src/checkout/dunning.service.ts` (now 1,294 lines)
  - `src/checkout/payment-ops.controller.ts` (+64)
  - `src/checkout/checkout-webhook-handler.service.ts` (+16)
  - `src/email/email.types.ts` (+5), `src/email/email.service.ts` (+12)
  - 5 templates (4 new, 1 modified)
  - `test/dunning.service.spec.ts` (+879 → 26 cases, 8 new regression tests)

**Tests:** 2900 passed / 2921 total (16 skipped, 5 todo) — green.
**TypeScript:** `npx tsc --noEmit` clean.

The four P2s and the one P1 from v1 are all genuinely fixed; the regression
tests do deterministically exercise the race (gated email promise, not just
sequential calls). The new migration is additive-only and rollback-safe.
The remaining five P3s are mostly the same items as v1 (ops/docs gaps,
no exporter) with one new sub-item (`'sending'` rows orphaned on
crash-during-send) — none are merge-blocking.

---

## TL;DR

Merge. Race-condition fix is the most failure-prone item in the batch and
the refixer landed it correctly with both fix (`updateMany` CAS gating the
send) and a regression test that actually races a gated email send against
`recordResolution()`. Stripe-fetch fallback in the Day 14 step is the
right shape (try/catch with forward-looking +24h fallback). `adminReset`
now hard-deletes attempts and resets baseline so a subsequent failure
gets a fresh Day 0 cadence. Retry path uses exponential backoff (1h → 4h
→ 16h) with permanent-fail after 3 retries. Day 7 and Day 14 templates
are genuinely distinct ("second heads-up" vs "subscription is ending").

---

## P0 — release-blocking

**None.**

---

## P1 — fix before merge

**None.** ✓ v1's only P1 is resolved.

### v1 P1-1 — `tick()` / `recordResolution()` CAS race — **FIXED**

**Location:** `src/checkout/dunning.service.ts:494–680` (`fireAttempt`)
and `333–384` (`recordResolution`).

The fix is the textbook CAS pattern. Walked line by line:

1. `fireAttempt` early-bails if `attempt.status` is not `pending` or
   `failed` (line 502–503). The stale snapshot from `findMany` could already
   be `cancelled`/`sending` — the early bail catches the obvious cases
   without a DB roundtrip.
2. Line 509–512: `updateMany({where: {id, status: fromStatus}, data:
   {status: 'sending'}})`. Atomic; `count===0` means somebody else moved
   the row (recordResolution flipped pending→cancelled, or a parallel
   tick replica claimed it first, or terminate). On `count===0` we
   `inc('dunning_send_race_total')` and return `'raced'` — **before any
   email send**.
3. The CAS predicate `status: fromStatus` (where fromStatus ∈
   {pending, failed}) means a row that's already `sending`, `sent`,
   `cancelled`, `skipped`, or `failed_permanent` cannot be re-claimed —
   no double-send.
4. Email send happens **only after** the CAS succeeds (line 584). On
   send success the row is flipped `sending → sent` (line 595–605); on
   send failure the catch routes to retry bookkeeping (`sending → failed`
   or `sending → failed_permanent`).
5. `recordResolution` (line 347–350) cancels **only** `status='pending'`
   rows. Any row already in `'sending'` (CAS-claimed by tick) is left in
   place. The worker's subsequent `sending → sent` write succeeds without
   resurrecting a cancelled row.
6. Line 351–357 stamps `superseded_at` on any `sending`/`failed` rows
   (audit-only timestamp). Status is NOT changed — important because a
   crashed worker's `'sending'` row stays inspectable, and a `'failed'`
   row is left alone because the retry-tick's state recheck (line 454–457)
   will see `state.status === 'resolved'` and cancel the row gracefully
   on the next pass.

**Regression coverage:** `test/dunning.service.spec.ts:652–723` is a
genuine race — it injects a slow email transport (`emailGate` Promise),
starts `tick()` without awaiting, yields the event loop twice, asserts
the Day 0 row is `'sending'` (confirming CAS landed), then calls
`recordResolution('p1')` while tick is blocked inside `email.send()`.
After release of the gate the test asserts:
  - The claimed row is `'sent'` (NOT cancelled).
  - The three pending rows are `'cancelled'`.
  - `superseded_at` is stamped on the in-flight row.
  - `dunning_send_race_total === 0` (no spurious metric bump).

The second test (line 725–764) covers the opposite race shape: stale
snapshot from a prior `findMany`, row cancelled between scan and CAS.
CAS returns count=0, send blocked, metric bumps to 1. Both regression
tests are deterministic and the assertions match the production
invariant exactly.

---

## P2 — fix before next iteration

**None.** All four v1 P2s are resolved.

### v1 P2-1 — Day 14 stale `cancellation_date` — **FIXED**

**Location:** `dunning.service.ts:1094–1175` (`refreshCancellationView`).

When the Day 14 cadence step (`step.kind === 'cancelled'`) is the row
being fired, `fireAttempt` (line 534–563) calls `refreshCancellationView`,
which hits `stripe.retrieveSubscription(stripe_subscription_id)` and
recomputes the cancellation date from:

  1. `sub.cancel_at` (canonical Stripe future-cancel timestamp), then
  2. `sub.current_period_end`, then
  3. `now + 24h` (forward-looking fallback).

`shouldSend` is set to `false` (and the attempt is `'skipped'` with
state advanced) when the subscription:
  - has no `stripe_subscription_id` and the recorded date is in the
    past (line 1102–1113);
  - is already canceled (status=='canceled' or canceled_at set) — line
    1121–1127;
  - has recovered (not cancel_at_period_end, no cancel_at, status
    not in {past_due, unpaid}) — line 1131–1141.

Stripe fetch failure (line 1163–1174) does NOT block the send — it
returns `shouldSend: true` with a `now + 24h` fallback so the email
never shows a past date. The warning is logged. **This is the correct
trade-off**: a stuck Stripe API shouldn't suppress a legitimate Day 14
notice; a stale "subscription ended a week ago" date in the email is
the actual customer-visible failure mode we're trying to avoid.

Note that `fireAttempt` mutates a local `state` view (line 559–562) but
does NOT persist the fresh date back to `DunningState.cancel_scheduled_at`
— the `customer.subscription.updated` webhook owns that column. Correct
separation of concerns.

**Regression coverage:** two tests at line 768–851.
  - Test 1: Stripe says subscription is active (recovered) → Day 14 is
    skipped, no `dunning-final` template ever rendered.
  - Test 2: Stripe returns a forward-looking `cancel_at` 15 days out →
    the rendered email shows that fresh date, not the stale week-old
    `state.cancel_scheduled_at`.

### v1 P2-2 — `adminReset` leaves cadence unrecoverable — **FIXED**

**Location:** `dunning.service.ts:735–767` + `recordFailure` re-arm
branch at `223–235, 279–292`.

`adminReset` now (a) **hard-deletes** every `DunningAttempt` for the
state (line 739–741) so no `(dunning_state_id, step_index)` slots are
occupied, and (b) **resets the state baseline**: `step_index=-1`,
`failure_count=0`, `last_failure_at=null`, `last_failed_amount_cents=
null`, `last_attempt_number=null`, `last_failure_reason=null`,
`grace_period_ends_at=null`, `cancel_scheduled_at=null`,
`recovered_at=null`, `resolved_at=null`, `escalated_at=null`,
`next_attempt_at=null` (line 744–760). State.status stays `'active'`
so `getAdminView` still finds the row.

`recordFailure` recognises the post-reset shape via the `isResetReArm`
heuristic at line 228–235:

```ts
const isResetReArm =
  existing &&
  existing.status === 'active' &&
  existing.step_index === -1 &&
  !reopened &&
  (await this.prisma.dunningAttempt.count({
    where: { dunning_state_id: existing.id },
  })) === 0;
```

`isFreshWindow = !existing || reopened || isResetReArm` → true →
`scheduleCadence(row, now)` schedules a fresh Day 0/3/7/14 from the
new failure timestamp (line 279–292).

The double-guarded `deleteMany` at line 287–291 is belt-and-braces —
adminReset already cleared rows, but the guard keeps the invariant
local to `recordFailure` so a future caller (e.g. a `reopened` window
that didn't go through adminReset) is also safe.

**Regression coverage:** test at line 855–896 asserts: post-reset
`step_index=-1`, `failure_count=0`, `last_failure_at=null`, attempt
table empty. Subsequent failure → 4 fresh pending attempts at
`step_index ∈ [0..3]`. Day 0 scheduled within ~60s of `now`, not in the
past.

### v1 P2-3 — `tick` doesn't retry `failed` attempts — **FIXED**

**Location:** `dunning.service.ts:437–447` (tick scan) + `635–679`
(retry bookkeeping in catch).

Two-query approach. The pending scan at line 437–441 stays clean:
`status='pending' AND scheduled_for <= now`. The retry scan at line
442–446: `status='failed' AND next_retry_at <= now`, with `take`
bounded by `limit - pendingDue.length` so the second pass can't blow
the budget. Both scans use dedicated indexes
(`DunningAttempt_status_scheduled_for_idx`,
`DunningAttempt_status_next_retry_at_idx` from the new migration).

On send failure (catch at line 635), the worker:
  1. Reads the persisted retry_count fresh (line 639–641) — handles
     concurrent retry from another replica.
  2. `nextCount = (fresh.retry_count ?? attempt.retry_count ?? 0) + 1`.
  3. If `nextCount > maxSendRetries` (default 3) → mark
     `failed_permanent`, set `failure_reason`, increment
     `dunning_attempt_failed_permanent_total`, and **advance state** so
     a stuck send doesn't block the rest of the cadence (line 643–659).
  4. Otherwise schedule `next_retry_at = now + retryBackoffMs *
     4^(nextCount - 1)` (1h → 4h → 16h with the default 1h base) →
     bump `dunning_attempt_failed_total` (line 660–676).

Cadence advance on permanent-fail is important — a permanent send
failure for the Day 0 row would otherwise leave Day 3/7/14 sitting
behind it (advanceState is normally called on success). Verified:
line 659 calls `advanceState(state, attempt)` inside the
`failed_permanent` branch.

**Self-DDoS analysis:** max 3 retries per attempt, 4 attempts per
cadence ⇒ at most ~12 send calls over ~24h per dunning. Backoff is
multiplicative-4 not multiplicative-2 so the per-replica burst is
small even under fleetwide retry storms. Tick limit defaults to 100
per scan, so a single tick can fire at most 100 retries — bounded.
No DDoS risk on our own mail sender.

**Regression coverage:** two tests at line 900–992.
  - Test 1: First send throws → row to `'failed'` with `retry_count=1`
    and `next_retry_at` set. Tick at `t+1min` (within backoff) → not
    re-picked. Tick at `t+2h` (past backoff) → second send succeeds,
    `dunning_attempt_retry_succeeded_total === 1`.
  - Test 2: Permanent SES outage. After `maxSendRetries=3` exhaustions
    the row is `'failed_permanent'`, `dunning_attempt_failed_permanent_total
    === 1`. Confirms the budget cap fires.

### v1 P2-4 — duplicate "final notice" copy at Day 7 + Day 14 — **FIXED**

**Location:** `src/email/templates/payment-final-notice.hbs` (Day 7)
and `src/email/templates/dunning-final.hbs` (Day 14).

**Day 7** (`payment-final-notice.hbs`):
  - H1: "A second heads-up about your payment" (orange #c2410c).
  - Body: "We still haven't been able to collect $X. Your access is
    open as usual today — we just want to flag that if the charge
    doesn't go through, the subscription is scheduled to end on
    `{cancellation_date}`."
  - CTA: "Update payment".
  - Sign-off: "Most of the time it's a card that expired or a billing
    address that doesn't match — both take a minute in the portal.
    There's still room to fix this before the cutoff."

**Day 14** (`dunning-final.hbs`):
  - H1: "Your subscription is ending `{cancellation_date}`" (red
    #b91c1c).
  - Body: "We've tried to collect $X several times now and weren't able
    to. Unless payment goes through by `{cancellation_date}`, your
    Growth Project subscription will end and your access will close."
  - Sign-off: "If you'd rather let the subscription end, you can do
    that from the same page. Either way, we wanted to make sure you
    knew, so this isn't a quiet lapse on our end."

**Subject lines** (`email.service.ts:44–53`):
  - Day 7: `"A second heads-up — subscription ends {{cancellation_date}}
    if payment doesn't go through"`.
  - Day 14: `"Your subscription is ending {{cancellation_date}}"`.

Both subjects are declarative, no exclamation, no all-caps. The phrase
"final notice" appears in *neither* subject or H1 of either template
now — Day 14 leans on "ending" rather than re-using the "final" frame.
Tone is Stillwater Standard: calm, premium, mindful — not dramatic,
not panic-mongering.

**Regression coverage:** test at line 996–1037 reads both `.hbs` files
verbatim and asserts:
  - Day 7 does NOT contain "final notice" (lowercase).
  - Day 7 matches at least one of {second, heads-up, cutoff, still}.
  - Day 14 matches at least one of {ending, will end, subscription}.
  - Neither template has `!` in the copy (HTML markup stripped first).
  - Day 7 H1 ≠ Day 14 H1.
  - Day 7 H1 does NOT contain "final notice".

**Note on template *key*:** the file is still named
`payment-final-notice.hbs` and the `EmailTemplateKey.PAYMENT_FINAL_NOTICE`
constant is still in use. The customer-visible copy is fixed, but the
internal name is slightly misleading. Not worth renaming — touches
schema-adjacent type. Flagged as P3 cosmetic below.

**PII / wrong-date check:** templates use the same `{{recipient_name}}`,
`{{amount_display}}`, `{{cancellation_date}}` fields as before. No new
PII surface. Day 14 uses the freshly-fetched `cancellation_date` thanks
to the P2-1 fix; Day 7 uses the original Day 0 timestamp (which equals
"today" at Day 7 with default 7-day grace — slightly weird wording
"scheduled to end on [today]" but not a regression and not security-
relevant).

---

## New schema migration audit

**Migration:** `prisma/migrations/20261002000000_dunning_v1_send_retry_cas/migration.sql`.

```sql
ALTER TABLE "DunningAttempt"
  ADD COLUMN "retry_count"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_retry_at"  TIMESTAMP(3),
  ADD COLUMN "superseded_at"  TIMESTAMP(3);

CREATE INDEX "DunningAttempt_status_next_retry_at_idx"
  ON "DunningAttempt" ("status", "next_retry_at");
```

- **Additive only.** Three nullable / defaulted columns + one index.
  No `DROP`, no `ALTER COLUMN`, no constraint change.
- **Default values:** `retry_count` defaults to 0 (the "no retries
  attempted yet" sentinel). `next_retry_at` and `superseded_at` default
  to NULL. The tick loop and `recordResolution` treat NULL as "no value
  yet" — matches the bookkeeping invariants.
- **Backfill:** existing rows get `retry_count=0` automatically; NULL
  retry_at/superseded_at semantics match the fresh-row shape. No
  data-migration script needed.
- **New status values introduced:** `'sending'` (transient CAS-claim
  slot) and `'failed_permanent'` (retry budget exhausted). Status is a
  free-form TEXT column so no enum/constraint alteration is required
  — the migration comment explicitly calls this out.
- **Rollback safety:** dropping the three columns and the new index
  would lose retry bookkeeping for rows in progress at rollback time
  but doesn't corrupt anything — pending/sent/cancelled rows continue
  to behave as before. The new statuses (`sending`, `failed_permanent`)
  would be left as orphan values if rollback happened mid-flight, but
  a v1 rollback procedure would presumably also drain in-flight
  attempts first.
- **Index choice:** `(status, next_retry_at)` is the right composite
  for the retry-due scan (`WHERE status='failed' AND next_retry_at <=
  now`). Selectivity is fine — only failed rows are in this index, so
  the cardinality stays small.
- **Migration ordering:** `20261002000000` correctly sequences after
  `20261001000000_dunning_v1` (the original schema). No conflicts with
  PR #282's `20260424180000_add_coach_nudges` (different prefix, applied
  in timestamp order either way).

Migration looks safe for production.

---

## P3 — nice-to-have

### P3-1. PR #282 (Nudge) textual conflict on `email.types.ts` + `email.service.ts`

**Unchanged from v1**, but the conflict is slightly larger because PR
#281 added subject-line entries in `email.service.ts:44–53` (Day 7
"second heads-up" + Day 14 "ending" subjects). Resolution remains
trivial concat of both append blocks — no semantic risk, both PRs
extend disjoint enum / map regions. The PR that merges second resolves.

PR #280 (custom-domain removal) already merged to main, so PR #281's
diff at this audit is cleaner; the PR #282 conflict scope is unchanged.

### P3-2. `DunningMetrics` is in-process only — no Prometheus / Datadog exporter

**Unchanged from v1**, but the surface area expanded. New counters
shipped in this PR:
  - `dunning_send_race_total`
  - `dunning_attempt_retry_succeeded_total`
  - `dunning_attempt_failed_permanent_total`
  - `dunning_admin_reset_total`

These are now the highest-signal SLI counters for the subsystem (race
detection and retry health are the things ops will most want to alert
on). They're still locked inside `DunningService` memory and exposed
only via the per-process `GET /v1/admin/payments/dunning/metrics/snapshot`
endpoint, which fragments by replica.

Mitigation: the structured JSON log lines (`event:
dunning.attempt_raced`, `event: dunning.attempt_failed`, etc.) are
durable through the Fly log shipper, so Datadog can compose the same
metrics from log queries. Acceptable for v1; v2 should hand the
counters to `prom-client` or fire them as DogStatsD-format lines.

### P3-3. `DUNNING_*` env vars undocumented and silently fall back on misconfig

**Unchanged from v1**, expanded scope. The PR adds two NEW env vars
(`DUNNING_MAX_SEND_RETRIES`, `DUNNING_RETRY_BACKOFF_MS`) on top of the
three from v1 (`DUNNING_CADENCE_DAYS`, `DUNNING_GRACE_DAYS`,
`DUNNING_MAX_FAILURES`). Verified via `grep -rn "DUNNING_" .env.example
README.md docs/` — zero matches. None are mentioned anywhere outside
the source file.

`resolveDunningConfig` (line 105–141) still silently falls back to
defaults on parse failure; no `this.logger.warn` despite the L103–104
comment claiming "we log once at construction". `numEnv` (line 143–
148) still requires `n > 0`, so `DUNNING_GRACE_DAYS=0` (a valid "no
grace" choice) is silently rejected.

Fix is cheap (log on parse failure + add a `.env.example` block) but
not merge-blocking.

### P3-4. `'sending'` rows are orphaned on crash-during-send (NEW)

**Location:** `dunning.service.ts:494–680`.

The CAS pattern assumes the worker completes (either succeeds or
catches an error). If the process is killed (OOM, container restart,
SIGKILL) between the CAS `pending → sending` write (line 509) and
either the `sending → sent` success update or the catch-branch retry
update, the row is stuck in `'sending'` forever:

  - `tick`'s pending scan (`status='pending'`) doesn't match.
  - `tick`'s retry scan (`status='failed' AND next_retry_at <= now`)
    doesn't match.
  - `recordResolution` only stamps `superseded_at` on sending rows;
    doesn't change status.

The customer's cadence advances at most through whatever
`advanceState` was called on (none if the crash was before send), so
the entire cadence can also stall behind a single orphan row.

Mitigation paths for v2:
  - Add a third tick scan: `status='sending' AND updated_at < now - K`
    (where K is, say, 1h — longer than any reasonable email-send
    timeout) → reset to `'failed'` with `next_retry_at = now` so the
    normal retry path picks them up.
  - Or use a database-level lock with a TTL.
  - Or instrument with a Datadog alert on `dunning_attempt_sending_total`
    when the metric is non-zero for > 1h.

Not merge-blocking — crashes mid-send are rare and the failure mode
is "one customer's cadence stalls", recoverable via SQL UPDATE. Worth
adding a `runSweeper` pass in v1.1 / v2.

### P3-5. Test gaps — env-override + webhook-routing tests still missing

**Same as v1 P3-4**, partially closed.

Closed by this PR:
  - The race-condition regression test (was the biggest gap in v1) is
    now present and deterministic.

Still missing:
  - `resolveDunningConfig` is never invoked by any test. Env-override
    contract is unverified for any of the 5 env vars (now including the
    new `DUNNING_MAX_SEND_RETRIES` / `DUNNING_RETRY_BACKOFF_MS`).
  - `applySubscriptionDeleted` calling `dunning.terminate` at
    `checkout-webhook-handler.service.ts:301–309` has no direct test
    (only indirect via `terminate` unit tests).
  - The new `case 'invoice.payment_succeeded':` fallthrough route
    (webhook handler line 76) is still untested at the webhook-handler
    level — only the underlying `applyInvoicePaid` path is exercised.

Adding 3 small tests (env override happy/sad path, terminate-from-
webhook, payment_succeeded route) would close this gap; not merge-
blocking.

---

## New code surface — no new findings beyond P3-4

**SSRF:** no new outbound HTTP fetches in `DunningService`. The only
external call is `stripe.retrieveSubscription`, which goes through the
already-hardened `StripeConnectApiService` (timeout=10s, fetch lives
behind that class's hardened wrapper). No URL-from-user-input anywhere.

**Auth / RBAC:** unchanged. All admin endpoints inherit
`@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard) + @Roles('owner')`
from the class-level decorator. No per-method overrides that could
weaken this.

**Error swallowing:** audited every `catch` in `dunning.service.ts`:
  - Line 591–594: provider `failed` response is re-thrown so the
    unified catch handles retry. ✓
  - Line 635–679: the retry catch is the entire purpose of P2-3. ✓
  - Line 781–785 (`adminCancel` Stripe call): warned, continues with
    local cancel. ✓ Correct — we don't want a Stripe outage to block
    the admin's local cancel.
  - Line 929–933 (`abandonAndCancel` Stripe call): warned, continues. ✓
  - Line 1002–1005 (`enqueueReminder`): only unique-violation
    suppressed, all others re-thrown. ✓
  - Line 1050–1054 (`scheduleCadence`): only P2002 suppressed, rest
    re-thrown. ✓
  - Line 1163–1174 (`refreshCancellationView` Stripe): warned, falls
    back to `now+24h`, `shouldSend=true`. ✓
  - Line 1192–1196 (`sendRecoveryEmail`): warned, best-effort. ✓
  - Line 1209–1211 (`lookupRecipientEmail`): returns null; the caller
    handles `null` recipient as "skip with no_recipient_email". ✓

No findings.

**P&L holes:** the cadence is purely outbound-notification. No money
movement, no refund, no ledger writes. `adminCancel` calls Stripe
`cancelSubscription` (line 780) which is the only money-adjacent
operation, gated by `@Roles('owner')`. ✓

**Telemetry gaps:** new metrics shipped (see P3-2 list). Logging is
single-line JSON via `logEvent` (line 1277–1285). The
`dunning.attempt_raced`, `dunning.attempt_skipped` (with reason),
`dunning.admin_reset`, `dunning.attempt_failed_permanent` events are
all present in code and would surface in Datadog. ✓

---

## What's still clean (re-verified)

All eight clean items from v1 (Day 0/3/7/14 cadence, DB constraints,
idempotency keys, webhook routing post-lint-fix, Day-5 recovery path,
scope discipline, template tone, RBAC, state-machine transitions)
remain clean. The refixer commits did not regress any of them; the
tests covering them (cadence-fires-once, idempotency, reopen,
terminate, all four admin overrides, sweeper, getAdminView) all pass.

---

## Final tally

- **P0:** 0
- **P1:** 0 (was 1 in v1; fixed)
- **P2:** 0 (was 4 in v1; all fixed)
- **P3:** 5
  - P3-1: PR #282 textual merge conflict (append-only safe)
  - P3-2: in-process metrics no exporter (worse surface than v1)
  - P3-3: 5 `DUNNING_*` env vars undocumented + silent fallback
  - P3-4 (NEW): `'sending'` rows orphaned on crash mid-send
  - P3-5: env-override + webhook-routing tests still missing

**Tests:** 2900 passed (up from ~2890 in v1; +8 regression tests + 2
template tests). Zero failures.
**TypeScript:** clean.
**Verdict: CLEAN — 0 / 0 / 0 / 5. Merge.**
