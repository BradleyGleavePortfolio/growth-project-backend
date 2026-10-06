FIX ROUND 2 (B-CRISIS2-123, agent 123) — growth-project-backend#758 @ b9ba736ce9ea3adfe49d6d79a7142193bdd73cd9

One commit on the operator's main merge e8d6a027 (fast-forward, no force push). Operator ruling on B-758-1 (safety over false alarms): remove the activity exclusion entirely.

## B-758-1 (Opus R4A, https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/758#issuecomment-6021114167): fixed
- The "during / while <activity>" exclusion on "can't breathe" and the added "please help" / "help me" words are removed. Every breathing rule in src/ai/ai-crisis-router.ts is now byte-identical to main, so every "can't breathe" variant routes to 911 exactly as on main.
- "I can't breathe during burpees" is 911 again (accepted over-escalation, operator ruling; operator decision 1 closed).
- Kept as they were at 905bff9f: the not-breathing, won't-wake-up and OD spelling rules (B-F9-1/2/3), and "odd" no longer matching.

## Tests
- test/crisis-router-not-breathing.spec.ts, both routers, 73 cases (+9). New block: all 9 Opus B-758-1 phrases (wheezing, lips blue / turning blue, chest is tight, no inhaler, asthma, bare "help", "what do I do", heart racing) plus "can't breathe during burpees" and "I can't breathe during burpees" are 911 on both. These 11 fail at 905bff9f (spec-vs-r2-r1.txt: 62 pass / 11 fail) and pass on main.
- Controls still normal: "out of breath after sprints", "I get out of breath on the stairs", "hold your breath on the brace", "creatine overdose?", "can you overdose on creatine?", "suicide sprints", plus the wake-up, ODed-on-cardio and "odd" controls.
- Against main e9b82e13: 31 fail (14 not-breathing / will-not-wake, 15 OD spellings, 2 "odd"); 42 pass. At this head 73/73.
- Local, one spec at a time via heavy.sh: new spec 73/73, ai-crisis-router 50/50, crisis-router-gym-talk 122/122, ai.service 58/58, roman-guardrails 25/25, rb121 117/117, streaming 31/31, golden.eval 27/27. Prettier and eslint clean.
- Corpus (53,635 literals, main vs head): no "breathe" phrase changes class; the only changes are the F9 phrases above.

Size: 177 changed lines vs main (src 39+/3-, spec 135).

## CI at b9ba736c
- All checks green: SUCCESS=15, SKIPPED=1 (deploy-readiness-gate, as usual); npm audit green (shell-quote override from #759). build-and-test SUCCESS, 876 suites / 15,417 tests passed, including the new spec: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37500867629/job/112397204848

Cs carried: C-758-1 "Oded" (the name) routes to 911, C (edge, deferred to 10k clients); C-758-2 "stopped breathing for a few seconds while sleeping" routes to 911 (errs to safety); "not breathing normally" form-word exclusion; dotted 988 intent.

READY FOR AUDIT
