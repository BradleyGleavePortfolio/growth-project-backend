-- Rollback of 20270319000000_cwa_coach_manage_client_tenancy (D8): restore the
-- 20260702000000_fix_workout_rls_coach_role text of "assignment_coach_manage" verbatim (no
-- client-tenancy predicate) and drop app.caller_coaches_client(text). Metadata only; no data change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";

CREATE POLICY "assignment_coach_manage"
    ON public."ClientWorkoutAssignment"
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

DROP FUNCTION IF EXISTS app.caller_coaches_client(text);

COMMIT;
