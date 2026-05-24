-- Phase 11 — Workout Builder follow-up: idempotency + completion payload + indexes.
--
-- Mobile sends rich completion data (idempotency_key, started_at,
-- completion_payload) on PATCH /assignments/:id/complete. The original
-- CompleteAssignmentDto only allowed post_rpe + post_notes; with
-- forbidNonWhitelisted: true, that 400'd every real client request.
--
-- For coach-side mutations (create plan, update plan, replace exercises,
-- create assignment) we add a per-user idempotency ledger so retries
-- return the original response instead of double-creating rows.
--
-- Two pieces:
--   1. Extend ClientWorkoutAssignment with completion_idempotency_key,
--      started_at, completion_payload columns. The idempotency key is
--      unique per (assignment_id) since a single assignment can only be
--      completed once; the unique constraint is the dedup mechanism.
--   2. Add a generic WorkoutBuilderIdempotencyKey table keyed by
--      (user_id, route_key, idempotency_key). The service layer stores
--      the resulting response_json on first call and returns the cached
--      response on retry.
--   3. Add composite indexes flagged in audit P2:
--        - WorkoutPlan(coach_id, archived_at, created_at DESC)
--        - ClientWorkoutAssignment(workout_plan_id, scheduled_for ASC)

-- ─── Completion payload + idempotency on ClientWorkoutAssignment ─────────

ALTER TABLE "ClientWorkoutAssignment"
    ADD COLUMN "completion_idempotency_key" TEXT,
    ADD COLUMN "started_at"                 TIMESTAMP(3),
    ADD COLUMN "completion_payload"         JSONB;

-- Unique per assignment: completing the same assignment with the same key
-- is the dedup guarantee. NULL keys (legacy rows pre-completion) coexist.
CREATE UNIQUE INDEX "ClientWorkoutAssignment_completion_idempotency_key_key"
    ON "ClientWorkoutAssignment" ("id", "completion_idempotency_key")
    WHERE "completion_idempotency_key" IS NOT NULL;

-- ─── WorkoutBuilderIdempotencyKey ledger ─────────────────────────────────
-- Stores the cached response for a coach-side mutation so retries with
-- the same client-supplied Idempotency-Key UUID return the original
-- response without re-executing the operation.

CREATE TABLE "WorkoutBuilderIdempotencyKey" (
    "id"               TEXT         NOT NULL,
    "user_id"          TEXT         NOT NULL,
    "route_key"        TEXT         NOT NULL,
    "idempotency_key"  TEXT         NOT NULL,
    "response_json"    JSONB        NOT NULL,
    "status_code"      INTEGER      NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutBuilderIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- Per-user, per-route, per-key uniqueness — the dedup mechanism.
CREATE UNIQUE INDEX "WorkoutBuilderIdempotencyKey_user_route_key_key"
    ON "WorkoutBuilderIdempotencyKey" ("user_id", "route_key", "idempotency_key");

CREATE INDEX "WorkoutBuilderIdempotencyKey_created_at_idx"
    ON "WorkoutBuilderIdempotencyKey" ("created_at");

ALTER TABLE "WorkoutBuilderIdempotencyKey"
    ADD CONSTRAINT "WorkoutBuilderIdempotencyKey_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lock the new table down too — only the owning user (or the service role)
-- can see or write their own idempotency rows.
ALTER TABLE "WorkoutBuilderIdempotencyKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutBuilderIdempotencyKey" FORCE ROW LEVEL SECURITY;

CREATE POLICY "WorkoutBuilderIdempotencyKey_owner"
    ON "WorkoutBuilderIdempotencyKey"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "user_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    )
    WITH CHECK (
        "user_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );

-- ─── P2 composite indexes ───────────────────────────────────────────────
-- The base migration created (coach_id, archived_at) and (created_at)
-- separately; the audit asked for a single composite index that supports
-- the common "active plans for a coach, newest first" query in one seek.
DROP INDEX IF EXISTS "WorkoutPlan_coach_id_archived_at_idx";
DROP INDEX IF EXISTS "WorkoutPlan_created_at_idx";
CREATE INDEX "WorkoutPlan_coach_id_archived_at_created_at_idx"
    ON "WorkoutPlan" ("coach_id", "archived_at", "created_at" DESC);

-- (workout_plan_id, scheduled_for ASC) — for the coach's per-plan
-- assignment list, ordered by schedule. Replaces the bare workout_plan_id
-- index from the base migration.
DROP INDEX IF EXISTS "ClientWorkoutAssignment_workout_plan_id_idx";
CREATE INDEX "ClientWorkoutAssignment_workout_plan_id_scheduled_for_idx"
    ON "ClientWorkoutAssignment" ("workout_plan_id", "scheduled_for");
