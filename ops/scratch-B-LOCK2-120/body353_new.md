**Tier:** T4 (payments: dunning lockout, card update, plan cancel; account identity).
**Why:** client money copy and a full-screen lockout; wrong state can lock a paying client or claim a charge that did not happen.
**T4 trigger scan:** payments yes (card update, cancel, dunning copy); auth/identity yes (lockout signal owned per auth generation); data deletion no.
**T3 trigger scan:** navigation wiring and universal link (L2); accessibility (lockout modal).
**Bounded T1:** none.
**Canonical builder:** B-LOCK2-120 (agent 120), fix round 2 (round 1: B-LOCK-118, agent 118). **Parent owner:** agent 120 (operator).
**Acceptance evidence:** see the Fix round table and the FIX ROUND 2 comment at `9d47045b`.
**Promotion triggers:** lands only after backend #687-#691 deploy; lockout flag (FEATURE_DUNNING_V2) stays off; inert on today's production (no status route: nothing shown).
**Scope:** L2: lockout provider and screen, banner, Update card screen, wiring. **Size:** 2,723 (+2679 / -44) vs L1.

Split of mobile #322 (payment lockout, Days 0-9 banner, native Update card; 4,623 lines at `23435ec2`, BEHIND main) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #322 was merged with mobile main `367e6c48` locally (clean) and cut with an import-order check. Stack: L1 -> L2 -> L3, merged back to back. Pairs with backend dunning (#687 -> #691): merge after that stack is deployed. Tree at L3 = refreshed #322 (git diff). #322's earlier approvals were at its own head; per the T4 rule a new head needs new verdicts, so each piece needs Opus 5.5 and Sol at its exact head (the content is unchanged, so these should be short). `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**L2 (base L1, 1,730 lines):** lockout provider and screen, Days 0-9 banner, Update card screen, RootNavigator and ClientNavigator wiring, update-card universal link (app.json, apple-app-site-association), packages and home hooks; lockout and navigator tests (17 suites, 125 tests locally).

## Fix rounds
| Round | Builder | Findings closed | Commits | Head |
|---|---|---|---|---|
| 1 | B-LOCK-118 (agent 118) | B-353-1 (Opus + Sol), B-353-2 (Opus + Sol), B-353-3 (Opus + Sol), B-353-4, C-353-2/C-353-3 (Opus, same lines), production truth | L1 merge `1fbb7837`, fix `0dce9ed2`, test `05d84f27` | 05d84f27 |
| 2 | B-LOCK2-120 (agent 120) | B-353-2, B-353-3 (Sol), B-353-6, B-353-7 (Opus): R-DISPUTE-PAUSE on banner, lockout, Update card, end-plan body; End my plan confirmation owner | L1 merge `b587e20f`, fix `9d47045b` | 9d47045b |

Since FIX ROUND 1 the stack is no longer byte-identical to #322: the split note above (sizes, "content is unchanged") describes the pre-fix cut; current sizes are in the tier header.

