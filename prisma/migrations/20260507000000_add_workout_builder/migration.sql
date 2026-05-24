-- Phase 11 — Workout Builder
-- Adds WorkoutPlan, WorkoutPlanExercise, and ClientWorkoutAssignment tables.

-- Enum for workout plan type
CREATE TYPE "WorkoutPlanType" AS ENUM ('strength', 'cardio', 'mobility');

-- Coach-authored workout plans
CREATE TABLE "WorkoutPlan" (
    "id"                        TEXT        NOT NULL,
    "coach_id"                  TEXT        NOT NULL,
    "name"                      TEXT        NOT NULL,
    "type"                      "WorkoutPlanType" NOT NULL,
    "duration_estimate_minutes" INTEGER,
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3) NOT NULL,
    "archived_at"               TIMESTAMP(3),

    CONSTRAINT "WorkoutPlan_pkey" PRIMARY KEY ("id")
);

-- Ordered exercise rows within a plan
CREATE TABLE "WorkoutPlanExercise" (
    "id"                        TEXT        NOT NULL,
    "workout_plan_id"           TEXT        NOT NULL,
    "exercise_external_id"      TEXT        NOT NULL,
    "order"                     INTEGER     NOT NULL,
    "sets"                      INTEGER     NOT NULL,
    "reps_or_duration_seconds"  INTEGER     NOT NULL,
    "weight_lbs"                DOUBLE PRECISION,
    "rest_seconds"              INTEGER,
    "superset_group_id"         TEXT,
    "notes"                     TEXT,

    CONSTRAINT "WorkoutPlanExercise_pkey" PRIMARY KEY ("id")
);

-- Per-client scheduled assignment of a plan, with optional completion data
CREATE TABLE "ClientWorkoutAssignment" (
    "id"                     TEXT         NOT NULL,
    "workout_plan_id"        TEXT         NOT NULL,
    "client_id"              TEXT         NOT NULL,
    "assigned_by_coach_id"   TEXT         NOT NULL,
    "scheduled_for"          TIMESTAMP(3) NOT NULL,
    "completed_at"           TIMESTAMP(3),
    "post_rpe"               INTEGER,
    "post_notes"             TEXT,

    CONSTRAINT "ClientWorkoutAssignment_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "WorkoutPlan"
    ADD CONSTRAINT "WorkoutPlan_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkoutPlanExercise"
    ADD CONSTRAINT "WorkoutPlanExercise_workout_plan_id_fkey"
    FOREIGN KEY ("workout_plan_id") REFERENCES "WorkoutPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientWorkoutAssignment"
    ADD CONSTRAINT "ClientWorkoutAssignment_workout_plan_id_fkey"
    FOREIGN KEY ("workout_plan_id") REFERENCES "WorkoutPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientWorkoutAssignment"
    ADD CONSTRAINT "ClientWorkoutAssignment_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientWorkoutAssignment"
    ADD CONSTRAINT "ClientWorkoutAssignment_assigned_by_coach_id_fkey"
    FOREIGN KEY ("assigned_by_coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraints
ALTER TABLE "WorkoutPlanExercise"
    ADD CONSTRAINT "WorkoutPlanExercise_plan_order_key"
    UNIQUE ("workout_plan_id", "order");

-- Indexes
CREATE INDEX "WorkoutPlan_coach_id_archived_at_idx"
    ON "WorkoutPlan"("coach_id", "archived_at");

CREATE INDEX "WorkoutPlan_created_at_idx"
    ON "WorkoutPlan"("created_at");

CREATE INDEX "WorkoutPlanExercise_workout_plan_id_idx"
    ON "WorkoutPlanExercise"("workout_plan_id");

CREATE INDEX "WorkoutPlanExercise_exercise_external_id_idx"
    ON "WorkoutPlanExercise"("exercise_external_id");

CREATE INDEX "ClientWorkoutAssignment_client_id_scheduled_for_idx"
    ON "ClientWorkoutAssignment"("client_id", "scheduled_for");

CREATE INDEX "ClientWorkoutAssignment_workout_plan_id_idx"
    ON "ClientWorkoutAssignment"("workout_plan_id");

CREATE INDEX "ClientWorkoutAssignment_assigned_by_coach_id_idx"
    ON "ClientWorkoutAssignment"("assigned_by_coach_id");
