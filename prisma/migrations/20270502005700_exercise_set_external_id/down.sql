-- Reverse of 20270502005700_exercise_set_external_id. Only for a confirmed
-- defect: drops the catalog id on every logged set (history falls back to
-- matching by name).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "ExerciseSet" DROP COLUMN IF EXISTS "exercise_external_id";

COMMIT;
