-- 20270502011000_exercise_set_asked (SET-ASKED-BE, agent 195): each logged set keeps what her plan
-- asked that day, so what was asked and what was done can be compared later, even after the coach
-- edits the plan.
--
-- ExerciseSet gains six nullable columns, no default:
--   plan_assignment_id, plan_order  the plan row the set was logged from (her assignment's id and
--                                   the row's order, as the phone holds both for a frozen or a live day)
--   asked_sets                      the sets asked (a coach-approved Roman set count when there is one)
--   asked_count, asked_unit         the count and whether it is reps or seconds (PlanExerciseUnit)
--   asked_weight_lbs                the weight asked, in lbs (null when the plan named none)
-- The server copies them from the rows she was shown; the phone sends only the reference.
-- ADD COLUMN only: no foreign key (the copy is the record, so a later plan or assignment delete
-- changes nothing), no backfill (older sets keep no ask), no index (no read filters on them).
-- Nullable with no default is a catalogue-only change on Postgres (no table rewrite).
-- No RLS change: ExerciseSet's policies are row policies (USING / WITH CHECK through the parent
-- WorkoutSession, 20261213000000 and 20270502000900) with no column list, so they cover every column.
-- Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ExerciseSet"
  ADD COLUMN IF NOT EXISTS "plan_assignment_id" TEXT,
  ADD COLUMN IF NOT EXISTS "plan_order" INTEGER,
  ADD COLUMN IF NOT EXISTS "asked_sets" INTEGER,
  ADD COLUMN IF NOT EXISTS "asked_count" INTEGER,
  ADD COLUMN IF NOT EXISTS "asked_unit" "PlanExerciseUnit",
  ADD COLUMN IF NOT EXISTS "asked_weight_lbs" DOUBLE PRECISION;

COMMIT;
