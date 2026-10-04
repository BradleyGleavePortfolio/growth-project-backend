**Tier:** T4
**Why:** money path tests. F4b carries the tests for F3/F4 money code (refund list completeness, converted-refund notices, async refund status, notice delivery deadline, settlement and sweep specs); it changes no runtime code.
**T4 trigger scan:** tests of webhook-driven money moves (charge.refunded with incomplete refund lists, charge.refund.updated / refund.updated), settlement adjustments, sweep deadline and payout notice delivery. All present (tests only).
**T3 trigger scan:** log-canary tests for closed-vocabulary log sinks (G12).
**Bounded T1:** none.
**Canonical builder:** B-FEES-117 (agent 117), round 13; round 15 by B-FEES15-118 (agent 118).
**Parent owner:** #627 (S-FEE), operator 117.
**Acceptance evidence:** CI-lane failing-before run on the pre-fix F4 head and passing-after at this head (Fix round table); every required check green at the head.
**Promotion triggers:** any change to the refund webhook, settlement adjustments, sweep or notice delivery re-opens T4 review by both lenses.

Tests-only piece of the #627 split, stacked directly above F4 (#684) by operator ruling (round 13): every piece stays under the 3,000-line limit. Stack: F1 #681 -> F2 #682 -> F3 #683 -> F4 #684 -> **F4b** -> F5 #685 -> F6 #686. Land with the rest of the stack (merge F4b into F4 in the stack-down order); never into main alone.

**F4b (base F4, 1,837 lines, tests only):**
- `test/s-fee-r13-refund-list-notices-deadline.spec.ts` (new, 22 tests): Sol B-683-4, Sol B-683-1, Opus B-684-3 P1-P5, C-684-4, Sol B-684-1, Sol B-684-3, G12 canary.
- `test/s-fee-charge-settlement.spec.ts` (moved from F3, unchanged).
- `test/s-fee-r11-fx-cash-truncation-logs.spec.ts` (moved from F4; listed refunds now carry Stripe's own amount and currency, and the B-684-1 cases stub Stripe's complete list; every amount assertion unchanged).
- `test/s-fee-settlement-sweep.spec.ts` (moved from F4, unchanged).

## Fix round table
| Round | Head | Builder | Findings closed | Evidence |
|---|---|---|---|---|
| 13 | `2ae0c3c94d281e0282a88442f9132e729366758a` | B-FEES-117 (agent 117) | tests for Sol B-683-1, Sol B-683-4, Opus B-684-3, Sol B-684-1, Sol B-684-3, C-684-4, G12 (fixes in #683 / #684) | failing-before [run 37179995422](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179995422) at `e9ee033d` + spec: 19 failed / 3 passed (the three passing are controls); passing-after: build-and-test green [run 37180609876](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180609876) |
| 15 (restack, merge-only) | `45ebb1e18764c2dbe72475317fe24cda8e5bc91e` | B-FEES15-118 (agent 118) | none in this piece (merge of F4 round 15 restack); own-diff patch-id `c27f641ff50e` unchanged | build-and-test green [run 37220308181](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220308181) |


