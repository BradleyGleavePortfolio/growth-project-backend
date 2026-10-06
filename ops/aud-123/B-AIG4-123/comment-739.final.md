FIX ROUND 1 (OPENING, B-AIG4-123, agent 123) — growth-project-backend#739 @ e640e184c7a670ac8bf5baa877878e6650435cfd

Tier T4 (crisis routing). Closes C-736-8, which the operator promoted because live Roman and the AI guide are both on day 1. One commit on main e6f9a5ec. 128 changed lines: 2 source files and 4 specs.

**Normal-user story.** A client types "I want to take all my pills" to the AI guide, or "I'm going to OD" to Roman. Before this change the client got an ordinary model answer, or the daily-limit message. Now both surfaces return the fixed 988 reply before the limit, consent and the model run.

**AI guide (`src/ai/ai-crisis-router.ts`).** Added `PILLS_INTENT` to SELF_HARM. It needs all four parts:
- an intent word: want to / wanna / going to / gonna / planning to / thinking about / about to / ready to / might / trying to / urge to / tempted to / feel like / should just;
- take or swallow;
- a quantity: all (of) my/the, too many, many, a (whole) bottle/pack/box of, a handful / bunch / lot of, or 5 or more (but not "400 mg");
- pills / tablets / meds / medication / medicine / capsules / painkillers / prescriptions, or a named medicine from the list the overdose rule already uses.

"going to OD" / "gonna OD" / "want to OD" already routed to 988 on main through the B-AIG3-123 line, so that line is unchanged.

**Roman (`src/roman/guardrails/safety-router.ts`).** Roman missed every one of these sentences: the pills sentences came back normal or medical_scope, and "I'm going to OD" came back normal. Added the same `PILLS_INTENT` and the AI guide's OD intent line, with a copy of its `NOT_A_SUBSTANCE` guard so "OD on carbs" stays normal. No existing pattern changed.

**Controls that stay normal.**
- Both surfaces: "should I take my pills with food?", "I took all my vitamins", "OD on carbs", "I'm going to take 400 mg ibuprofen before my run".
- AI guide also: "overdose on cardio", "can you overdose on creatine?".

**Tests.** Every new crisis case fails on main (22 in total).
- `test/ai-crisis-router.spec.ts`: 4 pills sentences return self_harm; 6 controls return null.
- `test/ai.service.spec.ts`: the same 4 at the daily limit get the 988 reply with `crisis:self_harm` and `model_used: 'safety'`. The model, quota upsert and updateMany are never called.
- `test/roman/roman-guardrails-rb121.spec.ts`: 4 pills and 3 OD sentences return self_harm with short_circuit; 4 controls are not short-circuited.
- `test/roman/roman-streaming.spec.ts`: the same 7 with the daily cost cap reached get `ROMAN_SAFETY_TEMPLATES.self_harm`, and the model stream is never called.

**Evidence.** Single-file runs through ops/heavy.sh:
- This head: 50/50, 55/55, 117/117 and 28/28 green.
- Main's two router files with these specs: 4, 4, 7 and 7 failures, all of them the new crisis cases.
- All 53,250 string literals in src/ and test/ were run through both routers at main and at this head. Only the intended sentences change class.
- The B-AIG3-123 probe was re-run at this head: no class changed against main.

**CI at this head.** 15 checks are green and deploy-readiness-gate was skipped. The green checks include build-and-test (lint, full type-check, build and the full test suite, [run 37406042459](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37406042459)), npm audit, banned casts, CodeQL, schema parity and the live tests.

**Follow-up Cs (not fixed):**
- "I'm going to take all my pills with breakfast" now gets 988 (errs on the safe side).
- The dotted spelling "O.D." is still not routed.
- Roman still sends "overdose on cardio" to 911, unchanged from main (errs on the safe side).

READY FOR AUDIT
