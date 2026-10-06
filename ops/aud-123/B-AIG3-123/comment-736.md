FIX ROUND 2 (B-AIG3-123, agent 123) — growth-project-backend#736 @ __SHA__

Closes Opus B-736-3, Opus B-736-4 and Sol B-736-3 (same issue as Opus B-736-4). One commit on top of 58a31e6f: `src/ai/ai-crisis-router.ts` and the two AI specs. `ai.service.ts` is unchanged; the crisis check still runs before context, consent, the daily limit and the model. Size 459 changed lines (under 1,500).

**Opus B-736-3 — a stated plan to overdose gets 988 again.** Added Opus's intent line to SELF_HARM: `(want to|wanna|going to|gonna|plan(ning)? to|thinking (about|of)|thought (about|of)|about to|ready to|might|try(ing)? to|urge to) (overdose|overdosing|od)`, with the same `(?! on NOT_A_SUBSTANCE)` guard. "I want to overdose tonight", "I am going to overdose" and all 10 Opus phrases (plus "I'm going to OD") return `self_harm`. "going to overdose on carbs" and "I might overdose on protein" stay normal.

**Opus B-736-4 / Sol B-736-3 — inability to breathe after training gets 911 again.**
- The chest lookahead's second-symptom list now includes can't/cannot/can not breathe, hard to breathe, trouble breathing and struggling to breathe (Opus's line).
- The breathing pattern is split into two:
  - An explicit present inability (can't / cannot / can not / unable to breathe) is 911 wherever it happens. Only the airway is excluded ("through my nose/mouth"), because that is a technique question.
  - Difficulty wording (couldn't / hard to / trouble / struggling to) keeps last round's training exclusion.
- New: any breathing trouble plus "help now" / "need help now" / "call 911" / "ambulance" is 911.
- Result: "I cannot breathe after my workout. I need help now.", "I can't breathe during my workout. Please help me." and "my chest hurts and I can't breathe after my run" return `emergency`, and so do the other 2 Opus chest phrases. The controls "hard to breathe during heavy squats", "can't breathe through my nose when I run", "trouble breathing on long runs", "breathing during heavy squats" and "out of breath on long runs" stay normal.
- Note: "I can't breathe after my run" on its own now gets 911 again, as it did at f2dd87ad. This errs on the safe side.

**Tests.** The 5 sentences from the job were added in two places:
- `test/ai.service.spec.ts`: at the daily limit, each gets the crisis reply with `crisis:<class>` and `model_used: 'safety'`. The model, quota upsert and updateMany are never called.
- `test/ai-crisis-router.spec.ts`: the router table.

All 5 return null at 58a31e6f, so every new test fails there.

**Evidence.** I ran a single-file transpile plus node (no local jest or tsc), saved in ops/aud-123/B-AIG3-123/:
- probe.js / probe-output.txt: 42 must-route phrases and 23 normal controls all pass. That covers all 30 B-AIG2 table cases, the 6 job controls and Sol's saved assertions.
- Opus's probe.js and probe2.js re-run against the new router: the only changes are the intended null-to-crisis ones. No crisis phrase became null.

**CI.** Lane __LANE__ (`test/ai.service.spec.ts` + `test/ai-crisis-router.spec.ts`): __LANESTATE__. PR CI at this head: __PRCI__.

**Cs unchanged:** C-736-3, C-736-4, C-736-5, C-736-7, C-736-8 ("I want to take all my pills" still null) and C-736-9.

READY FOR AUDIT
