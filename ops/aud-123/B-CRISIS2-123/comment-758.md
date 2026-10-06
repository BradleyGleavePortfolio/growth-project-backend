FIX ROUND 1 (OPENING) (B-CRISIS2-123, agent 123) — growth-project-backend#758 @ 905bff9f5361e8ce94d1863c31e2395a41f03b5f

T4 safety, one source file (src/ai/ai-crisis-router.ts, the 911 list Roman shares since b#744) + one new spec. 175 changed lines.

## What this fixes (each a crisis routing miss in normal use)
- B-F9-1: a client whose teammate collapses types "my teammate passed out and is not breathing" and gets a normal Roman answer (medical_scope) instead of "call 911 now". Same for "he's not breathing", "she's not breathing", "unconscious and not breathing". Now 911 on both surfaces.
- B-F9-2: a client types "she won't wake up" / "my friend won't wake up" and gets a normal answer. Now 911 on both.
- B-F9-3: a client types "my friend ODed", "my brother OD'ed", "he O.D." or "my friend O.D.'d" and gets a normal answer ("OD'd" and "overdosed" already routed). Now 911 on both.
- Also: "I can't breathe during burpees" and "I have odd soreness after leg day" got the 911 template (the old `od'?d` token matched "odd"). Now normal.

## Change
1. Not breathing: `not / isn't / stopped breathing` unless a form word follows ("not breathing properly during squats", "between reps", "through my mouth").
2. Will not wake up: he / she / they / someone / a person named by role (my friend, my teammate, the baby, ...) + won't / is not / can't wake up, or "... and won't wake up". "I can't wake up early", "he won't wake up for morning cardio", "my legs won't wake up" stay normal.
3. One `OD_VERB` token (overdosed, ODed, OD'd, OD'ed, O.D., O.D.'d, O.D.ed, ODing, OD'ing; never "odd") in the person rule; apostrophe/dotted forms also with no listed person (as OD'd was); bare "ODed" after someone named by role; "possible O.D.". The `on cardio` / `on creatine` guard is unchanged.
4. "can't breathe during / while <training activity>" is a training remark. "I can't breathe" alone, "after my workout", any chest symptom, or "please help" / "help me" / "help now" still give 911 (Sol's b#736 phrase "I can't breathe during my workout. Please help me." stays 911).

## Tests
- New test/crisis-router-not-breathing.spec.ts, both routers (AI guide null/emergency; Roman class + short_circuit): 64 cases. Run against main e9b82e13: 33 fail (14 not-breathing / will-not-wake, 15 OD spellings, 4 gym phrases that were 911), 31 guards pass. At this head 64/64.
- Router and wiring specs green locally, one at a time through heavy.sh: ai-crisis-router 50/50, crisis-router-gym-talk 122/122, ai.service 58/58, roman-guardrails 25/25, rb121 117/117, round2 36/36, c2-rmn3 28/28, launch-hardening 58/58, golden.eval 27/27, streaming 31/31, roman-round2 20/20, c2-pool 4/4, guardrails-wiring 11/11. Prettier and eslint clean.
- Corpus: every string literal in src/ and test/ plus the b#744 phrase files (53,558 strings), main vs head: no existing literal changes class.

## CI at 905bff9f
- Green: lint, type-check, build (in build-and-test), danger, CodeQL, schema parity, R100 banned casts, SBOM, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, size-label, deploy readiness; deploy-readiness-gate SKIPPED as usual. Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37497191461
- build-and-test Test step: 875 suites / 15,407 tests pass, including the new spec and every crisis/Roman spec; 1 failure, test/booking-lock-screen-push.spec.ts ("Your session is today" vs fixture "tomorrow", a date-bound fixture). main e9b82e13 fails the same test in its own CI (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37494141389/job/112374203140). Not this PR.
- npm audit (required) FAILS repo-wide: critical shell-quote GHSA-pqg4-j6r4-53mv has no exception; main e9b82e13 fails the same gate (Dependency Audit run 37494141350). Not this PR; no lockfile change here.
- So two required checks are red at this head for main-wide reasons; both need an operator fix on main, then a refresh of this PR.

## Operator decision
1. "I can't breathe during burpees" moves from 911 to normal (the F9 brief lists it as a gym control; B-AIG3-123 had made explicit inability 911 everywhere). With help words or a chest symptom it is still 911, and "I can't breathe after my workout" is still 911. Recommended default: keep as built.

## Cs (not fixed)
- C (edge, deferred to 10k clients): "my friend Oded ..." (the name) routes to 911; errs to safety.
- C: "my son is not breathing normally" stays non-911, as on main (form-word exclusion).
- C: dotted intent "I want to O.D." not added to the 988 intent rule (not in the brief).

READY FOR AUDIT
