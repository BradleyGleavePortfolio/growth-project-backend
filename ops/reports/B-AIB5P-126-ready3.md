FIX ROUND 2 (B-AIB5P-126, agent 126) — growth-project-mobile#439 @ 63076852ff2c957333666a94a1f5d61c8a4424ef — READY FOR AUDIT

Fixes B-439-1 (LM-SOL-126 REQUEST CHANGES at 030e5721) and takes in the b#815 approve shape (operator 18:47). Merged origin/main ad08af9b first (no conflicts).

B-439-1: a coach applies an AI change, the reply is the plan id only, and after the reload the builder still showed the old sets with Save blocked.
- Cause: the null-ref path called runReplayRefetch, which bumps refetchSeq before the GET. The adoption effect consumed that bump against the cached plan and ignored the fresh result.
- Fix (CoachWorkoutBuilderScreen aiOnApplied): always await `refetchPlan()` and adopt that result directly. The sequence is never bumped, so the cached copy cannot be adopted.
  - With a head token (b#815 `materialised_ref { plan_id, revision_index, lock_token }`): `adoptServerHead`; the toast offers Undo (the real undo route).
  - Without one (b#809 string, or b#815 with no lock_token when the autosave secret is unset): `autosave.rebaselineTo(fresh copy)`; undo/redo history resets; the next save fast-forwards its token via the hook's 409 path.
  - Only a failed read falls back to runReplayRefetch (the existing refresh affordance).
- Regression (coachWorkoutBuilderUndo.test.tsx "b#809 plan id reply"): the query keeps the cached pre-Apply plan while the GET is pending, then delivers a fresh plan with sets 4; asserts Sets shows 4, no toast Undo, and Save sends sets 4. Fails at 030e5721 (Received "3"), passes here. The head-token Undo test shares the same helper.

Shapes accepted (b#809 @ 8b82ead8, b#815 @ b83e0357), all in specs: approve `materialised_ref` string or object (lock_token optional, 16 hex, matching lock-token.helper); `exercise` null (c0984e2a) or `{ id: '', name: 'Workout details' }` (8b82ead8); `draft_id: null` for Explain (Done, no PATCH).

Size: 792 changed lines (9 files). CI at this head: Typecheck, lint, test success (648 suites, 8696 tests), CodeQL success.
C (edge, deferred to 10k clients): on the no-token fallback, the first edit after an earlier save gets one rebased 409 ("Edited elsewhere" briefly). Not reachable with b#815 deployed and the autosave secret set.
