FIX ROUND 1 (B-PRG2-122, agent 122) — growth-project-mobile#356 @ d38b4a7045da9c8aa0bec262adba2428dc8da287

Prior head 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5. Changes since then: merge of the new #355 head 36fd39d9eea8f4603358734a3e6c53905310992d (`95aeeebd`, clean, no conflict hunks; brings main 203e80e3 and the #355 fixes), then one fix commit `d38b4a70`. Job: B-PROG2-120 under the operator 122 rulings (JOBS122.md "Programs (step 6)").

**Fixed**
- **Opus B-356-2 (Check again refusal reported as "nothing was undone")** — `CoachWorkoutBuilderScreen.tsx` `sendHistoryRequest`: on a retry (`isRetry`), only a 200 or a parsed head-moved answer settles the outcome; any other answer (401/403/404/429/plain 409) keeps the `unconfirmed` gate and editing paused. `workoutBuilderUndo.ts` `describeUnconfirmedHistory` gains a session-ended branch: "Your session has ended, so the app could not confirm whether the change was undone. Editing is paused so nothing is lost. Sign in again, then open this workout to see the latest saved version."
  Normal-user story fixed: a coach whose Undo lost its response taps Check again after the session expired and is no longer told nothing was undone while the undo may have landed.
- **Opus B-356-1 (mobile side)** — `isUnknownHistoryOutcome`: a `conflict` whose body names `undo_head_moved` but carries no parsed head/token is an unknown outcome (editing paused, Check again), never a definite refusal. Together with #355 (`undo()` throws `contract`/409 for that body, and parses the B-MWB409-122 envelope with `head_revision_index` + `lock_token` when present), the screen reads the head index and lock token the backend PR returns and fails truthfully until it ships.

**Not fixed (operator 122 rulings: C (edge, deferred to 10k clients))**: Sol #356 "Undo races an explicit Save"; Sol #356 "HTTP 408 reopens editing". Opus C-356-1..3 and Sol C-356-1/C-356-2 stay follow-ups.

**Tests (each fails on 40ee678a)**: `coachWorkoutBuilderUndo.test.tsx` — B-356-2 (network unknown, then Check again refused 401: no "nothing was undone", session copy, editing paused, Check again still offered); B-356-1 (`undo_head_moved` 409 without head/token: could not confirm, editing paused). `workoutBuilderUndo.test.ts` — bare `undo_head_moved` conflict is unknown, parsed one is not; session-ended unconfirmed copy. Local heavy.sh runs: workoutBuilderUndo 18/18, coachWorkoutBuilderUndo 13/13.

**CI lane** (both lenses' saved probes + 11 related suites at this head): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387504253 — 181 passed / 10 failed, every failure expected:
- P356-B and P356-C (Opus): pass.
- P356-A (Opus): now `kind contract, status 409, unknown true`; its last assertion (`headMoved` defined) passes once B-MWB409-122 deploys, because today's envelope carries no head/token.
- P356-D (Opus): its "Tap Undo again" intent holds; it fails only at `mock.calls[1]` because the first answer now holds the editor behind Check again, so the second identical Undo request is never sent.
- Sol AUD-SOL-P12-120 history boundaries, 4 failing: Undo vs in-flight Save and HTTP 408 (both ruled C), other-session one-step false confirmation (Sol C-356-1) and post-unmount refetch (Sol C-356-2).
- All in-PR suites pass: coachWorkoutBuilderUndo, coachWorkoutBuilderAutosave, useAutosave, workoutBuilderUndo, workoutBuilderAccess, workoutAutosaveApi, programsApi, programErrors.

**Size**: 1,580 changed lines vs #355 (grandfathered 3,000).
**PR CI at this head**: Typecheck, lint, test success (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387743215/job/112025218859).
**Stack**: `ops/lanes122/notify/programs.txt` written for B-PRG4-122 (#357/#358 merge this head).

READY FOR AUDIT
