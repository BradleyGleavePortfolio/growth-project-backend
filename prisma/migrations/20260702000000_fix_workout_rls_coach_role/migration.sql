-- Phase 11 — Workout Builder audit #5 P1-1: close ClientWorkoutAssignment IDOR.
--
-- The previous `assignment_coach_manage` policy (added in
-- 20260621000000_fix_workout_rls_policies) only checked that
-- `assigned_by_coach_id` matched the calling user's id. It did NOT verify:
--   (a) that the calling user actually holds a coach/owner/sub_coach role, or
--   (b) that the referenced WorkoutPlan is owned by the calling user.
--
-- This left an IDOR vector: a student could INSERT a fake assignment row
-- naming themselves as `assigned_by_coach_id` and pointing at any
-- `workout_plan_id`, then read that plan via the `client_read_assigned_*`
-- SELECT policies. Server-side application guards do reject this path, but
-- RLS must independently fail closed.
--
-- Fix: replace the policy with one that requires BOTH the coach role
-- check AND ownership of the referenced WorkoutPlan, evaluated against
-- the calling user. The role check uses the `User.role` column with an
-- explicit IN-list so only `coach`, `owner`, and `sub_coach` users can
-- create or modify assignment rows.
--
-- The `assignment_client_read` SELECT policy from the prior migration is
-- left in place — it correctly restricts client reads to their own
-- assignments. No client INSERT/UPDATE/DELETE policy exists or should
-- exist; client completion goes through the NestJS service-role path.

DROP POLICY IF EXISTS "assignment_coach_manage" ON "ClientWorkoutAssignment";

CREATE POLICY "assignment_coach_manage"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
    )
    WITH CHECK (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND EXISTS (
            SELECT 1
            FROM "WorkoutPlan" wp
            WHERE wp."id" = "workout_plan_id"
              AND wp."coach_id" = (
                  SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
              )
        )
    );
