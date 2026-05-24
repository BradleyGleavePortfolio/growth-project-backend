-- Phase 11 — Workout Builder follow-up: Row Level Security
--
-- The base migration (20260508000000_add_workout_builder) created the
-- WorkoutPlan, WorkoutPlanExercise, and ClientWorkoutAssignment tables but
-- left them with no RLS, which means any Supabase client connecting with a
-- user JWT could read or write across tenants. This migration:
--
--   1. ENABLE + FORCE row-level security on all three tables. FORCE is
--      important: without it, the table owner (and anyone running as the
--      table owner — Prisma migrations, our service-role-key admin queries)
--      bypasses RLS entirely. With FORCE on, only the postgres superuser
--      and other BYPASSRLS roles skip the policies, so the NestJS API
--      (which uses the service role) keeps full access while end-user
--      JWT connections are constrained to their own rows.
--   2. Add per-table policies that map `auth.uid()` (the Supabase JWT
--      subject) to "User"."supabase_id", then enforce ownership:
--        - WorkoutPlan: only the owning coach can SELECT/INSERT/UPDATE/DELETE.
--        - WorkoutPlanExercise: accessible through the owning plan.
--        - ClientWorkoutAssignment: accessible to the assigned client OR
--          the assigning coach.
--
-- All policies are written as a single permissive expression (USING +
-- WITH CHECK) so PostgREST / supabase-js callers behave correctly for
-- both read and write paths. We intentionally do not split per-operation
-- policies because the ownership rule is identical for every verb.

-- ─── Enable + force RLS ──────────────────────────────────────────────────

ALTER TABLE "WorkoutPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutPlan" FORCE ROW LEVEL SECURITY;

ALTER TABLE "WorkoutPlanExercise" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutPlanExercise" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClientWorkoutAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientWorkoutAssignment" FORCE ROW LEVEL SECURITY;

-- ─── WorkoutPlan policy ──────────────────────────────────────────────────
-- Coach (the owner) can do everything to their own plans.

CREATE POLICY "WorkoutPlan_coach_owner"
    ON "WorkoutPlan"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    )
    WITH CHECK (
        "coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );

-- ─── WorkoutPlanExercise policy ──────────────────────────────────────────
-- Reachable only through the owning plan's coach. We resolve ownership by
-- joining to the parent WorkoutPlan row so the policy stays in sync if a
-- plan is reparented (currently impossible, but the join is the safe
-- general form).

CREATE POLICY "WorkoutPlanExercise_through_plan"
    ON "WorkoutPlanExercise"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        EXISTS (
            SELECT 1
              FROM "WorkoutPlan" wp
              JOIN "User" u ON u."id" = wp."coach_id"
             WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id"
               AND u."supabase_id" = auth.uid()::text
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
              FROM "WorkoutPlan" wp
              JOIN "User" u ON u."id" = wp."coach_id"
             WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id"
               AND u."supabase_id" = auth.uid()::text
        )
    );

-- ─── ClientWorkoutAssignment policy ──────────────────────────────────────
-- Two principals can touch an assignment row: the assigned client (for
-- read + completion) and the assigning coach (for read + management).

CREATE POLICY "ClientWorkoutAssignment_client_or_coach"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "client_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        OR
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    )
    WITH CHECK (
        "client_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        OR
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );
