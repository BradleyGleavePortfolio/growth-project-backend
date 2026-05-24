-- Phase 11 — Workout Builder P1 fixes (audit #2).
--
-- 1. P1-1: Add `status` column to WorkoutBuilderIdempotencyKey so the
--          ledger can claim a key BEFORE the protected mutation runs.
--          'in_progress' = a request holds the key; 'completed' = the
--          response is captured. Concurrent same-key callers see the
--          in_progress row and return 409. Existing rows are 'completed'.
--          response_json and status_code become nullable for the
--          in_progress claim window.
-- 2. P1-2: Drop the bogus UNIQUE (id, completion_idempotency_key) — `id`
--          is already the primary key, so the composite never blocked
--          duplicate completions. Completion is now made atomic with a
--          conditional updateMany() in the service layer instead.
-- 3. P1-5: Add RLS read-only policies for `WorkoutPlan` and
--          `WorkoutPlanExercise` so a client using a Supabase JWT can
--          read the plan/exercise rows attached to their assignment.
--          Without these, the existing assignment policy is reachable
--          but the joined rows are not, and Postgres returns empty
--          plan/exercises to assigned clients.

-- ─── P1-1: idempotency ledger claim status ───────────────────────────────

ALTER TABLE "WorkoutBuilderIdempotencyKey"
    ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'completed';

-- Allow the in_progress claim window where the response is not yet known.
ALTER TABLE "WorkoutBuilderIdempotencyKey"
    ALTER COLUMN "response_json" DROP NOT NULL,
    ALTER COLUMN "status_code" DROP NOT NULL;

-- updated_at is needed by Prisma's @updatedAt. Backfill to created_at for
-- pre-existing rows.
ALTER TABLE "WorkoutBuilderIdempotencyKey"
    ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "WorkoutBuilderIdempotencyKey"
SET "updated_at" = "created_at"
WHERE "updated_at" IS NULL OR "updated_at" = CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "WorkoutBuilderIdempotencyKey_status_created_at_idx"
    ON "WorkoutBuilderIdempotencyKey" ("status", "created_at");

-- ─── P1-2: drop bogus completion unique index ───────────────────────────

DROP INDEX IF EXISTS "ClientWorkoutAssignment_completion_idempotency_key_key";

-- ─── P1-5: RLS read-only policies for assigned clients ──────────────────

-- WorkoutPlan: a client can read plans assigned to them via
-- ClientWorkoutAssignment. Read-only; INSERT/UPDATE/DELETE are NOT
-- granted to clients on this table.
CREATE POLICY "client_read_assigned_plans"
    ON "WorkoutPlan"
    AS PERMISSIVE
    FOR SELECT
    TO PUBLIC
    USING (
        "id" IN (
            SELECT "workout_plan_id" FROM "ClientWorkoutAssignment"
            WHERE "client_id" = (
                SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
            )
        )
    );

-- WorkoutPlanExercise: a client can read live (non-archived) exercise
-- rows from plans assigned to them. Archived rows are intentionally
-- visible too — assigned clients keep seeing the snapshot they were
-- assigned even after the coach edits the plan.
CREATE POLICY "client_read_assigned_exercises"
    ON "WorkoutPlanExercise"
    AS PERMISSIVE
    FOR SELECT
    TO PUBLIC
    USING (
        "workout_plan_id" IN (
            SELECT "workout_plan_id" FROM "ClientWorkoutAssignment"
            WHERE "client_id" = (
                SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
            )
        )
    );
