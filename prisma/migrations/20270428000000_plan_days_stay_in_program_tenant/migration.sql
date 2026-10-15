-- PLANPROG (agent 143): a workout plan row may only point at a program of its
-- own tenant, and at a head revision of its own. WorkoutPlan_coach_owner
-- (20260508000001_rls_workout_builder) is the table's only write rule and checks
-- just coach_id = the caller, never program_id or head_revision_id. Any
-- signed-in user could therefore insert a day (coach_id = themselves) into
-- another coach's program, or move one of their own plans there, and the copy,
-- clone and assign paths copied every row under the program to that coach's
-- clients.
--
-- Every writer stamps a program day with its program's tenant
-- (WorkoutPlan.coach_id = WorkoutProgram.coach_id: workout-builder
-- copyProgramPlans, program-library writeDayPlan, program-delivery,
-- onboarding program-writer, the create-workout-plan materialiser and the
-- native importer). So the rule is that equality, not team membership: the
-- permissive policy already pins coach_id to the caller, which leaves the
-- caller's own programs as the only ones a row-layer day can join.
--
-- Two RESTRICTIVE policies AND with WorkoutPlan_coach_owner (main's, or #976's
-- after it ALTERs that policy) in any merge order. They depend on no helper
-- from #976, #980 or #986. A new or changed row passes only when
--   * program_id is NULL or names a program whose coach_id is the row's
--     coach_id, and
--   * head_revision_id is NULL or does not name another plan's revision (the
--     AI paths read a plan's content through head_revision_id).
-- UPDATE checks the row before and after the change, so a row that already
-- points across tenants cannot be edited further at the row layer.
-- cloned_from_plan_id is provenance only (never read for content) and legally
-- crosses coach_id (a sub-coach's saved workout copied into the head coach's
-- program), so it has no rule. Reads and deletes are unchanged: the permissive
-- policy already limits a delete to the caller's own rows.
--
-- The helper is SECURITY DEFINER so the check reads WorkoutProgram and
-- WorkoutPlanRevision directly: under the caller's own row rules the revision
-- check would pass for rows the caller cannot see, and the program check would
-- change whenever another PR changes WorkoutProgram's read rules.
--
-- No data changes. service_role and the migration role bypass RLS.
-- Reversible: down.sql drops both policies and the helper.
-- Live proof: test/rls/workout-plan-program-tenant-rls.spec.ts (rls-live-tests).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.workout_plan_links_in_tenant(
  plan_id text,
  plan_coach_id text,
  plan_program_id text,
  plan_head_revision_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
      plan_program_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public."WorkoutProgram" p
        WHERE p."id" = plan_program_id
          AND p."coach_id" = plan_coach_id
      )
    )
    AND (
      plan_head_revision_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public."WorkoutPlanRevision" r
        WHERE r."id" = plan_head_revision_id
          AND r."workout_plan_id" <> plan_id
      )
    )
$$;

COMMENT ON FUNCTION app.workout_plan_links_in_tenant(text, text, text, text) IS
  'PLANPROG (20270428000000): true when a WorkoutPlan row with these values points only inside its own tenant. program_id is NULL or names a program whose coach_id is the row''s coach_id, and head_revision_id is NULL or does not name a revision of another plan. Called only by the WorkoutPlan_links_in_tenant_insert and _update policies.';

REVOKE ALL ON FUNCTION app.workout_plan_links_in_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workout_plan_links_in_tenant(text, text, text, text) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "WorkoutPlan_links_in_tenant_insert" ON "WorkoutPlan";
CREATE POLICY "WorkoutPlan_links_in_tenant_insert" ON "WorkoutPlan" AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (app.workout_plan_links_in_tenant("id", "coach_id", "program_id", "head_revision_id"));
COMMENT ON POLICY "WorkoutPlan_links_in_tenant_insert" ON "WorkoutPlan" IS
  'PLANPROG: restrictive. A plan is inserted only into a program of its own tenant (program coach_id = plan coach_id) and only with its own head revision.';

DROP POLICY IF EXISTS "WorkoutPlan_links_in_tenant_update" ON "WorkoutPlan";
CREATE POLICY "WorkoutPlan_links_in_tenant_update" ON "WorkoutPlan" AS RESTRICTIVE FOR UPDATE TO public
  USING (app.workout_plan_links_in_tenant("id", "coach_id", "program_id", "head_revision_id"))
  WITH CHECK (app.workout_plan_links_in_tenant("id", "coach_id", "program_id", "head_revision_id"));
COMMENT ON POLICY "WorkoutPlan_links_in_tenant_update" ON "WorkoutPlan" IS
  'PLANPROG: restrictive. A plan is updated only while, and only into a state where, it points at a program of its own tenant and at its own head revision, so a plan cannot be moved into another coach''s program.';

COMMIT;
