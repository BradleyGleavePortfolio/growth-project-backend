-- C1V2-C1: workout data for the Coach's page logging screens. Three columns,
-- no policy change, no data change.
--   * WorkoutPlanExercise.alternative_external_ids: the coach's chosen swaps
--     for a planned exercise (exercise catalog ids or slugs, first choice
--     first). Existing rows read the empty list.
--   * ClientWorkoutAssignment.skipped_at: the client skipped this day.
--   * ClientWorkoutAssignment.client_note: the coach's note to the client for
--     this day.
-- Row rules: the columns sit on rows whose policies already follow the
-- client (20270502000800, 20270502000900): the client reads their own
-- assignment, the current coach reads every assignment of their client, a
-- former coach reads none; only the plan's coach writes its exercises, and no
-- API role writes an assignment (the backend writes through service_role).
-- Live proof: test/rls/workout-day-client-data-rls.spec.ts (rls-live-tests).
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "WorkoutPlanExercise"
  ADD COLUMN "alternative_external_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "ClientWorkoutAssignment"
  ADD COLUMN "skipped_at" TIMESTAMP(3),
  ADD COLUMN "client_note" TEXT;

COMMIT;
