FIX ROUND 1 (OPENING) (B-ROMAN911-123, agent 123) — growth-project-backend#744 @ cda23212514b60adbfffef0e9add310a4c7f541a

T4 (safety / crisis routing). W3-09: Roman and the AI guide must not send normal gym talk to 911 / 988. One commit on main 5230306c, 275 changed lines (2 source files + 1 new spec).

Normal-user story: a client asks Roman "can you overdose on creatine?" or "hard to breathe during heavy squats, how should I brace?" and gets "call 911 now"; "I hurt myself deadlifting, can I train?" got the 988 reply; on both surfaces "we did suicide sprints at practice" got the 988 reply.

Change:
- Roman SafetyRouter `emergency` / `self_harm` now use the AI guide crisis router's lists (one list for both surfaces). Removes Roman's broad overdose / poisoning / breathing / unconscious / hurt-myself patterns; Roman gains the suicide-method phrasings it was missing ("I am going to hang myself", "I want to jump off a bridge" were `normal` on Roman at main).
- AI guide list (both surfaces): drill and grip names (suicide sprints / drills / shuttles / squeeze / grip / runs, not "runs in") stay normal; the effort idiom "I've been killing myself in the gym" stays normal only with both an effort subject and a training place; "kill myself", "I'm killing myself", "thinking about killing myself" still route; "I keep wanting to hurt myself" now routes on the AI guide.

Evidence:
- Sweep of 60 gym / diet phrases on both routers at main: 26 false 911 / 988 routes; at this head: 0 (one kept on purpose, below).
- New router-table spec `test/crisis-router-gym-talk.spec.ts`: 47 gym phrases no crisis class on both; 18 emergency phrases 911 on both; 23 self-harm phrases 988 on both (C-736 / b#736 and b#739 tables + Roman router table). 88/88 green; 33 red with main's routers.
- Existing specs green locally (heavy.sh, one file each): ai-crisis-router 50/50, roman-guardrails 25/25, rb121 117/117, c2-rmn3 28/28, guardrails-round2 36/36, launch-hardening 58/58, guardrails-wiring 11/11, roman-golden.eval 27/27.
- 53,244 string literals in src/ and test/ through both routers, main vs head: 43 change class, all intended.
- PR CI at this head: 15 SUCCESS, 1 SKIPPED (deploy-readiness-gate); build-and-test (lint, full type-check, build, full suite) SUCCESS, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37414609790

Cs (not fixed): "I want to die of embarrassment" still 988 (errs to safety); "chest pain after bench" / "going to pass out after burpees" still 911 (real warning signs).

READY FOR AUDIT
