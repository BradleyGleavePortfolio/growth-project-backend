-- GUIDEWRITE (agent 144, owner "RLS for everything"): only a coach writes a
-- coach guideline. TIGHTENING ONLY: three policies narrowed, their comments
-- refreshed. No data change; nothing is created, dropped or deleted.
--
-- GAP: p_coachguideline_insert / _update / _delete (20261212010000, restated
-- by 20270419000000) admit "client_id" = app.current_user_id() with ANY
-- coach_id. So a session acting as a client could create a guideline row
-- that names any coach as its author, and edit or delete their own coach's
-- guideline. Roman and the AI context read that row as the coach's
-- instruction. The app never does this (the only writer is
-- CoachService.postGuidelines, a coach route, on the service-role
-- connection); the row rule must still forbid it.
--
-- NOW: insert, update and delete admit the owner admin, or the author
-- (coach_id = caller) about their own current client or about no client:
-- the 20270419000000 rule without the client branch. SELECT is unchanged, so
-- the client still reads every guideline written about them.
-- DailyMealPlan, MealTemplate and DailyMealPlanSlot (also restated by
-- 20270419000000) have no client branch, so they need nothing here.
-- Reverse: down.sql (restores the 20270419000000 text).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_coachguideline_insert" ON "CoachGuideline"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))));
COMMENT ON POLICY "p_coachguideline_insert" ON "CoachGuideline" IS '20270429000000: owner, or the author about their own current client (or no client). A client never writes a guideline.';
ALTER POLICY "p_coachguideline_update" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))));
COMMENT ON POLICY "p_coachguideline_update" ON "CoachGuideline" IS '20270429000000: owner, or the author while the client is still theirs (or the row names no client), post-image the same. A client never writes a guideline.';
ALTER POLICY "p_coachguideline_delete" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))));
COMMENT ON POLICY "p_coachguideline_delete" ON "CoachGuideline" IS '20270429000000: owner, or the author while the client is still theirs (or the row names no client). A client never deletes a guideline.';

COMMIT;
