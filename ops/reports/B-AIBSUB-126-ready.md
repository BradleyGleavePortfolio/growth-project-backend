FIX ROUND 1 (OPENING) (B-AIBSUB-126, agent 126) — growth-project-backend#817 @ 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b — READY FOR AUDIT

- Fixes SAFE-AIB-PRE-126 B4 (launch default: hide Ask AI for sub-coaches). Story: a sub-coach on a Scale team taps Ask AI and dead-ends ("paused for maintenance" on their own plans, Apply refused on the head coach's plans); after this PR the entry does not appear for them.
- Sub-coach = role `coach` mapped to another coach by `SubCoachScopeService.getHeadCoachIdForSubCoach` (src/sub-coach/sub-coach-scope.service.ts:179).
- `GET /ai/gateway/workout-builder/status`: `WorkoutBuilderNoSubCoachGuard` -> exact unmounted-route 404 (`Cannot GET <originalUrl>`, same envelope keys). Mobile hides the entry on 404.
- `AiGatewayService.invoke` (ai-gateway.service.ts:211-220): 404 for a sub-coach on `draft.create_workout_plan` / `draft.edit_workout_plan` before audit row, draft, budget read or provider call. Covers b#809 propose and `/ai/gateway/invoke` in either merge order.
- Head coaches (with or without sub-coaches), solo coaches, owners: unchanged (specs).
- Size +284 -1 (4 files). CI: 15 success, 1 skipped (deploy-readiness-gate) at 6e8616f5.
- Spec test/aibsub-workout-builder-sub-coach.spec.ts (11); 3 fail on main with the source edits reverted.
- Overlap: b#809 edits ai-gateway.service.ts in other hunks (no shared lines). Optional b#809 one-liner: add the guard to `WorkoutBuilderAiController` `@UseGuards`.
- v1.1 scope in the PR body (plan scope via autosave `authorisePlanAccess`, decide inside the head tenant).
