-- Reverse of 20270502004000_check_ins_habits_follow_the_coach, for a confirmed defect only: the
-- 20270502002500 body and comments come back, so a coach reads a client's habits again only while that
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
COMMENT ON POLICY "habit_current_coach_select" ON "Habit" IS '20270502002500: the client''s current coach reads the habit while the client shares habits with them.';
COMMENT ON POLICY "habit_current_coach_insert" ON "Habit" IS '20270502002500: the client''s current coach sets a habit naming themself, while the client shares habits with them.';
COMMENT ON POLICY "habit_current_coach_update" ON "Habit" IS '20270502002500: the client''s current coach edits a habit they set, while the client shares habits with them, before and after the change.';

COMMIT;
