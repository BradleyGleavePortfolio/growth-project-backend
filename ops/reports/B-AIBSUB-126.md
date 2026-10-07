# B-AIBSUB-126 — Ask AI hidden for sub-coaches (agent 126 worker, Claude Opus 5.5, BUILDER, T4 tenancy)

Started 18:36 PDT 2026-10-06 (times from `TZ=America/Los_Angeles date`). Hard stop 19:35.
Branch agent126/b-aibsub-126, worktree /home/user/workspace/wt/B-AIBSUB-126-backend (from origin/main 35c22212).
PR body: ops/reports/B-AIBSUB-126-prbody.md.

## Scope traced (screens + routes)
- Mobile m#439 head (agent126/b-aib5-126) `src/api/aiBuilderApi.ts`: status 404 -> `getStatus` returns null -> Ask AI entry hidden; propose 404 -> `not_available`. Mapping is by HTTP status only.
- Backend main `GET /ai/gateway/workout-builder/status` (workout-builder-status.controller.ts, b#808) -> WorkoutBuilderStatusService.getStatus.
- b#809 head 8b82ead8 `POST /ai/gateway/workout-builder/propose` -> WorkoutBuilderAiService.propose: flag 503 -> role -> tenantCoachId = getHeadCoachIdForSubCoach ?? self -> client check -> plan must be `coach_id === tenantCoachId` (404 for a sub-coach's own plan) -> capability 503 -> `this.gateway.invoke(...)` for both capabilities.
- `AiGatewayService.invoke` (main) role boundary -> MWB-5 capability gate -> consent -> budget -> provider -> draft.
- Sub-coach helper: `SubCoachScopeService.getHeadCoachIdForSubCoach` src/sub-coach/sub-coach-scope.service.ts:179 (explicit seat or open delegation; phantom coach_id rows -> null).

## B list
- B4 (from SAFE-AIB-PRE-126): a sub-coach on a Scale team opens a workout, taps Ask AI and gets "paused for maintenance" on their own plans or a refusal on Apply on the head coach's plans. FIXED in b#817 (hide for sub-coaches).

## U list
- None new.

## C one-liners
- C: with FEATURE_MWB_AI_LIVE_CREATE off, b#809 propose answers everyone (sub-coaches included) 503 AI_PAUSED before the gateway; unreachable for a sub-coach from the app (entry hidden). Optional one-liner for b#809 below.
- C (edge, deferred to 10k clients): a sub-coach-scope DB read failure on the status route answers 500 instead of a status body.

## Covered by open PRs
- None. b#809 (generator), b#815 (subset approve, stacked on b#809), b#813 (AIB-3 context) do not touch sub-coach visibility.

## PRs opened
- backend #817 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/817 @ 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b, +284 -1 (4 files), CI: 15 success, 1 skipped (deploy-readiness-gate) at 18:57; mergeable clean. READY comment https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/817#issuecomment-6029251025 (18:57 PDT).
  - Guard `WorkoutBuilderNoSubCoachGuard` on the status route: exact unmounted-route 404 (`Cannot GET <originalUrl>`, same envelope keys).
  - `AiGatewayService.invoke`: 404 for a sub-coach on draft.create_workout_plan / draft.edit_workout_plan before audit/draft/budget/provider (covers propose in b#809 and /ai/gateway/invoke regardless of merge order).
  - Spec test/aibsub-workout-builder-sub-coach.spec.ts 11 tests; 3 fail on main (sources reverted), all pass on the branch. Local green: mwb-5-feature-flag-gating (8), aib4-workout-builder-status (11). ESLint clean.

## Not fixed (needs operator)
1. Optional, b#809 builder (B-AIB2-126): `src/ai/gateway/workout-builder/workout-builder-ai.controller.ts:28` add `WorkoutBuilderNoSubCoachGuard` to `@UseGuards(JwtAuthGuard, RolesGuard)` after b#817 merges, so propose answers a sub-coach with the unmounted-route body before the flag 503. Not required for the fix (the gateway already 404s).
2. Overlap: b#809 also edits src/ai/gateway/ai-gateway.service.ts (different hunks: interface ~:95, provenance ~:343, draft ~:387, constant ~:665); b#817 touches imports, constructor, top of invoke. Expect a clean merge either order.
3. Decision for the operator: B4 default = hide for sub-coaches at launch (this PR). Full support is v1.1 (plan scope via autosave authorisePlanAccess, decide lets the sub-coach apply inside the head tenant, then remove the guard and gateway refusal).

## HANDOFF
Done 18:58 PDT (inside the 45-min box). b#817 @ 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b, CI green, READY FOR AUDIT comment posted
(body: ops/reports/B-AIBSUB-126-ready.md). Worktree removed (HEAD == origin branch, nothing uncommitted). No ci/* branches, no locks.
Notify: ops/lanes126/notify/B-AIBSUB-126.txt. Remaining for agent 126: dual lenses at 6e8616f5, merge (operator). Any fix round:
new worktree on branch agent126/b-aibsub-126 (merge main in, never rebase). If b#809 merges first, re-run CI on b#817 (merge main in);
the hunks do not overlap. After both merge, optional: b#809 builder adds the guard to WorkoutBuilderAiController.
