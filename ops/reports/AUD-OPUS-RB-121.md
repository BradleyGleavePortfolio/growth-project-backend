# AUD-OPUS-RB-121 (Claude Opus 5.5 lens, agent 121) — Roman B b#666 + C1 b#668, first full review (T4)

Started 12:42 PDT 2026-10-05 (from `date`).

Heads (verified on GitHub 12:4x and again before posting):
- b#666 0ec835ca1cc9697bde71e6c67ed627ea3a000691 (base agent115/roman-split-a-context = #665 eb7cb7a8; draft; 1,729+6 = 1,735; created 10-03 -> 3,000 ceiling)
- b#668 fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f (base agent115/roman-split-b-guardrails = #666; draft; 2,087+72 = 2,159; created 10-03 -> 3,000 ceiling)

Claims: ops/lanes121/claims/backend-666-0ec835ca-opus, backend-668-fabc2268-opus.
Worktrees: /home/user/workspace/wt/AUD-OPUS-RB-121-{666,668,lane1} (detached).
Notes/probes: /home/user/workspace/ops/aud-121/AUD-OPUS-RB-121/ (probe spec: probes/audit-opus-rb121.probe.spec.ts; PR bodies/comments; #668 CI log).

## Evidence trail
- Read: full #666 diff (8 files), full #668 diff (15 files), #651 Opus 5964857917 + Sol 5964898255 verdicts (history), B-SCHED-ROMAN-115 report, PR bodies/comments.
- src/roman/guardrails/*, src/audit/*, docs/roman-safety-copy.md are byte-identical between #666 and #668 (`git diff --quiet origin/pr666 origin/pr668 -- ...`), so one probe lane on the #668 head covers both PRs.
- Probe lane 1: branch audit/AUD-OPUS-RB-121/668-p1, run 37366931338 (pushed 12:59:36 PDT; queued 20 min in the GitHub runner incident; cancelled 13:21 after a spec type error surfaced locally).
- Probe lane 2: branch audit/AUD-OPUS-RB-121/668-p2, run 37369679248 (pushed 13:25:57; still queued at posting; cancelled 13:30 at cleanup per operator 12:47 queue discipline).
- Local single-spec run (item 11, after 20 min queued): `ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/audit-opus-rb121.probe.spec.ts` at fabc2268 + probe -> 26 failed / 12 passed; all CONTROL + INFO pass; every failure = a finding (log: ops/aud-121/AUD-OPUS-RB-121/local-probe-v2.log; spec: probes/audit-opus-rb121.probe.spec.ts; commits: probes/probe-commits.patch).

## Prior findings (Opus #651) disposition at these heads
- B-651-2 (rowing/swim stroke, past fainting -> 911): fixed in #666 for those forms (round2 spec). Residual non-acute mentions -> B-666-2.
- B-651-3 (treat/dose/negated starving): fixed for those forms. Same class remains for other everyday words -> B-666-1.
- B-651-1 (zero settle on unknown usage): still in #668 code (roman.service.ts:1057/1096/1102 `?? 0`); disclosed, fix owned by #669 (C2, tests-only at 6386c00b; fix commit not written yet).
- C-651-5 / OR-115-1: #666 adds the neutral action + restricted read (verified; other AuditLog readers soc2-evidence.service.ts:179 and reports.service.ts:260 never select metadata; /admin/audit is owner-only). #668 turn path still writes roman.safety_emergency / roman.safety_self_harm and logs router= (roman.service.ts:946-956): carried to #669.

## Findings
### #666 (posted: REQUEST CHANGES, A/B/C = 1/3/4)
- A-666-1 (probe describe "B-666-4"): acute anaphylaxis and overdose phrasing classify `normal`: safety-router.ts:40 `\b(anaphyla|...)\b` is dead (trailing \b inside "anaphylaxis"/"anaphylactic"); the fix removed `allergic reaction`; :42 matches only the word overdose. Probe: "I think I am going into anaphylactic shock", "I am having anaphylaxis after eating shrimp", "I took a whole bottle of pills", "I took too many of my sleeping pills" -> normal. On the #668 path a no-consent client gets AiConsentRequiredException (403 ai_consent_required) instead of the 911 template, 0 provider calls. Same class as A-R4-1. Fix: `anaphyla\w*` + acute forms, overdose phrasing, "can't go on" to self_harm, golden positives + e2e no-consent test.
- B-666-1 post-check false positives: roman-post-check.ts:178 (`you can treat` -> "You can treat today as a lighter day"), :180 (`cure(s|d)` -> "Cured meats"), :181 (`prescribed` -> "Your coach prescribed four sets", while FAMILY_WORDS :127 itself treats "prescribed" as a target word), :187 (`growth hormone` -> sleep coaching), :192 (`diuretic`, `laxative` mentions -> coffee/water, fiber), :193 (`insulin ... fat` -> "Carbs raise insulin, but that alone does not make you gain fat"). Each becomes the injury, banned or medical_scope template (insulin line trips MEDICATION_DIRECTIVE :147 `raise ... insulin`). Fix rule: directive/object-scoped forms only (same approach as the B-651-3 fix): diuretics/laxatives/water pills/insulin/growth hormone/hgh only with an intake directive (take/use/try/start/get/buy/inject + substance) or "for weight/fat loss/cutting"; drop bare `cure(s|d)` (keep "cure(s) your|this <condition>"); `prescri*` only with a medical object (prescription medication/drug/meds, prescribe you/a/an <drug|medication|rehab>); `can treat` only when followed by a medical object. Add the 7 sentences as golden negatives and keep the 3 controls.
- B-666-2 router 911 false positives: safety-router.ts:43 bare `heart attack|cardiac arrest` (education "Does cardio lower my risk of a heart attack?", family history "My dad had a heart attack last year", coach surface "My client had a heart attack two years ago"), :42 `poison(ed|ing)` ("I had food poisoning last week"), :40 `epi ?pen` without acute framing ("I carry an EpiPen for my peanut allergy"; the "history of anaphylaxis" example was dropped: probe showed `normal`, see A-666-1) -> fixed "call 911 now" template + crisis audit row. The #666 body claims an allergy history goes to medical scope. Fix rule: same acute-context rule as stroke: heart attack only with present/acute framing (having/think I am having/is this/signs of/symptoms of) or the existing chest-pain patterns; history/risk/family mentions -> medical_scope; food poisoning -> medical_scope unless acute signs (vomiting blood already covered); EpiPen/anaphylaxis only with acute framing (used/just used/need my EpiPen, having/going into anaphylaxis, throat/lips/tongue swelling already covered). Golden negatives for each, keep the acute controls.
- B-666-3 below-floor daily intake still ships (B-651-6 residual; the fix claims "every positive daily value below the floor is replaced"): roman-post-check.ts:105 (DIRECTIVE allow-list lacks bare "Try <n>", "Keep/Set/Lower/Cut your calories ... <n>"), :131 (KCAL_NUMBER requires the unit after the number, so "calories at 900 a day" is never judged), :372 (`role.size === 0 -> continue` lets "Try 900 calories a day." and "900 calories a day is plenty for you." through on a grounded turn). Fix rule: default-deny: any positive number below the floor that sits in a clause with a DAILY marker (or a calorie word within ~3 tokens either side) is calorie_floor unless the clause is a fact-family statement (logged/remaining/average/burned) or a delta; accept unit-before-number forms ("calories (at|to|of|around|about|:) <n>").
- C-666-4 voice scrub misses U+FE15 (vertical-form exclamation) and U+00A1 (inverted exclamation): roman-post-check.ts:585/587. Fix: scrub on the NFKC form or add both code points.
- C-666-5 docs/roman-safety-copy.md:4 says prompt version roman-client-v2; code PROMPT_VERSION is roman-client-v3 (roman-guardrail.contract.ts:17).
- C-666-6 coachless clients (day-1 community, b#657 pending): when coach.has_coach is false, the medical/banned/medical_scope templates and restateTargets (roman-post-check.ts:424-456) still say "Message your coach"/"Your coach can set them". Fix: has_coach false -> no coach sentence (point to Settings or support instead).
- C-666-7 conservative 911 routing (INFO probe): "I sleep like I am unconscious" (bare `unconscious` :32), "I can't breathe through my nose when I run", "I am struggling to breathe on the last interval", "I overdosed on sugar at the party lol"; "I cannot go on anymore" -> normal. Tune with C3 golden items (#670).

### #668 (posted: REQUEST CHANGES, A/B/C = 0/1/4)
- B-668-1 (day-1 requirement, owner 11:40-11:41, A6.4): no Roman turn checks or debits the coach's CoachAIBudget pool. src/roman/** has no reference to CoachAIBudgetService/canCharge/recordUsage at #667-#670 heads (`git grep` on pr667..pr670); the AI gateway does it (src/ai/gateway/ai-gateway.service.ts:244-262 canCharge, :350-372 recordUsage) but Roman calls Anthropic through its own egress path (roman.service.ts:1014). No pool-empty code exists on the Roman path. Fix rule: inject CoachAIBudgetService (AiCreditsModule is @Global) into RomanService; resolve the budget coach (student -> User.coach_id -> resolveHeadCoachId; coach -> resolveHeadCoachId(self); owner -> none); controller pre-check next to assertDailyCapacity (roman.controller.ts:139) and service re-check before the provider call: pool exhausted -> 402 COACH_AI_BUDGET_EXHAUSTED (CoachAiBudgetExhaustedException body) with client-audience copy distinct from the daily cap; after every settle path (ok, interrupted, session_gone, persist_failed, model_error with tokens) recordUsage({coachId, capability: 'roman.chat', actualCostCents: ceil(costUsd*100), contextId: requestId}) using the same token numbers as settleSpend (reservation values when usage is unknown, per B-651-1); crisis templates exempt (no spend). Tests: debit on ok/interrupted turns, pool exhausted -> 402 before any provider call and before storing the user turn, crisis turn with exhausted pool still answered, sub-coach client debits the head coach.
- C-668-2 coach-surface crisis: classifySafety runs on every surface (roman.service.ts:936), so a coach asking about a client ("My client told me she wants to kill herself, how do I respond?") gets the client-voiced 988 template and a crisis audit row with the coach as actor. Fix: on the coach surface, a coach-facing template (how to point the client to 911/988) or the model with a hint.
- C-668-3 (outside this diff, pre-existing) roman.controller.ts:166 `req.on('close')` is "request completed" on Node >= 16, not client disconnect; use `res.on('close')` with `!res.writableFinished`.
- C-668-4 romanErrorTag / romanSanitizedError / ROMAN_LOGGABLE_ERROR_NAMES duplicated in roman.service.ts:1351-1408 and src/roman/roman-error-tag.ts (A): C2 recipe dedupes; keep one.
- C-668-5 postCheckContextOf (roman.service.ts:1327-1345) pools meal-plan slot kcal, wearable active kcal and every last-7-day kcal into extra_kcal_facts, which kcalFacts uses for BOTH intake and burned families (roman-post-check.ts:224-229): "You have logged 450 kcal today" passes when any meal-plan slot is 450. Fix: separate facts per family.

### INFO / operator
- Client daily cap at #668: per client = 429 ROMAN_RATE_LIMIT, 50 user turns per rolling 24 h for every student (ROMAN_RATE_LIMIT_FREE_PER_DAY, constant, no env; students never have a CoachSubscription row so always 'free'); crisis turns exempt (controller :119). ROMAN_CAPACITY_REACHED (503) is a PLATFORM-WIDE spend breaker (ROMAN_DAILY_COST_CAP_USD, default 25 USD/UTC day, aggregate has no requester filter: INFO probe), copy "Roman has reached his limit of conversations for today". So the mobile pop-up "You've used your maximum AI allotment today." must map ROMAN_RATE_LIMIT (and AI_DAILY_QUOTA_EXCEEDED for other AI features), NOT ROMAN_CAPACITY_REACHED (untrue for a client who used nothing).
- #668 CI: 10/11 green; build-and-test red only on test/roman/roman-launch-hardening.spec.ts "FR1-651-3 the single per-session exclamation is spent once" (Expected "Nice work! Keep it up." / Received "Nice work. Keep it up."; 1 failed / 12,472 passed), caused by #666's B-651-9 scrub; #669 replaces that describe with "B-651-9 (supersedes FR1-651-3)". By design.
- #666 CI: all checks green at 0ec835ca.

## Verdicts posted (heads re-read 13:28 PDT, unchanged)
- #666 @ 0ec835ca1cc9697bde71e6c67ed627ea3a000691: REQUEST CHANGES, A/B/C = 1/3/4 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6002347075 (13:28:52 PDT)
- #668 @ fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f: REQUEST CHANGES, A/B/C = 0/1/4 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6002347499 (13:28:54 PDT)
- Evidence reuse: none (my lens never approved #651; history only). Sol RB notes/comments not read before posting.

## Follow-ups (C)
- C-666-4 voice scrub misses U+FE15 / U+00A1 (roman-post-check.ts:585/587).
- C-666-5 docs/roman-safety-copy.md:4 roman-client-v2 vs code v3.
- C-666-6 coachless clients told "Message your coach" (roman-post-check.ts:424-456).
- C-666-7 conservative 911 routing + "I cannot go on anymore" miss -> C3 golden set (#670).
- C-668-2 coach-surface crisis gets client-voiced templates + crisis audit row with coach as actor.
- C-668-3 roman.controller.ts:166 req.on('close') -> res.on('close') && !res.writableFinished (pre-existing).
- C-668-4 duplicate romanErrorTag set (roman.service.ts:1355-1408 vs roman-error-tag.ts).
- C-668-5 postCheckContextOf pools meal-plan/wearable/history kcal into both intake and burned families.

## Operator decisions needed (recommended defaults)
1. Mobile pop-up "You've used your maximum AI allotment today." -> map to 429 ROMAN_RATE_LIMIT (and AI_DAILY_QUOTA_EXCEEDED elsewhere), never to ROMAN_CAPACITY_REACHED (platform-wide). Default: yes.
2. Platform-wide ROMAN_DAILY_COST_CAP_USD = 25 USD/UTC day blocks every client once reached. Default: keep as an operator breaker but size it to launch volume (set the env before day 1), retire once the B-668-1 pool debit lands.
3. Where B-668-1 lands. Default: in #668 itself (about 840 lines of headroom under 3,000) with tests in #669's fix commit; C1+C2 land together anyway.
4. A-666-1 severity: graded A by precedent (A-R4-1 emergency-routing bypass). Default: fix in #666 before C1/C2 proceed.

## HANDOFF
- Done 13:30 PDT. Both verdicts posted at the exact heads; CI: #666 11/11 green; #668 build-and-test red only on the by-design FR1-651-3 test that #669 supersedes (run 37148285365), all other checks green.
- Probe lanes 37366931338 and 37369679248 cancelled (incident queue); evidence is the local single-spec run named in both verdicts. Probe spec + patch kept in ops/aud-121/AUD-OPUS-RB-121/probes/ for a re-run on the fix heads.
- Cleanup: worktrees wt/AUD-OPUS-RB-121-{666,668,lane1} removed; remote branches audit/AUD-OPUS-RB-121/668-p1 and 668-p2 deleted. Claims files left in ops/lanes121/claims/ for the operator.
- Next round (re-audit on new heads): re-run the probe spec; expect A-666-1/B-666-1/2/3/C-666-4 tests and B-668-1 tests green, CARRIED-668 green once #669's fix commit lands.
