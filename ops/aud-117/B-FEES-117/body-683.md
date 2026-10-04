feat(fees): charge settlement and reconciliation (split F3 of #627)
agent115/fee-split-2-transfer-orchestrator
**Tier:** T4
**Why:** money path. Charge settlement turns each charge into the coach's net from Stripe's actual fee and moves transfers, reversals and recoveries on refunds and disputes; reconciliation attests the books.
**T4 trigger scan:** Stripe charge, refund and dispute reads (incl. converted-currency refunds), transfer and reversal moves, recovery netting, per-charge lock, reconciliation snapshots. All present.
**T3 trigger scan:** logging and persisted diagnostics (closed vocabulary only).
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); fix round 11 by B-F34-116 (agent 116).
**Parent owner:** #627 (S-FEE), operator 116.
**Acceptance evidence:** CI-lane failing-before and passing-after runs (Fix round table); required checks at the head; build-and-test red by design only for the exact list below, which F4 #684 turns green.
**Promotion triggers:** any change to settlement, refund/dispute adjustment or reconciliation re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F3 (base F2, 2,895 lines at split; 2,983 at round 11):** charge settlement service and reconciliation; charge-settlement spec (26/26 locally). Round 11's regression tests for F3 code live in F4 #684 (`test/s-fee-r11-fx-cash-truncation-logs.spec.ts`): F3 is at its size limit and F4 carries the wired services they run through.

**Red by design at F3 (exact, round 11):** build-and-test fails 3 suites / 9 tests, all main specs whose updated versions F4 #684 carries (all pass at F4): `test/checkout-webhook-fee-split.spec.ts` (2), `test/purchase-split-handler.service.spec.ts` (2), `test/reconciliation.service.spec.ts` (5; main's fake lacks `chargeSettlement.findMany`). Every other check is green.


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and (at F3) reconciliation specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.


## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 | `35a18539c8a911524c3eab5b074b33e247f80ac2` | B-F34-116 (agent 116) | Sol B-683-1 / Opus C-683-2 (converted-currency refunds), Sol B-683-2 (unexecuted transfers are not cash), Sol B-683-3 (closed log codes), Opus C-683-3 (every settled charge reconciled), Opus C-683-1 (exact red-by-design list) | failing-before [run 37173415148](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173415148/job/111350921741), passing-after [run 37175462104](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175462104) (tsc + spec at the F4 head) |

