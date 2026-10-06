FIX ROUND 1 (OPENING, B-AIG-122, agent 122) — growth-project-backend#736 @ f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5

READY FOR AUDIT (T4 health safety; new PR on main a70533d5; 213 changed lines, under 1,500).

**Problem (M-ROMANCAP-122 decision 3).** A client who has used up the day's AI guide allotment and then types a crisis message got 429 AI_DAILY_QUOTA_EXCEEDED ("You've used your maximum AI allotment today.") instead of 988 / 911; a client without AI consent got the consent refusal. Normal-user story: a struggling client who chatted a lot today types "I want to kill myself" in the AI guide and must see 988 / 911, never the limit pop-up.

**Fix.**
- src/ai/ai-crisis-router.ts (new): `classifyAiGuideCrisis()` -> emergency | self_harm | null, smart punctuation normalized; patterns mirror the Roman SafetyRouter emergency + self_harm classes (Roman stack, not on main). Fixed impersonal replies: 988 Suicide & Crisis Lifeline (call or text) + 911 if in immediate danger; emergencies (overdose, poisoning, chest pain, cannot breathe, stroke, anaphylaxis, collapse) -> call 911 now. No first person, no contractions, no exclamation marks.
- src/ai/ai.service.ts `chat()`: the crisis check is the first statement; a crisis turn returns the fixed reply (`model_used: 'safety'`, `degraded: false`) before consent, context, `reserveDailyTokens` and the model. No quota reserved, nothing sent to a provider, no analytics event or audit row (health data). Response shape unchanged.
- Daily token limit unchanged (separate operator follow-up).

**Proof.**
- test/ai.service.spec.ts, block "crisis reply before the daily limit (B-AIG-122)": at-cap suicidal message -> 988, no 429, quota rows untouched, no model call, no audit row; at-cap overdose -> 911; no consent -> 988 instead of 403; ordinary training message at the cap still 429.
- Failing before: the first three fail on main (429 / 429 / 403); 35/35 pass with the fix.
- CI lane (targeted, test/ai.service.spec.ts): success https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393636969
- PR CI at this head: all 16 check runs green (1 skipped by design: deploy-readiness-gate), incl. build-and-test, R75 banned casts, danger, CodeQL.

**Cs (follow-up).**
- C: the controller burst throttle (20 requests / hour) still answers 429 before the service; the daily quota bites far earlier in practice. Follow-up: skip the throttle for crisis turns.
- C: two crisis pattern lists (AI guide + Roman); share one once the Roman stack is on main.
