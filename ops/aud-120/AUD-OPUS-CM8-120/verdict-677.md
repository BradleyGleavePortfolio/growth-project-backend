AUDIT Claude Opus 5.5 — growth-project-backend#677 @ b17888ab6eaa018a49d42a40eb2b773b89198d28 — VERDICT: APPROVE
Job AUD-OPUS-CM8-120 (agent 120), FIX ROUND 5, exact-head review (tests only; restack plus spec expectations after the engine swap).

A/B/C = 0/0/2

Scope:
- b17888ab is a clean merge. Its tree equals `git merge-tree --write-tree 921299fe 0ee4933d` (543b39c343e0).
- The own diff 0ee4933d..b17888ab is 6 test files, +2915 (under the 3,000 ceiling). The last Opus APPROVE was at 4aaee4ed (116), so every own file was compared with the version this lens last saw:
  - coach-money-production-writes.spec.ts: byte-identical to its 4aaee4ed blob (a9e498bf; moved from #674/#676).
  - coach-money.service.spec.ts, coach-money-reversal-postings.spec.ts: identical to the FR3/FR4 heads 4799c6af/6340993b. The only change since 4aaee4ed is ed1546b6, a mock answer for chargeRefund.findMany that the B-676-3 export needs.
  - refund-reversal-boundaries / -reconcile / -review.spec.ts: moved from #674 (cdb627db, e9db27d7). The only change since is 36ff0e6e (40+/43-), read line by line.
- CI at this head: all checks green (CI 37343101206). All six specs are green in lane B: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37350491962.

## 36ff0e6e judged: no money assertion dropped
- refund-reversal-boundaries.spec.ts:82-96, B-674-1. The injected direct write (`reversed_amount_cents += 50`, a writer that no longer exists) is replaced by a real concurrent `reverse()` of another refund inside the Stripe call. The 122 + 50 expectation on the transfer and the slice is unchanged. This is a stronger proof of the same property.
- refund-reversal-boundaries.spec.ts:233-246, B-674-3. The lost answer is now found on Stripe's list at once (transfer_reversed true after the first pass, one send instead of two). Stripe 245, recorded 245, slice 245 are unchanged.
- refund-reversal-reconcile.spec.ts:64-74. A second concurrent owner may also get 503 TRANSFER_REVERSAL_UNCERTAIN, which fails safe. Stripe total 122 is still asserted.
- refund-reversal-review.spec.ts:248-282. The closed codes follow the engine's vocabulary (SFEE_REVERSAL_UNCERTAIN, http/type/code on refusals). The free-text canary absence is still asserted on every line.

## C (follow-ups; not blocking)
- C-677-3 refund-reversal-reconcile.spec.ts:151-154. The metadata check went from toEqual to toMatchObject, so extra metadata keys (and tgp_purchase_id) are no longer pinned. Fix: an exact toEqual on the four keys the engine sends (tgp_purchase_id, tgp_kind, tgp_reversal_op, tgp_purpose).
- C-677-2 (carried, Sol): coach-money-reversal-postings.spec.ts:193-259 assertion hardening (exact rows and cents per window).

C-677-1 (this lens, MRR status pin) is largely covered by #703 coach-money-billed-mrr.spec.ts (past_due in, trialing apart, never-billed out).

Head re-read immediately before posting: b17888ab6eaa018a49d42a40eb2b773b89198d28. The stack lands as one; #674 B-674-15 blocks it.
