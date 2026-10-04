**Tier:** T4 (money path) | **Why:** card payments, dispute cycles, Day-10 lockout and 2A cancel | **T4 trigger scan:** Stripe pay/void/cancel, entitlement writes, dispute authority | **T3 trigger scan:** logging vocabulary, client copy | **Bounded T1:** none | **Canonical builder:** agent 116 (B-D34-116 fix round 1); restack B-DUN-117 (agent 117) | **Parent owner:** operator 117 | **Acceptance evidence:** Opus 5.5 and Sol APPROVE at the exact head | **Promotion triggers:** none (stack D1-D5 lands together, flag off)

Split of #628 (dunning v2 live: card update, lockout, recovery; 12,334 lines at FIX ROUND 8 `dc47e0ef`, already current with main `d23fa317`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check (no piece imports a later piece). Stack: D1 -> D2 -> D3 -> D4 -> D5, merged back to back; deploy only after D5, together with mobile #322. The tree at D5 equals #628's head (git diff). Behaviour notes for the owner from FIX ROUND 8 carry over: third-party-paid invoices settle one reconcile run later, and a dispute that arrives mid-cycle keeps the cycle open. No verdicts existed at dc47e0ef; each piece needs Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**D5 (base D4, 2,742 lines, test-only):** money-truth e2e and lifecycle e2e specs (80/80 locally).

### Fix rounds
| Round | Head | Findings | Builder | Evidence |
|---|---|---|---|---|
| 2 (restack, merge-only) | `0f24a8fa` | none (D4 fix round merged; tests unchanged, 2,742 lines) | B-D34-116 | D5 suites on the merged tree: run 37174570264 |
| 3 (restack, merge-only) | `e0afe678` | none: merge of D4 `06307883` carrying D1 `f8e47bf4`; D5 diff byte-identical (patch-id) | B-DUN-117 | [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-5976887162); build-and-test 722 suites green on the full stack tree |
