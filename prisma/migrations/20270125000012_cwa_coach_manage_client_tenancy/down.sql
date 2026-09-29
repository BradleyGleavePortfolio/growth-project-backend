-- Rollback of 20270125000012 (D8): restore the 20270125000011 text of "assignment_coach_manage"
-- verbatim (no client-tenancy predicate; plan-ownership helper retained) and drop the tenancy
-- helper. Run FIRST in the S8-D3 down chain (before 20270125000011). Metadata only.
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
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
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
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND app.current_user_owns_workout_plan("workout_plan_id")
    );

DROP FUNCTION IF EXISTS app.current_user_coaches_client(text);

COMMIT;
