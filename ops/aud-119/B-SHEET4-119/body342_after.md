**Tier: T4 (payments).** Builder of record for FIX ROUND 3: B-SHEET4-119 (agent 119); FIX ROUND 2: B-SHEET2-119 (agent 119); FIX ROUND 1: B-SHEET-118 (agent 118). Works against today's production backend (643817b3, no subscription-intent route: specific no-charge copy) and the recurring chain (#678-#701) / #661 reply codes.

Split of mobile #334 (package sheet payments with native recurring; 6,202 lines at FIX ROUND 4 `d466fd15`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #334 was behind mobile main; it was merged with main `367e6c48` locally (clean) and cut with an import-order check. Stack: S1 -> S2 -> S3, merged back to back. Pairs with backend #680 (recurring R3): merge after the backend money chain (#681..#686, #678..#680) is merged and deployed. Tree at S3 = refreshed #334 (git diff). Prior verdicts (Sol APPROVE at 78ba9bc9 before C-334-3; no Opus this round) do not carry; each piece needs Opus 5.5 and Sol audits at its exact head (T4, payments). C-334-2 interplay with mobile #322 stands. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**S1 (this PR, base main, 1,685 lines):** payment orchestration library, plan terms, wallet config and test, PaymentSheet appearance, client payments API field, app config and expected env entries. Not used by any screen until S2; 15 importing suites pass (180 tests).

## Fix rounds

| Round | Head | Scope | Comment |
|---|---|---|---|
| 1 | 56f281ad3aa977882c962a6591d3594899cdd5a1 | merge main 43f6bfad; B-342-1, B-342-2, C-342-1 (Sol), recurring codes, production fallback, B-343-4 terms | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5982491578 |
| 2 | 0b1985f46ae2d4baadfcc6a02f8257c2f504249d | merge main cc4ceeed; B-342-1 no-answer copy (Sol), B-342-3 per-currency minor units (Sol) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5983790118 |
| 3 | e3226f3b50a1f609aea7805600ec124324cd12aa | B-342-1 PACKAGE_NOT_FOUND after an unclear same-key attempt is never told as no charge (Sol); key kept, plan + support + attempt reference | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5984292430 |


