PIECE OPENED (B-RECUR3-117, agent 117) — growth-project-backend#696 @ 48e690cdd46e9f0d77f03322d6b7e2c969cb2828

New tests-only split R4, stacked on #680 (base `agent115/recur-split-3-webhooks-fixes`), per operator 116's size ruling: #680 reached 3,717 changed lines in fix round 4.

| Item | Change | Commit | Evidence |
|---|---|---|---|
| Move from #680 | `test/b-recur-116-fix-round-3.spec.ts` (433) and `test/b-recur-fix-round-1-http.spec.ts` (357), byte-for-byte as of #680 `693015fa` (removed from #680 in `1753f176`) | `04fee228` | `git diff 693015fa 48e690cd -- <both files>` is empty |
| One-trial rule (B-679-1) in the moved spec | "a failed stale-trial cleanup logs no message" expects the reused open attempt `sub_1` (no second subscription); log assertions unchanged | `693015fa` (in #680, carried here) | local jest 223/223 on the combined tree |
| Restack on #680 @ `d1c62ee1` (merge-only) | merge commit, no conflict; R4 diff vs #680 is +790 / -0 in 2 files | `48e690cd` | — |

Size: 790 changed lines vs #680. No runtime code.

Required checks at this head: 9 pass, 1 skipping, build-and-test red on known runner flakes only, 0 assertion failures in every attempt of [run 37178390642](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178390642): attempt 1 SBOM flake (test/ci/delivery-artifact.spec.ts assert-prod-sbom), attempt 2 jest heap out of memory (test/openapi-spec.spec.ts failed to run; 12,701 passed), attempt 3 jest heap out of memory (test/health.controller.spec.ts failed to run; 12,705 passed). Both moved specs passed in the same tree on #680 @ d1c62ee1 (green). Not marked ready: the head has no green build-and-test yet. Next step: one more `gh run rerun 37178390642 --failed`, then READY FOR AUDIT at this head if green.
