-- Reverse of 20270227000000_roman_workout_adjustments. Drops only what the
-- migration creates. Applied set changes stay in the assignment snapshots.
DROP TABLE IF EXISTS "WorkoutAdjustmentEvent";
DROP FUNCTION IF EXISTS public.workout_adjustment_event_reject_update();
DROP TABLE IF EXISTS "WorkoutAdjustmentProposal";
