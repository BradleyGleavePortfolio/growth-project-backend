Split of mobile #329 (coach setup wizard with Stripe Express onboarding, first package, invite and QR; 6,392 lines at `fc7fe73f`, BEHIND main) under the owner's PR size rule: over 3,000 changed lines is an automatic fail (MODEL_ROUTING.md 8.2, tgp-agent-context). #329 was merged with mobile main `367e6c48` locally (clean) and cut with an import-order check. Stack: W1 -> W2 -> W3, merged back to back. Needs backend coach Money (#674 -> #676 -> #677) deployed first. Mobile #332 is stacked on #329's branch and will be re-based onto W3 when it is split. Tree at W3 = refreshed #329 (git diff). Prior verdicts do not carry; each piece needs Opus 5.5 and Sol audits at its exact head (T4, payments onboarding). `tsc --noEmit` passes at every piece; every existing test importing a changed file was run locally.

**W2 (base W1, 1,922 lines):** setup checklist, first package form, get-paid panel, invite share card, setup notice, setup screen and its CoachNavigator route, home card entry points; package-create durability and idempotency tests (11 suites, 87 tests locally).


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
| 1 | `2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60` | B-WIZ-118 | merged #345; form and Get paid lifecycle fences (B-329-5, B-346-2), retry repeats the failed action, copy (B-346-1), archived recovery (C-346-2), today's-server stale note | [FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5982579141) |

