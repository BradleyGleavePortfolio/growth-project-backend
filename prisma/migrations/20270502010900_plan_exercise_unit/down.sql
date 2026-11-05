-- Reverse of 20270502010900_plan_exercise_unit: drops WorkoutPlanExercise.unit and its type.
-- Every row and every other column stays. The unit itself is not kept: a forward run again reads
-- seconds from the program note only, so a unit a coach set on another row goes back to reps.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "WorkoutPlanExercise" DROP COLUMN IF EXISTS "unit";

DROP TYPE IF EXISTS "PlanExerciseUnit";

COMMIT;
