AUDIT Claude Opus 5.5 — growth-project-backend#674 @ 3a07a0de45f431ca9f1f5b9a2ff1710d554e52cb — VERDICT: APPROVE
Job AUD-OPUS-CM10-121 (agent 121), FIX ROUND 6 delta review (last Opus verdict: RC 0/1/7 at e35c37a1, comment 6000051266).

A/B/C = 0/0/9

## Scope
- Delta e35c37a1..3a07a0de: 3 commits, 4 files, +55/-47.
  - 0f0a730b B-674-1: transfer-orchestrator.service.ts, split-ledger.service.ts.
  - e7f7232b B-674-15: refund-dispute-handler.service.ts, test/support/stateful-prisma.ts.
  - 3a07a0de B-674-16: refund-dispute-handler.service.ts.
- Every changed line was read, along with the code around it: reverse(), outcomeOf(), drive(), completeReversal(), recordFoundReversal(), recordReconciled(), applyRefundTransferReversalOnce(), the sweep, and every writer of the head slice.
- Size: +2,850/-145 = 2,995. This is under the 3,000 grandfathered ceiling.
- CI at this head: every required check is green, including build-and-test, mwb-3-live-tests (the live Postgres reversal concurrency spec), rls-live-tests, CodeQL, danger and schema parity.

## B-674-15 (this lens's CM8 finding): closed
- Where the fix is: reconcileTransferReversal, refund-dispute-handler.service.ts:1341-1365.
- What it does:
  - It loads the refund's own operations with status pending or succeeded, ordered by seq. These are the refund key, `-review` and `-found-*`.
  - Each one is finished through reverse(), using its own key. reverse() finds the existing operation by key, and outcomeOf() then either returns it or re-drives it, so nothing is sent a second time.
  - The result is recorded before `owedHeadCoachReversal` runs at :1366.
- So when another driver finishes the refund's operation and fills the transfer, the refund is no longer closed as nothing_owed. That other driver can be the stuck-reversal sweep, a sibling refund's resolvePendingReversals, or an earlier owner reconcile.
- Prefix safety: the prefix is `tgp-tr-rev-refund-<uuid>-`. ChargeRefund ids are fixed-length UUIDs, so no other refund's key can match it. Dispute keys use their own prefix.
- If another refund already holds an operation's receipt, that operation is skipped (B-641-9).
- The CM8 probe test/audit-opus-cm8-120-674-reconcile.spec.ts was red 2/3 at e35c37a1 and is green 3/3 here (builder lane 37355842923; this lens's lane below).

## B-674-1 (Sol): verified closed
- mirrorHeadSlice(tx, t) at transfer-orchestrator.service.ts:1449-1455 writes the legacy head slice inside the same transaction that records the transfer total. This holds in both completeReversal (:1441) and recordFoundReversal (:1134).
- Lock order is op, then transfer row, then slice in completeReversal, and transfer (slot CAS), then op, then slice in recordFoundReversal.
- No other writer of a legacy head_coach_split slice exists:
  - applyLedgerReversal touches only destination and application_fee slices;
  - setLegPosition applies to settlement slices only;
  - transfer.reversed only observes (B-674-3).
- A failed slice write rolls back the whole record:
  - after a send, the operation stays pending with attempts > 0, so the next driver lists Stripe before any re-send;
  - for a found reversal, no operation is written.

## B-674-16 (Sol): verified closed
- `transfer_reversal_last_attempt_at` is now stamped with the send clock just before every attempt (:974-979). That includes re-drives of an operation that already exists.
- The sweep's `last attempt before now` filter (:1186-1190) therefore pages past every row it touched.
- Rows past the window still move to review in the expired pass (:1156-1166).

## Probes
New probe test/audit-opus-cm10-121-674-delta.spec.ts (4 cases, real handler, ledger and orchestrator on the stateful double):
1. B-674-15, `-review` operation:
   - Setup: the refund-key operation was refused. The owner's `-review` send has an unknown outcome. A sibling refund's reverse() then re-drives the `-review` operation and fills the transfer.
   - Expected and seen here: reconcile records it (recorded_from_stripe, 122, trr_1). Postings are a=[122] and b=[123]; stripe, transfer and slice are each 245.
2. B-674-15, two owners reconciling at once after the sweep completed the operation: one record, one 245 posting, no send.
3. B-674-1, sweep found-record path (reversalStripeHolds, then recordFoundReversal):
   - A failed slice write leaves no operation, a transfer total of 0 and a slice of 0.
   - The next sweep records 122/122/122 once, binds trr_found_h and sends nothing.
4. B-674-16, re-drive while Stripe's list is down:
   - The row is stamped at or after the sweep clock, and a second pass skips it.
   - After 24 h it moves to review. Reconcile returns 503 TRANSFER_REVERSAL_UNCERTAIN while the list is still down.
   - Once Stripe reads again, reconcile records 122 with no send.

Results:
- Local runs, single spec through ops/heavy.sh (GitHub runner incident; lane queued over 20 minutes, _COMMON_121 item 11):
  - 4/4 PASS at the stack top ebde8b3b, where this PR's src is byte-identical;
  - 4/4 FAIL at e35c37a1, each for the intended reason: nothing_owed/0/null; nothing_owed; op 1 and transfer 122 left after the failed slice write; not stamped.
- Lane: CM8 probe replay in a CI lane at this exact head: builder lane https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37355842923 (commit 52f29747, parent 3a07a0de). This lens checked that run's log on GitHub and that every Opus probe blob in it is identical to this lens's copies. Result: 196/200. audit-opus-cm8-120-674-reconcile is 3/3 green (it was red 2/3 at e35c37a1). The 3 reds from this lens's probes are the obsolete-by-design cases already accepted at CM8: audit-cm1-674-reversal-mirror (the B-641-12 injected writer and mirror_before_reconcile) and the original B-674-14 case in audit-opus-cm-118-674-send (its adapted twin is green). This lens's own lane 37366160113 (all probes plus the delta probe at ebde8b3b) waited 26 minutes in the GitHub runner incident and was cancelled to free the queue (operator 12:47 queue rule).

## C (follow-ups, after the freeze; none blocks)
- C-674-16 (carried) :1463-1470 / :1487-1495. A refused `-review` operation stays refused, so every later reconcile returns 422 TRANSFER_REVERSAL_REFUSED, and the copy gives no next action that works. Fix: give the owner a fresh review key after a refusal (for example `-review-<n>`), and name the next action in the copy.
- C-674-17 (carried, widened):
  - The doc comment at :1299-1307 and the runbook row `recorded_from_stripe` (docs/runbooks/refund-transfer-reversal-review.md:25) still describe only metadata tgp_charge_refund_id. The refund's own operation, recorded first, is now the main path.
  - The runbook still has no rows for UNCERTAIN, REFUSED, LIST_INCOMPLETE, TOO_MANY or TRANSFER_NOT_IN_STRIPE.
- C-674-18 (new) prisma/schema.prisma:4681. The comment says "the latest admitted attempt", but every attempt is now stamped, re-drives included. Fix: comment only.
- C-674-19 (new) :1345-1351.
  - The own-operation lookup uses `startsWith` on idempotency_key. Postgres uses the unique btree index for that LIKE prefix only under the C collation, so on other collations each owner reconcile scans TransferReversalOp. This is an owner-only, rare path.
  - Fix: limit the query to the purchase's head transfer (`transfer_id`, which is indexed by @@unique([transfer_id, seq])), or query `in: [key, key-review]` plus the `-found-*` rows of that transfer.
- C-674-6 (carried) :1570-1600. A listTransferReversals provider error is a generic 500 in reconcile. Fix: map it to the typed 503.
- C-674-7 (carried) refund-reversal-admin.controller.ts:38-74. Reconcile does not record the acting owner.
- C-674-9 (carried) :1053-1072. A pending transfer reads as nothing_owed.
- C-674-13 (carried) :78/:858. The 60 s first-pass heuristic.
- C-641 (carried) :1731. applyLedgerReversal uses a float ratio for the share (release condition).

## Independence and evidence reuse
- The Sol lens's notes and comment for this round were not read; only first lines were listed, to find the heads.
- Evidence reused from this lens's CM8 verdict covers the code outside the delta, which is unchanged since e35c37a1.

## Main merge
main is 29 commits ahead. git merge-tree is clean, but one file in this PR, test/cancel-pending-on-refund.spec.ts, also changed on main (in separate hunks). Rule 12 therefore does not carry these verdicts over, and the main merge needs a short merge-only delta from both lenses. After the merge the size stays 2,995.

Head re-read immediately before posting: 3a07a0de45f431ca9f1f5b9a2ff1710d554e52cb.
