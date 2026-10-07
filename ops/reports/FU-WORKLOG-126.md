# FU-WORKLOG-126 — client workout logging on the 10-07 build (agent 126)

Worker: Claude Opus 5.5. Start 18:00 PDT 10-06. Hard stop 19:25.
Read-only code: backend main f71bb9a4 (fix branch from 2df556b7), mobile main 950689af. Flags: eas.json clinic (EXPO_PUBLIC_FF_ROMAN_CHAT true, MWB programs/autosave true).

## Scope traced (screens + routes)
- Workouts tab (WorkoutScreen): GET /routines, GET /workouts?limit=5|50, GET /workouts/volume, GET /assignments/me (react-query, staleTime 5 min), "From your coach" card, This Week tile, volume chart, muscle breakdown, Quick Workout, My Routines, Recent Workouts (edit/delete).
- Assigned workout: ClientWorkoutViewer / WorkoutAssignmentDetail (GET /assignments/:id, Roman set overlay, exercise names, coach notes, Start -> WorkoutTab/ActiveWorkout).
- Live workout (ActiveWorkoutScreen + active-workout/*): resume prompt, set logging (decimal weight, int reps), previous sets, rest timer (+30 s / skip / per-exercise 60/90/120), swap (logged sets stay), add/remove exercise, notes, finish summary + recent bests, POST /workouts (CreateWorkoutDto: reps IsInt, weight IsNumber), PATCH /assignments/:id/complete (idempotency UUID, open completion_payload).
- Offline: queueWorkout (expo-sqlite) -> "Saved on this phone" -> sync engine sends workout + assignment completion; WorkoutSyncCards.
- History edit (WorkoutHistoryEditScreen, PUT /workouts/:id), delete (DELETE /workouts/:id).
- Coach sees session: GET /coach/clients/:id/timeline reads workoutSession rows (90 days).
- Coach edit reaching client: detail reads the live plan; WORKOUT_ASSIGNED notification paths (workout-builder.service emitAssignmentPush, program-library pushProgramAssigned, AI assign-workout materialiser), pushTapData, mobile inbox normalizer + push router.

## B list
- B1 (mobile, FIXED m#444): a client whose app is already open, whose coach assigns a workout, goes to the Workouts tab and pulls to refresh, and the "From your coach" card never shows it until the app is force-closed (tab stays mounted, assignments query only refetched after finishing an assigned workout; no RN focusManager). WorkoutScreen.tsx (assignmentsQuery, onRefresh, focus effect).
- B2 (backend, FIXED b#814): a coach assigns a workout and the client's phone shows nothing, because every assign path wrote only an inbox row (createNotification channel 'push' stores a row; no worker sends it). workout-builder.service.ts:1723, program-library.service.ts:1444.

## U list
- U1 (FIXED m#444): the "Your coach assigned a new workout." inbox row did nothing on tap and was titled "Update" (notificationsApi.ts inboxScreenForKind/defaultTitleFor).
- U2 (FIXED b#814): a workout push tap (assigned or reminder) opened the notification center, not Workouts (notifications.service.ts pushTapData).
- U3 (FIXED m#444): This Week tile capped at 5 (counted the 5 most recent workouts).
- U4 (FIXED m#444): the coach's exercise note disappeared once the client tapped Start (only on the detail screen).
- U5 (FIXED m#444): "Rest: 45s · Coach target" on a client's own routine; now "From the plan".
- U6 (not fixed, needs operator): HomeScreen.tsx:400-425 shows "Explore the app" (to Log) instead of CONTINUE for a new client who has a coach-assigned workout but no logged workout yet (workoutExists reads GET /workouts only). Smallest fix: also treat a pending assignment (useMyWorkoutAssignments) as workoutExists. Left out: HomeScreen is shared with other FU lanes and its tests may render without a QueryClientProvider.
- U7 (not fixed, needs operator, T4 AI file): src/ai/gateway/materialisers/assign-workout.materialiser.ts:277 and assign-meal-plan.materialiser.ts:188 have the same inbox-row-only gap as B2 (no device push). Smallest fix: same `.then(() => notifications.sendPush({...}))` after createNotification. Not touched (AI gateway files, AI builder lanes own the area).
- U8 (not fixed): coach-assigned exercises are saved as muscle_group full_body (buildActiveWorkout seed has no muscle group), so the Muscle Breakdown card shows "-" for every muscle for clients who train only coach workouts. Needs a muscle field on the plan exercise or a catalog lookup; feature-sized.

## C one-liners
- C (edge, deferred to 10k clients): completeMyAssignment failing after a successful POST /workouts leaves the assignment pending (queued copy dropped on settle).
- C (edge, deferred to 10k clients): detail screen staleTime 5 min means a coach edit within 5 min of viewing needs pull-to-refresh.
- C (edge, deferred to 10k clients): createNotification 60 s per-kind throttle drops a second assignment row within a minute.

## Covered by open PRs
- None. m#439 (AIB-5) owns CoachWorkoutBuilderScreen/ai-builder, not touched.

## PRs opened
- mobile m#444 `agent126/fu-worklog-126` head 3ec7f0be4beb0185c3cb6b5f823dc05c2742eb13, 268 lines (256+/12-), CI green (Typecheck/lint/test, CodeQL, Analyze); READY comment posted 18:26.
- backend b#814 `agent126/fu-worklog-126` first head ba44c9aa (build-and-test Type-check failed on my new spec: the mock object cast did not overlap NotificationsService). Fixed with typed jest.fn mocks; head e27aa2374f5f41e7201f4f3e3936fcec70ae12bf, 104 lines (98+/6-), CI all green at 18:47; READY comment posted 18:47. Source unchanged between the two heads.
- Local: workoutLogging126 5/5, notificationsNormalize pass, romanP3HostWiring 35/35, workoutSync124.screen 7/7; backend fu-worklog-126-assignment-push 4/4, mwb-program-library 34/34; eslint clean on changed files.

## Not fixed (needs operator)
- U6 HomeScreen.tsx:400-425 (see above).
- U7 assign-workout.materialiser.ts:277, assign-meal-plan.materialiser.ts:188 (see above).
- b#814 needs a backend deploy to take effect; m#444 works with or without it.

## HANDOFF
- Done 18:48 PDT. Both PRs green and marked READY FOR AUDIT:
  - mobile m#444 @ 3ec7f0be4beb0185c3cb6b5f823dc05c2742eb13 (268 lines) — READY comment https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/444#issuecomment-6028890925
  - backend b#814 @ e27aa2374f5f41e7201f4f3e3936fcec70ae12bf (104 lines) — READY comment https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/814#issuecomment-6029125122
- Merge order: independent. b#814 needs a backend deploy to reach users; m#444 works on the current production backend.
- Worktrees FU-WORKLOG-126-mobile and FU-WORKLOG-126-backend removed after clean git status (all work pushed). No ci/* branches, locks or claims were used.
- Operator decisions: U6 (Home CTA for a client with an assigned workout but no logs), U7 (AI gateway assign-workout / assign-meal-plan materialisers send no device push; AI-lane files).
- Counts: B=2 (both fixed), U=8 (5 fixed, 3 not fixed), C=3.
