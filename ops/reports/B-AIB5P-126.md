# B-AIB5P-126 — m#439 Ask AI paused state, never hidden

Started 17:59 PDT 10-06 (times from `TZ=America/Los_Angeles date`). Builder: Claude Opus 5.5, agent 126 worker. Hard stop 18:50.
PR: growth-project-mobile#439, branch agent126/b-aib5-126, start head c138b4c4. Main 950689af (not moved; no merge needed).
Worktree: /home/user/workspace/wt/B-AIB5P-126-mobile (HS-AIB5-125-mobile did not exist), local branch agent126/b-aib5-126-local tracking origin/agent126/b-aib5-126.

## Scope traced
- useAiBuilder status load (mount only), AiBuilderSheet blocked states, CoachWorkoutBuilderScreen header button + prompt bar + aiPrepare (lock token).
- Backend b#808 status service: paused = FEATURE_MWB_AI_LIVE_CREATE not true; not_configured = flag on but neither capability resolves a real provider; no_credits; on.
- Visibility at c138b4c4 was already "only 404 hides" (status.loaded && value !== null); paused showed the paused copy.

## B list
None.

## U list (fixed in m#439 @ 63417260)
- U1: a coach opens the builder while the server switch is off with status `not_configured` and the sheet said "Ask AI is not set up on this account yet.", which is false (server switch, not the account). Now the paused copy, same as `paused`.
- U2: a coach on a weak connection opens the builder, the status read fails, and the sheet showed the prompt as if Ask AI were on with no way to re-check. Now the specific error line plus "Try again" (re-reads status; "Checking" while in flight); no prompt, no propose.
- Propose with no lock token: the screen now also treats an empty token as none (was only the bootstrap token); JSON drops the undefined key, so none is sent. Spec asserts the wire body has no lock_token.

## Round 2 (operator 18:20, SAFE-AIB-PRE-126 blockers, read against b#809 c0984e2a)
- B1 (fixed): a coach taps Apply, the server edits the workout, but the app parsed the approve reply (the AiActionDraft row, `materialised_ref` = plan id STRING, edit-workout-plan.materialiser.ts:324/340, ai-approval.service.ts returns `updated`) as a format error and kept the old rows. Now `materialised_ref: union(object, string)` -> string maps to null -> the screen re-reads the plan (runReplayRefetch); toast "Applied N changes." without Undo. The plan section 3 object still adopts the head with Undo.
- B2 (fixed): a coach taps Shorten, Explain or asks for a reorder and always got the format error. b#809 sends `exercise: null` for remove/reorder/meta (workout-diff.validator.ts, `exercise: exId ? {...} : null`) and `draft_id: null` for explain. Now both nullable; removed cards show the exercise name via CoachExerciseName from `before.exercise_external_id`; reorder "New order", meta "Workout details"; explain shows the summary + Done and makes no apply/reject call.
- U (fixed): context_used keys read as words ("Using your exercise library, this workout"); 503 `AI_NOT_CONFIGURED` (model did not answer) now shows the server copy, not "paused for maintenance".
- Type fix: `run()` takes `z.ZodType<T, z.ZodTypeDef, unknown>` so the transforming DecideSchema typechecks (verified with a standalone tsc repro).
- Specs (exact b#809 shapes): aiBuilder.test.tsx "b#809 shapes" (removed/moved/meta with exercise null + PlanExerciseSnapshot before; approve row with string ref -> onApplied(null, 3), no error); explain draft_id null -> Done, no PATCH; AI_NOT_CONFIGURED -> server. Local: aiBuilder.test.tsx 14/14, coachWorkoutBuilderUndo.test.tsx 18/18.
- Not covered at screen level (line cap): the null-ref path in CoachWorkoutBuilderScreen (re-read + toast without Undo); the hook test proves the parse.
- b#809 moved during this round (c0984e2a -> 8b82ead8 at 18:26): every card now names an exercise (`{ id: '', name: <label> }` when none), draft_id still null for explain; subset approve + the object `materialised_ref { plan_id, revision_index, lock_token? }` moved to stacked b#815 (b83e0357, draft). m#439 @ 030e5721 accepts all of these (nullable or named exercise; string or object ref; lock_token omitted or 16-hex).
- Operator item: if b#809 merges without b#815, the decide route ignores `accepted_change_ids`, so a coach who unticks a change still gets every change applied. b#809 and b#815 must both merge before the FLIP (b#815 body says the same).

## Round 3 (operator 18:39 FIX ROUND 2: Sol lens B-439-1; operator 18:47 b#815 shapes)
- B-439-1 (fixed): a coach applies an AI change, the server reply is the plan id only, and after the reload the builder still showed the old sets with Save blocked. Cause: the null-ref path called runReplayRefetch, which bumps refetchSeq before the GET, so the adoption effect consumed the bump against the cached plan and ignored the fresh one. Fix (CoachWorkoutBuilderScreen aiOnApplied): always await refetchPlan() and adopt that result directly. With a head token (b#815 object) adoptServerHead runs and the toast offers Undo. With no token (b#809 string, or b#815 object without lock_token) autosave.rebaselineTo(fresh copy) runs and the undo history resets. Only a failed read falls back to runReplayRefetch.
- Regression (coachWorkoutBuilderUndo.test.tsx): cached pre-Apply plan held during a deferred GET, fresh plan with sets 4 after it; asserts Sets shows 4, no toast Undo, Save sends sets 4. Fails on 030e5721 (Received "3"), passes at the new head. The head-token test shares the helper (applyOnce).
- b#815 @ b83e0357 shape checked: `materialised_ref: { plan_id, revision_index, lock_token? }`, token is the first 16 hex of the HMAC (lock-token.helper LOCK_TOKEN_HEX_LEN), matching RefSchema. b#809 @ 8b82ead8: every card has an exercise (`{ id: '', name: 'Exercise order' | 'Workout details' }` when none). The specs cover both exercise shapes, the string ref and the object ref.
- Merged origin/main ad08af9b (no conflicts).
- C (edge, deferred to 10k clients): on the no-token fallback, the coach's next edit after an earlier save gets one 409 that the hook rebases (the pill shows "Edited elsewhere" briefly). Not reachable once b#815 is deployed with the autosave secret.

## C one-liners
- Status is read once on mount; a kill-switch flip while the screen is open shows up via the propose 503 copy. C (edge, deferred to 10k clients).

## Covered by open PRs
None. No other open mobile PR touches ai-builder or CoachWorkoutBuilderScreen.

## PRs
- growth-project-mobile#439 @ 63417260 (round 1, CI green, READY posted 18:15) -> @ 030e5721f439608f5422776039fdec8a743170c6 (round 2) — 798 changed lines (9 files, additions only vs main). CI green (640 suites / 8622 tests, CodeQL). READY comment posted 18:27 (issuecomment-6028894779).
  Line savings to stay under 800: compacted aiBuilderApi.ts (run/field/getStatus/propose/types), one-line setRows mapping, test mocks.

## Not fixed (needs operator)
- Carried from HS-AIB5-125: AIB-2 (b#809) should return `materialised_ref.lock_token` on approve so the toast Undo shows at once; and must accept propose without `lock_token`.

## Not fixed (needs operator), round 2
- b#809 (backend, not mine): return `materialised_ref: { plan_id, revision_index, lock_token }` on approve so the toast Undo shows at once (the app already adopts it); optionally send `exercise` for removes (the app resolves the name from `before` meanwhile).
- Recommended default for the SAFE C item (sub-coach dead end): backend hides the entry for sub-coaches via status 404; no mobile change.

## HANDOFF
Branch agent126/b-aib5-126 at 63076852 (main ad08af9b merged in; never rebase/force-push). CI green (648 suites / 8696 tests, CodeQL); FIX ROUND 2 READY posted 18:51 (issuecomment-6029173791). Next: lenses at 63076852 -> operator merge before the 10-07 build. Worktree removed; no ci/* branches were created. Size 792 (8 lines headroom).

## PR state (latest)
- growth-project-mobile#439 @ 63076852ff2c957333666a94a1f5d61c8a4424ef, 792 changed lines, CI green, FIX ROUND 2 READY 18:51.
