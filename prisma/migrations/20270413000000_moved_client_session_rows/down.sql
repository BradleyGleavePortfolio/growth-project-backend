-- Reverse of 20270413000000_moved_client_session_rows. Only for a confirmed
-- defect: the old coach reads and writes a moved client's sessions again, a
-- client's current coach reads every coach's sessions with them, and the API
-- roles read the coach-only columns. Restores the 20261213000000 text verbatim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Revoking table SELECT also drops the column grants.
REVOKE SELECT ON "CoachingSession" FROM authenticated;
GRANT SELECT ON "CoachingSession" TO anon, authenticated;

ALTER POLICY "p_coachingsession_select" ON "CoachingSession"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
ALTER POLICY "p_coachingsession_insert" ON "CoachingSession"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
ALTER POLICY "p_coachingsession_update" ON "CoachingSession"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
ALTER POLICY "p_coachingsession_delete" ON "CoachingSession"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachingsession_select" ON "CoachingSession" IS 'PR-RLS-03 Primitive D: owner, the session coach, the lead client, or the client''s current coach may read the session.';
COMMENT ON POLICY "p_coachingsession_insert" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write: only the owner, the session''s own coach (coach_id = caller), the session''s lead client (client_id = caller), or that client''s current coach may create the session. coach_id/client_id ARE the authorization columns, so there is no IDOR escape — passing client_id = me means I am that session''s lead client by definition.';
COMMENT ON POLICY "p_coachingsession_update" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write (USING + WITH CHECK): only the owner, the session''s own coach, the session''s lead client, or that client''s current coach may update the session. coach_id/client_id are the authorization columns; WITH CHECK prevents re-pointing the session to a coach/client the caller is not.';
COMMENT ON POLICY "p_coachingsession_delete" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write: only the owner, the session''s own coach, the session''s lead client, or that client''s current coach may delete the session.';

DROP FUNCTION app.client_still_books_caller(text);

COMMIT;
