# B-ROMAN-BFIX-121 (agent 121): Roman B fixes, #666 / #668 / #669 / #670

Started 12:56 PDT; stopped 13:52 PDT under the operator's 13:50 wrap-up order.

## Result
- **#666** pushed `a3eb3206d3805dc765962528b6a1a3ab6e085b09` (2,167 lines). FIX ROUND 1 comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6002680008
- **#668** pushed `dabed7388157c64a50ff32bc8e7e003c001af339` (2,368 lines vs #666). FIX ROUND 1 comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6002680261
- **#669** head unchanged at `6386c00b2bdbb2c120a5f173dea4753574d415e8`. The WIP is on `ci/B-ROMAN-BFIX-121-669-wip` @ `62f8979221cd26b2abaf4b8e5c7109d6914c65a0`. Status comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6002680562
- **#670** unchanged at `fb67101934becfb8536664df008129061c013dde`. Not restacked.
- No PR is READY FOR AUDIT: CI is pending at both new heads (runner incident).

## Fixed (A/B)
- **#666 A-666-1 (Opus):** acute anaphylaxis phrasing, overdose without the word, and "cannot go on anymore" now reach the crisis route.
- **#666 B-666-1 (Sol) / B-666-2 (Opus):** acute-only routing for anaphylaxis, EpiPen, heart attack, cardiac arrest and food poisoning.
- **#666 B-666-1 (Opus):** everyday words no longer trigger refusals.
- **#666 B-666-2 (Sol):** the predicates ignore Markdown and list formatting.
- **#666 B-666-3 (Opus):** a whole-day amount below the floor is refused whatever the verb (default deny).
- **#666 B-666-3 (Sol):** only an affirmative stop counts as the injury safe step.
- **#668 B-668-1:** coach pool pre-check in the controller and the service, 402 `COACH_AI_BUDGET_EXHAUSTED` with client and coach copy, a debit on every settle path, crisis exempt. Its tests are NOT written yet (ruled to go in #669).
- **#668 B-668-3 (Sol) / C-668-5:** kcal facts are typed by family, day and source, on both the post-check and the converter side.
- **#668 B-668-2 (Sol):** resolved by the operator ruling.
  - The per-client cap stays 429 `ROMAN_RATE_LIMIT`, 50 free / 500 pro turns per rolling 24 h. It is a constant with no env.
  - `ROMAN_DAILY_COST_CAP_USD` is the platform ceiling. Its default is now **100 USD per UTC day** (was 25), set in `src/roman/roman.constants.ts` `ROMAN_DAILY_COST_CAP_USD_DEFAULT`, ENV_RULES and `.env.example`.

## Evidence
- **Local runs** (`ops/heavy.sh`, one file at a time):
  - #666: the rb121, guardrails and guardrails-round2 specs give 141/141.
  - #668: roman-streaming plus launch-hardening give 79/80. The one red is the by-design FR1-651-3 exclamation red, which #669 replaces.
- **Probe replay:** Sol's guardrails probe and Opus's #666 probes all pass, except C-666-4.
- **Static checks:** Roman-scope tsc is clean (full-project tsc runs out of memory locally), and eslint is clean on the changed files.
- **Not run:** no ci-lane run was made, and the Sol #668 live-turn probe file was not replayed.
- **Notes and scripts:** `ops/aud-121/B-ROMAN-BFIX-121/` (`scripts/edit668_*.py`, `scripts/edit669.py`, the posted verdicts and the comment bodies).

## Follow-ups (C)
- C-666-4: `roman-post-check.ts` voice scrub misses U+FE15 and U+00A1. Fix: scrub the NFKC form.
- C-666-5: `docs/roman-safety-copy.md:4` says v2. Fix: v3.
- C-666-6: coachless copy. Fix: no coach sentence when `has_coach` is false.
- C-666-7: conservative routing. Fix: golden items in #670.
- C-668-2: coach-surface crisis template.
- C-668-3: `roman.controller.ts:166` uses `req.on('close')`. Fix: `res.on('close')` plus `!res.writableFinished`.
- C (edge, deferred to 10k clients): pool debit at the ceiling under concurrent turns. `recordUsage` refuses the overshoot, the same as the gateway.

## HANDOFF
- **Heads:**
  - #666: `a3eb3206d3805dc765962528b6a1a3ab6e085b09`
  - #668: `dabed7388157c64a50ff32bc8e7e003c001af339`
  - #669: `6386c00b2bdbb2c120a5f173dea4753574d415e8` (unchanged)
  - #670: `fb67101934becfb8536664df008129061c013dde` (unchanged)
  - WIP: `ci/B-ROMAN-BFIX-121-669-wip` @ `62f8979221cd26b2abaf4b8e5c7109d6914c65a0`
- **Done:** #666 and #668 fix round 1 (all A and B of both RB lenses), with comments posted.
- **Left:**
  1. When CI is green on #666 and #668, post READY FOR AUDIT.
  2. #669: from the WIP branch, link deps and run the recipe's before specs: `roman-round2`, `roman-launch-hardening`, `roman-guardrails-wiring`, `roman.prompts`, `eval/roman-golden.eval`, plus `roman-streaming` and `roman.service`.
  3. #669: fix the fallout, then add the B-668-1 tests: debit on ok and interrupted turns; 402 before any provider call and before the user turn is stored; crisis still answered with an exhausted pool; a sub-coach's client debits the head coach; client copy has no credit figures; the constructor param type includes `CoachAIBudgetService`. Adapt Opus's B-668-1 probe to pass a real `CoachAIBudgetService`.
  4. Push #669 once and restack #670 (merge the new #669 head, one push).
  5. When AFIX posts READY on #665, merge the new #665 head into #666 and restack upward.
- **Open Bs:** none known on #666 or #668 beyond the B-668-1 tests (code done). #669's carried B-651-1/4/5/9 and OR-115-1 are fixed only in the WIP (untested).
- **Operator decisions:**
  - Confirm the 100 USD/day ceiling. Recommended default: keep 100.
  - The owner role and coachless clients have no coach pool. Recommended default: keep, same as the gateway.
- **Flags:** unchanged; `FEATURE_ROMAN_CHAT_ENABLED` is still excluded.
- **Locks:** none held by this job; the roman lock belongs to B-ROMAN-AFIX-121.
