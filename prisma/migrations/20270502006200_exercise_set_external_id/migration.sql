-- TRAIN-BE2 (Coach's page, plan C2): ExerciseSet.exercise_external_id, the
-- catalog id the app logged a set under (ids as WorkoutPlanExercise.
-- exercise_external_id holds them), so a client's exercise history matches
-- exactly. Additive and nullable, no data change: sets logged before this, or
-- by an app that does not send it, stay NULL and match by name.
-- Row rules: unchanged. The column sits on ExerciseSet, whose policies
-- (20261213000000, 20270502000900) let the client who logged the session read
-- and write it and the client's current coach read it; a former coach reads
-- none. Live proof: test/rls/workout-comments-history-rls.spec.ts
-- (rls-live-tests). Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "ExerciseSet" ADD COLUMN "exercise_external_id" TEXT;

COMMIT;
