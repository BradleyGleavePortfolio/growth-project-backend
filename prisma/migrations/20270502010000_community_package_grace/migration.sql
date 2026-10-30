-- PF-2-BE (FR-1190, LS-1190 B1 / LO-1190 B1): a package space follows the live
-- paid-access rule the app guard uses. A weekly plan's access_expires_at is Day 8
-- while the failed-payment grace runs to the Day-10 lock, so a client in that grace
-- lost the paid space two days early; and a plan under its own Day-10 lock that a
-- Stripe resync set entitled again kept it. The package line now counts a linked
-- purchase that is entitled, not own-locked, and unexpired or in live grace
-- (past_due / unpaid with an active "DunningState" row whose locked_out_at is null).
-- Same signature, owner and grants; every other line is unchanged from 20270502005600.

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
          c."archived_at" IS NULL
          AND (c."status" = 'active' OR p_listed)
          AND NOT EXISTS (SELECT 1 FROM public."community_workspace_bans" b
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
                    AND NOT EXISTS (SELECT 1 FROM public."DunningState" d
                                WHERE d."purchase_id" = p."id" AND d."status" = 'active' AND d."locked_out_at" IS NOT NULL)
                    AND (p."access_expires_at" IS NULL OR p."access_expires_at" > (now() AT TIME ZONE 'UTC')
                         OR (p."status" IN ('past_due', 'unpaid') AND EXISTS (SELECT 1 FROM public."DunningState" g
                                WHERE g."purchase_id" = p."id" AND g."status" = 'active' AND g."locked_out_at" IS NULL))))))
          )
        )
      )
  )
$fn$;
COMMENT ON FUNCTION app.community_can_access(uuid, text, boolean) IS '20270502010000: the one rule for a community space; a draft or archived space opens to its coach only. A package space counts a linked purchase that is entitled, not under its own Day-10 lock, and inside its paid window or its failed-payment grace (past_due or unpaid with an active, unlocked dunning cycle). p_listed (rosters, Remove, membership rows) also counts a row that is not removed and lists the people of a draft space, so the coach can manage it; content reads and writes use the default.';

COMMIT;
