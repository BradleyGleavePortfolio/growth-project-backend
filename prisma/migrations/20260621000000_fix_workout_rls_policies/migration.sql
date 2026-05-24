-- Phase 11 — Workout Builder audit #4 P1-2: tighten ClientWorkoutAssignment RLS.
--
-- The original policy from 20260508000001_rls_workout_builder used a single
-- FOR ALL clause covering both the client and the assigning coach. That
-- granted clients INSERT/UPDATE/DELETE on ClientWorkoutAssignment — which,
-- combined with the `client_read_assigned_plans` policy added in
-- 20260620000000_workout_builder_p1_fixes, let a client insert a fake
-- assignment row pointing to another coach's plan and then read that plan's
-- exercises (IDOR).
--
-- Fix: drop the FOR ALL policy and replace it with two narrower policies —
-- coaches retain full management of assignments for plans they own; clients
-- can only SELECT their own assignments. Client-side write paths are NOT
-- supported; client completion of an assignment goes through the NestJS
-- endpoint `PATCH /assignments/:id/complete`, which uses the Supabase
-- service role and is subject to the application's auth + entitlement
-- guards (it does not rely on user-JWT RLS at all).
--
-- The `client_read_assigned_plans` and `client_read_assigned_exercises`
-- policies from 20260620000000 are intentionally left in place — they
-- grant only SELECT on the joined rows, and the IDOR vector was the
-- INSERT path on ClientWorkoutAssignment, which is now closed.

DROP POLICY IF EXISTS "ClientWorkoutAssignment_client_or_coach" ON "ClientWorkoutAssignment";
DROP POLICY IF EXISTS "ClientWorkoutAssignment_coach_manage" ON "ClientWorkoutAssignment";

-- Coaches can manage (SELECT/INSERT/UPDATE/DELETE) assignments only for
-- plans where they are the assigning coach. WITH CHECK on the same column
-- prevents a coach from re-assigning a row to another coach.
CREATE POLICY "assignment_coach_manage"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    )
    WITH CHECK (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );

-- Clients can only SELECT their own assignments. No INSERT/UPDATE/DELETE.
CREATE POLICY "assignment_client_read"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR SELECT
    TO PUBLIC
    USING (
        "client_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );
