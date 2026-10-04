test(fees): money protocol, concurrency and paused-sender specs (split F5 of #627)
agent115/fee-split-4-checkout-wiring
**Tier:** T4
**Why:** money path. F5 is tests only; it pins the exact cents, ledger states and OR-111-1 coach notices of F1-F4's settlement, transfer, reversal and netting code.
**T4 trigger scan:** money (fee arithmetic, reversals, forward netting, coach payout notices). Present.
**T3 trigger scan:** shared test fixtures (test/utils/settlement-fakes.ts, F2) used by every fee suite.
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); restack rounds by B-F12-116 / B-F34-116 (agent 116); round 12 by B-F56-117 (agent 117).
**Parent owner:** #627 (S-FEE), operator 117.
**Acceptance evidence:** exact-head build-and-test with all 4 suites executing (Fix round table); every required check green at the head.
**Promotion triggers:** any change to an asserted amount, invariant or protocol rule in these specs re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F5 (base F4, 2,958 lines, test-only):** money protocol (r4), OR-111-1 (r5), charge concurrency and paused-sender (r9) specs (67/67 locally).


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and checkout specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.

## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 (restack, merge-only) | `1e446acb6777d813f9464c4d7a55be9835fb0643`, then `a3e387c38b4343a67168cea18f6bbf8ff0d7c11a` and `7425bb935456a64a13a08ae5bcd462bdc2873a39` | B-F12-116, B-F34-116 (agent 116) | none in this piece (merges of F1-F4 round 11) | 7 r5 copy pins red by design: [run 37175735674](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175735674/job/111357835324) |
| 12 | `b8c26b7f7e32ad01250d1a7955555497f1445832` | B-F56-117 (agent 117) | Opus C-685-1, the expectation half: the r5 expectations follow F2's impersonal copy (B-682-3); every amount unchanged | failing-before = run 37175735674 at 7425bb93 (the 7 tests); passing-after = build-and-test at this head (FIX ROUND 12 comment) |

