-- Phase 11 — Workout Builder follow-up: soft-archive WorkoutPlanExercise rows.
--
-- The original setExercises() implementation deleteMany'd every row in a
-- plan and re-inserted the new ordered list. That silently mutated what
-- already-assigned clients saw the next time they opened their assignment
-- — there was no audit trail of which exercises were in the plan at the
-- time the assignment was issued.
--
-- This migration adds an archived_at timestamp so the service layer can
-- soft-archive prior rows when a coach edits a plan that already has
-- active (non-completed) assignments. Read paths exclude archived rows
-- with WHERE archived_at IS NULL.
--
-- The unique constraint on (workout_plan_id, "order") is loosened to a
-- partial index that only applies to live (non-archived) rows. Without
-- this, soft-archiving a row would block re-using the same "order" slot
-- for the new active row.

ALTER TABLE "WorkoutPlanExercise"
    ADD COLUMN "archived_at" TIMESTAMP(3);

-- Drop the original full-table unique constraint and replace with a
-- partial unique index that only enforces uniqueness across live rows.
ALTER TABLE "WorkoutPlanExercise"
    DROP CONSTRAINT "WorkoutPlanExercise_plan_order_key";

CREATE UNIQUE INDEX "WorkoutPlanExercise_plan_order_active_key"
    ON "WorkoutPlanExercise" ("workout_plan_id", "order")
    WHERE "archived_at" IS NULL;

-- Index for the common "active exercises for a plan, ordered" read path.
CREATE INDEX "WorkoutPlanExercise_workout_plan_id_archived_at_idx"
    ON "WorkoutPlanExercise" ("workout_plan_id", "archived_at");
