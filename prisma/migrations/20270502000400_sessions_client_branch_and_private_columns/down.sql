-- Reverse of 20270502000400_sessions_client_branch_and_private_columns. Only
-- for a confirmed defect: a client again creates sessions naming any coach,
-- in any status, and writes every column of their own sessions. Restores the
-- 20270413000000 (#972) text verbatim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_coachingsession_insert" ON "CoachingSession"
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
ALTER POLICY "p_coachingsession_update" ON "CoachingSession"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))))
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
COMMENT ON POLICY "p_coachingsession_insert" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may create the session.';
COMMENT ON POLICY "p_coachingsession_update" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may update the session, before and after the change.';

DROP TRIGGER IF EXISTS "coaching_session_private_columns_guard" ON "CoachingSession";
DROP FUNCTION IF EXISTS app.coaching_session_private_columns_guard();
DROP FUNCTION IF EXISTS app.session_type_auto_approves(text, text);

COMMIT;
