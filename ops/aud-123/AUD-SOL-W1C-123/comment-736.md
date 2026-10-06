AUDIT GPT-6.1 Sol — growth-project-backend#736 @ 58a31e6fb959947920e99abc0facc8b34cfdb4c0 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/3. AUD-SOL-W1C-123, agent 123; independent fix-delta review.

## B-736-3 — Activity exclusion suppresses an acute breathing emergency

**Normal-user story:** A client who cannot breathe after a workout types “I cannot breathe after my workout. I need help now.” after using the daily AI allowance and receives “You have reached your daily AI coaching limit. It refreshes tomorrow” instead of the emergency 911 reply. ([Independent actual-chat reproduction](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37399907377/job/112064543881))

`src/ai/ai-crisis-router.ts:60–61` now excludes every breathing match followed by an activity clause, even an explicit inability-to-breathe/help-now report; therefore `AiService.chat` misses its safety return and reaches the ordinary quota refusal. “I can’t breathe during my workout. Please help me.” reproduces the same regression. ([Changed router](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/58a31e6fb959947920e99abc0facc8b34cfdb4c0/src/ai/ai-crisis-router.ts), [Chat/quota path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/58a31e6fb959947920e99abc0facc8b34cfdb4c0/src/ai/ai.service.ts), [Two failing assertions](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37399907377/job/112064543881))

**Minimal fix / verification:** Narrow the activity exclusion so the two acute help-now reports still get the fixed 911 reply before consent/quota/model, while preserving the requested ordinary bracing/nasal-breathing/long-run controls. Reuse the saved `test/audit-sol-w1c-123-crisis-delta.spec.ts` assertions; do not add unrelated hardening.

## Prior Bs and required controls

The named-medicine overdose now routes to 911, “I am going to hang myself” routes to 988, and both also pass the independent at-cap/without-consent assertion with no context, quota or model call; the crisis check remains first. ([Independent assertions](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37399907377), [Early return](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/58a31e6fb959947920e99abc0facc8b34cfdb4c0/src/ai/ai.service.ts))

“Overdose on cardio,” “can you overdose on creatine?”, “I hurt myself deadlifting, can I train?” and the three specified controls retain the normal-answer path under cap and the ordinary quota refusal at cap; the old Sol B-736-1/B-736-2 are closed. ([Passing exact-code service/table suites](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37396028556), [Independent rerun](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37399907377))

## CI / scope

Independent lane: **2 failed / 93 passed / 95 total**, only the two new acute-breathing assertions fail; both existing AI suites and all 12 independent controls pass. Lane head `e97786c76e3d7a82890fbc0a22e0d78baad1dae5` adds only the probe and lane metadata/workflow over exact PR head `58a31e6f`; no source edits. ([Independent run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37399907377))

Builder lane is source/spec-identical to this PR and passes 81/81; listed exact-head PR checks are successful, deploy gate skipped, and size is 412 changed lines under 1,500. Green existing checks do not cover B-736-3. ([Builder lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37396028556), [PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37396031421), [PR #736](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736))

C only, unchanged: C-736-3 Roman-router alignment, C-736-4 conservative hyperbole, C-736-5 intentional-overdose template's missing 988 line; no normal-use blocker established for these builder follow-ups in this scoped delta. Own prior throttle/quota follow-ups were not reopened. ([Builder C list](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6007481786))

No other lens's notes, report or verdict read; one audit-lane push, no local npm/Jest/tsc/eslint/build, PR-branch push, merge, deploy or production action.
