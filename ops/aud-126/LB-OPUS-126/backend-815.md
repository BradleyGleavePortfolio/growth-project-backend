AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#815 @ b83e035776624d4b76d3e94c9b3a43433c3b9101 — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (10 SUCCESS, 1 SKIPPED; fewer workflows run because the base is the b#809 branch, not main); mergeable clean. Size 171 lines (168+/3-). This PR is stacked on b#809 (base agent126/b-aib2-126) and must be retargeted to main once b#809 merges.

**T4 checks**
- Who may approve:
  - The tenant coach may now decide their own AI workout-builder draft through `isWorkoutBuilderModelDraft`. That needs a live-create capability AND the provenance source `workout_builder_model_diff`.
  - Only the gateway can add that marker: b#809 strips any caller-supplied provenance with that source, and `resolveProposedAction` is used only by WorkoutBuilderAiService after server-side validation.
  - A coach using the generic gateway route with their own `proposedActionPayload` still hits the no-self-approval rule.
  - The tenant, subject-roster and payload-client checks in `decide` run before this and are unchanged.
  - This fixes the dead end on b#809 alone, where a head coach with an active sub-coach could not apply their own AI suggestion.
- Subset approve (`accepted_change_ids`):
  - The controller accepts only `c<1-3 digits>` strings (at most 400), else 400.
  - The service refuses it (400 `ACCEPTED_CHANGES_UNSUPPORTED`) on anything other than a live-create draft with a `diff` array, and an empty subset is 400 `NO_CHANGES_ACCEPTED`.
  - The ids map to diff indices exactly as b#809 numbers them (`change_id = c<i>`, `diff = changes.map(op)`).
  - A `reorder` is kept only when every other op is kept.
  - The subset goes through the same materialiser, which re-asserts the payload and checks `base_revision_index`. The stored payload becomes the applied subset only when the status flip commits.
- `materialised_ref`:
  - It is returned only for an approved model-written workout draft, as `{plan_id, revision_index, lock_token?}`.
  - The lock token is the same HMAC autosave already gives this coach for this plan. If the secret is missing, the token is left out and the builder re-reads the plan instead.
  - Other drafts keep the old response.
- Approve without `accepted_change_ids` behaves exactly as before (apply every change).

**C (never block)**
- C-815-1: if the coach keeps a "changed" card for an exercise whose "added" card they unticked, the subset fails the materialiser dry run. The draft stays pending and an error is shown. Rare model output. C (edge, deferred to 10k clients).
- C-815-2: once approved, the draft row's `payload` is overwritten with the subset, so the full original proposal is kept only in `rationale` (first 1,000 characters of the reply).
