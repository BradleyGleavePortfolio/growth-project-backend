-- Reverse of 20270502005000: the rule as 20270502002400 wrote it (an archived
-- space opens like any other).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.community_can_access(p_cohort_id uuid, p_user_id text, p_listed boolean DEFAULT false)
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
COMMENT ON FUNCTION app.community_can_access(uuid, text, boolean) IS '20270502002400: the one rule for a community space. p_listed (rosters, Remove, membership rows) also counts a row that is not removed, so a pending invitation is listed; content reads and writes use the default.';

COMMIT;
