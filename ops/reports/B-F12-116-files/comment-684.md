FIX ROUND 11 (restack, merge-only) (B-F12-116, agent 116) — growth-project-backend#684 @ 392473a3edfb08ad3fdbc063ef1bbc9afad6b853

Merge-only restack under the fees stack lock (taken at 03:19 UTC, released after the push). `392473a3` = `42e9ca13` (the previous head) + a merge of F3 restack `c6fb2e3e`. There are no content changes in this piece.
- The delta against `42e9ca13` is byte-identical to the F1 + F2 round 11 delta: the `git patch-id --stable` of `git diff 42e9ca13 392473a3` equals the patch-id of `git diff 007d3dcb a5d6a434`.
- Files: `money-diagnostics.ts` (new), `charge-lock.ts`, `split-ledger.service.ts`, `stripe-connect-api.service.ts`, `schema.prisma` (comment only), `transfer-orchestrator.service.ts`, `payout-notice-copy.ts`, `test/utils/settlement-fakes.ts`, and the two new `s-fee-r11-*` specs.
- Findings and evidence: FIX ROUND 11 on #681 and #682.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece (merge-only) | merge of the lower piece | `392473a3` | build-and-test green at this sha, along with schema parity, rls-floor-guard, rls/community/mwb-3 live tests, test-deploy-readiness and size-label. npm audit was cancelled by the newer push. |

Head moved after this push: the PR head is now `59253c68b24c4b1033185b48b6f0d83906bec0df` (B-F34-116 round 11 on F3/F4, which contains `392473a3` as an ancestor). READY FOR AUDIT at that head belongs to that job's round comment, so this merge-only round does not post one for a superseded sha.
