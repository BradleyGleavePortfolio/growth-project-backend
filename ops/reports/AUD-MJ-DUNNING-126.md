# AUD-MJ-DUNNING-126 — can any dunning job do the same work twice? (agent 126 fleet, read-only, T4 money)

Started 18:02 PDT 10-06, report written 18:11 PDT, v2-ON redo 18:14-18:17 PDT (times from `TZ=America/Los_Angeles date`; redo finished 18:17). Code: /home/user/workspace/wt/RO-backend
= backend main f71bb9a4 (production, deploy 16). No PRs, no SQL run, no Stripe calls.
SQL for the operator: /home/user/workspace/ops/reports/AUD-MJ-DUNNING-126.sql

## Verdict
**12 jobs/paths: 12 SAFE, 0 UNSAFE, 0 UNKNOWN. B=0 U=0.** v2-ON redo (18:16 correction): 10 v2 paths, 10 SAFE, 0 UNSAFE, 0 UNKNOWN. Nothing in dunning can send two dunning emails, charge twice,
cancel twice or lock twice because of the duplicate ScheduleModule (or a duplicate webhook delivery).

Why the duplicate scheduler does not hurt dunning: @nestjs/schedule 6.1.3 `ScheduleExplorer.lookupSchedulers` wraps the SAME
provider `instance` for each ScheduleModule copy (deps/backend/node_modules/@nestjs/schedule/dist/schedule.explorer.js:44-71), so
both copies share the instance `running` flag; both dunning crons check and set it synchronously before their first await. Under
that, every write is a conditional update / unique key / deterministic idempotency key, so even a back-to-back re-run is a no-op.

## Flag state (CORRECTED 18:16 by the operator)
FEATURE_DUNNING_V2 is ON in production: b#762 merged and fly-env-sync apply ran 21:11Z 10-06 (run 37532040631; SoT line 7803
"Dunning gate met: b#762 merged, env-sync applied"). My first pass assumed off; the v2-ON redo is the section below. v1 timers do
not exist either way: `DunningService.tick()` / `runSweeper()` run only from owner-only admin routes (payment-ops.controller.ts:114-116,
:276-280), and under v2 they return at once (dunning.service.ts:437, :853), so v1 never sends a second email sequence.

## v2-ON REDO (18:14-18:17 PDT): the :07 sweep and every v2 path it drives — 10 SAFE, 0 UNSAFE, 0 UNKNOWN
Two concurrent copies: both call the SAME DunningLockoutScheduler instance (schedule.explorer.js:44-71), so copy 2 hits the shared
`running` flag and is skipped. If copy 1 had already finished, copy 2 is a re-run and every write below is one-winner, so it does nothing.
| # | v2 path | Guard (file:line, f71bb9a4) | Verdict |
|---|---|---|---|
| V1 | Sweep entry `handleCron` | flag check then `running` checked and set synchronously before the first await, dunning-lockout.scheduler.ts:33-41 | SAFE |
| V2 | Step advance (Day 1/3/7) `advance` → `claimWithOutbox` | CAS `updateMany` on id+status+locked_out_at+client_canceled_at+step_index+entered_at, `count !== 1` loses, dunning-v2.service.ts:466-482, :505; outbox rows created in the SAME tx with a deterministic id `<state>:<cycle>:<step>:<channel>` (:126-132, :509-523, upsert update:{}) | SAFE |
| V3 | Notice send: client push / email / in-app blocker, coach alert / push / email (`dispatchClaim`) | per-row CAS to 'sending' on status+attempts+claim_token with a new token, :649-662 (loser `continue`); cycle re-checked :672; receipt only by the token holder :691; email key `dunning_v2:<state>:<cycle>:email:<step>` dunning-v2.dispatcher.ts:271 + EmailSendLog.idempotency_key @unique (email.service.ts:161-173); coach key `coach_notify:<state>:<cycle>` dispatcher :340/:393. Push and blocker have no transport key; the row claim is their only guard, and it is enough. | SAFE |
| V4 | Outbox retry `retryDueNotices` | due rows only (:617; pending rows wait 10 min grace :520), same claim CAS as V3 | SAFE |
| V5 | Day-10 lockout `tryLock` | row lock :948, re-read, CAS on locked_out_at:null+entered_at+step_index :955-963; entitlement write and telemetry only when won (:965-967, :973); sweep selects only locked_out_at:null (:823) | SAFE |
| V6 | Pause re-assert `reassertDisputePauses` → `confirmDisputePause` | ClientBillingLease CAS :1787 (busy → skip), fencedTx :1806; Stripe keys `dunning_v2:dispute_pause:<purchase>:<cycle>:<fence>` :1531 and `...:<invoice>` :1537; pause/uncollectible are idempotent in effect | SAFE |
| V7 | Recovery tokens (PaymentRecoveryToken) | never created anywhere in src (no `create`); only revoked with `used_at: null` filter, dunning-v2.service.ts:1062, client-billing.service.ts:1833; links use the static DUNNING_UPDATE_CARD_URL | SAFE |
| V8 | Webhook Day-0 claim racing the sweep (`recordPaymentFailed` :407, fire-and-forget dispatch checkout-webhook-handler.service.ts:2898) | Day-0 CAS on step_index read (-1→0) :433-437; sweep only selects step_index>=0 (:827); webhook dispatch claims pending rows, sweep retry only past grace (V3/V4) | SAFE |
| V9 | v1 alongside v2 (attempt rows, recovery email) | v1 cadence rows are written but never sent (tick returns :437); v1 recovery email once per DunningState, key `dunning-recovered:<state id>` dunning.service.ts:1186; v2 `applyImmediateClear` sends nothing | SAFE |
| V10 | Reconciler out-of-band 2A (flag on), client-billing.service.ts:1935 | reconciler `running` flag client-billing.reconciler.ts:32-36 + ClientBillingLease CAS client-billing.service.ts:2223 + void key :341 | SAFE |

Duplicate-check SQL for DunningAttempt / DunningNoticeDelivery / DunningState / PaymentRecoveryToken: Q8-Q13 in the SQL file (all
should return 0 / no rows; from the 21:11Z flag-on time onward).

## Table (file:line on f71bb9a4)
| # | Job / path | Trigger | What it does | Guard (file:line) | Verdict |
|---|---|---|---|---|---|
| 1 | `dunning-v2-sweep` DunningLockoutScheduler.handleCron → DunningV2Service.runSweep | @Cron '7 * * * *' dunning-lockout.scheduler.ts:28 (LIVE: flag on) | advance Day 1/3/7 notices, Day-10 lockout, re-assert dispute pauses, retry outbox | Detail in v2-ON REDO V1-V8. instance flag :37-41; step claim CAS on step_index/entered_at/locked_out_at dunning-v2.service.ts:505 (in tx with outbox); deterministic outbox id `<state>:<cycle>:<step>:<channel>` :509/:126-132; per-row claim CAS (status+attempts+token) :649; lock CAS `locked_out_at: null`+entered_at+step_index :955-963 under row lock; email key `dunning_v2:<state>:<cycle>:email:<step>` dunning-v2.dispatcher.ts:271; coach key `coach_notify:<state>:<cycle>` dispatcher :340/:393 | SAFE |
| 2 | `client-billing-reconcile` ClientBillingReconciler → ClientBillingService.reconcile | @Cron '37 * * * *' client-billing.reconciler.ts:27 (runs with flag off) | finish in-dunning cancels (void open invoices, cancel sub, end access), settle lost card-pay answers; flag on: out-of-band 2A | instance flag :32-36; ClientBillingLease CAS client-billing.service.ts:2223 (loser throws inProgress, op deferred); void key `tgp-2a-void-<invoice>` :341; pay replay only when Stripe already shows the invoice paid :898 with key `tgp-1a-pay-<invoice>-<setupIntent>` :336; op closed via completed_at :1918 | SAFE |
| 3 | v1 cadence tick + grace sweeper DunningService.tick/runSweeper/abandonAndCancel | owner admin POST only (no timer) | send Day 0/3/7/14 emails; cancel sub after grace | Not on any timer (unaffected). If run: claim CAS pending/failed→sending dunning.service.ts:514; key `dunning:<attempt id>` :531 + EmailSendLog.idempotency_key @unique (email.service.ts:161-173); DunningAttempt @@unique(state, step) schema.prisma:5099; PaymentReminder @@unique(purchase,kind,channel,window_key) :5137; v2-on: tick/sweeper return :437/:853 | SAFE |
| 4 | invoice.payment_failed (client plan) applyInvoicePaymentFailed | Stripe webhook | past_due + v1 recordFailure + v2 Day-0 claim | StripeProcessedEvent insert in tx billing.service.ts:267 (fast path :176); v1 uniques above; v2 claim CAS (#1); purchase write under package lock + version check checkout-webhook-handler.service.ts:2849-2856 | SAFE |
| 5 | invoice.paid / payment_succeeded resolveDunningOnPaid | Stripe webhook | resolve cycle, recovery email, lift lockout | event dedup (#4); recovery email key `dunning-recovered:<state id>` dunning.service.ts:1186 + EmailSendLog unique; applyImmediateClear sends nothing, idempotent (dunning-v2.service.ts:994) | SAFE |
| 6 | customer.subscription.deleted → DunningService.terminate | Stripe webhook | close cycle, cancel pending attempts | event dedup; status guard dunning.service.ts:397-398; no send | SAFE |
| 7 | Coach SaaS invoice.payment_failed → PAYMENT_FAILED email | Stripe webhook | coach's own TGP plan past_due email | event dedup (in tx); key `billing-payment-failed:<event id>` billing.service.ts:1199; PaymentFailure.stripe_event_id @unique | SAFE |
| 8 | Dispute pause (charge.dispute.*) + sweep re-assert | webhook + #1 | pause_collection, mark open invoices uncollectible | ClientBillingLease CAS dunning-v2.service.ts:1787 + fencedTx :1806; keys `dunning_v2:dispute_pause:<purchase>:<cycle>:<fence>` :1531 and `...:<invoice>` :1537; flag-gated | SAFE |
| 9 | Client update card + pay (confirmCardUpdate → payPlan → payOne) | client tap | pay open invoices with new card | lease 'paying' client-billing.service.ts:611; key `tgp-1a-pay-<invoice>-<setupIntent>` :1024 | SAFE |
| 10 | Client cancel during dunning (runDunningCancel, 2A) | client tap / #2 | void invoices, cancel sub, end access | lease 'canceling' :1564; void key :341; journaled intent before each void | SAFE |
| 11 | Coach Restart plan (restartAfterDisputePause) | coach tap | resume billing after dispute pause | dispute lease → `billing_busy`; other-live-plan refusal (dunning-v2.service.ts:1556-1747) | SAFE |
| 12 | Owner admin dunning routes (advance/reset/cancel/trigger-immediate) | owner | drive v1 state | tick claim CAS (#3); terminate status guard | SAFE |

Not in this area / none exist: no card-expiry or card-update reminder job exists in src (grep for card_expir / customer.source.expiring:
none). Nudges explicitly exclude past_due (nudge-detector.service.ts:77-86). No payment-retry charge job exists: Stripe performs every
retry; TGP charges only on a client tap (#9).

## UNSAFE / UNKNOWN
None. (So no per-job counting query is required; the SQL file still has confirm-zero queries Q1-Q6 and Q8-Q13, and informational Q7.)

## B list
None.

## U list
None.

## C one-liners
- C (edge, deferred to 10k clients): v1 `failure_count` can be incremented twice if the outer webhook tx rolls back after
  recordFailure committed (cosmetic counter; Stripe's attempt_count drives copy).
- C (edge, deferred to 10k clients): v2 push/in-app is at-least-once after a 10-minute claim takeover (email dedups by key).
- C (edge, deferred to 10k clients): recovery email key is per DunningState, so a second dunning cycle on the same plan gets no
  recovery email (under-send, never double).

## Operator note (replaces the 18:11 "no automatic past-due notice" note, which assumed the flag was off)
- v2 is on, so the :07 sweep sends the Day 0/1/3/7 notices and the Day-10 lock; v1 cadence rows (DunningAttempt) and PaymentReminder
  rows are still written by the webhook but are never sent. That is by design (v2 owns every notice) and is not double work.
  SQL Q7 / Q8 show those unsent v1 rows; they are expected, not a fault.

## Covered by open PRs
None needed. Open backend PRs at 18:09: none touch src/checkout/dunning*, client-billing* or billing.service.ts (B-CRON-126's PR
not yet listed; it removes the second ScheduleModule.forRoot, which makes the instance-flag reliance moot).

## PRs opened
None (read-only job).

## Not fixed (needs operator)
Nothing.

## HANDOFF
Done. Report and SQL complete. If a fresh agent continues: run nothing; the operator runs AUD-MJ-DUNNING-126.sql read-only
(expect zeros in Q1-Q6 and Q8-Q13) and checks Fly logs for "dunning v2 sweep: previous tick still running, skipping" at :07 and
"client billing reconcile: previous tick still running, skipping" at :37 as proof the second copy was skipped.
