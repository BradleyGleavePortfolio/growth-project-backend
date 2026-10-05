**Tier: T4 (money path).** Current head: `f3c7fd37` after MAIN REFRESH (main `ee55f814` merged by B-DUNR-119, verified by B-DUNMR-120; no code change). The stack lands as one: D1 -> D2 -> D3 -> D4 -> D5, deployed only after D5 together with mobile #322.

Split of #628 (dunning v2 live: card update, lockout, recovery; 12,334 lines at FIX ROUND 8 `dc47e0ef`, already current with main `d23fa317`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check (no piece imports a later piece). Stack: D1 -> D2 -> D3 -> D4 -> D5, merged back to back; deploy only after D5, together with mobile #322. The tree at D5 equals #628's head (git diff). Behaviour notes for the owner from FIX ROUND 8 carry over: third-party-paid invoices settle one reconcile run later, and a dispute that arrives mid-cycle keeps the cycle open. No verdicts existed at dc47e0ef; each piece needs Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**D1 (this PR, base main, 2,974 lines after FIX ROUND 2):** migration 20270215000000_dunning_billing_actions (+ down.sql), schema, effective-access rules, client billing money helpers, Stripe Connect API billing calls, email templates, env/prod-switch/jest config entries, Stripe event fixtures and test fakes. Inert. Existing specs that import these files pass locally (18 suites, 317 tests).

**FIX ROUND 3 (B-DUNSPLIT-119, 2,822 lines):** main `3e9a9a75` merged (merge-only); dispute copy follows R-DISPUTE-PAUSE (access has ended, billing for the plan is paused, the coach decides whether to restart; no card button on the dispute email); Stripe event fixtures moved up to D2b #704 byte-identical; privacy-guard legacy list updated. Stack now: #687 D1 (2,822) -> #688 D2a (2,440) -> #704 D2b (694) -> #705 D2c (1,287, builds R-DISPUTE-PAUSE) -> #689 -> #690 -> #691. FEATURE_DUNNING_V2 stays off until #705 merges.

## Fix rounds

| Round | Builder | Head | Findings | Comment |
|---|---|---|---|---|
| 1 | B-D12-116 (agent 116) | `f8e47bf4` | Sol and Opus round-1 findings; cadence and dispatcher moved into D1 | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5976568403) |
| 2 | B-DUNA-118 (agent 118) | `38d9b3ab` | main `2af682ca` merged (merge-only); Sol B-687-3, B-687-4; Opus B-687-5; Opus B-688-7 (template part); C-687-6, C-687-7, C-688-10 | [FIX ROUND 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982921310) |
| 3 | B-DUNSPLIT-119 (agent 119) | `c260a849` | main `3e9a9a75` merged (merge-only); R-DISPUTE-PAUSE copy (client and coach); fixtures moved to #704; privacy-guard legacy list | [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5984088671) |
| MAIN REFRESH | B-DUNR-119 merge, verified by B-DUNMR-120 (agent 120) | `f3c7fd37` | main `ee55f814` (fees F-stack, recurring R1-R5) merged; conflict resolution keeps both sides (stripe-connect-api, email types/service); 2,640 lines | [MAIN REFRESH](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999323963) |

