feat(fees): settlement schema, fee policy, ledger and Stripe transfer API (split F1 of #627)
main
**Tier:** T4
**Why:** money path. Separate charges and transfers, the per-charge ledger, the charge lock and the Stripe transfer and reversal calls decide what each coach and TGP are paid.
**T4 trigger scan:** money movement (Stripe transfers and reversals, ledger rows), additive migration `20270210000000_s_fee_charge_settlement` (RLS forced), checkout call sites, deletion manifest. All present.
**T3 trigger scan:** logging vocabulary (closed codes and ids only), cross-piece contract (`reverseTransfer` `beforeSend`, used by F2), env and prod-switch entries.
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); fix round 11 by B-F12-116 (agent 116).
**Parent owner:** #627 (S-FEE), operator 116.
**Acceptance evidence:** CI-lane failing-before and passing-after runs per finding (Fix round table); all required checks at the head.
**Promotion triggers:** any change to fee math, the migration, the ledger identity or the charge lock re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F1 (this PR, base main, 2,503 lines at split; 2,882 at round 11):** migration 20270210000000_s_fee_charge_settlement (+ down.sql), schema and parity baseline, coach-net and fee-policy rules, money errors, charge lock, split ledger, platform fee, cron lease, Stripe Connect API transfer calls plus the checkout and guest-checkout call sites that change with them, notification hooks, env and prod-switch entries, deletion manifest; deletes the superseded fee-rounding spec. Also carries the updated checkout, guest-checkout and LP-attribution specs for the call-site change. Local: checkout, guest-checkout, LP attribution and packages specs 165/165.


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and checkout specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.

## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 | `9de3135c2f128289ab302dff43a04e12f32b74d1` | B-F12-116 (agent 116) | Sol B-681-1, B-681-2; Opus C-681-3, C-681-4 (same two), C-681-5; F1 half of B-682-1 (`reverseTransfer` `beforeSend`). C-681-6 not renamed (OR-113-4; no dependency-order defect) | failing-before [run 37172716648](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172716648/job/111348816612), passing-after with tsc [run 37172742665](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172742665/job/111348891780) |

