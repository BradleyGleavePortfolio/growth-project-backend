**Tier: T4 (payments, plan management, money copy).** FIX ROUND 5: B-SHEET5-119 (agent 119, closes B-344-7, B-344-2/3 residuals); FIX ROUND 4 restack + tests: B-SHEET4-119 (agent 119); FIX ROUND 3: B-SHEET3-119 (agent 119, closes B-344-1..6); FIX ROUND 2 restack: B-SHEET2-119 (agent 119); FIX ROUND 1: B-SHEET-118 (agent 118).

Split of mobile #334 (package sheet payments with native recurring; 6,202 lines at FIX ROUND 4 `d466fd15`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #334 was behind mobile main; it was merged with main `367e6c48` locally (clean) and cut with an import-order check. Stack: S1 -> S2 -> S3, merged back to back. Pairs with backend #680 (recurring R3): merge after the backend money chain (#681..#686, #678..#680) is merged and deployed. Tree at S3 = refreshed #334 (git diff). Prior verdicts (Sol APPROVE at 78ba9bc9 before C-334-3; no Opus this round) do not carry; each piece needs Opus 5.5 and Sol audits at its exact head (T4, payments). C-334-2 interplay with mobile #322 stands. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**S3 (base S2, 2,728 lines at FIX ROUND 3, grandfathered under 3,000):** client packages screen, package checkout screen, your-plans panel, package detail surface; subscription, recur-3 and screen purchase tests (5 suites, 72 tests locally).

## Fix rounds

| Round | Head | Scope | Comment |
|---|---|---|---|
| 1 (restack) | e7fcc5d2504e8c3948494ee847e16ff4937b78c3 | merge #343 d9e7da55; test-only trial fixtures today + 7 (follows B-343-4) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982498620 |
| 2 | 25af65691fbf60a3501a77624de8eafd0ccd81d3 | restack onto #343 19678ce7; contrast test carried byte-identical; one offline expectation follows B-342-1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5983790388 |
| 3 | 8f53887a6fe12a928313fde3f4464a2ee0630f3d | B-344-1..6 (+C-344-3 same lines): truthful list states (missing route / failed read / stale), dunning-specific End my plan consent, CancelPlanResult outcome shown, canonical resume view, generation fence, plan-action copy with Email support; new src/lib/planActions.ts | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984026424 |
| 4 (restack + tests) | 7e17d142d45cfcf6d922b6e78f79881be2428041 | restack onto #343 691e0cf0; FR3 content byte-identical; tests for B-343-1 and the B-342-1 hook flow (usePackagePurchase.nativeFence.test.tsx), two copy pins follow B-342-1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984292690 |
| 5 | bc4387ac9f1a35d8ad6746d8ece3cda75fe89ab4 | B-344-7 trial/scheduled receipt copy; B-344-2 no End my plan from an unconfirmed card + overdue clause in the consent; B-344-3 structured receipts reconciled against each newer read (2,958 lines) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984615650 |

Proposed land gate (operator decides): with the recurring chain, also dunning D4 #690 (the cancel route); without it End my plan answers with the route-missing copy and the plan is unchanged.

