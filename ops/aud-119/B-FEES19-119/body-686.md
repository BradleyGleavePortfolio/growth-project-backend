**Tier:** T4
**Why:** money path. F6 is tests only; it pins transfer-create recovery, in-flight transfer handling and renewal backfill of F1-F4's settlement code.
**T4 trigger scan:** money (transfer create / recovery, no duplicate payout). Present.
**T3 trigger scan:** shared test fixtures (test/utils/settlement-fakes.ts, F2).
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); restack rounds by B-F12-116 / B-F34-116 (agent 116); round 12 restack by B-F56-117 (agent 117); round 13 by B-FEES-117 (agent 117); round 15 by B-FEES15-118 (agent 118); round 16-17 restack by B-FEES16-118 (agent 118); round 18 by B-FEES18-119 (agent 119).
**Parent owner:** #627 (S-FEE), operator 117.
**Acceptance evidence:** exact-head build-and-test with all 3 suites executing (Fix round table); every required check green at the head.
**Promotion triggers:** any change to an asserted amount, invariant or protocol rule in these specs re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F4b (#697, tests only, round 13) -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F6 (base F5, 1,355 lines, test-only):** transfer create recovery (r7), in-flight (r8) and renewal backfill specs.


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and checkout specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.

## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 (restack, merge-only) | `b5bbe806f4709d79702d0525211c106bc46afa48`, then `1895147dce06953061dce594220cef82f97f9e0e` and `6f1b94a91f6a2b9e8142ac85970521b9285fff6c` | B-F12-116, B-F34-116 (agent 116) | none in this piece (merges of F1-F5) | inherited 7 r5 copy pins red: [run 37175737276](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175737276/job/111357840016) |
| 12 (restack, merge-only) | `e6893c976f59717d64a0c7dc4d8f84f05bbf286e` | B-F56-117 (agent 117) | none in this piece (merge of F5 round 12); Opus C-686-1 by retitle (the PR title now names the specs this piece contains) | build-and-test at this head (FIX ROUND 12 comment); F6's 3 files byte-identical to 7be7d396 |
| 13 (restack, merge-only) | `a17477598e36a996d2a2e5f68a137883bbddd75b` | B-FEES-117 (agent 117) | none in this piece (merges of F5 round 13 restack); own-diff patch-id `f14b1e32b05a` unchanged | build-and-test green [run 37180611533](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180611533) |
| 15 (restack, merge-only) | `5937064f66cbf17cc2b0cd7b09e7cf5f62467f66` | B-FEES15-118 (agent 118) | none in this piece (merge of F5 round 15 restack); own-diff patch-id `f14b1e32b05a` unchanged | build-and-test green [run 37220312060](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220312060); prior probes at the fees top [run 37220644877](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220644877) |
| 17 (restack, merge-only) | `8cb7b2d4bee3bccb65596581f84bccf9227ffc4b` | B-FEES16-118 (agent 118) | none in this piece (merge of F5 round 17 restack); own-diff patch-id `f14b1e32b05a` unchanged | build-and-test green [run 37225036205](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036205); prior probes at the fees top [run 37225776608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225776608) (Opus F56-116 mutants all killed, 54 expected failures) |
| 18 (restack, merge-only) | `30a118ddfd75339375ea4f6f6288669f3cbebfd5` | B-FEES18-119 (agent 119) | none in this piece (merge of F5 round 18 restack); own-diff patch-id `f14b1e32b05a` unchanged | build-and-test green [run 37231460547](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231460547); scratch fees top + main full suite [run 37232435047](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232435047) |




