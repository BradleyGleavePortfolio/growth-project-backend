AUDIT Claude Opus 5.5 — growth-project-backend#736 @ 58a31e6fb959947920e99abc0facc8b34cfdb4c0 — VERDICT: REQUEST CHANGES

AUD-OPUS-W1C-123, agent 123. Delta re-review f2dd87ad..58a31e6f (src/ai/ai-crisis-router.ts + 2 specs). A/B/C = 0/2/4. T4 (safety). Size 412 lines (under 1,500). All 16 checks green at this head.

**What the round got right.** All five prior Bs are closed. "I took a whole bottle of Tylenol" gives 911. "I am going to hang myself" and the other 6 method phrases give 988. All 12 fitness phrases from my B-736-1 now get a normal answer, including "overdose on cardio", "can you overdose on creatine?" and "I hurt myself deadlifting, can I train?". The controls "kill this workout", "I'm dying after leg day" and "took 2 Tylenol for my headache" stay normal. The prior story phrases still route: "I want to kill myself", "I want to die", "I overdosed", "I took 20 of my sleeping pills" and "I can't breathe". `ai.service.ts` is unchanged. The crisis check (src/ai/ai.service.ts:391) still runs before context (:406), consent (:417), the daily limit (:479) and the model.

Evidence: I ran `classifyAiGuideCrisis` at f2dd87ad and at 58a31e6f side by side. This was a single-file in-memory transpile plus node, with no jest, tsc or npm. Script and output: ops/aud-123/AUD-OPUS-W1C-123/p736/probe.js, probe-output.txt, probe2.js and probe2-output.txt.

**B-736-3 — regression from this round: saying you plan to overdose no longer gets the crisis reply.**
Story: a client who has used up the day's AI guide allowance types "I want to overdose tonight". At f2dd87ad they got the crisis reply. Now they get the daily-limit pop-up, which is the exact miss #736 exists to fix.
- Cause: src/ai/ai-crisis-router.ts:85-88. The narrowed overdose pattern only matches an overdose that has happened or is happening to a person. Intent phrasing no longer matches anywhere.
- These were crisis at f2dd87ad and are null now: "I want to overdose", "I am going to overdose", "I'm going to overdose tonight", "I want to overdose on my pills", "I am going to overdose on my sleeping pills", "I'm planning to overdose", "I am thinking of overdosing", "I might overdose tonight", "I want to overdose and die" and "I want to overdose and not wake up".
- The gap traces to my own fix rule (a) in the last round, which named only reported overdoses. I am correcting it here.
- Fix: add one SELF_HARM pattern for intent: `\b(want to|wanna|going to|gonna|plan(ning)? to|thinking (about|of)|thought (about|of)|about to|ready to|might|try(ing)? to|urge to) (overdose|overdosing|od)\b`. Use the same `(?! on ${NOT_A_SUBSTANCE}\b)` guard so "going to overdose on carbs" stays normal.
- Verify: the 10 phrases above return `self_harm` (988, which includes the 911 line). All 15 null cases in test/ai-crisis-router.spec.ts stay null.

**B-736-4 — regression from this round: chest pain together with not being able to breathe after training no longer gets 911.**
Story: a client finishes a run, types "my chest hurts and I can't breathe after my run" while at the day's limit, and gets the limit pop-up instead of "call 911 now".
- Cause: the new training exclusion on the breathing pattern (:60-63) drops the message. The chest pattern at :56 does not count breathing trouble as its second symptom.
- These were emergency at f2dd87ad and are null now: "my chest hurts and I can't breathe after my run", "I can't breathe after my workout and my chest hurts" and "my chest feels tight and I can't breathe after squats".
- "I can't breathe after my run" on its own being normal is fine.
- Fix: in the :56 lookahead list (`numb(ness)?|tingl...|cold sweat`), add `can'?t breathe|cannot breathe|can not breathe|hard to breathe|trouble breathing|struggling to breathe`.
- Verify: those 3 phrases return `emergency`. "I find it hard to breathe during heavy squats, how should I brace" stays null, because it mentions no chest symptom.

Cs (one line each, no fix now):
- C-736-7: "I think I overdosed on caffeine from pre-workout" and "I can't breathe in this heat during runs" still get 911. This over-routes on the safe side.
- C-736-8: "I want to take all my pills" and "I'm going to OD" were null at both heads (not a regression). Builder follow-up, or the same B-736-3 line can cover them if it is trivial.
- C-736-9: "how do I hang myself from a pull-up bar for dead hangs" gets 988. C (edge, deferred to 10k clients).
- Builder Cs C-736-3, C-736-4 and C-736-5 stay C. I have no new normal-user story for them.

I applied both proposed lines to a scratch copy, which is not pushed (p736/fixcheck.js, fixcheck-output.txt). With them, all 13 B phrases route, and all 15 spec null cases plus "going to overdose on carbs" and "I might overdose on protein" stay null.

One small push closes both Bs: two pattern lines plus their spec rows. Re-review scope after that: B-736-3, B-736-4 and the changed lines only.
