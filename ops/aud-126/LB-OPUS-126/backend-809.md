AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#809 @ 8b82ead8d3d4598ba6f416e69a13f63c1fc55b6e — VERDICT: APPROVE

A=0 B=0 C=5. CI: green at this head (16 SUCCESS, deploy-readiness-gate SKIPPED); mergeable clean. Size 785 lines (781+/4-), under the cap.

Flag state: FEATURE_MWB_AI_LIVE_CREATE is "unset" on main, so this route answers 503 `AI_PAUSED` before any read. This verdict grades the code for the flip as well.

**SAFE checklist 1-12 against this head**
1. Consent: `subjectUserId: input.client_id` goes to the gateway, which runs `egress.assertMaySend` before the provider call. Box-2 consent is required on every attempt, including the repair attempt (each attempt is a separate `invoke`). With no `client_id`, the user turn holds only the plan rows. `buildWorkoutBuilderUserMessage` sends no notes, so no client data leaves the server.
2. Minimisation: `loadClientContext` reads goal, experience, equipment (12 x 40 chars), days per week, injury enums (filtered by `isInjuryArea`) and the screening boolean. It reads no name, email, logs, snacks or messages, and the spec asserts this.
3. Tenancy:
   - The role is coach/owner (RolesGuard plus a re-check in the service). Owner is the platform super-admin (`roles.guard.ts:69` total bypass), the same as every other route.
   - For a coach, the client is checked with `canAccessClient`, and the plan must have `coach_id === head-coach tenant` and not be archived; otherwise 404.
   - The draft's `tenant_coach_id` is the head coach.
   - Sub-coach handling is B4, owned by the coming agent126/b-aibsub-126.
4. Human in the loop: the model output only becomes a `pending` AiActionDraft. I checked the gateway path end to end: there is no execute-or-apply branch, and `explain` returns null so no draft is written. Approval is forced for both capabilities (b#808, `ai-gateway.config.ts`). Callers cannot set the `workout_builder_model_diff` provenance marker; the gateway strips it.
5. Prompt injection: the instruction and rows go in the user turn as JSON. The reply is parsed only as `{summary, changes[{op, reason}]}` and then through `WorkoutDiffOpSchema`. The capability, `target_plan_id`, `target_client_id` and `base_revision_index` are set by the server. The gateway's capability materialiser schema runs again before the draft is written.
6. Output validation:
   - The pipeline is schema, library id, bounds, loads, screening/deload, contraindications, a pure-applier dry run, then 14 exercises and 12 sets per muscle.
   - Invalid ops are dropped with a reason.
   - There is one repair attempt (at most two metered calls), then 422 `AI_NO_SAFE_PROPOSAL`.
7. Domain safety:
   - New exercises must come from the seed library or already be in the workout.
   - `weight_lbs` is nulled on add, and a load increase is allowed only from an existing load, at most 10 percent.
   - The screening flag and deload block any increase.
   - The contraindication table filters both the prompt library and the output; an exercise the coach typed passes with a warning.
   - Medical claims are stripped from summary, reason and notes, and a medical-claim plan name is dropped.
   - In production a stub provider answers 503, never a fake proposal (`NODE_ENV === 'production'` check).
8. Cost: the gateway meters every attempt against the head coach pool and returns 403 `COACH_AI_BUDGET_EXHAUSTED`. The route throttle is 60/h, and credits come from the AIB-4 status service.
9. Kill switch: the flag is read on every call as the first statement, before the role, tenancy, Prisma or provider. Spec covered.
10. Logs: prompt and response are stored as hashes in `aiRequestAudit`, and the service writes no log lines with the instruction, context or health values.
11. Store/legal: no medical claims (item 7) and no purchase wording.
12. Mobile reachability: the route has no EXPO flag. m#439 calls it, and older backends 404.

**For the operator (not a B for this PR, since the flag is off)**
- The FLIP gate must include the stacked b#815 (subset approve plus `materialised_ref`). As the PR body says, without it Apply applies every change even when the coach unticked some. Today the manifest gate for FEATURE_MWB_AI_LIVE_CREATE names AIB-1a, AIB-2 and AIB-4 only. Recommended default: add b#815 (and agent126/b-aibsub-126) to the FLIP preconditions.

**C (never block)**
- C-809-1: `rationale: response.text.slice(0, 1000)` stores the raw model reply on the draft. This is pre-existing gateway behaviour. The reply is coach-tenant only, but SAFE 10 says "diff and reasons only".
- C-809-2: under the screening flag, `add_exercise` (for example from more_volume) is not blocked; only increases on existing rows are. The coach still approves, and mobile shows the banner from `screening_flag`.
- C-809-3: the 429 from `@Throttle` uses the global throttler copy, not a route-specific message. Reaching 60/h is rare.
- C-809-4: the copy 'Ask AI is paused for maintenance' is also used when the switch is simply not flipped yet.
- C-809-5: weekly set caps are not enforced and a plan with no head revision answers 409. Both are known and listed in the PR. C (edge, deferred to 10k clients).
