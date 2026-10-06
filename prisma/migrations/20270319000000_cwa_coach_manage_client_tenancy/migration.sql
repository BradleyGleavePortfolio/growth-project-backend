-- ClientWorkoutAssignment: apply the coach-client tenancy rule inside `assignment_coach_manage`
-- (D8, B-D8-124). TIGHTENING ONLY: one new helper, one policy recreated; no data change, no other
-- table, no application code change.
--
-- GAP (since 20260702000000_fix_workout_rls_coach_role, which production runs today):
--   `assignment_coach_manage` (FOR ALL TO PUBLIC) checks that the caller is the assigning coach
--   (assigned_by_coach_id), that the caller's role is coach / owner / sub_coach, and (WITH CHECK) that
--   the caller owns the referenced WorkoutPlan. It never checks that the ASSIGNEE ("client_id") is a
--   client the caller may act on. PostgREST exposes the public schema and anon / authenticated hold
--   table write grants, so this policy is the only database fence on that path.
--
-- THE APPLICATION RULE this helper encodes (today's main):
--   src/workout-builder/workout-builder.service.ts assertCanAccessClient + src/sub-coach/
--   sub-coach-scope.service.ts canAccessClient / getAuthorizedClientIds / membershipHeadCoachIdFor.
--   The acting user may act on a client when the client row exists and is not soft-deleted
--   (deleted_at IS NULL) AND EITHER
--     (a) client.coach_id = acting user (head coach / owner direct roster; no target-role test), OR
--     (b) the acting user is a sub-coach: role = 'coach', coach_id IS NOT NULL, with an explicit
--         membership to that head coach (an active TeamSubCoachAssignment(head_coach_id = coach_id,
--         sub_coach_id = actor, archived_at IS NULL) or an open SubCoachAssignment(head_coach_id =
--         coach_id, sub_coach_id = actor, unassigned_at IS NULL)), AND an OPEN SubCoachAssignment
--         (sub_coach_id = actor, client_id = client, unassigned_at IS NULL), AND the client is a
--         student.
--   Nothing is widened: every branch is a subset of what the application allows.
--
-- IDENTITY: the caller is resolved INSIDE the helper exactly as the existing policy resolves it,
--   public."User".supabase_id = auth.uid()::text. The helper's only argument is the client id, so an
--   API role can ask only "may I, the caller, act on this client"; there is no arbitrary
--   (actor, client) oracle.
--
-- HARDENING (repo precedent 20261212000000 / 20260704000000): STABLE, SECURITY DEFINER (it reads
--   "User", "TeamSubCoachAssignment" and "SubCoachAssignment" outside the caller's policy graph; a
--   SECURITY DEFINER SQL function is never inlined, so it adds no policy recursion), search_path = ''
--   with every reference schema-qualified, EXECUTE revoked from PUBLIC and granted to anon,
--   authenticated and service_role (anon needs EXECUTE so its refusal stays a policy refusal).
--
-- POLICY: dropped and recreated with every 20260702000000 condition kept verbatim, plus
--   `AND app.caller_coaches_client("client_id")` in BOTH USING and WITH CHECK.
--
-- EFFECT: a signed-in coach can no longer read, delete, insert or re-point an assignment naming a
--   client who is not theirs. Reads and deletes (USING) are fenced immediately. Writes (WITH CHECK):
--   the WorkoutPlan EXISTS kept verbatim below still meets "client_read_assigned_plans" on
--   "WorkoutPlan" (20260620000000), which reads "ClientWorkoutAssignment", so the rewriter refuses
--   API-role INSERT / UPDATE with 42P17 before and after this migration; this migration does not
--   break that cycle (no widening), and the tenancy predicate holds whenever the cycle is broken
--   (proved live in test/rls/cwa-coach-manage-client-tenancy-rls.spec.ts). The backend connects with
--   BYPASSRLS credentials and never evaluates this policy; the mobile app does not read or write
--   tables through PostgREST. No legitimate caller changes behaviour.
--
-- LOCKS: CREATE FUNCTION is catalog-only; DROP / CREATE POLICY takes a short ACCESS EXCLUSIVE on
--   "ClientWorkoutAssignment" (same profile as every prior policy rewrite on this table). Atomic.
-- ROLLBACK: down.sql restores the 20260702000000 policy text verbatim and drops the helper.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.caller_coaches_client(client_user_id text)
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
         AND client."deleted_at" IS NULL
         AND (
           -- (a) head coach / owner: the client is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with explicit team membership and an OPEN assignment to this student
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND (
               EXISTS (
                 SELECT 1
                 FROM public."TeamSubCoachAssignment" seat
                 WHERE seat."head_coach_id" = caller."coach_id"
                   AND seat."sub_coach_id" = caller."id"
                   AND seat."archived_at" IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM public."SubCoachAssignment" delegation
                 WHERE delegation."head_coach_id" = caller."coach_id"
                   AND delegation."sub_coach_id" = caller."id"
                   AND delegation."unassigned_at" IS NULL
               )
             )
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

COMMENT ON FUNCTION app.caller_coaches_client(text) IS
  'Caller-bound RLS helper (D8, 20270319000000): true when the CALLER (User.supabase_id = auth.uid()) may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canAccessClient: the client is not soft-deleted and either its coach_id is the caller, or the caller is a sub-coach (role coach, coach_id set, explicit team membership) with an open SubCoachAssignment to that student. Only argument is the client id. Called by assignment_coach_manage USING and WITH CHECK.';

REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_coaches_client(text) TO anon, authenticated, service_role;

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
        AND app.caller_coaches_client("client_id")
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
        AND app.caller_coaches_client("client_id")
    );

COMMENT ON POLICY "assignment_coach_manage" ON public."ClientWorkoutAssignment" IS
  'Assigning coach manages assignments (20260702000000 conditions verbatim) only for clients the caller may act on: app.caller_coaches_client(client_id) in USING and WITH CHECK (D8, 20270319000000).';

COMMIT;
