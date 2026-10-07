# SKIPPED (not posted): another Opus lens posted at 6e8616f5 first (19:00 PDT). Draft kept.

AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-backend#817 @ 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b — VERDICT: APPROVE

B=0 U=0 C=2. T4 auth/tenancy, refusal only. CI: all checks green at this head (build-and-test, danger, R75, schema parity, CodeQL, rls/community/mwb-3 live; deploy-readiness-gate skipped as usual). Size +284/-1 (4 files, 229 test lines).

Checked:
- Who counts as a sub-coach: `isSubCoachOfAnotherCoach` -> `getHeadCoachIdForSubCoach` -> `membershipHeadCoachIdFor` (sub-coach-scope.service.ts:51-85). It is true only for role coach, with a non-null coach_id AND an open TeamSubCoachAssignment seat or an open SubCoachAssignment delegation. Head coaches (coach_id null), solo coaches, phantom coach_id rows without a membership, owners and clients are all false. So the featured head coach and every solo coach keep Ask AI. Nothing is widened.
- Status route: `WorkoutBuilderNoSubCoachGuard` runs after JwtAuthGuard and RolesGuard on the only route in WorkoutBuilderStatusController. It throws the unmounted-route 404 before the status service or its budget read. The mobile client already maps a status 404 to "hide the entry" (aiBuilderApi.getStatus -> null; useAiEntryStatus visible=false). So the AIB-5 builder button, the AIB-6 week "Ask AI" and the History button all disappear for a sub-coach, with no dead end and no misleading "paused" copy.
- Gateway: for the two workout-builder capabilities only (`isMwbLiveCreateCapability`), a sub-coach gets 404 before the request id, audit row, draft, budget read or provider call. This covers both b#809 propose (which calls gateway.invoke) and POST /ai/gateway/invoke whatever the merge order. Other capabilities do no lookup.
- `@Optional()` SubCoachScopeService: SubCoachModule is @Global and imported by AppModule, so production always injects it.
- Tests: real HTTP with the real guards and the global filter (status 404 envelope and key set, service not called), head/solo/owner 200, helper truth table, gateway create/edit 404 with no audit and no draft.

Owner-decision note (not graded as a B): the owner's 15:40 rule is "do not turn it off or hide it". This PR hides Ask AI for sub-coaches only, which matches the recommended launch default from SAFE-AIB-PRE-126 B4 and b#809, because every sub-coach attempt would otherwise dead-end. Recommended default: merge; full sub-coach support in v1.1 as the PR body scopes it.

C (none block):
- C: two to three extra indexed reads per status call for coaches with a coach_id (membership lookup). Fine at launch size.
- C: b#809's propose controller still answers the flag-off 503 before reaching the gateway refusal. The optional one-line guard the PR body suggests for WorkoutBuilderAiController would make the answer uniform; it is not needed, because the app hides the entry from the status 404.
