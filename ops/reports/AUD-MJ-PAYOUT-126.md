# AUD-MJ-PAYOUT-126 — payouts: can any job do the same work twice? (read-only, T4 money)
Worker AUD-MJ-PAYOUT-126 (Claude Opus 5.5, auditor, agent 126 fleet). Started 18:02 PDT 10-06, done 18:14 PDT (TZ=America/Los_Angeles date).
Hard stop was 18:55. Code: /home/user/workspace/wt/RO-backend @ f71bb9a4 (backend main = production deploy 16). No PRs, no SQL run, no Stripe calls.
SQL for the operator: /home/user/workspace/ops/reports/AUD-MJ-PAYOUT-126-queries.sql

## Context
Production runs every @Cron twice per tick, concurrently, in the same process (two ScheduleModule.forRoot(), fix is b#810
agent126/b-cron-126 @ 9ee51c0b, open). Both copies call the SAME provider instance (SettlementSweepCron and
RefundTransferReversalScheduler are each provided once, src/checkout/checkout.module.ts:103,109), so they share `this.holder`.
Webhooks can also arrive twice. Flags as in production: FEATURE_BANK_PAYOUTS_V2 is "excluded" (off) in
.github/fly-env-desired-state.json; SFEE_SETTLEMENT_SWEEP_ENABLED is unset, so the sweep is ON (settlement-sweep.cron.ts:57-59);
FEATURE_DUNNING_V2 = "true" (fly-env-desired-state.json:41, operator correction 18:16).

## Operator 18:16 correction re-check (FEATURE_DUNNING_V2 is ON) — done 18:15 PDT
No payout verdict assumed dunning v2 off. Re-checked every dunning-v2 touch point on the payout paths:
- src/checkout/dunning-v2/**: no transfer, reversal or payout writes; the only ConnectTransfer use is a read to resolve a purchase
  (dunning-v2.service.ts:2069-2073).
- refund-dispute-handler.service.ts:1961-1969 (lost chargeback): the head-coach reversal runs through
  applyDisputeTransferReversalOnce (once-only claim, job #7) BEFORE the D2d restartedByCoach check; restartedByCoach (:2377) only
  decides entitlement/status, never money. :2066 likewise only gates the disputed mirror.
- refund-dispute-handler.service.ts:491-497 pauseAfterFullRefund and checkout-webhook-handler.service.ts:735 runDisputeEffect act on
  subscriptions / dunning obligations (BILL / DUNNING lanes), not on Connect transfers or payouts.
- dunning-lockout.scheduler.ts:28 is a DUNNING-lane cron; it moves no payout money.
Result unchanged: 15 SAFE / 0 UNSAFE / 0 UNKNOWN.

## Scope traced (payout area)
Inventory: `git grep -n "@Cron(\|@Interval(\|@Timeout(" -- src`. Payout-area timed jobs: only two.
- src/checkout/settlement-sweep.cron.ts:71 `sfee-settlement-sweep` (*/15) -> PurchaseSplitHandlerService.runTransferSweeper
  (purchase-split-handler.service.ts:222): settlements (SETTLE lane) -> payout notices -> due coach / head-coach transfers.
- src/checkout/refund-transfer-reversal.scheduler.ts:35 `refund-transfer-reversal-retry` (*/15) -> head-coach transfer reversals owed
  for refunds and lost chargebacks (shared with SETTLE lane; covered here because it moves Connect transfer money).
Retry paths / admin: POST /v1/admin/payments/transfers/run-sweeper (payment-ops.controller.ts:268-271, no lease), POST
payout-readiness/run-sweeper (payment-ops.controller.ts:482-486). Webhooks (one Stripe endpoint, BillingService.handleEvent):
transfer.failed, payout.failed/canceled, payout.paid, transfer.reversed, account.updated; plus /v1/webhooks/payouts-v2/stripe-connect.
Read side: coach earnings (payment-ops.controller.ts:893 computeEarningsSummary), GET /v1/connect/accounts/me (payout sync, b#750).

## Verdict table (15 jobs: SAFE 15 / UNSAFE 0 / UNKNOWN 0)
| # | Job (entry file:line) | Money work | Guard (file:line) | Verdict |
|---|---|---|---|---|
| 1 | sfee-settlement-sweep cron, transfer leg (settlement-sweep.cron.ts:71 -> runOnce :76) | posts coach / head-coach Stripe transfers | (a) CronLease single-runner: conditional `updateMany WHERE name AND lease_until < now` then INSERT on PK, P2002 = held (cron-lease.service.ts:31-45; schema.prisma:4686 `name @id`). Not re-entrant by holder, so the second copy (same holder string) still loses; it returns before the finally/release (settlement-sweep.cron.ts:94-97). (b) If a copy ever runs after the first released, every row is still guarded by #5. | SAFE |
| 2 | Admin run-sweeper (payment-ops.controller.ts:268-271) | same as #1, no lease | per-charge money lock with a fresh random token per acquisition (charge-lock.ts:159, ALS re-entry only inside one call :169-173) + #5 per-row claim + Stripe key | SAFE |
| 3 | Inline head-coach transfer on charge webhook (purchase-split-handler.service.ts:179-198) | queues + sends legacy head-coach split | row upsert on unique key `tgp-tr-<purchase>-headcoach` (transfer-orchestrator.service.ts:344-366; schema.prisma:4606 `idempotency_key @unique`); send via #5 under the charge lock | SAFE |
| 4 | Settlement leg transfer enqueue (charge-settlement.service.ts:864-876) | queues coach_net / head-coach legs | key `tgp-settle-<chargeId>-<leg>` (charge-settlement.service.ts:876), deterministic; create inside the settlement tx, unique index rejects a second insert (transfer-orchestrator.service.ts:373-404) | SAFE |
| 5 | TransferOrchestratorService.attempt (transfer-orchestrator.service.ts:460) incl. crash re-run / adoption | Stripe POST /transfers | claim-by-write CAS `updateMany WHERE id, status, attempts, stripe_transfer_id NULL, stripe_send_unresolved_at = read value`, loser returns (:522-539); Stripe Idempotency-Key = persisted row.idempotency_key (:580, header stripe-connect-api.service.ts:720, :861), identical for both copies; metadata.tgp_transfer_op lookup before any re-send after a crash (:483-486, :567); recordPosted CAS on pending (:803-815) | SAFE |
| 6 | Payout-adjustment notices: sweep dispatchPending (payout-notice.service.ts:210) + post-webhook dispatchForCharge (:181) | in-app + push + email to payee | claim CAS on dispatch_claimed_at (:237-252), fence before each channel (:258-260), in-app receipt CAS in the same tx as the inbox row (:378-396), push throttle_key = notice id (:447-455), email key from notice key (:525, :563); notice row unique key (schema.prisma:4817) | SAFE |
| 7 | refund-transfer-reversal-retry cron (refund-transfer-reversal.scheduler.ts:35 -> refund-dispute-handler.service.ts:1161) | Stripe transfer reversal (coach clawback) per refund / lost dispute | deterministic keys `tgp-tr-rev-refund-<id>` / `tgp-tr-rev-dispute-<id>` (refund-dispute-handler.service.ts:60-64); prior op by key short-circuits (transfer-orchestrator.service.ts:1029-1033); reversal slot CAS on reversal_seq + one-pending check (:1201-1225); TransferReversalOp.idempotency_key @unique and @@unique(transfer_id, seq) (schema.prisma:4639, :4657); send claim CAS on attempts (:1282-1291); Stripe key = op key (:1322); dispute row claim CAS (refund-dispute-handler.service.ts:1261-1268); ledger posting only by the claimer (:1021-1026). Loser returns 'pending' (:1012-1017), no alert | SAFE |
| 8 | transfer.failed webhook + coach alert (billing.service.ts:555 -> :1362) | marks transfer failed, COACH_ALERT | StripeProcessedEvent PK insert in the same tx (billing.service.ts:266-268; schema.prisma:698 `stripe_event_id @id`; P2002 -> alreadyProcessed :587-590); status CAS `status != failed`, alert only when count = 1 (:1401-1408, :1423) | SAFE |
| 9 | payout.failed / payout.canceled webhook + coach alert (billing.service.ts:567-569 -> :1493) | snapshot status, COACH_ALERT | event-id dedup as #8; same-payout same-status replay is a no-op (:1555-1558) | SAFE |
| 10 | payout.paid (and payout.* first refusal) -> RefundDisputeHandler.onPayoutEvent (refund-dispute-handler.service.ts:2337) -> PayoutReadiness.recordPayoutEvent (payout-readiness.service.ts:260) | snapshot overwrite only, no money, no message | absolute overwrite, newer-arrival wins (:277-298) + event-id dedup | SAFE |
| 11 | transfer.reversed webhook (refund-dispute-handler.service.ts:2228) | syncs reversed total | absolute monotone sync `max(recorded, stripe amount_reversed)` (:2248-2265); legacy rows observe only (:2266-2309); settlement rows under the charge lock (:2321) | SAFE |
| 12 | Payout sync B-PAYOUTSYNC-123 (b#750): GET /v1/connect/accounts/me -> ConnectService.getStatusForCoach (connect.service.ts:133-152) and account.updated (billing.service.ts:1255-1294) | mirrors Stripe account flags | absolute overwrite from Stripe (connect.service.ts:178-190), no counters, no messages | SAFE |
| 13 | Payout readiness stale sweep (payout-readiness.service.ts:303, admin only) | refreshes snapshots | absolute overwrite from Stripe | SAFE |
| 14 | Payouts v2 webhook + routing (payouts-v2-webhook.controller.ts:47; checkout-webhook-handler.service.ts:781) | none | FEATURE_BANK_PAYOUTS_V2 off -> no-op (payout-routing.service.ts:75); even when on it only classifies (no writes) | SAFE |
| 15 | Coach earnings / balances (payment-ops.controller.ts:893-930) | read-only sums | derived from SplitLedgerEntry + PayeeRecovery rows; no stored counters (`increment:` grep: none in payout code); legacy slices keyed by unique idempotency_key with P2002 adoption (split-ledger.service.ts:415-450), per-charge slices created once under the ChargeSettlement unique-per-charge claim (schema.prisma ChargeSettlement.stripe_charge_id @unique); legacy and settlement paths are exclusive per charge (purchase-split-handler.service.ts:98-108) | SAFE |

No UNSAFE or UNKNOWN, so no smallest-fix list. The SQL file still gives zero-row confirmation queries (Q1 double transfer per leg,
Q2 one Stripe transfer on two rows, Q3 over-reversal, Q4 double transfer/payout-failed alert, Q5 double payout notice,
Q6 earnings double-count, Q7 lease state, Q8 unresolved sends).

## B list
None.

## U list
None.

## C one-liners
- C (edge, deferred to 10k clients): payout-notice email key includes the attempt number (payout-notice.service.ts:525/563); a crash between the email send and its status save could send one more email on the retry.
- C (edge, deferred to 10k clients): transfer.failed / payout.failed coach alerts are written through NotificationsService, not the webhook tx (billing.service.ts:1436, :1574); if the tx then rolls back, Stripe's redelivery alerts again.
- C (not double-work, follow-up): onPayoutEvent reads `payout.account` (refund-dispute-handler.service.ts:2349-2353), which real Stripe payout objects do not carry (the connected account is on the event envelope), so payout.paid never refreshes the snapshot from the webhook (the TTL refresh covers it). If it ever matched, it would pre-write the status and applyPayoutFailed (billing.service.ts:1555) would skip the coach alert.
- C (sub-coach waits): legacy head-coach transfer key is per purchase (transfer-orchestrator.service.ts:345), so pre-S-FEE recurring renewals collapse onto one row: an under-pay of the legacy head-coach split, never a double-pay.

## Covered by open PRs
- Root cause (every cron twice): b#810 agent126/b-cron-126 @ 9ee51c0b "fix(schedule): load ScheduleModule once ..." (B-CRON-126). No other open backend PR touches payout code.

## PRs opened
None (read-only auditor).

## Not fixed (needs operator)
Nothing required. Optional: run /home/user/workspace/ops/reports/AUD-MJ-PAYOUT-126-queries.sql (read-only) to confirm Q1-Q6 return zero rows.

## HANDOFF
DONE 18:14 PDT; FEATURE_DUNNING_V2=on re-check done 18:15 PDT (no change). Report and SQL written; notify line written. No worktrees, branches, locks or ci-lane runs were created.
