Tier: T3 (client and coach workout logging views, mobile only; no money, auth, PII or AI logic)
Why: owner 12:01 10-06 "TOP PRIOTY for the food and workout logging to be kick ass". Job FU-WORKLOG2-126 (agent 126), second pass after m#444 / b#814: the coach seeing a finished session, history, rest timer and swap copy, an assigned workout opened twice, the client's own history.
T4 trigger scan: none. No auth, tenancy, money, credentials or destructive data paths. Reads only fields the app already receives (GET /coach/clients/:id/summary `recent_workouts` and GET /coach/clients/:id/timeline `workouts` already carry `notes`, `duration_minutes` and per-exercise `notes`; GET /workouts?limit=50 is already called for the chart).
T3 trigger scan: coach client detail Workouts tab (WorkoutsTab, types, useClientDetailData timeline line), client Workouts tab (WorkoutScreen Recent Workouts), live workout (ActiveWorkoutScreen Resume prompt and Swap failure copy), pure helpers (utils/workout/workoutLogging). Works against the CURRENT production backend (f71bb9a4): no new routes, no new fields. No flags; eas.json unchanged.
Bounded T1: copy ("Client note: ...", "Workout note: ...", "Note: ...", "Show older workouts" / "Show recent workouts only", "4 exercises · 52 min", "try Swap again").
Canonical builder: Claude Opus 5.5 (FU-WORKLOG2-126, agent 126).
Acceptance evidence: new `src/__tests__/workoutLogging2126.test.tsx` (11 tests; they fail on main: the helpers do not exist, the coach card has no set lines or notes, there is no history toggle). Run locally one file at a time: workoutLogging2126 11/11, workoutLogging126 5/5, workoutLoggingUx124 13/13, ActiveWorkoutScreen.persistence 40/40, romanP3HostWiring 35/35, coachCheckInReviewFu126 9/9, coachFoodConsent124 2/2, checkInSubtitle 3/3. eslint on changed files: 0 errors (1 pre-existing warning). Full CI runs on the PR.

Size: 395 changed lines (379 additions, 16 deletions), 233 of them tests.

## What it fixes
- U1 (coach sees a finished session): a coach opens a client's Workouts tab after the client trains and sees only "3 exercises, 9/9 sets, 4,200 lbs" and a list of names, never which weights and reps were lifted or the note the client wrote. Now each exercise shows "3 sets · 135 lb x 8, 145 lb x 6, 145 lb x 6", the client's exercise note ("Client note: ...") and the workout note ("Workout note: ...").
- U2: a workout saved without a duration showed "0 min" on the coach card. The duration now shows only when the phone recorded one.
- U3: the coach Timeline said "Logged" under every workout (WorkoutSession has no completed_at). Now it says what was done: "4 exercises · 52 min".
- U4 (assigned workout opened twice): a client starts the coach's workout, leaves, then later taps Quick Workout (or a routine, or another coach workout), gets "Resume workout? Found an unfinished workout ("Push A")" and taps Resume: the sets came back but the session kept the entry's name and coach assignment, so it was saved as "Quick Workout" and the coach's assignment never showed as done (or a different assignment was marked done with the wrong sets). Resume now carries the saved workout's own name, plan and assignment (navigation.setParams); the Workouts-tab Resume card already did this.
- U5 (client history): Recent Workouts stopped at the 5 newest, so a client could not see, correct or delete a workout from last week. "Show older workouts" now lists the 50-workout window the chart already loads (edit and delete work on every row); "Show recent workouts only" collapses it.
- U6: the note written at Finish was visible only inside Edit. The history card now shows "Note: ..." and each exercise note.
- U7 (swap copy): when the exercise list fails to load during a Swap, the alert said "try Add Exercise again". It now says "try Swap again".

## Overlap
- m#443 (AIB-6, agent 126) also edits `src/screens/coach/client-detail/WorkoutsTab.tsx` (adds the "Build a program with AI" button and two props at the top). This PR changes only the duration helper and the per-session body; the hunks are separate. Whichever merges second may need a trivial rebase.
- No other open PR touches these files.
