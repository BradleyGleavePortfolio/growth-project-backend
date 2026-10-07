# FU-WORKLOG2-126 — workout logging pass 2 (agent 126)

Worker: Claude Opus 5.5. Start 18:33 PDT 10-06. Hard stop 19:40.
Base: mobile origin/main 7a51f0a0 (includes m#444), backend origin/main fdf4260a (code read in RO-backend f71bb9a4; src/workout unchanged since).
Not redone: everything in FU-WORKLOG-126.md (m#444 merged, b#814 open).
Status: DONE 18:57 PDT. Both PRs CI green and READY FOR AUDIT.

## Scope traced (screens + routes)
- Coach sees a finished session: ClientDetailScreen -> WorkoutsTab (GET /coach/clients/:id/summary `recent_workouts`: WorkoutSession + ExerciseSet, take 10, created_at desc; mapCoachWorkoutSessions) and TimelineTab workout events (GET /coach/clients/:id/timeline `workouts`, 90 days).
- Personal records: live "Session summary" card + Finish alert ("Recent best", workoutSummary vs last 50 workouts). ProgressChartCard PR detection is mounted with enablePRDetection={false} (weight chart only); no PR screen exists.
- History: WorkoutScreen Recent Workouts (GET /workouts?limit=5), 50-workout chart window, WorkoutHistoryEditScreen (PUT /workouts/:id replace-all), delete (DELETE /workouts/:id). Backend WorkoutService.getWorkouts/updateWorkout/deleteWorkout.
- Rest timer (wall-clock anchor, +30 s, Skip, per-exercise 60/90/120, AppState refresh, haptic at 0) and Swap (logged sets stay, replacement gets remaining sets, rest kept) copy and states.
- Assigned workout opened twice: From your coach card -> WorkoutAssignmentDetail (Start hidden once completed_at; ['assignments'] invalidated after completion) -> ActiveWorkout restore-on-mount prompt, WorkoutSyncCards resume card (resumeParams), server completeAssignment (completed_at null guard + idempotency key).

## B list
- None found in this pass.

## U list (all fixed unless noted)
- U1 (m#448): a coach opening a client's Workouts tab after a session saw only counts (exercises, sets, total volume) and names, never the weights/reps per set or the client's notes. Now each exercise shows "3 sets · 135 lb x 8, ..." plus "Client note" and "Workout note".
- U2 (m#448): coach card showed "0 min" when no duration was recorded. Now omitted.
- U3 (m#448): coach Timeline said "Logged" under every workout. Now "4 exercises · 52 min".
- U4 (m#448): a client who started the coach's workout, left, then tapped Quick Workout (or a routine / another coach workout) and Resume on "Resume workout?" got the sets back but the entry's name and assignment: saved as "Quick Workout" and the coach's assignment never marked done (or another assignment marked done with the wrong sets). Resume now carries the saved workout's name, plan and assignment (navigation.setParams).
- U5 (m#448): Recent Workouts stopped at the 5 newest; nothing older could be seen, edited or deleted. "Show older workouts" lists the 50-workout window already loaded.
- U6 (m#448): the note written at Finish was visible only in Edit. History card now shows "Note: ..." and exercise notes.
- U7 (m#448): Swap with a failed exercise list said "try Add Exercise again". Now "try Swap again".
- U8 (b#818): same-day workouts tied on `date` (@db.Date) and came back in any order, so the just-finished workout could sit below the morning one and "previous sets" could read the older one. Now `date desc, created_at desc`.
- U9 (not fixed, small, needs a product call): WorkoutAssignmentDetail says "Start workout" even when a session for that assignment is already in progress on the phone (tapping it shows the Resume prompt, so nothing is lost). Smallest fix: read loadActiveWorkoutSession(userId) and label "Resume workout" when session.assignmentId === assignmentId.
- U10 (not fixed, feature-sized): no personal-records or full-history screen; PRs appear only in the live summary ("Recent best", last 50 workouts). ProgressChartCard PR detection is off for lifts (only weight is charted).

## C one-liners
- C (edge, deferred to 10k clients): ExerciseSet has no order column; exercise order on read relies on insertion order.
- C (edge, deferred to 10k clients): ActiveWorkout already mounted and a different assignment's Start updates route params without re-seeding (two assignments, mid-workout, cross-tab).
- C (edge, deferred to 10k clients): an assigned workout finished offline stays "From your coach" until sync, so it can be started again.
- C (edge, deferred to 10k clients): coach plan rest 0 s shows "Rest: 0s · From the plan" and no timer.

## Covered by open PRs
- None of the above. m#443 (AIB-6) also edits WorkoutsTab.tsx (top: AI button + props); hunks are separate, named in the m#448 body.

## PRs opened
- mobile m#448 `agent126/fu-worklog2-126` head 75fd7b35f8c444a1aba43f8a0d379076ab54b6db, 395 lines (379+/16-, 233 tests). CI: GREEN (Typecheck, lint, test; CodeQL) at 18:53; READY comment posted 18:53 (issuecomment-6029199914).
  Local: workoutLogging2126 11/11, workoutLogging126 5/5, workoutLoggingUx124 13/13, ActiveWorkoutScreen.persistence 40/40, romanP3HostWiring 35/35, coachCheckInReviewFu126 9/9, coachFoodConsent124 2/2, checkInSubtitle 3/3; eslint 0 errors.
- backend b#818 `agent126/fu-worklog2-126` head 2e7d8de69cef6d13bedbd8e4cedc2dc4f7151802, 39 lines (38+/1-). CI: GREEN (all checks; deploy-readiness-gate skipped) at 18:56; READY comment posted 18:56 (issuecomment-6029243262).
  Local: workout-history-order-fu126 1/1, workout-routines-ux124 8/8; eslint clean.

## Not fixed (needs operator)
- U9 WorkoutAssignmentDetailScreen.tsx:227 "Start workout" label while a session for the same assignment is in progress (see above).
- Prior-pass items still open: U6 HomeScreen.tsx:400-425, U7 assign-workout.materialiser.ts:277 / assign-meal-plan.materialiser.ts:188 (FU-WORKLOG-126.md).

## HANDOFF
Done. m#448 and b#818 are CI green with READY FOR AUDIT comments posted. Worktrees removed after a clean git status (both branches pushed). No ci/* branches created. Notify line written to ops/lanes126/notify/FU-WORKLOG2-126.txt.
Next owner actions: audit/merge m#448 before the 10-07 build (m#443 edits the top of WorkoutsTab.tsx in separate hunks; rebase whichever lands second). b#818 needs a backend deploy to take effect; m#448 does not depend on it.
