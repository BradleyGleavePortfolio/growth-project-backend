-- Reverse of 20270425000000_coach_brief_server_read_only. Only for a confirmed
-- defect: restores the 20260525120000 coach_select_own_brief policy verbatim,
-- so a coach reads their own CoachBrief rows directly again (without the
-- server's sharing, move and delegation checks).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "coach_select_own_brief" ON "CoachBrief";
CREATE POLICY "coach_select_own_brief"
  ON "CoachBrief"
  FOR SELECT
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

COMMIT;
