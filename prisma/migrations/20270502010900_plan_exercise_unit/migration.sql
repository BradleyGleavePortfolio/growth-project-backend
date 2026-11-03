-- 20270502010900_plan_exercise_unit (TIMED-SETS-BE, agent 193): each plan exercise says whether its
-- number is reps or seconds, so the phone can show and time a held exercise (a plank, a wall sit).
--
-- WorkoutPlanExercise.unit: PlanExerciseUnit (reps | seconds), NOT NULL, default reps.
-- reps_or_duration_seconds keeps its name and meaning: the count, read in this unit.
-- Existing rows: reps, except the rows whose program note says for certain the number is seconds.
-- The consultation programs mark every exercise row "REPS." or "SECONDS." at the start of its note
-- (the overlay cap in consultation-programs.ts already reads that prefix), so those rows, and the
-- copies a coach or client made of them, become seconds. Nothing else in the database says it for
-- certain (the library has free-text categories only), so the number itself is never used to guess.
-- The ADD COLUMN with a constant default is a catalogue-only change on Postgres 11+ (no table rewrite);
-- the UPDATE touches only the marked rows.
-- No RLS change: WorkoutPlanExercise keeps its policies, which cover every column.
-- Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PlanExerciseUnit" AS ENUM ('reps', 'seconds');

ALTER TABLE "WorkoutPlanExercise" ADD COLUMN IF NOT EXISTS "unit" "PlanExerciseUnit" NOT NULL DEFAULT 'reps';

UPDATE "WorkoutPlanExercise" SET "unit" = 'seconds' WHERE "notes" LIKE 'SECONDS.%';

COMMIT;
