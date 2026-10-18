-- READTESTS (LSB B2, round 1): the SQL twin of SubCoachScopeService's
-- membership rule. Removing a sub-coach archives the pair's one seat row
-- (unique per head and sub) and leaves their client delegations open, so an
-- archived seat ends membership and an open delegation counts only for a pair
-- that never had a seat. app.can_read_client_consultation uses this helper,
-- so a removed sub-coach no longer reads the head's delegated clients' intake
-- rows, nor the head the removed coach's own clients'. Same signature, owner,
-- search_path and EXECUTE grants (service_role only). Reverse: down.sql.

CREATE OR REPLACE FUNCTION app.sub_coach_membership_head(coach_user_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $fn$
  SELECT u.coach_id
    FROM "User" u
    LEFT JOIN "TeamSubCoachAssignment" t
      ON t.head_coach_id = u.coach_id
     AND t.sub_coach_id = u.id
   WHERE u.id = coach_user_id
     AND u.role::text = 'coach'
     AND u.coach_id IS NOT NULL
     AND (
           (t.id IS NOT NULL AND t.archived_at IS NULL)
        OR (
             t.id IS NULL
             AND EXISTS (
                   SELECT 1
                     FROM "SubCoachAssignment" s
                    WHERE s.head_coach_id = u.coach_id
                      AND s.sub_coach_id = u.id
                      AND s.unassigned_at IS NULL
                 )
           )
     )
$fn$;

REVOKE ALL ON FUNCTION app.sub_coach_membership_head(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.sub_coach_membership_head(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION app.sub_coach_membership_head(text) TO service_role;
COMMENT ON FUNCTION app.sub_coach_membership_head(text) IS
  'Head coach id of an EXPLICIT team member (role coach, coach_id set, and an active TeamSubCoachAssignment from that head, or, for a pair that never had a seat, an open SubCoachAssignment from that head), else NULL. An archived seat is a removal. A bare coach_id is not membership. Mirrors SubCoachScopeService.getHeadCoachIdForSubCoach. Internal to app.can_read_client_consultation; not executable by anon/authenticated.';
