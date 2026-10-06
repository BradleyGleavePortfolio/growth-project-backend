AUDIT Claude Opus 5.5 — growth-project-backend#736 @ f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 — VERDICT: REQUEST CHANGES

AUD-OPUS-AIG1-122, agent 122. A/B/C = 0/2/6. T4 (safety). Size 213 lines (under 1,500). All 16 checks at this head green.

What is right: the crisis check runs first in `AiService.chat` (src/ai/ai.service.ts:391), before context, the consent gate, `reserveDailyTokens` and the model, so a matched message spends no allowance and writes no quota, audit or analytics row. Non-matching messages follow the old path unchanged (the limit still returns 429). Both fixed replies are impersonal and correct (988 call or text and 911 for self-harm; 911 or the local number for an emergency or overdose), with no first person and no exclamation marks. Mobile `AIGuideScreen` keeps the send button enabled after the cap pop-up and renders `reply`, so a client at the limit does reach this path.

Evidence: a pure-function probe of `classifyAiGuideCrisis` at this head (single-file in-memory transpile plus node, no jest/tsc/npm). Script and full output: ops/aud-122/AUD-OPUS-AIG1-122/probe.js and probe-output.txt.

**B-736-1 — ordinary fitness questions get the 911 or 988 crisis reply instead of an answer (every client, every day, not only at the limit).**
Story: a client asks the AI guide "can you overdose on creatine?" or "I hurt myself deadlifting last week, can I train?" and gets "Please stop what you are doing and call 911 now" (or the Suicide & Crisis Lifeline text) instead of an answer, and every rewording fails the same way.
- src/ai/ai-crisis-router.ts:54 matches the bare word `overdose` and `poisoning`. These return `emergency`: "overdose on cardio" (named in the job), "I think I overdosed on cardio this week", "can you overdose on creatine?", "is it possible to overdose on caffeine from pre-workout", "how much protein is an overdose", "did I overdose on carbs last night", and "is mercury poisoning a risk if I eat tuna every day".
- :70 `(hurt|cut|cutting) myself` returns `self_harm` (the 988 text) for "hurt myself deadlifting last week, can I train".
- :36 breathing returns `emergency` for "I find it hard to breathe during heavy squats, how should I brace", "I can't breathe through my nose when I run, any tips" and "I have trouble breathing on long runs".
- :42 bare `unconscious` returns `emergency` for "how do I stop unconscious snacking at night".
Before this PR, all of these got a normal model answer, so this is a regression.
Fix rule: (a) treat an overdose or poisoning as a crisis only when it is reported as happening to a person ("I overdosed", "I took an overdose", "my friend overdosed", "I was poisoned"), and not for "overdose on <training or food word>" or "can you / is it possible / how much" questions; (b) treat hurt/cut/harm myself as self-harm only with intent or ongoing framing ("want to / going to / urge to / keep / been cutting / on purpose"), not a past injury report; (c) do not match the breathing patterns when followed by a training context ("during / when / while / on / through / after" plus an activity) or in a how/tips question, while "I can't breathe" on its own still matches; (d) treat `unconscious` as a crisis only with a person subject ("is / he's / she's / someone / knocked unconscious").
Verify: add the 12 phrases above as `null` cases, and keep "I overdosed", "I took a whole bottle of pills", "I took 20 of my sleeping pills", "I can't breathe", "I want to hurt myself" and "I have been cutting myself" as crisis cases.

**B-736-2 — common suicide-method phrasing is not caught, so a client at the limit still gets the limit pop-up.**
Story: a client who has used up the day's AI guide allowance types "I am going to hang myself" and gets the daily-limit pop-up instead of 988, which is the exact miss this PR exists to fix.
- src/ai/ai-crisis-router.ts:62-83 (SELF_HARM) returns `null` for "I am going to hang myself", "I want to hang myself", "I am going to shoot myself", "I want to jump off a bridge", "I am going to jump off the roof", "I want to slit my wrists" and "I just want it all to end".
Fix rule: add method phrases to SELF_HARM: `(hang|shoot|stab|drown|strangle|suffocate) myself`, `slit(ting)? my (wrists?|throat)`, `jump(ing)? (off|from|in front of) (a |the |my )?(bridge|roof|building|balcony|cliff|window|train)`, and `(want|wish|need) (it all|everything) to (end|stop)`.
Verify: these 7 phrases return `self_harm`, and the PR's at-cap spec gets one case such as "I am going to hang myself" that expects 988 with no quota write.

Cs (one line each, no fix now):
- C-736-1: the 20/h `@Throttle` on /ai/chat runs before the crisis check (builder follow-up). No normal-use story, because the 12,000-token day with a 6,600 reservation stops a client after a few turns.
- C-736-2: `ClientEntitlementGuard` returns 403 before the crisis check for a client without entitlement. This is outside this diff.
- C-736-3: the shared pattern list with Roman (builder follow-up). Roman's safety-router has the same B-736-1 patterns, which is for the operator, not this PR.
- C-736-4: hyperbole such as "leg day makes me want to die", "killing myself at the gym today", "I am going to collapse after this workout", "I just passed out on the couch lol" and "chest tightness when I bench" gets a crisis reply. Conservative routing is acceptable here.
- C-736-5: the emergency text for an intentional overdose gives 911 only. A short 988 line could follow.
- C-736-6: the daily limit size, and slang or passive phrasing ("kms", "I want to disappear forever", "I am done with life"). C (edge, deferred to 10k clients).
