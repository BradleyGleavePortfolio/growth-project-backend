-- Reverse of 20270502003400_workout_day_client_data. Only for a confirmed
-- defect: drops the coach's swaps, the client's skips and the coach's day
-- notes (data loss for those three columns only).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "ClientWorkoutAssignment"
  DROP COLUMN IF EXISTS "client_note",
  DROP COLUMN IF EXISTS "skipped_at";

ALTER TABLE "WorkoutPlanExercise"
  DROP COLUMN IF EXISTS "alternative_external_ids";

COMMIT;
