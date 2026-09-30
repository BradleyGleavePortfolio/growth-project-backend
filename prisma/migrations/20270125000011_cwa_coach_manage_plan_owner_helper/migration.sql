-- ClientWorkoutAssignment: break the WorkoutPlan <-> ClientWorkoutAssignment policy cycle
-- (latent BASE defect, surfaced by the S8-D3 role x owner-state matrix; fixed inside PR #587 by
-- orchestrator decision 2026-09-29; docs/decisions/2026-09-26-s8d-person-link.md §2.2 addendum).
--
-- DEFECT (pre-existing since 20260702000000, verified on integration/importer without S8-D3):
--   `assignment_coach_manage` WITH CHECK reads "WorkoutPlan" to require that the assigning coach owns
--   the referenced plan. "WorkoutPlan" carries `client_read_assigned_plans` (20260620000000), whose
--   USING reads "ClientWorkoutAssignment". PostgreSQL's rewriter refuses the cycle at plan time, so
--   EVERY INSERT / UPDATE on "ClientWorkoutAssignment" by a non-BYPASSRLS role fails with
--   42P17 "infinite recursion detected in policy" before any USING / WITH CHECK is evaluated. SELECT
--   and DELETE are unaffected (WITH CHECK is not applied). The application writes as service_role and
--   never saw it; the designed coach-manage write branch was unusable through direct access.
--
-- FIX: the plan-ownership test moves into a SECURITY DEFINER helper. A SECURITY DEFINER SQL function
-- is never inlined, so its body is planned as a separate query and the rewriter's cycle detection no
-- longer sees "WorkoutPlan" inside the "ClientWorkoutAssignment" policy. The predicate is UNCHANGED:
--   EXISTS (SELECT 1 FROM "WorkoutPlan" wp WHERE wp."id" = <plan> AND wp."coach_id" = <caller User.id>)
-- with <caller User.id> = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text), exactly
-- as the policy spelled it. Nobody gains read or write access: the helper returns only a boolean
-- about the CALLER's own ownership of ONE plan id, and the rest of the policy (assigned_by_coach_id
-- = caller, caller role IN (coach, owner, sub_coach), person_id IS NULL) is byte-identical.
--
-- HARDENING (repo precedent 20261212000000 / 20260704000000): STABLE, SECURITY DEFINER,
-- `SET search_path = ''` with every reference schema-qualified, EXECUTE revoked from PUBLIC and
-- granted only to the roles under which the policy is evaluated (service_role, authenticated, anon —
-- as app.is_user_coached_by, 20260607000000 L436-439). anon needs EXECUTE so that its refusal stays a
-- POLICY refusal (42501 on the row), not a function-privilege error.
--
-- LOCKS: CREATE FUNCTION is catalog-only; DROP/CREATE POLICY takes a short ACCESS EXCLUSIVE on
-- "ClientWorkoutAssignment" (same profile as every prior policy rewrite on this table). Atomic.
-- ROLLBACK: down.sql restores the 20270125000000 policy text verbatim and drops the helper.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_owns_workout_plan(plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT plan_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."WorkoutPlan" wp
       WHERE wp."id" = plan_id
         AND wp."coach_id" = (
           SELECT u."id" FROM public."User" u WHERE u."supabase_id" = auth.uid()::text
         )
     )
$$;

COMMENT ON FUNCTION app.current_user_owns_workout_plan(text) IS
  'Security-definer RLS helper: true when the WorkoutPlan with this id is owned (coach_id) by the User whose supabase_id is auth.uid(). Exists to break the WorkoutPlan <-> ClientWorkoutAssignment policy cycle; the predicate is the one assignment_coach_manage WITH CHECK spelled inline.';

REVOKE ALL ON FUNCTION app.current_user_owns_workout_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_owns_workout_plan(text) TO service_role, anon, authenticated;

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

COMMIT;
