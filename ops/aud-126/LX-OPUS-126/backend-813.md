# SKIPPED (not posted): another Opus lens posted at dee67d53 first (19:08 PDT). Draft kept.

AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-backend#813 @ dee67d534ac927c2c87ab0960d50185ed9cb3b5f — VERDICT: APPROVE

B=0 U=0 C=4. T4 AI (privacy minimisation + server-side safety pass on the per-client program generator). FIX ROUND 2 head. CI at this head: all green (build-and-test incl. type-check and full test, danger, R75, schema parity, CodeQL, rls/community/mwb-3 live, test-deploy-readiness). Size 789 excluding the snapshot.

Round 2 delta (c3eae417..dee67d53): B-813-1 fixed. `coachAskedToKeep` keeps a row only when the exercise name follows a keep word in the same clause with no negation before it. Every failure mode leans conservative: "Avoid / No / Don't keep / felt heavy" all swap, and an unclear wording swaps (the coach can re-add it in the editor). Kept rows are now listed in coach_notes. The rest of the delta is formatting only.

Whole PR checked against plan sections 1-2 and SAFE:
- Consent: the generator still passes `dataSubject: clientDataSubject(clientId, 'coach')` after `assertCoachOwnsClient`. The extra reads (WorkoutContextService) stay on the server until the adapter's box-2 check, and the spec asserts no grant -> 403 and no draft. Recovery is read only with an active WearableConnection, which matches the plan table gate.
- Minimisation: `serializeContextForPrompt` drops client_id, identity (name), prescribed macros, today_calories, weight trend and free-text injuries. recent_workouts is reduced to date/completed/post_rpe/plan_type. Context v2 sends enums and numbers only, and history uses seed ids only (custom exercise names are skipped as client text). Check-ins are energy/soreness/sleep_hours (take 2). The gateway's workout capabilities get `workoutBlock` (first_name "the client", no weight/height/snacks) and do not read the last coach message (`take: 0`). Other capabilities are unchanged.
- Safety pass before persistDraft: injury rows are swapped to a seed exercise that loads none of the client's areas (no duplicate in one day) or dropped with a coach_notes reason. Sets/reps/rest/notes are clamped and exercises are capped at 14 per day. A load is kept only for a logged exercise, at most 105% of the last weight. The materialiser (coach-ai.service.ts materializeWorkoutProgram) keeps the original `order` values, so removals cannot create duplicate orders, and empty days are already handled. Seed ids (seed:legs-007 etc.) are valid library ids.
- Tenancy: coach style reads only `WorkoutPlan.coach_id = coachId` and is cached per coach for 10 min. No client data is in the style.
- Live effect: Coach AI v1 generator programs for clients with listed injuries now get server swaps. Clients without injuries only see the clamps and no AI-invented loads for unlogged lifts, which is the intended plan behaviour.

C (none block):
- C: the prompt-side and server-side medical-claim deny list (plan section 2) is prompt-only on this generator (rule 10). This is not a regression, because the pre-PR generator had none. Fold it into AIB-3b with b#809's validator.
- C: screening_flag on this generator is a prompt instruction plus a coach_notes ask, not a server rule (no "increase" ops exist on a fresh program).
- C: with no `name`, `row.name || exercise_external_id` gives "barbell-back-squat", which the lower_back pattern `/back squat/` misses (the knee pattern still matches). Edge, deferred to 10k clients.
- C: the same mention-equals-keep pattern exists in b#809's validator (`instruction.includes(name)`), as the builder notes. Operator: carry the `coachAskedToKeep` rule into b#809 / AIB-3b before the flip.
