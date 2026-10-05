AUDIT Claude Opus 5.5 — growth-project-backend#674 @ e35c37a1db1da2949c366f681633b1b1f72a11b3 — VERDICT: REQUEST CHANGES
Job AUD-OPUS-CM8-120 (agent 120), FIX ROUND 5, exact-head review (main ee55f814 refresh, engine swap 7a10fe1a, B-CM6-1, B-CM7-1).

A/B/C = 0/1/7

Scope: full diff main...e35c37a1 (+2831/-134, under the 3,000 grandfathered ceiling). Everything changed since the last Opus verdict (f9e21a87) was read in full: 49644775, 8cc17809, 7a10fe1a, f4634d99, 90884240, fa673d6b, 9e8a3a6b, ed49ef24, e35c37a1. CI at this head: all checks green (CI 37343095521, CodeQL, Danger, Schema parity).

Probe lanes (evidence):
- Lane A, #674 alone: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350431169 (branch audit/AUD-OPUS-CM8-120/674-probes-1, probe commit b38c1337 on e35c37a1). 17 suites, 152/157. Reds: the new B-674-15 probe (2 red, control green), plus 3 old-probe cases explained under "Probe substitution" below.
- Lane B, stack top: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350491962 (audit/AUD-OPUS-CM8-120/703-probes-1, b4182bf7 on 88940c3f). The same B-674-15 probe is red there as well.

## B-674-15 — owner reconcile closes a refund as nothing_owed after its own reversal was completed elsewhere
src/checkout/refund-dispute-handler.service.ts:1340-1348 (`owedHeadCoachReversal` runs, and `nothing_owed` returns) comes before :1360-1375 (the lookup of this refund's own operation under `tgp-tr-rev-refund-<id>` / `-review`). `owedHeadCoachReversal` (:1045-1064) needs a transfer that is `status: 'succeeded'` with cents left.

Path: a refund goes to review while its operation is still pending. `moveTransferReversalToReview` (:1155-1163) does not look at operations. Then another driver completes that operation:
- main's settlement sweep, `resolveStuckReversals` in charge-settlement.service.ts:1048-1078, which drives every pending operation older than 60 s and resolves legacy transfers on their own; or
- a sibling refund's or dispute's `reverse()`, which calls `resolvePendingReversals` first.

If that completion leaves the transfer fully reversed (every full refund, or a sibling that takes the rest), reconcile marks the refund done with no bound Stripe id and no SplitLedgerReversal posting, and returns `nothing_owed`, 0 cents. The runbook gives "None" as the next action, and the transfer.reversed observer sees no gap (recorded total = Stripe total), so nothing alerts.

Effect: the head-coach slice total is right, but that refund's dated posting is missing. The coach Money windows and export (#676) then overstate the head coach's kept earnings by the refund's share.

This is new in this round. Before the engine swap, the claim and the posting ran inside reverse(); 7a10fe1a/90884240 split operation completion from the refund's local record. The sweep (:946-957) and dispute (:1762-1776) paths already check the prior operation first. Only reconcile has the old order.

Probe test/audit-opus-cm8-120-674-reconcile.spec.ts (lane A and lane B):
- Full refund, settlement sweep completes the op, then reconcile. Expected `recorded_from_stripe`, 245, bound `trr_1`, postings [245]. Received `nothing_owed`, 0, bound null, postings []. Stripe total 245, transfer total 245, no send.
- Partial refund in review (122) whose op is completed by a sibling refund's sweep pass, which then takes the remaining 123. Expected r-a `recorded_from_stripe`, 122, postings a=[122] b=[123]. Received `nothing_owed`, 0, a=[], b=[123].
- Control: partial refund, op completed by the sweep, transfer not full. Green (`recorded_from_stripe`, 122, posting [122], no send).

Fix rule:
- In reconcileTransferReversal, run the own-operation loop over [key, key-review] before `owedHeadCoachReversal`. A pending or succeeded own operation is finished and recorded by `recordReconciled`, whatever the transfer's remaining amount. It already uses `prior.transfer_id`; `recordReconciled` does not need `owed`.
- Compute `owed`, and possibly return `nothing_owed`, only when no own operation is pending or succeeded.
- This is a reorder with close to zero net lines, so #674 stays under 3,000. The regression spec goes in #703 (tests-only piece).

Verify: the probe's two red cases go green and the control stays green. test/refund-reversal-reconcile.spec.ts, refund-reversal-review.spec.ts, refund-reversal-send-time.spec.ts and transfer-reversal-found-slot.spec.ts stay green.

## Closed at this head (verified)
- B-674-13 (send-time clock): admission reads `clock()` at each send (:964-968; sweep `sendClock` :1170). test/refund-reversal-send-time.spec.ts is green in lane A on #674 alone.
- B-674-14 (incomplete list): `listAllTransferReversals` (:1562-1595) is complete only at has_more=false; the engine's `findStripeReversal` is the same. The adapted replay of this lens's 118 probe is green: an incomplete list leaves the reversal owed with no send, then a complete list records it once with no send.
- B-CM6-1 / B-CM7-1:
  - Under READ COMMITTED, `startReversal` and `recordFoundReversal` re-read base/cap from the row inside the slot transaction. The slot UPDATE takes the row lock, and the pending-op check refuses while another operation is open (ReversalUncertainError, fail safe).
  - A second concurrent recordFoundReversal loses the reversal_seq CAS. stripe_reversal_id is unique.
  - test/transfer-reversal-slot-base.spec.ts and transfer-reversal-found-slot.spec.ts are green on #674 alone (lane A). The builder's failing-before run 37342770868 shows them red before e35c37a1.
- C-674-12 (first-pass posting time): one first pass dates every posting at posted_at (REFUND_FIRST_PASS_MS, :78/:858). The composed case of this lens's 118 #676 probe is green in its adapted replay (lane B).
- Legacy head-coach transfer: one per purchase (upsert key `tgp-tr-<purchase>-headcoach`), so dropping the charge filter is correct. transfer.reversed is observe-only. The SplitLedgerReversal unique index keeps a posting to once per event. Migrations 20270314000000 and 20270317116000 are unchanged and additive. R-DISPUTE-PAUSE and OR-111-1 are untouched: a reversal only ever targets the refund's own sale's head-coach transfer.

## Probe substitution (job item): accepted
- B-641-12 mirror case (audit-cm1-674-reversal-mirror.spec.ts:197): it injects `reversed_amount_cents += 100`, a writer that no longer exists. Every write now goes through the slot (startReversal / completeReversal / recordFoundReversal). The same property, that a concurrent reversal of another refund is never lost, is proven by:
  - refund-reversal-concurrency.live.spec.ts on real Postgres (mwb-3-live-tests step green at 88940c3f, run 37343105712);
  - transfer-reversal-slot-base and transfer-reversal-found-slot (lane A);
  - refund-reversal-boundaries B-674-1, now driven by a real concurrent `reverse()` (lane B).
- Sol-116 "two distinct refunds" probe: it drives the removed reverse({claim, metadata}) variant. The same evidence covers it.
- `mirror_before_reconcile` (audit-cm1-674-reversal-mirror.spec.ts:58): obsolete by design (B-674-3 observe-only). Its money fields hold (recorded once, 122/122).
- Original 118 B-674-14 case (audit-opus-cm-118-674-send.spec.ts:152): the engine now records at the first pass, so its precondition cannot occur. The adapted replay proves the property (above).

## C (follow-ups; not blocking under the FREEZE)
- C-674-16 :1362-1375, :1455-1462 and :1478-1488. A `-review` operation that Stripe refused once is sticky. Each later reconcile replays it and answers 422 TRANSFER_REVERSAL_REFUSED, even after the head coach's balance recovers. The message gives no working next action. Fix: say that retry does not resend, and give the working path: a reversal made in the Dashboard, then recorded with stripe_transfer_reversal_id. Or allow one fresh key after a refusal.
- C-674-17 docs/runbooks/refund-transfer-reversal-review.md, plus the comment at :1302. There are no rows for TRANSFER_REVERSAL_UNCERTAIN, TRANSFER_REVERSAL_REFUSED, TRANSFER_REVERSALS_LIST_INCOMPLETE, TRANSFER_REVERSALS_TOO_MANY or TRANSFER_NOT_IN_STRIPE. The runbook still says new reversals carry metadata `tgp_charge_refund_id`; they carry `tgp_reversal_op`. Fix: add the rows and correct the metadata text.
- C-674-6 (carried, narrowed) :1568. A provider error from `listTransferReversals` itself is still a generic 500 in reconcile. Fix: a closed 503 that says retry.
- C-674-7 (carried) refund-reversal-admin.controller.ts:38-74. No acting owner is recorded.
- C-674-9 (carried) :1052-1056. A pending head-coach transfer reads as nothing_owed.
- C-674-13 (carried) :78/:858. The 60 s first-pass heuristic.
- C-641 (carried release condition) :1062. Float pro-rata share arithmetic.

Head re-read immediately before posting: e35c37a1db1da2949c366f681633b1b1f72a11b3. The stack #674 -> #676 -> #677 -> #703 lands as one.
