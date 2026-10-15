-- Rollback of 20270502002400 (C6-BVIS): the helpers and the four policies get
-- back their earlier predicates (20261224000000, 20270502000200,
-- 20261212000000), then the rule, the package link and the visibility go.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "community_messages_author_update" ON "community_messages"
  USING ("sender_id"::text = app.current_user_id() OR app.is_community_workspace_coach("workspace_id"))
  WITH CHECK ("sender_id"::text = app.current_user_id() OR app.is_community_workspace_coach("workspace_id"));

ALTER POLICY "community_messages_author_delete" ON "community_messages"
  USING ("sender_id"::text = app.current_user_id() OR app.is_community_workspace_coach("workspace_id"));

ALTER POLICY "community_memberships_coach_all" ON "community_memberships"
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

ALTER POLICY "community_memberships_self_or_shared_cohort_select" ON "community_memberships"
  USING (
    "user_id"::text = app.current_user_id()
    OR app.shares_community_cohort("cohort_id")
  );

CREATE OR REPLACE FUNCTION app.workspace_has_participant(p_workspace_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_workspace_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public."community_workspaces" w WHERE w."id" = p_workspace_id AND w."coach_id" = p_user_id)
    OR EXISTS (SELECT 1 FROM public."community_memberships" m
               WHERE m."workspace_id" = p_workspace_id AND m."user_id" = p_user_id AND m."status" <> 'removed')
  )
$fn$;
COMMENT ON FUNCTION app.workspace_has_participant(uuid, text) IS
  '20270502000200: the user is the workspace coach or holds a membership there that was not removed (the DM recipient rule of community_messages_author_insert).';

CREATE OR REPLACE FUNCTION app.is_community_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_memberships" m
    WHERE m."workspace_id" = p_workspace_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$fn$;
COMMENT ON FUNCTION app.is_community_workspace_member(uuid) IS
  'Caller holds a non-removed membership in the workspace. search_path pinned to '''' (S1-DB-01).';

CREATE OR REPLACE FUNCTION app.shares_community_cohort(p_cohort_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_memberships" m
    WHERE m."cohort_id" = p_cohort_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$fn$;
COMMENT ON FUNCTION app.shares_community_cohort(uuid) IS
  'Caller shares the cohort via a non-removed membership. search_path pinned to '''' (S1-DB-01).';

DROP FUNCTION app.community_can_access(uuid, text);

DROP TABLE "community_cohort_packages";

ALTER TABLE "community_cohorts" DROP COLUMN "visibility";

DROP TYPE "CommunitySpaceVisibility";

COMMIT;
