**Tier:** T4 (money path) | **Why:** card payments, dispute cycles, Day-10 lockout and 2A cancel | **T4 trigger scan:** Stripe pay/void/cancel, entitlement writes, dispute authority | **T3 trigger scan:** logging vocabulary, client copy | **Bounded T1:** none | **Canonical builder:** agent 116 (B-D34-116 fix round 1) | **Parent owner:** operator 116 | **Acceptance evidence:** Opus 5.5 and Sol APPROVE at the exact head | **Promotion triggers:** none (stack D1-D5 lands together, flag off)

Split of #628 (dunning v2 live: card update, lockout, recovery; 12,334 lines at FIX ROUND 8 `dc47e0ef`, already current with main `d23fa317`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). Cut with an import-order check (no piece imports a later piece). Stack: D1 -> D2 -> D3 -> D4 -> D5, merged back to back; deploy only after D5, together with mobile #322. The tree at D5 equals #628's head (git diff). Behaviour notes for the owner from FIX ROUND 8 carry over: third-party-paid invoices settle one reconcile run later, and a dispute that arrives mid-cycle keeps the cycle open. No verdicts existed at dc47e0ef; each piece needs Opus 5.5 and Sol audits at its exact head (T4, money path). `tsc --noEmit` passes at every piece.

**D3 (base D2, 2,913 lines):** client billing service and reconciler. Not reachable until D4 (controller and lockout allow-list must land together: the route-table spec scans controllers on disk); specs in D4/D5. Lockout route-table spec passes locally at this head (36/36).

### Fix rounds
| Round | Head | Findings | Builder | Evidence |
|---|---|---|---|---|
| 1 | `6cead7ec` | Sol B-689-1..4, Opus B-689-1, B-689-2, C-689-1, C-689-2 | B-D34-116 | failing-before runs 37173650946, 37174160085; passing-after 37174229442 |

