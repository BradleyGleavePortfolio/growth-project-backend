FIX ROUND 1 (OPENING) (B-AIB5P-126, agent 126) — growth-project-mobile#439 @ 030e5721f439608f5422776039fdec8a743170c6 — READY FOR AUDIT

Round 2 for job B-AIB5P-126 (operator 18:20): fixes the two SAFE-AIB-PRE-126 blockers against the REAL backend shapes on b#809 c0984e2a. This replaces the 63417260 READY. Main 950689af unchanged.

- B1: a coach taps Apply, the server edits the workout, but the app parsed the approve reply as a format error and kept the old rows. The approve reply is the AiActionDraft row; `materialised_ref` is the plan id STRING (edit-workout-plan.materialiser.ts returns `ref: editedPlanId`). Now `materialised_ref: union(section 3 object, string)`; a string maps to null, so the screen re-reads the plan (runReplayRefetch) and shows "Applied N changes." without Undo. The section 3 object (with lock_token) still adopts the head with Undo.
- B2: Shorten, Explain or any reorder always failed. b#809 sends `exercise: null` for remove/reorder/meta and `draft_id: null` for explain. Both nullable now; removed cards show the exercise name resolved from `before.exercise_external_id` (CoachExerciseName), reorder "New order", meta "Workout details"; explain shows the summary and Done with no apply or reject call.
- U: `context_used` keys read as words ("Using your exercise library, this workout"); 503 `AI_NOT_CONFIGURED` (model did not answer) shows the server copy instead of "paused for maintenance".
- `run()` now takes `z.ZodType<T, z.ZodTypeDef, unknown>` so the transforming schema typechecks.

Specs with the exact b#809 shapes (aiBuilder.test.tsx): proposal with removed/moved/meta changes, `exercise: null` and a PlanExerciseSnapshot `before`, approved with the AiActionDraft row (`materialised_ref: 'plan-1'`) -> onApplied(null, 3), no error line; explain `draft_id: null` -> Done, no PATCH; 503 AI_NOT_CONFIGURED -> server. Both new cases fail at 63417260 (zod contract error).
Round 1 states kept: paused/not_configured -> paused copy, no prompt, no propose; status unreadable -> Try again; only a 404 hides the entry.

Size: 798 changed lines (9 files). CI at this head: Typecheck, lint, test success (640 suites, 8622 tests), CodeQL success.
Open item: b#809 is still a draft over the size cap, so its shapes may move; the app accepts both the string and the section 3 object for `materialised_ref`.
