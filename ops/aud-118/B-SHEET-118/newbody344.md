**Tier: T4 (payments).** Restack of record for FIX ROUND 1: B-SHEET-118 (agent 118).

Split of mobile #334 (package sheet payments with native recurring; 6,202 lines at FIX ROUND 4 `d466fd15`) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #334 was behind mobile main; it was merged with main `367e6c48` locally (clean) and cut with an import-order check. Stack: S1 -> S2 -> S3, merged back to back. Pairs with backend #680 (recurring R3): merge after the backend money chain (#681..#686, #678..#680) is merged and deployed. Tree at S3 = refreshed #334 (git diff). Prior verdicts (Sol APPROVE at 78ba9bc9 before C-334-3; no Opus this round) do not carry; each piece needs Opus 5.5 and Sol audits at its exact head (T4, payments). C-334-2 interplay with mobile #322 stands. `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**S3 (base S2, 2,079 lines):** client packages screen, package checkout screen, your-plans panel, package detail surface; subscription, recur-3 and screen purchase tests (5 suites, 72 tests locally).

## Fix rounds

| Round | Head | Scope | Comment |
|---|---|---|---|
| 1 (restack) | e7fcc5d2504e8c3948494ee847e16ff4937b78c3 | merge #343 d9e7da55; test-only trial fixtures today + 7 (follows B-343-4) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982498620 |
