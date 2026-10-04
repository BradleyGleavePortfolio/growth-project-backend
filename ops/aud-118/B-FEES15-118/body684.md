**Tier:** T4
**Why:** money path. F4 wires settlement into checkout, the refund/dispute webhook, the sweep cron and the coach payout notices (in-app, push, email).
**T4 trigger scan:** webhook-driven money moves (charge.refunded incl. truncated refund lists, disputes, admin refunds), sweep cron, payout notice delivery and copy shown to coaches. All present.
**T3 trigger scan:** logging and persisted diagnostics (closed vocabulary only).
**Bounded T1:** none.
**Canonical builder:** agent 115 (split of #627); fix round 11 by B-F34-116 (agent 116); round 13 by B-FEES-117 (agent 117).
**Parent owner:** #627 (S-FEE), operator 116.
**Acceptance evidence:** CI-lane failing-before and passing-after runs (Fix round table); every required check green at the head.
**Promotion triggers:** any change to the webhook money paths, the sweep or notice copy re-opens T4 review by both lenses.

Split of #627 (coach net payouts: price minus the Stripe fee minus 2%; 14,846 lines at FIX ROUND 10 `66162285`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #627 was BEHIND main; it was merged with main `d23fa317` locally (clean) and the pieces were cut from that tree with a dependency check (no piece imports a later piece). Stack: F1 -> F2 -> F3 -> F4 -> F4b (#697, tests only, round 13) -> F5 -> F6, merged back to back; deploy only after F6, together with mobile #321. The tree at F6 equals the refreshed #627 (git diff). The recurring stack #678 -> #679 -> #680 now sits on F6. Prior verdicts on #627 (Opus APPROVE and Sol RC 0/1/0 at 3a5338d7; none at 66162285) do not carry; each piece needs fresh Opus 5.5 and Sol audits at its exact head (T4, money path). Open follow-up C-627-10 (nullable column) stays a separate PR after merge. `tsc --noEmit` passes at every piece; local jest for each piece's specs listed below.

**F4 (base F3, 2,606 lines at split; 2,995 at round 11; 2,435 at round 13, its round-11 and sweep specs now in F4b #697):** purchase split handler, refund/dispute handler, settlement sweep cron, payout notice service and email template, webhook handler, payment-ops controller, admin analytics, billing, module wiring; purchase-split, sweep, webhook fee-split and payment-ops specs, plus the reconciliation, admin analytics, coach-connect and field-select specs (11 suites, 209/209 locally). First piece that changes live money paths.


**Landing (operator 115, 2026-10-03):** the core money pieces are coupled at runtime: F2 swaps the transfer orchestrator under the existing purchase-split handler, so main's purchase-split, webhook fee-split and (at F3) reconciliation specs stay red at F2 and F3 until F4 carries their updated versions. F1, F4, F5 and F6 are expected green. Do not merge F1 to main alone (it switches checkout to separate charges and transfers before the transfer machinery exists). Review in slices, land as one: after every piece has dual APPROVE at its exact head, merge F6 into F5, F5 into F4, ... F2 into F1 (bases are agent115 branches, not protected), confirm F1's tree equals the audited F6 head (git diff empty; lenses post a merge-only delta), then merge F1 into main with all required checks green, then deploy.


## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 11 | `e9ee033d425a61bb48efe2ac2387a23e5347acb0` | B-F34-116 (agent 116) | Sol B-684-1 (latest-ten refund page converges on amount_refunded), Sol B-684-2 (closed codes at notice, wrapper and cron log sinks), Sol C-684-1 / Opus B-684-1 / operator copy rule (no first person), Opus C-684-2 (live held amount on any page); tests for F3's B-683-1/2/3 and C-683-3 | failing-before [run 37173415148](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173415148/job/111350921741), passing-after [run 37175462104](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175462104) (tsc + spec at the F4 head) |
| 13 | `d3e8ceb22dcc5fe604421845173b99c9066207b0` | B-FEES-117 (agent 117) | Sol B-684-1 + Opus B-684-3 (complete refund list, money only on succeeded, refund updates move money), Opus C-684-4 (alert + flag after a failed applied refund), Sol B-684-3 (notice delivery keeps the sweep deadline), Sol C-684-4 (bounded latest-notice lookup), addendum G12 (`:66`, `:197` closed codes); two specs moved to F4b #697 | failing-before [run 37179995422](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179995422) (19 failed / 3 passed controls), passing-after in #697; build-and-test green [run 37180267131](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180267131) |

Copy changed in round 11 (old -> new):
- `src/email/templates/coach-payout-adjustment.hbs`: "We take it out of your next payout, and out of the ones after it if one sale is not enough. Nothing is taken from sales you were already paid for." -> "It comes out of your next payout, and out of the ones after it if one sale is not enough. Nothing is taken from sales already paid out."
- `src/checkout/payout-notice.service.ts` (PAYOUT_NOTICE_NOT_FOUND): "We could not find that payout notice on your account. Refresh Money to see your current notices." -> "That payout notice is not on this account. Refresh Money to see the current notices."

