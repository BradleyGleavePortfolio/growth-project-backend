**Tier:** T4 (payments: dunning lockout, card update, plan cancel; account identity).
**Why:** client money copy and a full-screen lockout; wrong state can lock a paying client or claim a charge that did not happen.
**T4 trigger scan:** payments yes (card update, cancel, dunning copy); auth/identity yes (lockout signal owned per auth generation); data deletion no.
**T3 trigger scan:** navigation wiring and universal link (L2); accessibility (lockout modal).
**Bounded T1:** none.
**Canonical builder:** B-LOCK-118 (agent 118). **Parent owner:** agent 118 (operator).
**Acceptance evidence:** see the Fix round table and the FIX ROUND comment at `f084cc0f`.
**Promotion triggers:** lands only after backend #687-#691 deploy; lockout flag (FEATURE_DUNNING_V2) stays off; inert on today's production (no status route: nothing shown).
**Scope:** L3: native card update suite (tests only). **Size:** 1,119 (+1119 / -0) vs L2.

Split of mobile #322 (payment lockout, Days 0-9 banner, native Update card; 4,623 lines at `23435ec2`, BEHIND main) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #322 was merged with mobile main `367e6c48` locally (clean) and cut with an import-order check. Stack: L1 -> L2 -> L3, merged back to back. Pairs with backend dunning (#687 -> #691): merge after that stack is deployed. Tree at L3 = refreshed #322 (git diff). #322's earlier approvals were at its own head; per the T4 rule a new head needs new verdicts, so each piece needs Opus 5.5 and Sol at its exact head (the content is unchanged, so these should be short). `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**L3 (base L2, 1,119 lines, test-only):** native card update suite (41/41 locally).

## Fix rounds
| Round | Builder | Findings closed | Commits | Head |
|---|---|---|---|---|
| 1 (restack, merge-only) | B-LOCK-118 (agent 118) | none (merge-only onto fixed L2) | merges `ea1e0ebd`, `f084cc0f` | f084cc0f |

Since FIX ROUND 1 the stack is no longer byte-identical to #322: the split note above (sizes, "content is unchanged") describes the pre-fix cut; current sizes are in the tier header.

