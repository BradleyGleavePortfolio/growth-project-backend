# AUD-MJ-SETTLE-126 — settlement and fees: can any job do the same work twice?

Auditor: AUD-MJ-SETTLE-126 (agent 126 fleet), read-only, T4 money. Started 18:02 PDT 10-06, report written 18:12 PDT.
Code read: /home/user/workspace/wt/RO-backend = backend main f71bb9a4 (= production, deploy 16).
Context: duplicate `ScheduleModule.forRoot()` (app.module.ts:169 + data-export.module.ts:32) means every @Cron runs as two
concurrent copies in the same process, calling the same singleton instance. Webhooks can also arrive twice.
No PRs, no SQL run, no Stripe calls.

## Result
**SAFE 23 / UNSAFE 0 / UNKNOWN 0.** Nothing in settlement, fees, refunds or the ledger can do the same money work twice under
the double scheduler. Two layers hold this up. First, the only timed settlement job has a DB single-runner lease. Second, every
money write underneath is a claim-by-write, a unique key, or a deterministic Stripe Idempotency-Key, so it would be safe even
without the lease. Credit notes do not exist in the codebase (`git grep -i creditNote|credit_note` = 0 hits), so there is nothing
to check there.
The only remaining dependency is the production DB itself: the verdicts assume the unique indexes from the migrations are present.
SQL Q0 confirms that. Q1-Q11 confirm that nothing was actually doubled in the last 30 days.
SQL: /home/user/workspace/ops/reports/AUD-MJ-SETTLE-126.sql

## Scope traced (jobs, handlers, retry paths)
Timed (from `git grep -n "@Cron(\|@Interval(\|@Timeout(" -- src`), in my area:
- src/checkout/settlement-sweep.cron.ts:71 `sfee-settlement-sweep` (*/15). Calls PurchaseSplitHandlerService.runTransferSweeper
  (purchase-split-handler.service.ts:222), which calls ChargeSettlementService.runSettlementSweep (charge-settlement.service.ts:958),
  PayoutNoticeService.dispatchPending, and then the due-transfer loop.
- src/checkout/refund-transfer-reversal.scheduler.ts:35 `refund-transfer-reversal-retry` (*/15). Calls
  RefundDisputeHandlerService.retryPendingTransferReversals (refund-dispute-handler.service.ts:1161).
- Other crons checked for settlement/fee/refund/ledger calls: none. guest-checkout-reconciliation / lost-webhook-reconcile
  call guestCheckout only; settlement for guests runs post-commit from billing.service.ts:743 plus the sweep backstop. The
  trial-conflict "settle" is a subscription cancel, which is billing scope (AUD-MJ-BILL-126). No queue consumers
  (@Processor/@OnEvent) in checkout/connect/billing.
Webhooks: BillingService.handleEvent (billing.service.ts:166) dispatches to checkout-webhook-handler (charge success -> settle,
:1474/:1501/:1529) and refund-dispute-handler.handle (:259 -> charge.refunded, refund.updated, dispute.*, transfer.reversed).
Manual: createAdminRefund (refund-dispute-handler.service.ts:2427), POST /v1/admin/payments/transfers/run-sweeper
(payment-ops.controller.ts:270), ReconciliationService.runSweep (admin, read + snapshot upsert only).

## Verdict table
| # | Job / handler / path (file:line) | Money step | Guard (file:line) | Verdict |
|---|---|---|---|---|
| T1 | sfee-settlement-sweep tick (settlement-sweep.cron.ts:71-97) | the whole settlement + payout sweep | CronLease single runner. `tryAcquire` (cron-lease.service.ts:25-46) is `UPDATE ... WHERE name AND lease_until < now`, otherwise INSERT on the PK, and P2002 means "held". Copy 2's UPDATE blocks on copy 1's row lock, re-checks the WHERE, matches 0 rows, its INSERT hits P2002, and it returns `lock_held` (settlement-sweep.cron.ts:94) **before** the try/finally, so it never releases copy 1's lease. TTL 10 min, run budget 8 min. Holder is the same string for both copies, but acquisition does not depend on the holder. | SAFE |
| T1a | retry awaiting_fee settlements (charge-settlement.service.ts:965-988) -> settleCharge | create ledger slices + transfer rows for a charge | (1) per-charge lock: ChargeLock.run (charge-settlement.service.ts:525). The lease row `sfee-charge:<id>` uses a fresh random token per run (charge-lock.ts:159), with CAS acquire at charge-lock.ts:208-223. (2) Claim-by-write inside the tx: `updateMany WHERE id, status='awaiting_fee', refunded/dispute cols unchanged` (:722-751), and `if (claim.count !== 1) return null` (:752). Only the winner writes slices/transfers, and the fence (:717) is in the same tx. (3) `ChargeSettlement.stripe_charge_id @unique` (schema.prisma:4702; migration 20270210000000:94). Create P2002 adopts the winner (:2116). | SAFE |
| T1b | orphan paid purchases -> settlePurchase -> settleCharge (:991-1017, :911-955) | same as T1a | same as T1a (per charge) | SAFE |
| T1c | S-FEE invoice backfill (backfillPaidInvoices :1124-1238) | settle a renewal charge with no row | settleCharge guards (T1a). Cursor upsert (:1242) is position only, not money. | SAFE |
| T1d | re-drive stuck reversals (resolveStuckReversals :1048-1080) | Stripe transfer reversal | TransferReversalOp written before Stripe. Slot CAS on `reversal_seq` (transfer-orchestrator.service.ts:1201-1212), one pending op per transfer (:1219-1230), op `idempotency_key @unique` (schema:4639), and a send claim CAS on attempts (:1282-1291). The Stripe Idempotency-Key is the op key (:1322), so it is identical for every driver. Completion is a CAS on status='pending' (:1402). | SAFE |
| T1e | re-run flagged adjustments (rerunFlagged :1082-1121) -> applyAdjustments | reversals / recoveries / reinstatements | charge lock (:1356), adjustment CAS on refunded/dispute columns (:1485-1497), and targets that are absolute (position recomputed from rows, :1821). Recovery key `tgp-rec-<charge>-<leg>-<state>` @unique (:2046, schema:4768). Reinstatement transfer key `tgp-settle-<charge>-<leg>-reinstate-<state>` (:1919) is checked in the tx and is unique. Netting is a CAS on (amount, collected, status) (:2010). | SAFE |
| T1f | payout-notice redelivery (dispatchPending, purchase-split-handler.service.ts:238) | coach in-app / push / email notice | claim CAS on dispatch_claimed_at (payout-notice.service.ts:237-252), a fence before each channel (:258), and the in-app inbox row plus receipt CAS in one tx (:378-404). | SAFE |
| T1g | stale/recovery alerts (reportStale :1265-1340) | log lines only (operator) | read-only counts. Also inside the lease. | SAFE |
| T1h | due-transfer loop (purchase-split-handler.service.ts:245-259) | Stripe transfer create | charge lock (attemptTransferUnderLock :2170) + `ConnectTransfer.idempotency_key @unique` (schema:4606). The Stripe Idempotency-Key = row key (transfer-orchestrator.service.ts:580) is deterministic: `tgp-settle-<charge>-<leg>` (charge-settlement.service.ts:876). Transfer-send internals belong to AUD-MJ-PAYOUT-126. | SAFE |
| T2 | refund-transfer-reversal-retry (refund-transfer-reversal.scheduler.ts:35) | legacy head-coach transfer reversal | no lease; every row-level step is claimed (T2a-c) | SAFE |
| T2a | move expired rows to review + Sentry (refund-dispute-handler.service.ts:1133-1158) | operator alert | claim `updateMany WHERE transfer_reversal_review_at IS NULL` (:1134), and only the claimer alerts | SAFE |
| T2b | refund head-coach reversal (applyRefundTransferReversalOnce :959-1019) | Stripe transfer reversal | key `tgp-tr-rev-refund-<refundRowId>` (:60-61), identical for both copies. Admission stamps first_attempt + amount by CAS (:1105-1115) and both copies read back the same amount. reverse() returns the existing op by key (transfer-orchestrator.service.ts:1030-1034), otherwise there is a slot CAS (T1d). Done is marked by CAS `transfer_reversed=false` (:1050-1066). | SAFE |
| T2c | lost-dispute head-coach reversal (:1243-1289) | Stripe transfer reversal | row claim CAS on transfer_reversal_last_attempt_at (:1261-1268, "another sweep holds it") + key `tgp-tr-rev-dispute-<id>` (:63-64) | SAFE |
| W1 | every Stripe webhook (billing.service.ts:166-268) | all webhook money steps | `StripeProcessedEvent.stripe_event_id @id` (schema:698) is inserted inside the handler tx (:266), so a duplicate delivery gets P2002 and is treated as alreadyProcessed | SAFE |
| W2 | payment success -> onChargeSucceeded / settlePurchase / settleGuestPurchase (checkout-webhook-handler.service.ts:1474,1501,1529) | settle a charge | T1a guards (idempotent per charge id, not per event), so a different event type for the same charge collapses too | SAFE |
| W3 | legacy destination charge (legacyOnChargeSucceeded, purchase-split-handler.service.ts:115-209) | legacy ledger + head-coach transfer | ledger rows keyed `sfee-legacy-ledger:<purchase>:<kind>:<payee>` @unique with P2002 adopt (split-ledger.service.ts:85-89, 415-454). Transfer key `tgp-tr-<purchase>-headcoach` @unique (transfer-orchestrator.service.ts:345) | SAFE |
| W4 | charge.refunded / charge.refund.updated / refund.updated -> upsertAndApplyRefund (refund-dispute-handler.service.ts:742-904) | reverse the payout for a refund; coach refund alert | `ChargeRefund.stripe_refund_id @unique` (schema:5284), with P2002 adopting the winner (:786-797). Under the charge lock (:891), the books are claimed with `updateMany WHERE ledger_reversed=false` (:851, :858). Settlement refunds converge on cumulative succeeded refunds (absolute). Ledger posting is once per (entry, source) via SplitLedgerReversal @@unique (schema:4557). The coach alert is gated on the claim result `ledger_just_reversed` (:399, :616, :709). | SAFE |
| W5 | charge.dispute.* -> applyAdjustments (:1717-1735, onDisputeClosed :1873) | dispute withdrawal, dispute fee, reinstatement | dispute amounts are read from Stripe (canonical, absolute), plus the T1e guards | SAFE |
| W6 | transfer.reversed (onTransferReversed :2228-2335) | transfer reversed total | absolute sync, `max(recorded, Stripe amount_reversed)` (:2250-2256), under the charge lock. The legacy path only observes. | SAFE |
| W7 | post-commit payout notice delivery (deliverPayoutNotices :301 -> dispatchForCharge) | coach notice | T1f claim; notice rows keyed `tgp-notice-<charge>-<leg>-<event>-<state>` @unique (charge-settlement.service.ts:1636, schema:4817) | SAFE |
| M1 | admin refund (createAdminRefund :2427-2530) | Stripe refund create | deterministic Stripe key `tgp-refund-<purchase>-<charge>-<amount\|full>-<initiator>` (:2454), so a double tap within 24 h gives one Stripe refund. The row is unique on stripe_refund_id and the alert is gated on the claim (:2517). | SAFE |
| M2 | admin run-sweeper (payment-ops.controller.ts:270) | same as T1, without the lease | the per-charge guards T1a-T1h apply without the lease | SAFE |
| M3 | ReconciliationService.runSweep (connect/fees/reconciliation.service.ts:177) | none (snapshot upsert) | no money writes | SAFE |

## Queries (operator, read-only)
All are in /home/user/workspace/ops/reports/AUD-MJ-SETTLE-126.sql. No UNSAFE/UNKNOWN verdicts exist, so these are confirmation
queries. Expect 0 rows for Q1-Q11.
- Q0 unique indexes present
- Q1 duplicate ledger slice per charge
- Q2 >1 first-pay transfer per settlement leg
- Q3 one Stripe transfer on two rows
- Q4 net paid > charge gross
- Q5 reversed > transferred
- Q6 ledger reversal posted twice per source
- Q7 recovery over-collected
- Q8 netted vs collected cross-check
- Q9 duplicate coach refund alert
- Q10 duplicate payout-notice inbox row
- Q11 two Stripe reversals for one op key

## B list
none (in this area).
## U list
none.
## C one-liners
- Admin refund key includes the amount and initiator, so two deliberate equal partial refunds by the same admin within 24 h collapse into one: C (edge, deferred to 10k clients).
- Legacy head-coach transfer key is per purchase (`tgp-tr-<purchase>-headcoach`), so a legacy-destination renewal does not pay the head-coach split again. This is not double-work, and it is sub-coach scope, which waits per owner 18:01: C (deferred, not analysed).
- Two cron copies sharing one CronLease holder string are only safe because acquisition ignores the holder. Keep it that way if the lease is ever changed: C (note).

## Covered by open PRs
None of the open backend PRs touch settlement/fees/refunds (checked `gh pr list` 18:08). The root cause fix is B-CRON-126's PR. This audit
does not depend on it.

## PRs opened
none (read-only job).

## Not fixed (needs operator)
none. Optional: run the SQL file (Q0 first) to confirm production indexes and zero duplicates.

## HANDOFF
Done. Report and SQL are final. Nothing in flight, no worktrees, no locks, no ci/* branches. If a fresh agent continues: run nothing. The
operator runs the SQL file. If Q0 is missing any listed index, every verdict that cites it becomes UNKNOWN and needs re-checking.
