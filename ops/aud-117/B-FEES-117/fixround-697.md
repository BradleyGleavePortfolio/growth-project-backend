FIX ROUND 13 (B-FEES-117, agent 117) — growth-project-backend#697 @ 2ae0c3c94d281e0282a88442f9132e729366758a

Builder: agent 117, job B-FEES-117. New tests-only piece "fees F4b tests" (operator ruling 2), base F4 #684 (`d3e8ceb2`), stacked under F5 #685. Size 1,837, tests only; SIZE ASSESSMENT below.

| Finding | Change | Commit | Test |
|---|---|---|---|
| Sol B-683-4, Sol B-683-1, Opus B-684-3 (P1-P5), Opus C-684-4, Sol B-684-1, Sol B-684-3, G12 addendum (fixes in #683 / #684) | new `test/s-fee-r13-refund-list-notices-deadline.spec.ts`, 22 tests, every amount exact; the new reader and the deadline argument are resolved at run time so the spec also runs on the pre-fix head | `e30901b570676df11978d5a690d1cdf4070d903c`, `2ae0c3c94d281e0282a88442f9132e729366758a` (explicit call counter for tsc `noImplicitAny`) | itself |
| size: specs moved out of F3 / F4 | `test/s-fee-charge-settlement.spec.ts` (from F3, unchanged), `test/s-fee-settlement-sweep.spec.ts` (from F4, unchanged), `test/s-fee-r11-fx-cash-truncation-logs.spec.ts` (from F4; listed refunds now carry Stripe's own `amount` and `currency`, which the reader requires, and the two B-684-1 cases stub Stripe's complete list with the eleventh refund; every amount assertion unchanged) | `e30901b570676df11978d5a690d1cdf4070d903c` | themselves |

Evidence:
- Failing-before: [run 37179995422](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179995422) (spec on the pre-fix F4 head `e9ee033d`): 19 failed / 3 passed. The 3 passing are controls (same-currency notice, P4, P5); "two complete pages are summed exactly (control)" fails there only because the reader does not exist yet.
- Passing-after: PR CI build-and-test at this head (link in the table below once complete), the spec 22/22, the moved specs green.

SIZE ASSESSMENT: 1,837 of 3,000, tests only: the round-13 spec (519 lines), the F3 settlement spec (586), the round-11 spec (373) and the sweep spec (359). It exists so F3 and F4 stay under the limit with their fixes.

READY FOR AUDIT
