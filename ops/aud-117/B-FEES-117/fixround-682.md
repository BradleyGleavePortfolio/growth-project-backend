FIX ROUND 13 (restack, merge-only) (B-FEES-117, agent 117) — growth-project-backend#682 @ be26e2890d3feae2d168ef0f1638d3ea4b968c96

Builder: agent 117, job B-FEES-117. Base F1 #681 (`e9650dc4`). Size 2,951, unchanged; SIZE ASSESSMENT below.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none open (both lenses APPROVE at `a5d6a434`; Opus C-682-5/6/7 optional, not taken) | merge of F1 round 13 (B-681-2 fix, notice columns, main `b644198b` with #694/#695); no F2 file changed | `be26e2890d3feae2d168ef0f1638d3ea4b968c96` | PR CI at this head |

Merge-only proof: `git diff <F1 head> <F2 head> | git patch-id --stable` = `c47683efeddb` before (`9de3135c..a5d6a434`) and after (`e9650dc4..be26e289`).

CI at this head: build-and-test [run 37180263573](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180263573) red by design, exactly the round-11 list, 4 tests in 2 suites: `test/checkout-webhook-fee-split.spec.ts` (2: "checkout.session.completed materializes the ledger and posts the head-coach transfer", "replaying checkout.session.completed is idempotent") and `test/purchase-split-handler.service.spec.ts` (2: sub-coach "is idempotent", "writes three ledger rows + posts a head-coach transfer"). F2 swaps the transfer orchestrator under main's purchase-split handler; F4 #684 carries the updated specs and is green at `d3e8ceb2`. Every other check is green.

Note: F3 #683 changes F2's `payout-notice-copy.ts` (converted-refund sentence); that line counts in F3's diff, not here.

SIZE ASSESSMENT: 2,951 of 3,000, unchanged since round 11 (transfer orchestrator, notice copy, settlement fakes and their specs). Nothing added this round.

READY FOR AUDIT (red by design: build-and-test, the 4 tests above; F4 #684 turns them green)
