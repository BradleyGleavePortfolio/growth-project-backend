-- ClientWorkoutAssignment: apply the application's coach-client tenancy rule inside
-- `assignment_coach_manage` (owner decision D8, 2026-09-29; TIGHTENING ONLY).
--
-- GAP (present since 20260702000000, preserved verbatim by 20270125000000 / 20270125000011):
--   `assignment_coach_manage` checks that the caller is the assigning coach (assigned_by_coach_id),
--   that the caller's role is coach / owner / sub_coach, and (WITH CHECK) that the caller owns the
--   referenced WorkoutPlan. It never checks that the ASSIGNEE ("client_id") is a client the caller
--   may act on. Through direct access a coach could therefore insert, re-point, read or delete
--   assignments naming ANY user as the client, as long as the plan was theirs. The application never
--   allowed that: every assignment write goes through WorkoutBuilderService.assertCanAccessClient.
--
-- THE APPLICATION RULE (src/workout-builder/workout-builder.service.ts assertCanAccessClient;
-- src/sub-coach/sub-coach-scope.service.ts getAuthorizedClientIds / canAccessClient; the AI path
-- src/ai/coach/coach-ai.service.ts delegates to the same method). The acting user may act on a
-- client when EITHER
--   (a) the client's User.coach_id is the acting user (head coach / owner direct roster), OR
--   (b) the acting user is a sub-coach (User.role = 'coach' AND User.coach_id IS NOT NULL) holding an
--       OPEN SubCoachAssignment (sub_coach_id = acting user, client_id = client, unassigned_at IS
--       NULL) to that client, and the client is a live student (role = 'student', deleted_at IS NULL).
-- This migration encodes exactly that predicate; nothing is widened.
--
-- FIX: a SECURITY DEFINER helper (same pattern and hardening as 20270125000011's
-- app.current_user_owns_workout_plan) evaluates the rule for the caller identified by auth.uid(), and
-- the policy ANDs it into BOTH USING and WITH CHECK. SECURITY DEFINER because the predicate reads
-- "User" and "SubCoachAssignment" (the policy evaluator may not be able to read "SubCoachAssignment"
-- — cf. app.is_subcoach_of, 20261215000000) and because a never-inlined function body cannot re-enter
-- the ClientWorkoutAssignment policy graph (42P17). The helper returns only a boolean about the
-- CALLER's own relationship to ONE client id; nobody gains read or write access. Every other
-- condition of the 20270125000011 policy is byte-identical: person_id IS NULL, assigned_by_coach_id =
-- caller, caller role IN (coach, owner, sub_coach), and app.current_user_owns_workout_plan in WITH
-- CHECK. The GUC-keyed helpers app.is_current_coach_of / app.is_subcoach_of are NOT reused: this
-- policy is auth.uid()-keyed, and mixing identity sources would make the predicate depend on a
-- session GUC that the direct-access path never sets.
--
-- EFFECT (direct-access coach path only; the application writes as service_role):
--   * a coach can INSERT / SELECT / UPDATE / DELETE assignments only for clients the app considers
--     theirs; UPDATE cannot re-point client_id to another coach's client (WITH CHECK);
--   * assignments a coach previously created for a client who is not (or no longer) theirs become
--     invisible and immutable to that coach through direct access — exactly what
--     assertCanAccessClient would answer. No data is changed, no backfill is needed.
--   * person-owned rows (S8-D3) remain service_role-only: person_id IS NULL is unchanged.
--
-- HARDENING (repo precedent 20270125000011 / 20261212000000 / 20260704000000): STABLE,
-- SECURITY DEFINER, `SET search_path = ''` with every reference schema-qualified, EXECUTE revoked from
-- PUBLIC and granted only to the roles under which the policy is evaluated (service_role,
-- authenticated, anon — anon needs EXECUTE so its refusal stays a POLICY refusal, 42501 on the row).
--
-- LOCKS: CREATE FUNCTION is catalog-only; DROP/CREATE POLICY takes a short ACCESS EXCLUSIVE on
-- "ClientWorkoutAssignment" (same profile as every prior policy rewrite on this table). Atomic.
-- ROLLBACK: down.sql restores the 20270125000011 policy text verbatim and drops the helper.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_coaches_client(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT client_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" caller
       JOIN public."User" client ON client."id" = client_user_id
       WHERE caller."supabase_id" = auth.uid()::text
         AND (
           -- (a) head coach / owner: the client is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with an OPEN SubCoachAssignment to a live student
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND client."deleted_at" IS NULL
             AND EXISTS (
               SELECT 1
               FROM public."SubCoachAssignment" sca
               WHERE sca."sub_coach_id" = caller."id"
                 AND sca."client_id" = client."id"
                 AND sca."unassigned_at" IS NULL
             )
           )
         )
     )
$$;

COMMENT ON FUNCTION app.current_user_coaches_client(text) IS
  'Security-definer RLS helper (D8): true when the User whose supabase_id is auth.uid() may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient — the client''s coach_id is the caller, OR the caller is a sub-coach (role coach, coach_id set) with an open SubCoachAssignment to that live student.';

REVOKE ALL ON FUNCTION app.current_user_coaches_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_coaches_client(text) TO service_role, anon, authenticated;

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
        AND app.current_user_coaches_client("client_id")
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
        AND app.current_user_coaches_client("client_id")
        AND app.current_user_owns_workout_plan("workout_plan_id")
    );

COMMIT;
