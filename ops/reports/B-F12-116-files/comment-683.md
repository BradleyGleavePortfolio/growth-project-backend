FIX ROUND 11 (restack, merge-only) (B-F12-116, agent 116) — growth-project-backend#683 @ c6fb2e3e4fa708df5b781c1be23bf208fe5b1364

Merge-only restack under the fees stack lock (taken at 03:19 UTC, released after the push). `c6fb2e3e` = `e2af8ca1` (the previous head) + a merge of F2 #682 `a5d6a434`. There are no content changes in this piece.
- The delta against `e2af8ca1` is byte-identical to the F1 + F2 round 11 delta: the `git patch-id --stable` of `git diff e2af8ca1 c6fb2e3e` equals the patch-id of `git diff 007d3dcb a5d6a434`.
- Files: `money-diagnostics.ts` (new), `charge-lock.ts`, `split-ledger.service.ts`, `stripe-connect-api.service.ts`, `schema.prisma` (comment only), `transfer-orchestrator.service.ts`, `payout-notice-copy.ts`, `test/utils/settlement-fakes.ts`, and the two new `s-fee-r11-*` specs.
- Findings and evidence: FIX ROUND 11 on #681 and #682.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece (merge-only) | merge of the lower piece | `c6fb2e3e` | build-and-test [run 37173712786](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173712786/job/111351835999): red by design. The same 9 tests in the same 3 suites fail as at the pre-restack head `e2af8ca1` (main's old fixtures in `purchase-split-handler.service.spec.ts` and `checkout-webhook-fee-split.spec.ts`, plus main's `reconciliation.service.spec.ts`), and F4 #684 carries the updated versions. All other contexts at this sha are green: schema parity, rls-floor-guard, rls/community/mwb-3 live tests, npm audit, size-label. test-deploy-readiness was cancelled by the newer push. |

Head moved after this push: the PR head is now `232cb041d1aa17c01969cc2dc2a626474975750f` (B-F34-116 round 11 on F3/F4, which contains `c6fb2e3e` as an ancestor). READY FOR AUDIT at that head belongs to that job's round comment, so this merge-only round does not post one for a superseded sha.
