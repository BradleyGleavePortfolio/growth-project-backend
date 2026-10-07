AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#817 @ 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (15 SUCCESS, 1 SKIPPED); mergeable clean. Size 285 lines (284+/1-), 55 of them in src.

**T4 tenancy checks (operator: head and solo coaches unaffected; the 404 is the exact shape mobile treats as hidden)**
- Who counts as a sub-coach: `isSubCoachOfAnotherCoach` is true only for role `coach` when `getHeadCoachIdForSubCoach` returns a different id. On main (`sub-coach-scope.service.ts:60-86`) that needs all three of:
  - `User.coach_id` is set;
  - an open TeamSubCoachAssignment seat or an open SubCoachAssignment delegation under that head;
  - the head is not the caller.
- Who is unaffected:
  - A head coach (with or without sub-coaches), whose `coach_id` is null or has no membership row, so the lookup returns null.
  - A solo coach, the same way.
  - A phantom `coach_id` with no membership, which the service treats as its own head.
  - An owner, because of the role check.
  - The spec covers head coach with a sub-coach, solo coach and owner as unchanged on both the status route (200, same body) and invoke (a pending draft is written).
- Status route: `WorkoutBuilderNoSubCoachGuard` runs after JwtAuthGuard and RolesGuard and throws `NotFoundException('Cannot GET <url>')` before the status service (and its budget read) runs.
- Mobile hide: checked against mobile m#439 @ 63076852, `src/api/aiBuilderApi.ts:56-83`. `toAiBuilderError` maps any 404 (body codes other than the budget, consent and AI_NOT_CONFIGURED codes do not matter) to `not_available`, and `getStatus` turns that into `null`, which `useAiBuilder.ts:33` names as "the ONLY hide case".
  - The axios response interceptor in `src/services/api.ts` passes a 404 through unchanged. It only rewrites 401, 402 and dunning responses.
  - So a sub-coach sees the entry hidden, exactly as on today's production backend.
- Gateway: in `AiGatewayService.invoke`, a sub-coach gets a 404 for `draft.create_workout_plan` and `draft.edit_workout_plan` only. It happens before the request id, the audit row, the draft, the budget read and the provider call. This covers both the b#809 propose route and `POST /ai/gateway/invoke`. Other capabilities do no lookup and are unchanged (spec covered).
- Refusal only. Nothing is widened, and nothing changes while FEATURE_MWB_AI_LIVE_CREATE is unset.

**C (never block)**
- C-817-1: if the membership lookup throws (a database error), the status route answers 500. Mobile then keeps the entry visible with a retry rather than hiding it. C (edge, deferred to 10k clients).
- C-817-2: in the gateway, `@Optional() subCoachScope` means a module wiring that ever forgets SubCoachModule would silently skip the refusal. Today SubCoachModule is `@Global` and imported by AppModule.
