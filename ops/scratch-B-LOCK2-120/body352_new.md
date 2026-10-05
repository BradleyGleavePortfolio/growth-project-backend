**Tier:** T4 (payments: dunning lockout, card update, plan cancel; account identity).
**Why:** client money copy and a full-screen lockout; wrong state can lock a paying client or claim a charge that did not happen.
**T4 trigger scan:** payments yes (card update, cancel, dunning copy); auth/identity yes (lockout signal owned per auth generation); data deletion no.
**T3 trigger scan:** navigation wiring and universal link (L2); accessibility (lockout modal).
**Bounded T1:** none.
**Canonical builder:** B-LOCK2-120 (agent 120), fix round 2 (round 1: B-LOCK-118, agent 118). **Parent owner:** agent 120 (operator).
**Acceptance evidence:** see the Fix round table and the FIX ROUND 2 comment at `c89f719c`.
**Promotion triggers:** lands only after backend #687-#691 deploy; lockout flag (FEATURE_DUNNING_V2) stays off; inert on today's production (no status route: nothing shown).
**Scope:** L1: dunning API client, store, interceptor, error copy, native flow helper. **Size:** 2,586 (+2580 / -6) vs main.

Split of mobile #322 (payment lockout, Days 0-9 banner, native Update card; 4,623 lines at `23435ec2`, BEHIND main) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #322 was merged with mobile main `367e6c48` locally (clean) and cut with an import-order check. Stack: L1 -> L2 -> L3, merged back to back. Pairs with backend dunning (#687 -> #691): merge after that stack is deployed. Tree at L3 = refreshed #322 (git diff). #322's earlier approvals were at its own head; per the T4 rule a new head needs new verdicts, so each piece needs Opus 5.5 and Sol at its exact head (the content is unchanged, so these should be short). `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**L1 (this PR, base main, 1,774 lines):** dunning API client, native update-card flow, error copy, lockout store, PaymentSheet appearance, locked-dunning API interceptor and test, support constants, backend #628 fixture. Not used by any screen until L2; 40 importing suites pass (622 tests).

## Fix rounds
| Round | Builder | Findings closed | Commits | Head |
|---|---|---|---|---|
| 1 | B-LOCK-118 (agent 118) | B-352-1, C-352-4, C-352-5 (L1 half), production 404 truth, B-353-2 native-flow ownership port | main merge `fe2fa580`, fix `ac244d22` | ac244d22 |
| 2 | B-LOCK2-120 (agent 120) | B-352-2, B-352-3 (Sol), B-352-7 (Opus): R-DISPUTE-PAUSE copy in every outcome, D2c `reason`, shared native sheet owner | main merge `40706529` (main cc4ceeed), fix `c89f719c` | c89f719c |

Since FIX ROUND 1 the stack is no longer byte-identical to #322: the split note above (sizes, "content is unchanged") describes the pre-fix cut; current sizes are in the tier header.

