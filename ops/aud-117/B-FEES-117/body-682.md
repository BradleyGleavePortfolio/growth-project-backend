feat(fees): transfer orchestrator and payout notice copy (split F2 of #627)
agent115/fee-split-1-ledger-foundation
**Tier:** T4
**Why:** money path. The transfer orchestrator creates and reverses Stripe transfers; a stale sender or a lost receipt can pay or debit a coach twice.
**T4 trigger scan:** Stripe transfer create and reversal protocol (claims, fences, start budget, reconciliation listings), ledger receipts, payout notice copy shown to coaches. All present.
**T3 trigger scan:** logging and persisted diagnostics (closed vocabulary only), shared test fakes (`test/utils/settlement-fakes.ts`).
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); fix round 11 by B-F12-116 (agent 116).
**Parent owner:** #627 (S-FEE), operator 116.
**Acceptance evidence:** CI-lane failing-before and passing-after runs per finding (Fix round table); required checks at the head, build-and-test red by design only for the 4 old-fixture tests F4 #684 updates.
**Promotion triggers:** any change to the send or reversal protocol, the reconciliation listings or notice copy re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F2 (base F1, 2,529 lines at split; 2,951 at round 11):** transfer orchestrator, payout notice copy, settlement test fakes; orchestrator, send-boundary and transfer-match specs (13/13 locally).


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and checkout specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.

## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 | `a5d6a434a9bd909699b158ac3791a09db25c241d` | B-F12-116 (agent 116) | B-682-1 (both lenses), Sol B-682-2 / Opus C-682-4 and C-685-2 (closed diagnostics incl. the park-after-lock-loss re-check log), Opus B-682-3 / Sol C-682-1 (impersonal notice copy) | failing-before [run 37173216866](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173216866/job/111350295701), passing-after with tsc [run 37173243305](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173243305/job/111350375764) |

