# AUD-OPUS-W1C-123 — Claude Opus 5.5 lens, agent 123: AI crisis routing b#736 and Roman live turns b#669 / b#670 (T4 safety)

Started 18:32 PDT 2026-10-05. All 3 verdicts were posted by 18:40:40. Done 18:42, inside the 45-minute box (19:17). All times are from `TZ=America/Los_Angeles date`.
Brief: ops/lanes123/_COMMON_123.md, plus only the "Lens pair W1C" entry in JOBS123.md.
Independence: I read only my own prior Opus reports (AUD-OPUS-AIG1-122, AUD-OPUS-RMN4-122) and the builder FIX ROUND comments. I read no Sol note, report or comment for this round, and did not open the Sol worktrees.
Claims: ops/lanes123/claims/backend-736-58a31e6f-opus, backend-669-31573c83-opus, backend-670-30f09747-opus.

## Verdicts posted (I checked each head on GitHub right before posting)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #736 | 58a31e6fb959947920e99abc0facc8b34cfdb4c0 | REQUEST CHANGES | 0/2/4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6007542496 |
| #669 | 31573c83c8aeff3536db840ceaa2e0788249dfe1 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669#issuecomment-6007575448 |
| #670 | 30f097477f1ab7ba54dec43fe048bab57972e715 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670#issuecomment-6007575593 |

Comment bodies: ops/aud-123/AUD-OPUS-W1C-123/verdict-736-58a31e6f.md, verdict-669-31573c83.md and verdict-670-30f09747.md.

## #736 (delta f2dd87ad..58a31e6f)
**The five checks the job named all pass:**
- "I took a whole bottle of Tylenol" gives 911.
- "I am going to hang myself" gives 988.
- "overdose on cardio", "can you overdose on creatine?" and "I hurt myself deadlifting, can I train?" get a normal answer.
- The 3 controls stay normal.
- The crisis check still runs first (ai.service.ts:391), before context (:406), consent (:417), the limit (:479) and the model.

All 12 phrases from my prior B-736-1 return null, all 7 from my prior B-736-2 return self_harm, and the story phrases still route.

**New Bs (both regressions this round introduced):**
- B-736-3: intent to overdose now returns null. Examples: "I want to overdose", "I am going to overdose", "I'm planning to overdose", "I might overdose tonight" and "I want to overdose and die" (10 phrases). All were emergency at f2dd87ad.
  - Cause: the narrowed overdose pattern at :85-88 matches only an overdose that has happened or is happening. My own fix rule (a) last round named only reported overdoses, and the comment says so.
  - Fix: one SELF_HARM intent line with the NOT_A_SUBSTANCE guard.
- B-736-4: a chest symptom plus "can't breathe after my run/workout/squats" now returns null (3 phrases).
  - Cause: the new training exclusion on breathing (:60-63), combined with the chest pattern at :56, whose second-symptom list has no breathing words.
  - Fix: add the breathing words to the :56 list.

Both fix lines worked on a scratch copy (p736/fixcheck-output.txt): the 13 B phrases route, and the 15 spec null cases plus the "overdose on carbs/protein" phrases stay null.

**Cs:**
- C-736-7: caffeine and heat phrases over-route.
- C-736-8: "I want to take all my pills" and "I'm going to OD" return null at both heads.
- C-736-9: "hang myself from a pull-up bar" gets 988 (edge).
- The builder's C-736-3, C-736-4 and C-736-5 stay C.

**CI and size:** 16/16 checks green; 412 lines.

**Probes:** p736/probe.js and probe2.js compare old and new side by side. Outputs are in *-output.txt.

## #669 (delta ef71cb9c..31573c83)
- safety-router.ts is byte-identical.
- Post-check, old and new side by side (p669/postcheck.js): my 13 RMN4 replies give identical results. The 4 B-669-1 wordings are now rejected, and 14 of 15 correct aggregate-word replies pass at both heads.
- Cs:
  - C-669-2: plan-slot sums ("Your planned meals add up to 1,800 kcal.") and "rest of your meals ... should come to 1,220" are now rewritten. This errs on the safe side (p669/postcheck2-output.txt).
  - C-669-3: an older over-reject, present at both heads: "Lunch was 450 kcal, so you have 1,220 kcal left today.".
- CI: 11/11 green. Lane 37396178179 at 20088519 (the #670 head plus lane files) was green: test/roman including the golden eval, plus full tsc.

## #670 (merge-only)
- Parents: exactly dc159eaf and 31573c83.
- The only non-merge commit is 31573c83.
- `git diff dc159eaf 30f09747` is byte-identical to `git diff ef71cb9c 31573c83` (patch-id 758176b1).
- The merge-tree result b8bfedac equals the head tree.
- The 5 eval file blobs are unchanged.
- 11/11 checks green.

## RD1 — b#667 @ af32412c87042f77ed3b62a3dbd6e7aa4263120e (Roman train main merge), 18:47-18:58 PDT, 20-minute box
Operator mail at 18:46. Claim: ops/lanes123/claims/backend-667-af32412c-opus. I checked the head right before posting at 18:57:35.

**Verdict: REQUEST CHANGES, A/B/C 0/0/0 on the merge content.** Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6007753559
Body: ops/aud-123/AUD-OPUS-W1C-123/rd1/verdict-667-af32412c.md. Evidence: rd1/evidence.txt, rd1/remerge-diff.txt, and the CI logs (build-and-test.log, r75.log, npmaudit.log).

**The merge itself is clean:**
- Parents are 9b525546 (tree b8bfedac, the audited #670 tree) and main 76a59216.
- The only conflict was ci.yml; both live-spec steps are kept, so the union is 4 steps.
- The four auto-merged files (.env.example, audit.service.ts, dunning-lockout.guard.ts, env-validation.ts) each carry both sides' hunks.
- Lockout behaviour: main's guard plus Roman's roman/context lock; roman/sessions* stays allowed.
- Env rules: 333 + 1 + 7 = 341, with no duplicate names.

**3 of 11 required checks are red (8 green):**
1. build-and-test: a merge interaction. Main's new test/privacy/no-pii-in-logs.spec.ts:600 pins `'src/roman/roman.service.ts': 1`. The train's roman.service.ts now logs `romanErrorTag(err)`, so the count is 0. Fix: delete that line (test-only).
2. R75: the train's specs are net +2 `as unknown as` (roman-context-a2-fixes.spec.ts:100, roman-context-core.spec.ts:44) and net +2 `as never` (roman.controller.spec.ts:445 and :458) against main. Fix: test-only.
3. npm audit: the critical proxy-addr advisory GHSA-jqcg-44mw-7w3h is red on main too, with an identical lockfile. This is an operator decision on main, not a #667 change.

**Next:** a test-only fix push (operator or builder). Then a delta re-review of only those 2 test files, with required checks green.

## RD2 — b#667 @ c5c86cb46bfe3f6ea425e255536a9ae091686580, 19:01-19:12 PDT
**Verdict: APPROVE, 0/0/0.** Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6007925076 (body: rd2/verdict-667-c5c86cb4.md).
- **ec12f3a9 (test-only, no test weakened):**
  - The PII scan keeps exact equality; the stale Roman entry is gone, so roman.service.ts is now pinned at 0.
  - Typed builders replace the 4 casts.
  - it/expect counts are unchanged.
- **c5c86cb4:** a clean main merge. Only package-lock.json changed (proxy-addr 2.0.8 from b#738), byte-identical to main; the merge-tree result equals the head tree.
- **CI:** all 11 required checks green at 19:12.

## AIG3 — b#736 @ 384314a88d2a29ed198358f9e8ea60c4ccbaea8d, 19:05-19:12 PDT
**Verdict: APPROVE, 0/0/2.** Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6007925310 (body: p736r2/verdict-736-384314a8.md; probe: p736r2/probe3.js and probe3-output.txt).
- **Closed:** B-736-3 (all 10 overdose-intent phrases now give 988) and B-736-4 (all 3 chest-plus-breathing phrases give 911). The job's 5 phrases are covered at the daily limit in ai.service.spec.
- **No regressions:** all controls stay normal, and the 15 story phrases still route.
- **Merge-only:** 384314a8 is a clean merge (tree equal, PR file blobs equal to 78ce5db8).
- **CI and size:** 11/11 checks green; 459 lines.
- **Cs:**
  - C-736-10: the literal "can't breathe" in a training question now gives 911. This errs to safety.
  - C-736-11: "can't breathe out of my nose" is now null, which is correct.

## HANDOFF
- **Done.** I created no worktree (I read code with `git show` / `git archive` into ops/aud-123/AUD-OPUS-W1C-123/p669/tree-*), pushed no ci/ or audit/ branches, ran no lane and held no locks. The main clone checkout is untouched (I ran `git fetch` by SHA only). The worktrees wt/AUD-SOL-W1C-123-* belong to the Sol lens; I did not touch them. Claims stay in ops/lanes123/claims/.
- **#736 history:** B-736-3 and B-736-4 were fixed in FIX ROUND 2 (78ce5db8) and closed in AIG3 above.
- **All items done, 19:13 PDT.**
  - #736: Opus APPROVE at 384314a8.
  - #667: Opus APPROVE at c5c86cb4.
  - #669 and #670: Opus APPROVE (both since landed into #667).
- **Merge:** the operator merges once Sol's verdicts at the same heads are in.
- **Cleanup:** none needed. I made no worktrees, branches, lanes or locks; the claims stay in ops/lanes123/claims/.
