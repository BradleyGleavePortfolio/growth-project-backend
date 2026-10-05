AUDIT Claude Opus 5.5 — growth-project-mobile#356 @ 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5 — VERDICT: REQUEST CHANGES

Agent 120, job AUD-OPUS-P12-120 (Opus lens, first full review). Tier: T4 (stacked on #355; the stack takes its highest tier). Size 1,501, under the grandfathered 3,000 ceiling. CI at this head: Typecheck, lint, test success.

A/B/C = 0/2/3

**B-356-1 — The undo fence (B-328-6) cannot work against the deployed backend.**
`src/api/workoutAutosaveApi.ts:236-240,505` builds `headMoved` only from a body that carries `head_revision_index` and `lock_token`. The backend's global HttpExceptionFilter strips both from the 409. Production f48267f9 sends `{"statusCode":409,"code":"undo_head_moved","message":"This workout changed after the undo was requested. Showing the latest saved version.","error":"undo_head_moved","timestamp":…,"path":…}` (backend probe https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343254265). Main ee55f814 behaves the same, because undo_head_moved is not on the error-details allowlist (https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343228885). The real api layer turns that body into a plain conflict with `headMoved` undefined. `src/screens/coach/workoutBuilderUndo.ts:109-114` then says "Another change to this workout was saving at the same moment, so nothing was undone. Tap Undo again." (probe P356-A, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343202834). Two cases follow:
- An undo commits but its response is lost. On Check again the screen reports "nothing was undone" and reopens editing on a stale head and token (P356-C).
- Another session moves the head. Every "Tap Undo again" resends the same stale fence and is refused the same way (P356-D).
The tests in this PR build `headMoved` by hand (`coachWorkoutBuilderUndo.test.tsx`; `workoutAutosaveApi.test.ts:413-433`), so the body production actually sends is never exercised.
Fix rule: (a) the backend carries `head_revision_index` and `lock_token` in the undo_head_moved HTTP body, tested through HttpExceptionFilter (the same backend change as B-355-1). (b) A 409 whose code or error is undo_head_moved but that has no usable head or token is never a definite refusal: keep the gate, refetch the plan, never say "nothing was undone" on a retry, and never offer a retry with the same fence. Test with the exact deployed envelope.

**B-356-2 — `src/screens/coach/CoachWorkoutBuilderScreen.tsx:1380-1387`: on Check again, any definite refusal is read as proof that the first request did nothing.**
After an unknown outcome, the first undo may have committed. A refusal of the retry (401, 403, 404, 429 or a plain 409) says nothing about the first request. The screen still shows "Your session has ended, so nothing was undone. Sign in again, then use Undo.", clears the gate and reopens editing (probe P356-B, run 37343202834).
Fix rule: when `isRetry` is set, only a 200 or a parsed head-moved answer settles the outcome. Every other answer keeps the 'unconfirmed' gate and shows the next step for its cause (sign in, wait, ask for access) without claiming that nothing changed.

Follow-ups (C):
- C-356-1 `CoachWorkoutBuilderScreen.tsx:1369`: on a retry, `head === expectedHead + 1` is read as 'applied' even when a different session saved exactly once. Fix rule: confirm against the refetched head revision, or a server replay of the original request, before saying the undo applied.
- C-356-2 `CoachWorkoutBuilderScreen.tsx:745-746,1412`: `autosaveHasPendingRef` is assigned during render and read right after `await autosave.flush()`. A stale true shows HISTORY_WAIT_FOR_SAVE when there is nothing to wait for (the safe direction). Fix rule: read the pending state that flush resolves with (flush returns whether anything is still pending).
- C-356-3 `workoutBuilderUndo.ts:61-81`: a 408 (kind 'unknown', 4xx) counts as a definite refusal, while #355 `programErrors.ts:42` treats 408 as unknown. Fix rule: treat 408 as outcome-unknown in both.

Verified sound: the undo and redo stacks match backend semantics (target below head; an undo writes a new head); the history gate blocks edits, Save, the pill and the flush on leaving; explicit Save is unchanged; Sentry extras carry codes only.
Probes ran on audit/AUD-OPUS-P12-120/* lane branches cut from this exact head, with probe specs only (never merged).
