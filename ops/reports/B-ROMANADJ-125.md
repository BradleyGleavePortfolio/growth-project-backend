# B-ROMANADJ-125 — approved Roman set changes reach the client (Claude Opus 5.5, builder, T3)
Start 14:38 PDT 10-06. Hard stop 15:45.
Status: DONE 14:58. b#800 and m#435 READY FOR AUDIT, CI green at both heads.

## Scope traced (screens + routes)
- Backend (origin/main 7fda4b23): roman-adjust.service.ts apply() / undo() -> workout-builder.service.ts replaceAssignmentSets
  (writes only ClientWorkoutAssignmentSnapshot.exercises_json); client reads GET /assignments/me (listMyAssignments) and
  GET /assignments/:id (getMyAssignment) -> presentAssignment. WorkoutAdjustmentProposal.applied_change.exercises[] carries
  {order, sets_before, sets_after} for every exercise; status approved|edited = applied, undone/dismissed/expired/pending = not.
- Mobile (origin/main 8fac2fa2, includes m#422): WorkoutAssignmentDetailScreen renders and starts workout_plan.exercises (the only
  screen that calls buildActiveWorkoutExercises; rg confirms no other client screen starts an assigned workout).

## B list
- B1 (AUDIT-07-125 / AUDIT-14-125 B2): a coach approves Roman's set cut in the Action Queue, the card says applied, but the client
  opens the workout and still sees and starts the old sets. FIXED by b#800 + m#435.

## U list
- None new.

## C one-liners
- C (edge, deferred to 10k clients): a coach who edits the live plan's set count for an exercise Roman already adjusted sees Roman's
  count win on the client (spec: only Roman's counts are overlaid; latest Roman decision per order wins).

## Covered by open PRs
- None. No open backend PR touches src/workout-builder/workout-builder.service.ts or src/roman-adjust/; no open mobile PR touches
  WorkoutAssignmentDetailScreen.tsx, workoutBuilderApi.ts, useWorkoutBuilder.ts or utils/workout/.

## PRs opened
- growth-project-backend#800, branch agent125/b-romanadj-125-sets, head 3052a7e631ea44c588f29d4c882ead3649c1498b, +216/-4 (220).
  Adds roman_adjusted_sets [{order, sets}] to both client reads (approved|edited proposals, changed exercises only, latest
  decided_at per order wins, [] otherwise); strips the raw proposal rows. 6 tests; 5 of them fail on main (the 403 test passes on
  main by design). Local: test/workout-builder.service.spec.ts 52/52. CI: all SUCCESS (build-and-test, danger, R75, schema parity,
  CodeQL, npm audit, sbom, rls-floor-guard, rls/community/mwb-3 live tests); deploy-readiness-gate SKIPPED by design. READY comment:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/800#issuecomment-6026205005
- growth-project-mobile#435, branch agent125/b-romanadj-125-sets, head be8626212e1081b72f348131b8dfdac06715355e, +212/-3 (215).
  overlayRomanAdjustedSets util + screen overlay for list and Start + "Updated by your coach" note. Missing field = today's
  behaviour. 6 tests; the overlay screen test fails on main. Local: new file 6/6, workoutAssignmentNamesUx124 8/8. CI: Typecheck,
  lint, test SUCCESS; Analyze (actions, javascript-typescript) SUCCESS. READY comment:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/435#issuecomment-6026204796

## Not fixed (needs operator)
- Merge order: m#435 is safe to merge first (no field = today). Approved changes only reach clients once b#800 is deployed.
  If b#800 cannot deploy before launch, AUDIT-14 default stands: unset FEATURE_ROMAN_ADJUST_ENABLED for launch.

## HANDOFF
- Complete. b#800 (head 3052a7e6) and m#435 (head be862621), both on branch agent125/b-romanadj-125-sets, READY FOR AUDIT with green
  CI. Worktrees removed after verifying local == remote heads and no uncommitted work. No ci/* lane branches were created; no locks held.
- If a lens asks for changes: recreate a worktree from origin/agent125/b-romanadj-125-sets in the matching repo.
- Merge order: m#435 any time (safe without the backend); b#800 must merge and deploy for approved changes to reach clients.
