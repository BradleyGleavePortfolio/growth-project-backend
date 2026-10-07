# HS-AIB5-125 (head start on B-AIB5-126): Ask AI in the workout builder

Started 17:10 PDT 10-06 (times from `TZ=America/Los_Angeles date`). Builder: Claude Opus 5.5, agent 125 worker.
Branch agent126/b-aib5-126 (from mobile main 950689a), worktree /home/user/workspace/wt/HS-AIB5-125-mobile.
PR: growth-project-mobile#439 @ c138b4c4803e536bfd29f3e4c0e82ccec770ad08, CI green, marked ready, READY comment posted 17:40. Worktree left in place (clean, pushed) for agent 126.

## Scope traced
- CoachWorkoutBuilderScreen (autosave hook, undo/redo stacks, settleHistoryHead, runReplayRefetch, adoptServerHead, readHead)
- Backend contract from plan section 3 (routes not built yet: AIB-2 propose, AIB-4 status). Existing PATCH /ai/gateway/drafts/:id body `{ decision }`.
- eas.json production + clinic: EXPO_PUBLIC_FF_MWB_AUTOSAVE=true, so the entry is reachable in the store build.

## What was built (797 changed lines, 9 files)
- src/api/aiBuilderApi.ts, src/components/coach/ai-builder/{aiBuilderCopy.ts, useAiBuilder.ts, AiBuilderSheet.tsx (includes ChangeCard)}
- CoachWorkoutBuilderScreen.tsx: one hunk (header Ask AI, pinned prompt bar, prepare/flush, adopt after apply + undo step, toast Undo)
- Tests: ai-builder/__tests__/aiBuilder.test.tsx (10), coachWorkoutBuilderUndo.test.tsx (+3 Ask AI), status-404 mocks in the
  Autosave and RowIdAdoption specs.

## B list / U list
None found (this was a build job). C: none.

## Covered by open PRs
None. No open mobile PR touches CoachWorkoutBuilderScreen or the ai-builder folder.

## Not fixed (needs operator)
1. AIB-2 should return `materialised_ref.lock_token` on approve. Without it the builder re-reads the plan and the toast has no
   Undo (the header Undo history resets on the next save). Smallest fix: in the edit/create materialiser result, add
   lockTokenFor(planId, version, head_revision_id) from src/workout-builder/lock-token.helper.ts.
2. AIB-2 must accept a propose request without `lock_token`. The builder leaves it out until it learns the real token from the
   first autosave.

## HANDOFF
Continue on branch agent126/b-aib5-126 (merge main in, never rebase or force-push). Read the PR #439 checklist. If CI is green
and the READY comment is posted, the next step is the lens pair at the exact head, then merge before the 10-07 build.
