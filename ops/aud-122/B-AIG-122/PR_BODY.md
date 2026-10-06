## Summary
A client who has used up the day's AI guide allotment and then types a crisis message ("I want to kill myself", an overdose) got `429 AI_DAILY_QUOTA_EXCEEDED`, which the app shows as "You've used your maximum AI allotment today.", instead of 988 / 911. A client without AI consent got the consent refusal instead. Even under the limit, the message went to the model with only a "your coach is the right call" referral line.

`AiService.chat` now runs a deterministic crisis check first (`src/ai/ai-crisis-router.ts`; the patterns mirror the Roman SafetyRouter `emergency` and `self_harm` classes). A crisis message gets a fixed reply before consent, context, the daily quota and the model:
- self-harm / suicidal: 988 Suicide & Crisis Lifeline (call or text), 911 if in immediate danger;
- emergency (overdose, poisoning, chest pain, cannot breathe, stroke, anaphylaxis, collapse): call 911 now.

No quota is reserved, nothing is sent to a provider, and no analytics event or audit row is written for the turn (health data). Copy is impersonal: no first person, no contractions, no exclamation marks. Response shape unchanged (`reply`, `timestamp`, `degraded: false`); the debug-only `model` reads `safety`. The token limit itself is unchanged (separate follow-up).

Normal-user story: a struggling client who chatted a lot today types "I want to kill myself" in the AI guide and now sees the 988 / 911 message, never the limit pop-up.

## Linked plan / brief
B-AIG-122 (agent 122 job book), found by M-ROMANCAP-122 decision 3. SoT A6.4 (AI daily cap pop-up), A2 item 1 (crisis routing).

## Test plan
- `test/ai.service.spec.ts` new block "crisis reply before the daily limit (B-AIG-122)": at-cap suicidal message (smart apostrophe) -> 988, no 429, no quota rows touched, no model call, no audit row; at-cap overdose -> 911; no consent grant -> 988 instead of 403; ordinary training message at the cap still gets 429.
- Failing before: the first three fail on main (429 / 429 / 403); all 35 pass with the fix (targeted jest via heavy.sh).
- R75 staged check: no net new banned tokens. eslint clean on the three files.

## Rollback plan
Revert this PR; the AI guide returns to the previous behaviour.

## Audit pack pointer
ops/reports/B-AIG-122.md

---

## R-rule self-check
- [x] **Size:** 213 changed lines (147 source incl. comments, 66 test), under 1,500.
- [x] **R18 lane scope:** AI guide chat only.
- [x] **R75 banned cast tokens:** zero net new.
- [ ] **R74 test:src ratio:** N/A under the owner RUTHLESS SCOPE rule (tests only for the fix); 0.45.
- [x] **R92 RLS impact:** none.
- [x] **R98 PII statement:** reads the message text in memory only; nothing stored, logged or sent for a crisis turn.
- [x] **R82 + R106 migration safety:** no migrations.
- [x] **R83 feature flag:** N/A, safety routing must always be on.
- [x] **R3 commit identity:** Bradley Gleave <bradley@bradleytgpcoaching.com>, no AI co-author.
- [ ] **R14 audit cycle:** pending dual lens.

## Dependencies
None. Based on main a70533d5. Independent of the Roman stack; once Roman lands, both surfaces should share one pattern list (follow-up C).

## Notes for auditor
T4 health safety. Read `src/ai/ai.service.ts` chat() top (the early return) and `src/ai/ai-crisis-router.ts`. The controller burst throttle (20 requests / hour) still applies before the service; the daily quota bites far earlier in practice, so it is noted as a C.
