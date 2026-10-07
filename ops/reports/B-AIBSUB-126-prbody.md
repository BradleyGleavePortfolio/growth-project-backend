**Tier:** T4 (auth/tenancy: who may reach the AI workout builder routes and the two workout-builder gateway capabilities)
**Why:** SAFE-AIB-PRE-126 B4. A sub-coach on a Scale team can open Ask AI, but every attempt dead-ends: on their own plans propose answers 404 (the app shows the "paused for maintenance" copy), and on the head coach's plans the draft is stamped with the head coach's tenant, so Apply is refused. Recommended launch default: hide Ask AI for sub-coaches; full support is v1.1.
**T4 trigger scan:** auth/tenancy (new route guard on the status route; new refusal in `AiGatewayService.invoke` for `draft.create_workout_plan` / `draft.edit_workout_plan` when the requester is a sub-coach). Refusal only: nothing is widened, no new access. No money, no PII, no migration, no flag, no destructive data. Production today: the AI gateway and FEATURE_MWB_AI_LIVE_CREATE are off, so no live behaviour changes until the flip.
**T3 trigger scan:** none (no mobile change; the 10-07 app already hides the entry on a status 404).
**Bounded T1:** none.
**Canonical builder:** Claude Opus 5.5 (B-AIBSUB-126 for agent 126).
**Acceptance evidence:** test/aibsub-workout-builder-sub-coach.spec.ts (11 tests; 3 fail on main with the source changes reverted: sub-coach status 404, sub-coach create 404, sub-coach edit 404). PR CI.

## B fixed
- **B4 (SAFE-AIB-PRE-126): a sub-coach can never use Ask AI.** Story: a sub-coach on a Scale team opens a workout, taps Ask AI and gets "paused for maintenance" on their own plans or a refusal on Apply on the head coach's plans. After this PR the Ask AI entry does not appear for a sub-coach at all, the same as on an older backend.

## What it does
- Sub-coach = a user with role `coach` whom `SubCoachScopeService.getHeadCoachIdForSubCoach` (src/sub-coach/sub-coach-scope.service.ts:179, explicit team seat or open delegation) maps to another coach. Helper: `isSubCoachOfAnotherCoach` in src/ai/gateway/workout-builder/workout-builder-sub-coach.gate.ts.
- `GET /ai/gateway/workout-builder/status`: new `WorkoutBuilderNoSubCoachGuard` (after JwtAuthGuard and RolesGuard) throws `NotFoundException("Cannot GET <originalUrl>")`, which the global HttpExceptionFilter turns into the exact envelope of a route Nest never mounted (same message format as `RoutesResolver`'s not-found handler, same keys). The mobile client (`aiBuilderApi.getStatus`) maps 404 to "hide the entry". The status computation (and its budget read) never runs for a sub-coach.
- `AiGatewayService.invoke` (src/ai/gateway/ai-gateway.service.ts:211-220): for the two workout-builder capabilities only, a sub-coach requester gets `NotFoundException` before the request id, the audit row, any draft, the budget read and the provider call. This is the path `POST /ai/gateway/workout-builder/propose` (b#809, `workout-builder-ai.service.ts` `this.gateway.invoke(...)`) and `POST /ai/gateway/invoke` both use, so propose returns 404 for a sub-coach on every plan whichever of this PR and b#809 merges first. (On a sub-coach's own plan b#809 already answers 404 `plan_not_found`.)
- Head coaches (including a head coach who has sub-coaches), solo coaches, phantom `coach_id` rows without a membership (treated as their own head by the helper) and owners: unchanged. Other capabilities: no lookup, unchanged.
- `SubCoachScopeService` is injected `@Optional()` only so the six positional `new AiGatewayService(...)` test constructors keep compiling; SubCoachModule is `@Global` and imported by AppModule (app.module.ts:398), the same way b#809's `WorkoutBuilderAiService` injects it.

## Overlap with open PRs
- b#809 (B-AIB2-126) also edits src/ai/gateway/ai-gateway.service.ts (hunks at the request interface ~:95, provenance ~:343, draft write ~:387, constant ~:665). This PR touches the imports, the constructor and the top of `invoke` only; no shared lines. Optional one-liner for b#809 (not required for the 404): add `WorkoutBuilderNoSubCoachGuard` to `@UseGuards` on `WorkoutBuilderAiController` so propose answers a sub-coach with the unmounted-route body before the flag 503 too.
- b#815, b#813: no shared files.

## v1.1 scope (full sub-coach support, not in this PR)
- Plan scope through the autosave `authorisePlanAccess` gate (src/workout-builder/workout-builder-autosave.service.ts) instead of `plan.coach_id === tenantCoachId` in the propose service, so a sub-coach can ask AI on their own plans and on head-coach plans they may edit.
- Drafts keep `tenant_coach_id` = head coach but record the sub-coach as requester, and `decide` (ai-approval.service.ts tenant check) lets that sub-coach apply their own model-written draft inside the head coach's tenant (with the B3 marker fix).
- Credits: the sub-coach draws from the head coach's pool (already how `resolveHeadCoachId` meters).
- Then remove `WorkoutBuilderNoSubCoachGuard` from the status route and the gateway refusal; the app needs no change.

## Tests
- test/aibsub-workout-builder-sub-coach.spec.ts (11), over real HTTP with the real controller, RolesGuard, the new guard and the global HttpExceptionFilter: sub-coach status 404 with `Cannot GET /ai/gateway/workout-builder/status` and the same key set as an unmounted route, status service never called; head coach with a sub-coach / solo coach / owner -> 200 unchanged; helper truth table; gateway: sub-coach create and edit -> 404 with no audit row and no draft; head coach / solo / owner -> pending draft written; other capabilities do no lookup.
- Fails on main: with the two source edits reverted, 3 of 11 fail (the three sub-coach 404 cases); the rest pass on both.
- Local targeted runs green: the new spec (11), mwb-5-feature-flag-gating (8), aib4-workout-builder-status (11). ESLint clean on the four files.

Size: +284 -1 (4 files).
