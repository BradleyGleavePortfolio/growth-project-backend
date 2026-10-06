# B-RMNC2-122 — Roman C2 b#669 finish + restack C3 b#670 (agent 122 builder, Opus)

Started 17:07 PDT 2026-10-05 (times from `TZ=America/Los_Angeles date`); time box 75 min (ends 18:22). Lock: ops/lanes122/locks/roman.
Operator add-on 17:15: fix Opus A-666-3 and Sol B-666-5 in #669 (#666/#668 unchanged; the train lands as one).

## Heads
| PR | Old head | New head | Changed lines |
|---|---|---|---|
| #669 | 6386c00b2bdbb2c120a5f173dea4753574d415e8 | ef71cb9c1a5aa7c148bfdb1241830cc7a9beb9d2 (pushed 17:23:34) | 1,609 / 3,000 (vs #668 fefe73c6) |
| #670 | fb67101934becfb8536664df008129061c013dde | dc159eaf24dafafd32df4c06ed75f08971b31bbc (pushed 17:25:48) | 1,135 / 3,000 (vs #669; unchanged, pure merge) |

#669 = WIP ci/B-ROMAN-BFIX-121-669-wip @ 62f89792 + merge of #668 fefe73c6 (ef4e6f59; one conflict in reserveDailySpend,
resolved to the WIP's payload-bound reservation; the 9-cent B-668-1 pool admission from fefe73c6 kept) + fix ef71cb9c.
#670 = merge of #669 ef71cb9c (dc159eaf, clean, no other change).

## What #669 now carries
1. B-SCHED-ROMAN-115 recipe (from the WIP, now tested): payload bound + advisory-lock admission (B-651-4/5), settledUsage (B-651-1),
   neutral roman.safety_route audit (OR-115-1), no exclamation allowance in prompt/post-check (B-651-9, FR1-651-3 green), shared error
   tag, roman.prompts.ts line, disclosed T4 ci.yml step for roman-spend-admission.live.spec.ts. Dead `spendsExclamation` param removed.
2. C-668-6: `assertCoachPoolOpen` stub in roman.controller.spec.ts and roman-sse-error-contract.spec.ts mocks (the 11 red at #668);
   roman-rmn2-fixes.spec.ts harness transaction now carries aiRequestAudit + $executeRaw (the reservation runs in a locked tx).
3. B-668-1 tests (ruled into #669): test/roman/roman-c2-pool.spec.ts (real CoachAIBudgetService, stateful pool row): interrupted reply
   debits at the reserved worst case; sub-coach's client debits the head coach; used-up pool = 402 COACH_AI_BUDGET_EXHAUSTED before the
   ledger and the provider, client copy with no figures; crisis still answered, no pool read. roman.controller.spec.ts +2: 402 before
   the user turn is stored; crisis skips the pool check.
4. A-666-3 (Opus, operator add-on): safety-router.ts EMERGENCY adds named-medicine overdoses (bottle/pack/handful, 5+ or a bunch of
   Tylenol/acetaminophen/Advil/ibuprofen/Xanax/... ). "took 2 Tylenol", "Advil before a run", "bottle of water", "lots of vitamins" stay
   ordinary. Controller already skips consent/pool/limits on isSafetyShortCircuit, so these get the 911 template first.
5. B-666-5 (Sol, operator add-on): roman-post-check.ts kcalFacts: entry values validate an intake number only when the clause makes no
   whole-day claim, or names ONE meal (singular) with no summing wording (total/intake/so far/across/meals/combined/...).

## Tests (local, ops/heavy.sh, one file at a time)
- Failing-before: test/roman/roman-c2-rmn3-fixes.spec.ts at #669-pre-fix (= #668 fefe73c6 guardrails): 7 failed / 12 passed
  (5 A-666-3 crisis phrasings + 2 B-666-5 summaries; log ops/aud-122/B-RMNC2-122/rmn3-before.log). After: 19/19.
- Recipe before-specs green: roman-round2 20/20, roman-launch-hardening 58/58 (FR1-651-3 incl.), roman-guardrails-wiring 11/11,
  roman.prompts 19/19, eval/roman-golden.eval 27/27 (at #670).
- Also green: roman-streaming 21, roman.service 51, roman.controller 17, roman-sse-error-contract 12, roman-rmn2-fixes 6,
  roman-client-context-injection 4, roman-c2-pool 4, roman-guardrails 25, -round2 36, -rb121 106.
- eslint clean on changed files; scoped tsc (changed specs + roman.module graph) clean. Full tsc in the lane.

## CI
- Lane ci/B-RMNC2-122-1 run 37394100478 at #670 dc159eaf (pushed 17:27:23, 1m35s after the #670 push): full `tsc --noEmit` green;
  test/roman (all, incl. eval golden set), test/ai-consent, dunning lockout route table + guard: 30 suites passed, 762 tests passed,
  13 skipped (2 live specs, no DB in the lane), 0 failed. Log ops/aud-122/B-RMNC2-122/lane1-full.log. Branch deleted.
- PR CI #669 ef71cb9c: all checks green (CI run 37393768369: build-and-test, mwb-3-live-tests incl. the new Roman spend admission live
  spec step on real Postgres, rls-live, rls-floor-guard, community-live; Schema parity, Dependency Audit, H4, size label).
- PR CI #670 dc159eaf: all checks green (CI run 37393965007).

## Comments
- #669 FIX ROUND 1: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6006562381 (READY FOR AUDIT)
- #670 RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6006623533 (READY FOR AUDIT)
- Bodies: ops/aud-122/B-RMNC2-122/c669.md, c670.md. Notify: ops/lanes122/notify/roman-c2.txt.

## Decisions (recommended defaults)
1. #669 now carries two #666-file fixes (A-666-3, B-666-5) by operator order. Default: lenses review them on #669; #666/#668 land with
   the train unchanged.
2. Named-medicine overdose threshold: 5 or more, or a bottle/pack/handful/bunch. Default: keep ("took 2 Tylenol" is a dose).
3. C-666-7 (golden items for conservative routing) not added to #670 (pure merge keeps the restack trivial). Default: follow-up C.

## HANDOFF
- DONE 17:36 PDT: #669 pushed once (ef71cb9c), #670 restacked once (dc159eaf), lane + PR CI green at both, FIX ROUND / RESTACK comments
  posted ending READY FOR AUDIT, notify written.
- Next: lens pair delta review of #669 (FIX ROUND 1 delta incl. A-666-3 + B-666-5) and #670 (merge-only). #668's red is fixed on #669.
- Cleanup done: worktrees wt/B-RMNC2-122-{669,670} removed, local branches rmnc2-669/670 deleted, ci/B-RMNC2-122-1 deleted, lock
  locks/roman released. WIP branch ci/B-ROMAN-BFIX-121-669-wip left in place (owned by B-ROMAN-BFIX-121; now superseded by #669).
  Main clone checkout untouched.
