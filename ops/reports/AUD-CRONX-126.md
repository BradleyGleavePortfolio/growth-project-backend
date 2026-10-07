# AUD-CRONX-126 — what the duplicate scheduler double run could have done (agent 126 fleet)

Auditor: AUD-CRONX-126 (Claude Opus 5.5, read-only, T4 money). Start 17:59 PDT 10-06, report 18:1x PDT (times from `TZ=America/Los_Angeles date`).
Code: /home/user/workspace/wt/RO-backend = backend main f71bb9a4 (= production deploy 16). Flags: .github/fly-env-desired-state.json on main.
Queries for the operator: /home/user/workspace/ops/reports/AUD-CRONX-126-queries.sql (SELECT only; table names checked against
prisma/schema.prisma, none of the tables used has an @@map).
Operator 18:05 re-scope applied: full table kept; depth on jobs that SEND to users and on data writes; money jobs given a
one-pass safety read (AUD-MJ-*-126 own the depth).

## Premise (confirmed in code)
`ScheduleModule.forRoot()` at src/app.module.ts:169 and src/data-export/data-export.module.ts:32. @nestjs/schedule 6.1.3
`forRoot()` returns a fresh dynamic-module object each call (deps/backend/node_modules/@nestjs/schedule/dist/schedule.module.js:22);
on @nestjs/core 11.1.27 that is two module instances, so two ScheduleExplorers each run `explore()` over ALL providers and every
@Cron/@Interval is registered twice. Both copies call the SAME singleton method at the same tick. So:
- an in-memory `if (this.running) return; this.running = true` set before the first `await` DOES protect (one JS thread);
- a DB claim (conditional update, unique insert, SKIP LOCKED, lease row) protects;
- find-then-act with no claim runs twice.
Manually registered jobs (src/coach/brief/coach-brief.scheduler.ts:157-217 via `schedulerRegistry.addCronJob`) are registered once.
The double run has existed since #171 (2026-05-12).

## Scope traced (35 files, 39 decorators)
Every @Cron/@Interval in src (no @Timeout exists). Money first, then senders, then data writes. Columns: Safe twice? and why.

| # | Job (file:line) | What it does | Live on prod? | Safe twice? | Why / what a user would see |
|---|---|---|---|---|---|
| **Money** |||||
| 1 | client-billing-reconcile (checkout/client-billing.reconciler.ts:27) | finishes in-dunning cancels | yes | SAFE | `running` flag + Stripe idempotency keys |
| 2 | dunning-v2-sweep (checkout/dunning-v2/dunning-lockout.scheduler.ts:28) | Day-N dunning steps, notices, lockout | YES (operator 18:16: FEATURE_DUNNING_V2 on since env-sync 14:11 10-06) | SAFE | `running` flag + CAS on step_index / locked_out_at; notices use a deterministic id (`noticeDeliveryId`, dunning-v2.service.ts:126) + upsert (:510) + CAS sends, so a dunning email/push cannot go out twice |
| 3 | refund-transfer-reversal-retry (checkout/refund-transfer-reversal.scheduler.ts:35) | retries head-coach transfer reversals | yes | SAFE | refund-scoped Stripe idempotency key + `transfer_reversed` CAS claim (refund-dispute-handler.service.ts:967-1006) |
| 4 | sfee-settlement-sweep (checkout/settlement-sweep.cron.ts:71) | coach payouts / transfers | yes | SAFE | "CronLease" conditional update + unique insert (cron-lease.service.ts:25-46); second copy gets lock_held; transfers carry stable idempotency keys |
| 5 | trial-conflict-sweep (packages/trials/trial-conflict.service.ts:474) | cancels a losing trial purchase | no native trials in prod | SAFE | per-row lease_token CAS (:268) |
| 6 | trial-notice-sweep (packages/trials/trial-notice.service.ts:536) | trial-ending push + email | no native trials in prod | SAFE | per-channel claim before send (:716) |
| 7 | coach-ai-budget-rollover (ai-credits/coach-ai-budget.scheduler.ts:28) | monthly AI pool reset | yes | SAFE | CAS `period_end <= now` (coach-ai-budget.service.ts:506) |
| 8 | guest-checkout-reconciliation (storefront/guest-checkout-reconciliation.service.ts:49) | converts paid guest checkouts to accounts + purchase | yes | LIKELY SAFE (defer to AUD-MJ) | no claim, but purchase insert is unique-keyed, the loser's tx aborts, markRetryable is CAS on status, welcome email only after a committed tx |
| 9 | checkout-lost-webhook-reconcile (storefront/lost-webhook-reconcile.service.ts:54) | polls Stripe for pending guest PIs | yes | SAFE for money | uses the webhook path (handlePaymentSucceeded); C: reconcile_attempts counts twice per minute, so the give-up cap is reached in half the time |
| 10 | checkout-receipt (storefront/checkout-receipt.scheduler.ts:37) | legacy PDF receipt email | NO (LEGACY_PDF_RECEIPT_ENABLED unset; code needs 'true') | NOT SAFE (inert) | find-then-send with no claim; would double the receipt email if ever turned on |
| **Senders (push, in-app, email, messages)** |||||
| 11 | push-outbox (notifications/push/push-delivery.service.ts:293) | sends queued pushes | yes | SAFE | `draining` flag + `FOR UPDATE SKIP LOCKED` claim (:330) |
| 12 | push-receipts (push-delivery.service.ts:682) | Expo receipts, token cleanup | yes | SAFE | `receiptSweepRunning` flag |
| 13 | **nudge-detection (notifications/nudges/nudge.scheduler.ts:43)** | missed check-in / streak / inactive / onboarding nudges | yes (NUDGE_ENABLED unset = on) | **NOT SAFE (deferred path)** | fresh nudges are safe (unique NudgeLog(user_id, trigger_type, signal_key)); but `reprocessDeferred` (nudge-engine.service.ts:210-235) reads `status='deferred'` with no claim and updates unconditionally, both copies pass `tryReserveCapBucket` (same row, same bucket, no conflict) and both deliver. User sees: a nudge held for quiet hours (21:00-08:00 local) arrives twice at 08:00 (two identical in-app rows via createNotification, which has no dedupe; two pushes via pushToUser, which goes straight to Expo; the email once thanks to its idempotency key). Query Q1/Q1b |
| 14 | client-daily / coach-daily / weekly digest (notifications/digest.scheduler.ts:35,53,71) | digest emails | yes | SAFE | unique NotificationDigestLog(user_id, digest_kind, window_date) claimed before send (notifications.service.ts:933) |
| 15 | booking-reminder-1h / -24h (scheduling/jobs/reminder.job.ts:235,263) | session reminders | yes (BOOKING_REMINDERS_ENABLED=on) | SAFE | unique NotificationDeliveryLog claim + versioned CAS takeover (:809-890) |
| 16 | booking-request-expiry (scheduling/jobs/request-expiry.job.ts:90) | expires requests, notifies | yes | SAFE | "SchedulingJobLease" conditional update + unique insert |
| 17 | coach-broadcast-dispatch (broadcasts/broadcast-dispatcher.service.ts:97) | coach broadcasts | yes | SAFE | `running` flag + CAS on next_run_at/updated_at + unique run_key |
| 18 | coach-welcome-message (engagement/coach-welcome.service.ts:119) | welcome DM after intake | yes (unset = on) | SAFE | `running` flag + unique client_id / message_id |
| 19 | workout-reminders (engagement/workout-reminder.service.ts:107) | daily workout reminder | yes (unset = on) | SAFE | `running` flag + unique (client_id, local_date) |
| 20 | drip-dispatcher (packages/drip-dispatcher.cron.ts:84) | package content drops | yes | SAFE | `running` flag (this is the operator's skip warning); C: one warn line per minute of log noise |
| 21 | **ptm-recompute-nightly (ptm/ptm.scheduler.ts:41)** | client risk score + coach red-risk alert | yes (PTM_SCORING_ENABLED unset = on) | **NOT SAFE** | both copies read the same previous prediction, both write a red one, `CoachAlertsService.createAlert` (coach/coach-alerts.service.ts:85-111) dedupes by find-then-create with no unique key. Coach sees: two "<client> crossed into the red risk band" alerts and two in-app rows for the same client the same night; the push goes through the outbox with collapse key `coach_alert:<deep link>` (notifications.service.ts:605), so it is usually collapsed to one, and doubled only when both copies enqueue before either row exists. Also two "PtmPrediction" rows per client per night (admin views). Query Q2/Q2b/Q3 |
| 22 | weekly-insight (ai/coach/weekly-insight.cron.ts:36) | weekly coach AI brief | NO (CRON_COACH_AI_INSIGHT unset; needs 'on') | NOT SAFE (inert) | no guard; would double the brief if turned on |
| 23 | crm-lead-sync (landing-pages/crm/lead-sync.processor.ts:90) | pushes leads to coach CRM | yes | SAFE | `FOR UPDATE SKIP LOCKED` claim |
| 24 | community-events-transitions (community/events/community-events.scheduler.ts:47) | event state changes | NO (FEATURE_COMMUNITY_EVENTS unset) | SAFE | flag + `running` |
| **Data writes / erasure** |||||
| 25 | coach-effectiveness-nightly (coach/coach-effectiveness.scheduler.ts:46) | coach score | yes | NOT SAFE (C) | append-only create, two rows per coach per night; admin-only, readers take the latest. Canary Q3 |
| 26 | leaderboard-nightly-recompute (leaderboard/leaderboard.scheduler.ts:31) | in-memory scores | yes | C | in-memory cache only; both copies compute the same score |
| 27 | account-deletion finalize (account-deletion/account-deletion.service.ts:592) | hard delete after grace | yes | SAFE | row lock in tx + deleted_at check; loser gets locked/already_deleted |
| 28 | gdpr-scrub (users/gdpr-scrub.scheduler.ts:36) | tombstones deleted users | yes (GDPR_SCRUB_DRY_RUN=false) | C | no claim, but writes the same tombstone values (idempotent) |
| 29 | roman-erase-deleted-sessions (roman/roman-erasure.sweep.ts:85) | Roman erasure | yes | SAFE | `running` flag |
| 30 | voice-erasure (community/voice/voice-erasure.ts:214) | voice note erasure | voice notes off | SAFE | lease CAS (:169) |
| 31 | data-export-cleanup (data-export/data-export-cleanup.cron.ts:21) | expires export archives | yes | C | idempotent deletes; at most duplicate Sentry noise |
| 32 | guest-checkout-pii-scrub (storefront/guest-checkout-pii-scrub.service.ts:59) | scrubs guest PII | yes | SAFE | CAS `scrubbed_at: null` |
| 33 | wearable-processed-event-prune (wearables/maintenance/...prune.scheduler.ts:42) | prunes dedupe rows | yes | SAFE | idempotent deleteMany |
| 34 | workout-builder-revision-prune (workout-builder/workout-builder-revision-prune.cron.ts:38) | prunes autosave revisions | yes | SAFE | Serializable tx, same candidate ids; loser fails serialization and logs |
| 35 | bloodwork-stale-daily (bloodwork/bloodwork-stale.scheduler.ts:24) | marks panels stale | yes | SAFE | idempotent updateMany, no send |
| 36 | scout-progress-flush @Interval (scout/scout.service.ts:263) | importer progress upsert | importer off | SAFE | upsert of latest snapshot |

## B list (item-1 only)
None at job level. No money job double-charges, double-pays, double-refunds or double-credits: every money path has a DB claim,
lease or Stripe idempotency key. The root cause (two ScheduleModule instances) is B-CRON-126's fix.

## U list
- U1 nudge-detection deferred path (nudge-engine.service.ts:210-235): a client whose nudge was held for quiet hours gets the same
  nudge twice the next morning (two in-app rows, two pushes). Fixed for good by B-CRON-126; job-level fix if wanted: make the
  reprocess a claim (`updateMany where {id, status:'deferred'}` and skip when count !== 1).
- U2 ptm red-risk alert (ptm-recompute.service.ts:101-157 + coach-alerts.service.ts:85-111): a coach gets two identical
  "crossed into the red risk band" alerts in the alert list and inbox for one client the same night (push usually collapsed to one). Fixed by B-CRON-126; job-level fix if
  wanted: `running` flag in PtmScheduler.handleCron.

## C one-liners
- C coach-effectiveness and PtmPrediction append twice per night (admin-only duplicates; readers take the latest).
- C lost-webhook reconcile_attempts increments twice per minute (give-up cap reached in half the intended time).
- C drip-dispatcher / guarded jobs log one "skipped" warn per tick (log noise, goes away with B-CRON-126).
- C checkout-receipt and weekly-insight are unguarded but switched off; they would double if switched on.
- C gdpr-scrub, data-export-cleanup, leaderboard run twice with idempotent results.
- Note: FEATURE_DUNNING_V2 is ON in production (operator correction 18:16; desired-state file agrees). Row 2 treated as live; safe.

## Covered by open PRs
- Root cause: B-CRON-126 (remove the second ScheduleModule.forRoot()). Not checked against its PR head (not mine to review).

## PRs opened
None (read-only job).

## Not fixed (needs operator)
- Run AUD-CRONX-126-queries.sql in production (read-only). Q3 (canary) confirms the double run historically; Q1/Q2 count
  what users actually received; Q0* are catch-alls across every push/in-app/email row.
- U1/U2 disappear once B-CRON-126 deploys; no separate PR recommended unless the operator wants belt-and-braces.

## HANDOFF
Done. Table complete for all 36 job entries (39 decorators; digest and booking reminders grouped). Queries in
/home/user/workspace/ops/reports/AUD-CRONX-126-queries.sql. No worktrees, no branches, no locks held.
