AUDIT Claude Opus 5.5 — growth-project-backend#684 @ 9fb9c48f0c8cfb2a76562c0f23ac7f3bbc652379 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/2

Lens AUD-OPUS-FL-119 (agent 119). Tier T4 (refunds, payouts, access). Scope: the round-17 delta 6b13af56..9fb9c48f (233497d5 B fixes, 05bc6d31 log renames, 9fb9c48f lint comment move), every changed line read, plus the money list end to end. Unchanged code since 6b13af56 rests on this lens's earlier evidence (verdict 5983739251).

**Prior Opus findings at 6b13af56**
- B-684-7 (refund.updated not routed): closed. checkout-webhook-handler.service.ts:224 routes `refund.updated`. refund-dispute-handler.service.ts:157-159 gives it the post-commit notice handoff. r17 router-level tests fail before (run 37230855089, 17 fail / 2 controls pass) and pass after (37230897422).
- B-684-8 (a stale event rewrites a failed refund and moves money): closed for sequential order. `nextRefundStatus` :41-47 makes failed and canceled terminal, and succeeded only moves to failed. The apply re-reads the status under the lock (:630). Failed-after-apply is decided under the lock (:602-607, :660-673). My probe from 6b13af56 (R0-R2, S1-S5) passes at this head, byte-identical spec: run 37233481399. The F34-117 probe passes in the same run.
- C-684-9, C-684-10, C-697-2: closed by the round. C-684-3 and C-684-11 carried (below).

**B-684-12: lost update on the refund status write. A failure recorded between a stale worker's read and its write is overwritten, the money moves, and no alert is raised.**
- Where: refund-dispute-handler.service.ts:550-563 (`updateExisting` computes `nextRefundStatus(existing.status, ...)` from a row read at :564 and writes it unconditionally, `where: { stripe_refund_id }`). The same applies to the P2002 path at :595.
- Counterexample: worker S handles a stale succeeded delivery (a redelivered `refund.updated`, a `charge.refund.updated` twin, or a `charge.refunded` snapshot). S reads the row as pending. Worker F then processes `refund.updated` failed in full: it writes failed, and its under-lock check sees ledger_reversed false, so nothing is flagged. S then writes succeeded over failed. S's under-lock re-read (:630) now sees succeeded and applies the refund.
- Result: the coach's 4,630 is taken back for a refund Stripe reports failed. The row says succeeded. There is no SFEE_REFUND_FAILED_AFTER_APPLY alert and no reconcile flag. In the L2 variant access also ends.
- This breaks the guarantee stated in the round-17 comment at :599-601 ("a concurrent apply either saw the terminal status ... or finished first (and is flagged here)").
- Why it is plausible: Stripe sends both refund events per transition while `charge.refund.updated` lives, redelivers every non-2xx (this code throws ChargeLockBusyError and RefundStateUnavailableError on purpose), and does not order deliveries.
- Probe: audit/AUD-OPUS-FL-119/684-lostupdate, spec test/audit-opus-fl-119-684.spec.ts (r17 harness, unchanged setup). Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37233481399:
  - L0 control (sequential) passes.
  - L1 fails: refund.updated succeeded vs failed. Got status succeeded, net 0; expected failed, net 4,630.
  - L2 fails: charge.refund.updated succeeded while the list still says succeeded. Got status succeeded, net 0, purchase refunded.
  - L3 fails: charge.refunded snapshot. Got status succeeded, net 0, refunded_cents 4,900.
- Fix rule: make the status transition a compare-and-set. `updateMany({ where: { stripe_refund_id, status: existing.status }, data })`. On count 0, re-read and recompute `nextRefundStatus` (bounded loop), then continue with the re-read row. Alternatively, read and write the status inside `withChargeLock` (lock order: charge lock only, no new nesting).
- Verify: probe L1-L3 pass and L0 still passes. Put the test in #697 (2,276 lines, room for it).

**Money list (round-17 delta)**
- Webhook order and redelivery: charge.refunded, charge.refund.updated and refund.updated converge per refund id. Sequential stale orders are safe (S1-S5, r17). Concurrent conflicting order is not safe: B-684-12.
- Concurrency: one charge lock. Apply and failed-after-apply both decide under it. The status write sits outside it: B-684-12.
- Terminal states: failed/canceled are terminal. A succeeded refund.updated that covers the charge ends access (`revokeFullyRefunded` :356, idempotent WHERE guards, drops canceled in the same transaction). A pending refund that ended access through amount_refunded and then fails: C-684-11 (carried).
- Lists: `coversCharge` :519-528 reads the charge and the complete refund list and fails closed with RefundStateUnavailableError before anything moves (r17 "unreadable refund list").
- Currency: `coversCharge` compares presentment minor units on both sides (charge.amount vs succeeded_client_cents). Same-currency settlement sums DB succeeded rows. Zero-decimal currencies are unaffected (same units on both sides).
- Payout notices (Sol B-684-3): the claim is stamped at the time it is taken (:189). A fenced claim, the deadline and the 60 s claim margin are checked right before each channel start, after every preparatory await. A stop releases only this worker's claim and un-counts the attempt. A pre-created push row id is saved before the stop. Reviewed, no finding of my own. Sol owns the closure call.
- Logs (C-686-3, 05bc6d31): the renames `message` -> `diagnostic`/`mailOutcome` cover closed values only: `moneyErrorDiagnostic` (kind/http/allow-listed type/code), `settlementFailureCode`, fixed lookup reasons, and channel statuses. No address, name or free text. The moved SFEE_REFUND_FAILED_AFTER_APPLY line logs ids and status only.
- Copy: no new user-facing copy in the delta.

**C (follow-ups, not blocking)**
- C-684-3 (carried, outside diff) refund-dispute-handler.service.ts:1168 dispute alert copy must follow R-DISPUTE-PAUSE for recurring plans. It is owned by #687/#688.
- C-684-11 (carried) refund-dispute-handler.service.ts:282-298 `charge.refunded` decides a full refund from amount_refunded, which counts pending refunds. Rule: decide from the succeeded rows as written vs the charge amount, as `coversCharge` does. On failed/canceled of a never-applied refund that ended access, alert the coach. Product default: no automatic restore.

Size: 2,679 changed lines (grandfathered, 3,000 ceiling). CI at this head: required checks pass=10, skipping=1 (build-and-test 37231460850 green).
