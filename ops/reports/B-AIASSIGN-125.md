# B-AIASSIGN-125 — "Approve & assign" really assigns (AUDIT-14 B1)

Builder: Claude Opus 5.5, agent 125 worker. Start 15:42 PDT 10-06, hard stop 16:20.
Base: backend origin/main a6f4b5a9.

## Scope traced (screens + routes)
- Client detail > Coach AI > Generate workout program > AIWorkoutDraftScreen "Approve & assign" -> POST /coach/ai/drafts/:id/approve
  (CoachAIController.approve -> CoachAIService.approveDraft -> materializeWorkoutProgram -> WorkoutBuilderService.createPlan/setExercises).
- Assignment fan-out reused: WorkoutBuilderService.fanOutProgramPlans (ClientWorkoutAssignment + ClientWorkoutAssignmentSnapshot per plan),
  notifyProgramAssigned (WORKOUT_ASSIGNED push). Client zone: notifications/recipient-timezone.ts resolveRecipientTimeZone.

## B list
- B1 (AUDIT-14): a coach approves an AI workout program, is told it was assigned, and the client never receives a workout (only
  unassigned library plans were created). FIXED in b#806.

## U list
- none new.

## C one-liners
- C (edge, deferred to 10k clients): assignment tx failure after plan creation leaves orphan plans in the coach library (draft returns to DRAFT; retry works).

## Covered by open PRs
- None. Checked all open backend PRs for coach-ai / workout-builder.service.ts: only #587/#593 (old RLS/scout stack) and #605 (coach-ai.module.ts) touch nearby files; no overlap in logic. Overlap named in PR body.

## PRs opened
- b#806 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806 — branch agent125/b-aiassign-approve-assigns,
  head 3c224d8efed34eb5ffbbcfdd5d07bd59962bd840, 390 lines (+371/-19), 5 files. First head de58a499 failed "Banned cast tokens (R75)"
  (+1 `as unknown as` from a copied payload cast); fixed at 3c224d8e by reusing the single cast (net 0). CI at 3c224d8e: all green (16 success,
  deploy-readiness-gate skipped). READY comment 15:59: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806#issuecomment-6026995144
  - approveDraft (WORKOUT_PROGRAM): tenancy re-check, conditional DRAFT->APPROVED claim, plans created, ONE tx writes one assignment +
    snapshot per plan (offset (week-1)*7+(day-1)) and stamps APPROVED+approvedAsId, one push after commit, returns assigned_count.
    Double tap: replay after completion, 409 while in flight; claim released on failure.
  - Start: next Monday 09:00 client zone (UTC fallback) unless payload.start_date (YYYY-MM-DD). src/ai/coach/ai-program-start.ts.
  - WorkoutBuilderService.writePlanAssignmentsInTx (20-line public wrapper).
  - Tests: test/ai/coach-ai.controller.spec.ts 5 new tests fail on main, 12/12 pass here; test/ai/ai-program-start.spec.ts 4/4. eslint clean (targeted).

## Not fixed (needs operator)
- Owner decision (AUDIT-14 asked for one): start date. Built per JOBS125 = next Monday in the client's zone. Recommended default: keep.

## HANDOFF
- Complete. b#806 READY FOR AUDIT at 3c224d8efed34eb5ffbbcfdd5d07bd59962bd840 with green CI (READY comment 15:59). Worktree
  /home/user/workspace/wt/B-AIASSIGN-backend removed after push (no unsaved work); branch agent125/b-aiassign-approve-assigns stays.
  No ci/* lane branches created. Next: L4 lens pair reviews b#806; merge pairs with mobile m#425 (copy switches on assigned_count).
