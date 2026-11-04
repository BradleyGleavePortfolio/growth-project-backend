-- Reverse of 20270502011000_exercise_set_asked: drops the six ExerciseSet columns it adds.
-- Every row and every other column stays. The copied asks are lost: a forward run again starts
-- every existing set with no ask (the forward migration has no backfill).

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ExerciseSet"
  DROP COLUMN IF EXISTS "plan_assignment_id",
  DROP COLUMN IF EXISTS "plan_order",
  DROP COLUMN IF EXISTS "asked_sets",
  DROP COLUMN IF EXISTS "asked_count",
  DROP COLUMN IF EXISTS "asked_unit",
  DROP COLUMN IF EXISTS "asked_weight_lbs";

COMMIT;
