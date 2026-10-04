Split of mobile #329 (coach setup wizard with Stripe Express onboarding, first package, invite and QR; 6,392 lines at `fc7fe73f`, BEHIND main) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #329 was merged with mobile main `367e6c48` locally (clean) and cut with an import-order check. Stack: W1 -> W2 -> W3, merged back to back. Needs backend coach Money (#674 -> #676 -> #677) deployed first. Mobile #332 is stacked on #329's branch and will be re-based onto W3 when it is split. Tree at W3 = refreshed #329 (git diff). Prior verdicts do not carry; each piece needs Opus 5.5 and Sol audits at its exact head (T4, payments onboarding). `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**W1 (this PR, base main, 1,878 lines):** setup API client, packages API field, durable package-create intent, error mapping, Connect copy states and test, setup status, vendored QR encoder (MIT, LICENSE.md) and QrCode. New modules only; 11 importing suites pass (187 tests).


**Tier: T4** (payments onboarding: Stripe Express Connect, package pricing and money copy; split piece of #329).
- Why: creates and prices packages clients pay for, reads Connect status, reports failures to Sentry.
- T4 trigger scan: money (package price/cadence PATCH, free binding), Stripe Connect onboarding, session/account identity races, diagnostics content.
- T3 trigger scan: user-visible setup copy.
- Bounded T1: none.
- Canonical builder: agent 115 (split); fix round 1: B-WIZ-118 (agent 118).
- Parent owner: operator (land #345-#351 as one, rule 11).
- Acceptance evidence: required checks green at the exact head, failing-before CI lane per finding, probe replays of both lenses.
- Promotion triggers: backend coach Money #674 -> #676 -> #677 deployed (live Stripe re-read, money routes, HTTPS onboarding return).

**Fix rounds**
| Round | Head | Builder | Change | Comment |
|---|---|---|---|---|
| 1 | `97c9005e644ebc13731d1477bfecc270a10552fd` | B-WIZ-118 | merged main 7fdb629a; cadence PATCH + answer check (B-345-1/2), isLive stop (B-329-5), content-free referenced reports (B-345-3), today's-server fallbacks | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5982572052) |
