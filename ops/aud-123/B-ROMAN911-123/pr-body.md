**Tier: T4 (safety / crisis routing).** Both lenses at the exact head before merge.

## Summary
W3-09 (B-ROMAN911-123, agent 123), follow-up C from b#739. Roman chat is on for everyone, and its SafetyRouter still sent ordinary gym and diet talk to the fixed 911 or 988 template.

Normal-user story: a client asks Roman "can you overdose on creatine?", "hard to breathe during heavy squats, how should I brace?" or "I hurt myself deadlifting, can I train?" and gets "call 911 now" or the 988 crisis reply instead of an answer. On both Roman and the AI guide, "we did suicide sprints at practice" or "is the suicide grip safe on bench" got the 988 reply.

- `src/roman/guardrails/safety-router.ts`: the `emergency` and `self_harm` lists are now the AI guide crisis router's lists (one list for both surfaces, as the AI guide header asked). Roman's old broad patterns (any "overdose" or "poisoning", any "hard to / trouble breathing", any "unconscious", any "hurt / cut myself") are gone; the AI guide's narrowed forms, which went through B-AIG2-122, B-AIG3-123 and B-AIG4-123 review, replace them. Roman also gains the suicide-method phrasings the AI guide already routed ("I am going to hang myself", "I want to jump off a bridge", "I just want it all to end" were `normal` on Roman). The other Roman classes (eating disorder, medical scope, injury) and the templates are unchanged.
- `src/ai/ai-crisis-router.ts` (applies to both surfaces):
  - `suicide`/`suicidal` no longer matches drill and grip names: sprints, drills, shuttles, squeeze, grip, runs ("suicide runs in my family" still routes).
  - "killing myself" as effort ("I've been killing myself in the gym", "I keep killing myself on cardio") gets the normal answer only when both the effort subject (I'm / been / keep) and a training place or activity are present. "kill myself", "I'm killing myself", "thinking about killing myself", "I'm going to kill myself at the gym" still route.
  - Hurt-myself intent gains "wanting to": "I keep wanting to hurt myself" now routes to 988 on the AI guide (it already did on Roman; sharing the list would otherwise have lost it).
  - Exports `CRISIS_EMERGENCY_PATTERNS` / `CRISIS_SELF_HARM_PATTERNS`.

## Tests
- New `test/crisis-router-gym-talk.spec.ts`, a router table on both routers: 47 gym/diet phrases get no crisis class (and no Roman short-circuit); 18 emergency phrases are 911 on both; 23 self-harm phrases are 988 on both (the C-736 / b#736 and b#739 tables plus the Roman router table). 88 cases, 88 green; with main's two router files 33 fail (26 gym phrases routed to 911/988, 7 crisis phrases missed or routed to the wrong line on Roman).
- Existing specs green locally (ops/heavy.sh, one file at a time): ai-crisis-router 50/50, roman-guardrails 25/25, roman-guardrails-rb121 117/117, roman-c2-rmn3-fixes 28/28, roman-guardrails-round2 36/36, roman-launch-hardening 58/58, roman-guardrails-wiring 11/11, roman-golden.eval 27/27. Full suite in PR CI.
- A scan of all 53,244 string literals in src/ and test/ through both routers (main vs this head): 43 change class, all intended (gym talk to normal or injury_pain, Roman crisis phrases gaining 988, Roman "I am going to overdose" moving from 911 to 988 as on the AI guide).

## Size
275 changed lines (2 source files, 1 new spec; Roman file net -102). No lockfile, no new casts, no empty catches.

## Follow-up Cs (not fixed)
- "I want to die of embarrassment" still gets 988 on both (errs to safety).
- "chest pain after bench" and "I feel like I'm going to pass out after burpees" still get 911 (intended: real warning signs).
