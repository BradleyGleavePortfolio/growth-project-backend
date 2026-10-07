**Tier:** T4 (AI egress, client health data, money metering).
**Why:** SAFE-MWBAI-125 blocker 1 (the model did not write the diff) and AI master builder plan AIB-2: `POST /ai/gateway/workout-builder/propose`.
**T4 trigger scan:** AI provider egress (box-2 consent via the gateway `AiEgressService.assertMaySend`), client injuries/screening (enums and one boolean only), coach AI budget (gateway meter, b#805), new provenance marker on drafts.
**T3 trigger scan:** new coach/owner route (throttle 60/h), new controller + provider in AiGatewayModule.
**Bounded T1:** pure validator, constants and prompt modules.
**Canonical builder:** Claude Opus 5.5 (HS-AIB2-125 head start, B-AIB2-126 agent 126 finished it).
**Acceptance evidence:** CI on this head; `test/aib2-workout-diff.validator.spec.ts` (11) and `test/aib2-workout-builder-ai.service.spec.ts` (9) pass locally; SAFE 1-12 map below.

Flag state: FEATURE_MWB_AI_LIVE_CREATE stays unset (off): the route answers 503 `AI_PAUSED` before any read, provider call or draft. No manifest or env change (AIB-4, b#808 merged, owns the status route and manifest). main (2df556b7, b#808) is merged in.

**Split (operator 17:56):** this PR is the generator only. Subset approval (`accepted_change_ids`), the team-coach marker check and the `materialised_ref` the builder adopts are in the stacked PR on `agent126/b-aib2b-126` (base = this branch; retarget to main when this merges). **Both must merge before the FLIP**: without the stacked PR, Apply applies every change even if the coach unticked some, and the approve response is the Prisma row (`materialised_ref` = plan id string).

## What it does
1. `src/ai/gateway/workout-builder/workout-builder-ai.service.ts` gates in order: flag 503 `AI_PAUSED` -> coach/owner -> client tenancy 404 -> plan tenancy 404 -> lock token 409 `REVISION_STALE` (only when `lock_token` is sent) -> capability allow-listed 503 `AI_NOT_CONFIGURED` -> gateway (roster, box-2 consent 403, budget 403, meter) -> validator -> one repair attempt -> 422 `AI_NO_SAFE_PROPOSAL`.
2. `ai-gateway.service.ts`: `resolveProposedAction` hook. The model's reply, validated by the caller, becomes the draft payload; the gateway adds the `workout_builder_model_diff` provenance marker and strips any caller-supplied marker. `explain` writes no draft.
3. `workout-diff.validator.ts`: schema -> library id -> hard bounds -> loads -> screening/deload -> contraindications -> pure-applier dry run -> 14 exercises / 12 hard sets per muscle. Invalid ops are dropped with a reason.
4. Section 4: max_tokens create 8,000 / edit 6,000 / explain 1,500; no temperature (the gateway Anthropic adapter sends none; thinking/effort are pinned globally in coach-ai.constants, so per-mode effort is not possible without an adapter change).

## Fixed on this head (agent 126 run)
- CI red on c0984e2a (Type-check): `ai-approval.service.ts(242)` InputJsonValue and the spec's untyped provider mock. The approval file left this PR; the spec mock is typed.
- `WorkoutBuilderAiService` was never registered as a provider (`ai-gateway.module.ts:78`), so the app would not have booted with the controller. Fixed.
- Mobile builder needs (HS-AIB5-125): propose accepts a request without `lock_token` (stale check skipped only then; the edit materialiser still re-checks `base_revision_index`), `workout-builder-ai.service.ts:71-72`.
- U1 (SAFE-AIB-PRE-126): a `plan_meta` rename whose name makes a medical claim ("Knee rehab day") is dropped with "Workout names cannot make medical claims." (`workout-diff.validator.ts:65`). Story: Ask AI renames a workout with a medical claim, the coach applies and assigns it, and the client sees it.
- `credits_remaining_pct` now comes from the AIB-4 status service, so propose and the status route show the same number.

## Response shape changes (for B-AIB5P-126 / m#439)
- `changes[].exercise` is never null now: `remove_exercise` carries the removed exercise (`before.exercise_external_id`), `reorder` -> `{ id: '', name: 'Exercise order', thumbnail_url: null }`, `plan_meta` -> `{ id: '', name: 'Workout details', thumbnail_url: null }`; an id outside the seed library is named "Exercise in this workout" (`workout-diff.validator.ts:151-153`).
- `draft_id` is still `null` for Explain (no draft is written). Mobile must accept null there.
- Everything else is unchanged.

## SAFE checklist 1-12 (file:line on this head)
1. Consent: `subjectUserId: input.client_id` (`workout-builder-ai.service.ts:101`) -> gateway box-2 `egress.assertMaySend` before the provider call (`ai-gateway.service.ts:240`), re-read in the Anthropic adapter. Spec: "no box-2 grant -> 403 before any provider call".
2. Minimisation: `loadClientContext` (`workout-builder-ai.service.ts:147-160`): goal, experience, equipment (12 x 40 chars), days/week, injury enums, screening boolean. No name, email, phone, weights, snacks or message excerpt. Spec asserts the system prompt holds no instruction/email/snack.
3. Tenancy: client via `canAccessClient` (`:58`), plan must be the tenant's and not archived (`:65`). Gateway roster check runs again.
4. Human in the loop: the model output becomes a pending AiActionDraft (`ai-gateway.service.ts:397-405`); approval is forced for both workout capabilities (`ai-gateway.config.ts:83`, b#808); nothing is applied or assigned by this route.
5. Prompt injection: instruction and rows go in the user turn as JSON (`workout-builder-prompt.ts:57`), system prompt says they are data (`:37`); the reply is parsed only as `{summary, changes[{op, reason}]}` (`:64`); capability and target ids are set by the server (`workout-builder-ai.service.ts:125-127`).
6. Output validation: `validateProposedChanges` (`workout-diff.validator.ts:98`), dry run with the pure applier (`:130`), one repair attempt (`workout-builder-ai.service.ts:94`), then 422 (`:138`).
7. Domain safety: library ids only (`validator.ts:123`), hard bounds (`:41`, `training-safety.constants.ts:8`), no invented loads (`validator.ts:72`), screening/deload blocks increases (`:84`), contraindication table (`constants.ts:19`, `validator.ts:88`), medical claims removed from summary/reason/notes and plan names (`constants.ts:35`, `validator.ts:65,148`), system prompt forbids them (`prompt.ts:35`).
8. Cost: both capabilities metered by the gateway (b#805); propose throttle 60/h per user (`workout-builder-ai.controller.ts:35`); at most two provider calls per propose, each metered. Spec: budget debited once.
9. Kill switch: `isMwbAiLiveCreateEnabled()` first (`workout-builder-ai.service.ts:53`), read per call; spec "flag off -> 503 before any read or draft".
10. Logs: prompt/response stored as SHA-256 hashes only (`ai-gateway.service.ts:312,479`); no instruction, context or health values in log lines.
11. Store/legal: no medical claims (item 7); label "AI-suggested, coach-approved" comes from the AIB-4 status route; this route returns no purchase wording.
12. Mobile reachability: no EXPO flag; m#439 calls this route; status 404 on older backends hides the entry.

## Known, not in this PR
- B4 (SAFE-AIB-PRE-126): a sub-coach is refused (plan must be the head coach's; the draft's tenant is the head coach). Waiting on an owner decision; recommended default: hide Ask AI for sub-coaches on 10-07, full support v1.1.
- C: plan with no head revision answers 409 (old plans only); weekly set caps not enforced; no `aiRequestAudit` row when the resolver throws after a real call.

Size: 785 changed lines (cap 800).
