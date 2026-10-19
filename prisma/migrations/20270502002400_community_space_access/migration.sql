-- C6-BVIS: a person reads or writes a community space only while
-- app.community_can_access(space, person) is true. No anon grant (B-PUBLIC).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "CommunitySpaceVisibility" AS ENUM ('public', 'clients', 'package', 'members');

ALTER TABLE "community_cohorts" ADD COLUMN "visibility" "CommunitySpaceVisibility" NOT NULL DEFAULT 'members';

CREATE TABLE "community_cohort_packages" (
    "cohort_id" UUID NOT NULL,
    "package_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_cohort_packages_pkey" PRIMARY KEY ("cohort_id","package_id")
);

ALTER TABLE "community_cohort_packages" ADD CONSTRAINT "community_cohort_packages_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_cohort_packages" ADD CONSTRAINT "community_cohort_packages_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "CoachPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_cohort_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_cohort_packages" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "community_cohort_packages" FROM anon;
CREATE POLICY "community_cohort_packages_coach_all" ON "community_cohort_packages"
  FOR ALL TO public
  USING (EXISTS (SELECT 1 FROM "community_cohorts" c WHERE c."id" = "cohort_id" AND app.is_community_workspace_coach(c."workspace_id")))
  WITH CHECK (EXISTS (SELECT 1 FROM "community_cohorts" c WHERE c."id" = "cohort_id" AND app.is_community_workspace_coach(c."workspace_id")));

CREATE FUNCTION app.community_can_access(p_cohort_id uuid, p_user_id text, p_listed boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public."community_cohorts" c
    JOIN public."community_workspaces" w ON w."id" = c."workspace_id"
    JOIN public."User" u ON u."id" = p_user_id
    LEFT JOIN public."community_memberships" m ON m."cohort_id" = c."id" AND m."user_id" = p_user_id
    WHERE c."id" = p_cohort_id
      AND (
        w."coach_id" = p_user_id
        OR (
          NOT EXISTS (SELECT 1 FROM public."community_workspace_bans" b
                      WHERE b."workspace_id" = c."workspace_id" AND b."user_id" = p_user_id AND b."lifted_at" IS NULL)
          AND (m."status" = 'active' OR (p_listed AND m."status" <> 'removed')
               OR (m."id" IS NULL AND c."visibility" IN ('clients', 'package')))
          AND (
            m."role" <> 'student' OR c."visibility" = 'public'
            OR (u."coach_id" = w."coach_id"
                AND (c."visibility" <> 'package' OR EXISTS (
                  SELECT 1
                  FROM public."community_cohort_packages" l
                  JOIN public."ClientPurchase" p ON p."package_id" = l."package_id"
                  WHERE l."cohort_id" = c."id"
                    AND p."client_user_id" = p_user_id
                    AND p."coach_user_id" = w."coach_id"
                    AND p."entitlement_active"
                    AND (p."access_expires_at" IS NULL OR p."access_expires_at" > (now() AT TIME ZONE 'UTC')))))
          )
        )
      )
  )
$fn$;
ALTER FUNCTION app.community_can_access(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_can_access(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_can_access(uuid, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_can_access(uuid, text, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_can_access(uuid, text, boolean) IS '20270502002400: the one rule for a community space. p_listed (rosters, Remove, membership rows) also counts a row that is not removed, so a pending invitation is listed; content reads and writes use the default.';

-- A non-public space of the workspace (the Hall, DMs); DEFINER: no RLS loop.
CREATE FUNCTION app.community_workspace_open(p_workspace_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."community_cohorts" c
                 WHERE c."workspace_id" = p_workspace_id AND c."visibility" <> 'public'
                   AND app.community_can_access(c."id", p_user_id))
$fn$;
ALTER FUNCTION app.community_workspace_open(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_workspace_open(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_workspace_open(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_workspace_open(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app.shares_community_cohort(p_cohort_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT app.community_can_access(p_cohort_id, app.current_user_id())
$fn$;
COMMENT ON FUNCTION app.shares_community_cohort(uuid) IS
  'Caller passes app.community_can_access for the space (20270502002400). search_path pinned to '''' (S1-DB-01).';

CREATE OR REPLACE FUNCTION app.is_community_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT app.community_workspace_open(p_workspace_id, app.current_user_id())
$fn$;
COMMENT ON FUNCTION app.is_community_workspace_member(uuid) IS
  'Caller passes app.community_can_access for a space of the workspace that is not public (20270502002400). search_path pinned to '''' (S1-DB-01).';

CREATE OR REPLACE FUNCTION app.workspace_has_participant(p_workspace_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_workspace_id IS NOT NULL AND p_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public."community_workspaces" w WHERE w."id" = p_workspace_id AND w."coach_id" = p_user_id)
    OR app.community_workspace_open(p_workspace_id, p_user_id)
  )
$fn$;
COMMENT ON FUNCTION app.workspace_has_participant(uuid, text) IS
  '20270502002400: the user is the workspace coach or passes app.community_can_access for a space of the workspace that is not public (the Hall, DMs and workspace-wide rows).';

ALTER POLICY "community_memberships_coach_all" ON "community_memberships"
  USING (app.is_community_workspace_coach("workspace_id") AND app.community_can_access("cohort_id", "user_id", true))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

ALTER POLICY "community_memberships_self_or_shared_cohort_select" ON "community_memberships"
  USING (
    "user_id"::text = app.current_user_id()
    OR (app.shares_community_cohort("cohort_id") AND app.community_can_access("cohort_id", "user_id", true))
  );

ALTER POLICY "community_messages_author_update" ON "community_messages"
  USING (app.is_community_workspace_coach("workspace_id")
         OR ("sender_id"::text = app.current_user_id() AND ("scope" <> 'cohort' OR app.shares_community_cohort("cohort_id"))))
  WITH CHECK (app.is_community_workspace_coach("workspace_id")
         OR ("sender_id"::text = app.current_user_id() AND ("scope" <> 'cohort' OR app.shares_community_cohort("cohort_id"))));

ALTER POLICY "community_messages_author_delete" ON "community_messages"
  USING (app.is_community_workspace_coach("workspace_id")
         OR ("sender_id"::text = app.current_user_id() AND ("scope" <> 'cohort' OR app.shares_community_cohort("cohort_id"))));

COMMIT;
