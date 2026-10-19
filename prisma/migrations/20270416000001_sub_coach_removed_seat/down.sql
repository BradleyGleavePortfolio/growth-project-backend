-- Reverse of 20270416000001_sub_coach_removed_seat: the 20270212000000 rule
-- again (an open delegation is membership even after the seat is archived).
-- Only for a confirmed defect: it reopens a removed sub-coach's consultation
-- reads.

CREATE OR REPLACE FUNCTION app.sub_coach_membership_head(coach_user_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $fn$
  SELECT u.coach_id
    FROM "User" u
   WHERE u.id = coach_user_id
     AND u.role::text = 'coach'
     AND u.coach_id IS NOT NULL
     AND (
           EXISTS (
             SELECT 1
               FROM "TeamSubCoachAssignment" t
              WHERE t.head_coach_id = u.coach_id
                AND t.sub_coach_id = u.id
                AND t.archived_at IS NULL
           )
        OR EXISTS (
             SELECT 1
               FROM "SubCoachAssignment" s
              WHERE s.head_coach_id = u.coach_id
                AND s.sub_coach_id = u.id
                AND s.unassigned_at IS NULL
           )
     )
$fn$;

COMMENT ON FUNCTION app.sub_coach_membership_head(text) IS
  'Head coach id of an EXPLICIT team member (role coach, coach_id set, active TeamSubCoachAssignment or open SubCoachAssignment from that head), else NULL. A bare coach_id is not membership. Mirrors SubCoachScopeService.getHeadCoachIdForSubCoach. Internal to app.can_read_client_consultation; not executable by anon/authenticated.';
