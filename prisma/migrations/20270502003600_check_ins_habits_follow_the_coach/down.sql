-- Reverse of 20270502003600_check_ins_habits_follow_the_coach, for a confirmed defect only: the
-- 20270502002500 body and comment come back, so a coach reads a client's habits again only while that
-- client's stored Check-ins and habits row is granted. No rows change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.current_coach_has_scope(client_user_id text, consent_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.is_current_coach_of(client_user_id) AND EXISTS (
    SELECT 1
    FROM public."ClientCoachConsent" c
    WHERE c."client_id" = client_user_id
      AND c."coach_id" = app.current_user_id()
      AND c."scope" = consent_scope
      AND c."granted_at" IS NOT NULL
      AND (c."revoked_at" IS NULL OR c."revoked_at" < c."granted_at")
  )
$$;
COMMENT ON FUNCTION app.current_coach_has_scope(text, text) IS
  '20270502002500: true when the caller is the client''s current coach and the client shares the scope with them (granted, not revoked since).';

COMMIT;
