FIX ROUND 1 (B-AIG2-122, agent 122) — growth-project-backend#736 @ 58a31e6fb959947920e99abc0facc8b34cfdb4c0

Fixes both lenses' Bs at f2dd87ad (Sol 6006699712: B-736-1, B-736-2; Opus 6006734594: B-736-1, B-736-2). One push. Only `src/ai/ai-crisis-router.ts` changed in src; `ai.service.ts` is unchanged (the crisis check still runs first, before context, consent, the daily limit and the model). Size: 412 changed lines vs main (under 1,500).

**Misses now routed**
- Named-medicine overdose (Sol B-736-1): "I took a whole bottle of Tylenol" -> 911. The pattern is copied from the Roman SafetyRouter (A-666-3, b#669 ef71cb9c): five or more, or a bottle/pack/handful/bunch, of a named medicine (Tylenol, ibuprofen, Xanax and similar). "took 2 Tylenol for my headache" is still a dose (normal answer).
- Suicide-method phrases (Opus B-736-2): "I am going to hang myself" -> 988. Added: hang/shoot/stab/drown/strangle/suffocate myself (not "shoot myself a reminder"), slit my wrists/throat, jump off or in front of a bridge/roof/building/train with intent, want it all/everything to end.

**False positives removed (Sol B-736-2, Opus B-736-1)**
- Overdose and poisoning count only when reported as happening to a person ("I overdosed", "I took an overdose", "my friend overdosed", "I was poisoned", "drank bleach", "has alcohol poisoning"), and not "overdosed on <cardio, creatine, carbs, protein, ...>". "overdose on cardio", "can you overdose on creatine?", "how much protein is an overdose" and "is mercury poisoning a risk" get the normal answer.
- Hurt/cut myself needs intent or an ongoing pattern ("I want to hurt myself", "I have been cutting myself", "on purpose"). "I hurt myself deadlifting, can I train?" gets the normal answer.
- Breathing trouble followed by a training activity ("during heavy squats", "through my nose when I run", "on long runs") gets the normal answer; "I can't breathe" still gets 911. "unconscious" needs a person ("my friend is unconscious"), so "unconscious snacking" gets the normal answer.

**Tests**
- `test/ai.service.spec.ts` (service level, real `AiService.chat`): at the daily limit, "I took a whole bottle of Tylenol" -> 911 and "I am going to hang myself" -> 988, with no quota write and no model call; under the limit, "overdose on cardio", "can you overdose on creatine?", "I hurt myself deadlifting, can I train?" and the controls "kill this workout", "I'm dying after leg day", "took 2 Tylenol for my headache" get the normal model answer; at the limit, the three former false positives get the 429 limit reply.
- `test/ai-crisis-router.spec.ts`: phrase table (10 emergency, 10 self-harm, 15 normal) including both lenses' phrases.
- Failing-before: with the router reverted to f2dd87ad, 30 of the new cases fail (every B case); the three controls and the kept crisis cases pass, as guards against over-matching.
- CI lane (both specs at this head): [run 37396028556](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37396028556) success. PR CI: PRCI_STATE.

**Cs left (not in scope)**: Roman's own router keeps the same false positives (C-736-3, operator); the emergency text for an intentional overdose has no 988 line (C-736-5); hyperbole such as "killing myself at the gym" and "chest tightness when I bench" still routes conservatively (C-736-4).

READY FOR AUDIT
