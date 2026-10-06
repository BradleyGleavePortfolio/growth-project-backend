# B-CRISIS2-123 — Builder (Claude Opus 5.5), agent 123: F9 "not breathing" and OD spellings must route to 911 (safety)

Started 09:27:56 PDT 2026-10-06 (time box 30 min, ends 09:57:56). Brief: ops/lanes123/_COMMON_123.md + WAVE 4 preamble + my JOBS123.md entry F9 only; background ops/reports/B-ROMAN911-123.md, AUD-OPUS-R3D-123.md, AUD-SOL-R3D-123.md. SoT pulled; A1, A2 overrides 1-11, A5 rules 11-12 read.
Worktree: /home/user/workspace/wt/B-CRISIS2-123-1 (from main e9b82e13, branch agent123/crisis-not-breathing).

## PR
- growth-project-backend#758 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758
- Head 905bff9f5361e8ce94d1863c31e2395a41f03b5f (one commit on main e9b82e13, one push 09:37). Author/committer Bradley Gleave, no co-author.
- Size 175 changed lines (src/ai/ai-crisis-router.ts 49+/8-, new test/crisis-router-not-breathing.spec.ts 118).
- Body: ops/aud-123/B-CRISIS2-123/pr-body.md.

## What was wrong at main e9b82e13 (probe ops/aud-123/B-CRISIS2-123/probe.js, crisis.txt, gym.txt)
- Not 911 on either surface: "my teammate passed out and is not breathing" (Roman medical_scope), "he's/she's not breathing", "my teammate is not breathing", "unconscious and not breathing", "she won't wake up", "my friend won't wake up", "she's not waking up", "my friend ODed", "my brother OD'ed", "he O.D.", "my friend O.D.'d", "she O.D.ed".
- 911 for gym talk: "I can't breathe during burpees" (B-AIG3-123 made explicit inability 911 everywhere), "he is odd" / "I have odd soreness after leg day" (old `od'?d` token matched "odd").
- Already 911 on main: "overdosed" and "OD'd" with a person, "he's ODing" (kept as guards).

## Change (src/ai/ai-crisis-router.ts only; Roman shares the list since b#744)
1. Not breathing: `(not|isn't|aren't|wasn't|stopped|has stopped|stops) breathing` unless a form word follows (properly, right, during, between, through, on, at, ...).
2. Won't wake up: he/she/they/someone/somebody/PERSON_NOUN (my/a/the + friend, teammate, baby, ...) + won't / will not / can't / is not / not + wake/waking up, or "and won't/isn't wake up"; not when followed by early, on time, for, to, before, at, until, by, when, in the, anymore.
3. OD_VERB token (overdosed, ODed, OD'd, OD'ed, O.D., O.D.'d, O.D.ed, ODing, OD'ing; never "odd") in the PERSON rule; OD_VERB_MARKED (apostrophe/dotted forms) in the no-person B-744-1 rule; new rule for bare forms after someone named by role ("my teammate ODed", "a guy at my gym ODed"); "possible O.D." in the noun rule.
4. "can't breathe during/while <ACTIVITY>" excluded from the explicit-inability rule; "please help" / "help me" added to the help-now rule so Sol's b#736 phrase "I can't breathe during my workout. Please help me." stays 911. "after my workout" alone still 911.

## Tests / evidence (ops/aud-123/B-CRISIS2-123/)
- New spec 64 cases on both routers; spec-vs.js runs it against main copies (main/): spec-vs-main.txt 31 pass / 33 fail (every crisis and now-normal phrase red; all 31 guards green); spec-vs-head.txt 64/64.
- jest via heavy.sh (jest-*.txt): new spec 64/64, ai-crisis-router 50/50, crisis-router-gym-talk 122/122, ai.service 58/58, roman-guardrails 25/25, rb121 117/117, round2 36/36, c2-rmn3 28/28, launch-hardening 58/58, golden.eval 27/27, streaming 31/31, roman-round2 20/20, c2-pool 4/4, guardrails-wiring 11/11. Prettier + eslint clean.
- corpus.js -> corpus-output.txt: 53,558 literals (src/, test/, b#744 phrase files): no existing literal changes class (6 changes, all phrases quoted in my own code comments).

## Operator decisions
1. "I can't breathe during burpees" moves 911 -> normal (brief lists it as a gym control; B-AIG3-123 had made it 911). With help words or a chest symptom it is still 911; "I can't breathe after my workout" still 911. Recommended default: keep as built.
2. main is red on two required checks (booking-lock-screen-push.spec.ts date fixture; npm audit shell-quote GHSA-pqg4-j6r4-53mv), so no backend PR can merge. Recommended default: one operator fix PR on main (move the fixture dates forward relative to a fixed clock; bump shell-quote in the lockfile, as op123/proxy-addr-2.0.8 did), then refresh b#758 (A5 rule 12 tree check carries verdicts).

## Cs (not fixed)
- C (edge, deferred to 10k clients): "my friend Oded ..." (the name) routes to 911 because "my friend" + "oded"; errs to safety.
- C: "my son is not breathing normally/right" stays non-911 (same as main; form-word exclusion).
- C: "I want to O.D." (dotted intent spelling) not added to the 988 intent rule (not in the brief).

## CI at 905bff9f (run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37497191461)
- Green: lint, type-check, build (build-and-test steps), danger, CodeQL, schema parity, R100 banned casts, SBOM, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, size-label, deploy readiness; deploy-readiness-gate SKIPPED.
- build-and-test Test step FAILURE: 875 suites / 15,407 tests pass (incl. the new spec and every crisis/Roman spec); the 1 failure is test/booking-lock-screen-push.spec.ts ("today" vs fixture "tomorrow", date-bound fixture, AT = 2026-10-06T17:00Z). main e9b82e13 fails the same test (job https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37494141389/job/112374203140). Not this PR. Log: ops/aud-123/B-CRISIS2-123/build-and-test-905bff9f.log.
- npm audit (required) FAILURE repo-wide: critical shell-quote GHSA-pqg4-j6r4-53mv, no exception; main e9b82e13 Dependency Audit run 37494141350 fails the same. Annotations: ops/aud-123/B-CRISIS2-123/npm-audit-905bff9f-annotations.txt.
- No ci-lane run used; no re-trigger pushes.

## Comment
- FIX ROUND 1 (OPENING) posted 09:48 after verifying the head: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758#issuecomment-6021075055 (body ops/aud-123/B-CRISIS2-123/comment-758.md), ends READY FOR AUDIT.


## FIX ROUND 2 (10:04-, operator mail; time box 20 min, ends 10:24)
- Lenses at 905bff9f: Opus REQUEST CHANGES B-758-1 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758#issuecomment-6021114167), Sol APPROVE 0/0/5 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758#issuecomment-6021123232). Operator ruling: remove the "during/while <activity>" exclusion entirely; every "can't breathe" routes to 911 as on main; "I can't breathe during burpees" -> 911 accepted (decision 1 closed).
- Operator merged main into the PR branch (e8d6a027, includes #759 CI unblock). Worktree /home/user/workspace/wt/B-CRISIS2-123-2 from e8d6a027.
- New head b9ba736ce9ea3adfe49d6d79a7142193bdd73cd9 (one commit on e8d6a027, fast-forward push 10:05). Breathing rules + help-now rule restored byte-identical to main; not-breathing / won't-wake-up / OD rules kept. PR size 177 lines vs main.
- Spec 73 cases (+9 B-758-1 phrases, burpees x2 moved to 911): spec-vs-r2-main.txt 42/31, spec-vs-r2-r1.txt 62/11 (exactly the 11 B-758-1 + burpees cases red at 905bff9f), spec-vs-r2-head.txt 73/73. jest-r2-*.txt all green (8 specs). corpus-r2-output.txt: no breathe phrase changes class vs main.
- Comment body: ops/aud-123/B-CRISIS2-123/comment-758-r2.md.
- CI at b9ba736c: SUCCESS=15, SKIPPED=1 (deploy-readiness-gate); npm audit green; build-and-test SUCCESS 876 suites / 15,417 tests (run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37500867629, log build-and-test-b9ba736c.log).
- FIX ROUND 2 comment posted 10:18 after verifying the head: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758#issuecomment-6021586441, ends READY FOR AUDIT.


## HANDOFF (round 1, superseded)
- Done 09:49 PDT, inside the 30-minute box (09:27:56-09:57:56). b#758 head 905bff9f5361e8ce94d1863c31e2395a41f03b5f (one commit, one push), FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT. Open Bs from my side: 0 (B-F9-1 not breathing, B-F9-2 won't wake up, B-F9-3 ODed/OD'ed/O.D. spellings fixed; each phrase red on main per spec-vs-main.txt).
- Next step (operator): both T4 lenses at 905bff9f (1 source file + 1 spec, 175 lines). Fix the two main-wide red required checks before merge (decision 2). Decision 1 (burpees) default keep.
- Notify: ops/lanes123/notify/B-CRISIS2-123.txt. Worktree /home/user/workspace/wt/B-CRISIS2-123-1 removed (all work pushed; HEAD == origin). No ci/* or audit/* branches created; no locks or claims held.
- Evidence: ops/aud-123/B-CRISIS2-123/ (probe.js + crisis.txt + gym.txt, spec-vs.js + spec-vs-main.txt / spec-vs-head.txt, corpus.js + corpus-output.txt, jest-*.txt, eslint.txt, main/ router copies, CI logs).
- Not mine: merge, deploy, main CI fixes.

## HANDOFF
- Round 2 done 10:18 PDT, inside the 20-minute box (10:04-10:24). b#758 head b9ba736ce9ea3adfe49d6d79a7142193bdd73cd9 (one fast-forward push on the operator's main merge e8d6a027), CI green, FIX ROUND 2 comment posted, READY FOR AUDIT. Open Bs from my side: 0 (B-758-1 fixed per operator ruling).
- Next step (operator): both lenses delta re-review e8d6a027..b9ba736c (src/ai/ai-crisis-router.ts breathing rules restored to main; spec +9 cases). Sol approved 905bff9f; Opus B-758-1 is the only open item.
- Notify updated: ops/lanes123/notify/B-CRISIS2-123.txt. Worktrees B-CRISIS2-123-1 and -2 removed (all work pushed); local helper branch agent123/crisis-not-breathing-r2 deleted. No ci/* or audit/* branches; no locks or claims held.
- Not mine: merge, deploy.
