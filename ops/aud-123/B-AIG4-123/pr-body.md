**Tier: T4 (safety / crisis routing).** Both lenses at the exact head before merge.

## Summary
Closes C-736-8 (both lenses on b#736), promoted by the operator because live Roman and the AI guide are both on day 1.

Normal-user story: a client types "I want to take all my pills" to the AI guide, or "I'm going to OD" to Roman, and got an ordinary model answer (or the daily-limit message) instead of the 988 reply. Both now get the fixed 988 reply before the daily limit, consent and the model.

- `src/ai/ai-crisis-router.ts`: new `PILLS_INTENT` in SELF_HARM. Intent words (want to / wanna / going to / gonna / planning to / thinking about / about to / ready to / might / trying to / urge to / tempted to / feel like / should just) + take / swallow + all (of) my/the, too many, many, a (whole) bottle/pack/box of, a handful / bunch / lot of, or 5+ (not "400 mg") + pills / tablets / meds / medication / medicine / capsules / painkillers / prescriptions or a named medicine (same list as the existing named-medicine overdose rule). The OD intent line from B-AIG3-123 already routes "going to OD" / "gonna OD" / "want to OD" on main; unchanged.
- `src/roman/guardrails/safety-router.ts`: Roman missed every sentence (pills -> normal or medical_scope, "I'm going to OD" -> normal). Added the same `PILLS_INTENT` and the AI guide's OD intent line with the same `NOT_A_SUBSTANCE` guard (copied), so "OD on carbs" stays normal. No other pattern changed.

Controls that stay normal (both surfaces): "should I take my pills with food?", "I took all my vitamins", "OD on carbs", "I'm going to take 400 mg ibuprofen before my run"; AI guide also "overdose on cardio", "can you overdose on creatine?".

## Tests (each new crisis test is red on main e6f9a5ec, 22 in total)
- `test/ai-crisis-router.spec.ts`: 4 pills sentences -> self_harm; 6 controls -> null.
- `test/ai.service.spec.ts`: the 4 pills sentences at the daily limit -> 988 reply, `crisis:self_harm`, `model_used: 'safety'`, no model call, no quota upsert/updateMany.
- `test/roman/roman-guardrails-rb121.spec.ts`: 4 pills + 3 OD sentences -> self_harm, short_circuit; 4 controls not short-circuited.
- `test/roman/roman-streaming.spec.ts`: the same 7 sentences with the daily cost cap reached -> `ROMAN_SAFETY_TEMPLATES.self_harm`, no model stream.

Local single-file runs (ops/heavy.sh): 50/50, 55/55, 117/117, 28/28 green; with main's two router files: 4, 4, 7, 7 failures (only the new crisis cases). A scan of all 53,250 string literals in src/ and test/ through both routers (main vs this head) changes only the intended sentences.

## Size
128 changed lines (2 source files, 4 specs). No lockfile, no new casts, no empty catches.

## Follow-up Cs (not fixed)
- "I'm going to take all my pills with breakfast" now gets 988 (errs to safety).
- "I'm going to O.D." (dotted) is still not routed.
- Roman sends "overdose on cardio" / "can you overdose on creatine?" to 911 (unchanged from main, errs to safety).
