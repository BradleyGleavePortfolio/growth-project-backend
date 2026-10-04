# AUD-OPUS-F3-119 (Claude Opus 5.5 lens, agent 119, T4) — fees F3 backend#683

Started 12:30 PDT 10-04. Claim: ops/lanes119/claims/backend-683-cc183e0a-opus. Head: cc183e0ae05158290e5db77ef645578667133e0f
(base F2 #682 70f879a2, dual APPROVE, not re-audited). Size 2,959 (+2,933/-26), 41 headroom.

## Progress log
- 12:30 read _COMMON_119, _COMMON_118, _COMMON_116, JOBS119 entry; claimed head; read B-FEES16-118 report, FIX ROUND 16
  (5983177143), Sol RC at 438d29e6 (5982960241), own APPROVE at 438d29e6 (ops/aud-118/AUD-OPUS-F23-118/verdict-683.md).
- 12:32-12:38 audited delta 438d29e6..cc183e0a (2 linear commits; src: charge-settlement.service.ts, money-errors.ts), every
  applyAdjustments caller at F3 and at #684 6b13af56 / #686 8cb7b2d4, isRetryableMoneyError consumers, billing webhook dedup
  (StripeProcessedEvent inserted inside the outer tx, so a throw rolls it back and Stripe redelivers).
- Probe test/audit-opus-f3-119-683.spec.ts (Q1-Q6; copy saved at ops/aud-119/AUD-OPUS-F3-119/audit-opus-f3-119-683.spec.ts):
  at cc183e0a + Opus F23-118 probe + builder spec: run 37228953907, 33/33 pass.
  Discrimination at 438d29e6: run 37229072725, Q1-Q4 and Q6 fail, Q5 control passes.
- Verified PR CI run 37225035844 job 111502834528: only the Test step fails, exactly 9 tests / 3 suites (fee-split 2,
  purchase-split 2, reconciliation 5); lint/type-check/build green; 727 suites / 12,579 pass; all other checks green.
- Verified builder lanes: before 37224835684 (lane 025d9a3c = 55d871b0 + probes, no src) 10 fail / 23 pass; after 37224855812
  (lane bf0814ec = cc183e0a + probes, no src) 54/58, the 4 = Sol F34-117 v1/v2 known cases. tsc 37224866058 green.
- R75 main b644198b..cc183e0a OK; 438d29e6..cc183e0a OK.
- 12:42 re-read head (unchanged), posted verdict APPROVE 0/0/4:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5983692196
- 12:42 deleted audit/AUD-OPUS-F3-119/683-r16-probe and 683-r16-probe-before; removed worktrees AUD-OPUS-F3-119-1/-2.
  prstate after posting: opus=APPROVE sol=APPROVE at cc183e0a.

## Findings decided
- Opus C-683-7 = Sol B-683-7: closed (flagForReconcile returns saved; NoticeUnrecordedError retryable; no double-apply on redelivery).
- Sol B-683-8: closed (dispute id on flag; lost re-derived under the lock).

## Follow-ups (C)
- C-683-8 (new): src/connect/fees/charge-settlement.service.ts:1681 logs "the delivery fails for redelivery" also on the sweep
  (rerunFlagged :1100, resolveStuckReversals :1067) and on the F4 admin refund catch (#684 src/checkout/refund-dispute-handler.service.ts:1383),
  where no delivery exists. Rule: neutral text naming both retry paths (webhook redelivery, or the next sweep while an earlier flag stands).
- C-683-4 (carried): unbounded per-purchase Stripe reads, src/connect/fees/reconciliation.service.ts. Rule: bound reads per run with a cursor.
- C-683-5 (carried; = Sol C-683-6): incomplete paid-invoice page resets the backfill cursor, charge-settlement.service.ts ~:1161-1164,
  :1226-1236. Rule: only a validated terminal page ends the scan; keep the cursor and log invoiceBackfillFailed otherwise.
- C-683-6 (carried): no unit cases for the succeeded-only filter, reconciliation.service.ts:350-354. Rule: add pending/failed/canceled cases.
- Concur (builder's C, not counted): test/utils/settlement-fakes.ts:19-23, :42 NULL satisfies `lte` in the fake compare.
  Rule: comparisons never match null/undefined; then drop the local flagged-only filters.
- For #684 (outside this PR): the admin refund catch (refund-dispute-handler.service.ts:1383) treats NoticeUnrecordedError as
  "deferred to the charge.refunded webhook"; safe only if that webhook runs after the admin claim. Rule: on NoticeUnrecordedError,
  leave a durable retry (or surface a reference) rather than relying on webhook timing. Low (needs two DB write failures).

## Operator decisions (recommended default first)
1. R-DISPUTE-PAUSE copy: the coach payout dispute copy (F2 src/connect/fees/payout-notice-copy.ts:97-120, chargeback / dispute_lost)
   says nothing about access or billing on recurring plans. Recommend: the PR that implements the dispute pause adds the exact
   sentence (access has ended, billing is paused, the coach decides on restarting) when that behaviour ships; F2/F3 must not claim
   it before the code exists (copy truth). Not a blocker for F3.
2. Recommend ticketing C-683-8 with the other frozen Cs for the first fees round after the freeze (#683 has 41 lines of headroom;
   tests for any later #683 change go to #697).

## HANDOFF
Done 12:43 PDT 10-04. #683 @ cc183e0ae05158290e5db77ef645578667133e0f: Opus APPROVE 0/0/4
(https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5983692196); Sol also APPROVE at this head per prstate.
CI: build-and-test red by design (exactly the 9 tests F4 #684 carries), everything else green. Audit branches deleted, worktrees removed.
Next step (operator): merge-only delta verdicts on #684/#697/#685/#686 restack heads; ticket the Cs above. Nothing left for this job.
