-- Reverse of 20270429000000_guideline_rows_coach_written_only. Only for a
-- confirmed defect: it brings back the gap (a client session may again create
-- a guideline naming any coach as author, and edit or delete their coach's
-- guideline). Restores the 20270419000000 text verbatim. No data to restore.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_coachguideline_insert" ON "CoachGuideline"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))));
COMMENT ON POLICY "p_coachguideline_insert" ON "CoachGuideline" IS '20270419000000: owner, the guideline client, or the author about their own current client (or no client).';
ALTER POLICY "p_coachguideline_update" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))));
COMMENT ON POLICY "p_coachguideline_update" ON "CoachGuideline" IS '20270419000000: owner, the guideline client, or the author while the client is still theirs (or the row names no client); post-image the same.';
ALTER POLICY "p_coachguideline_delete" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))));
COMMENT ON POLICY "p_coachguideline_delete" ON "CoachGuideline" IS '20270419000000: owner, the guideline client, or the author while the client is still theirs (or the row names no client).';

COMMIT;
