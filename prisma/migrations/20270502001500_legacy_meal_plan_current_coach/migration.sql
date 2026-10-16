-- RLSMEALLEGACY (agent 145; GPT-6.1 Sol AUDIT on #961, B1 database half):
-- a former coach loses row access to a moved client's legacy meal plans.
-- Second lock only: the backend reads and writes through Prisma's
-- service-role connection, which bypasses RLS, and a Data API caller has no
-- app.current_user_id, so no app path changes. #961 closes the server half.
-- No data change; nothing is deleted. Reverse: down.sql.
--
-- GAP: p_mealplan_select, _update and _delete (20261213000000, the same text
-- in production on 2026-10-14) admit the client, the client's current coach
-- (app.is_current_coach_of), or "coach_id" = app.current_user_id() with no
-- end. After a move, a plan keeps coach_id = the former coach, so that coach
-- still reads, edits and deletes it. p_mealplan_insert has the same branch,
-- so the former coach could also add a plan about the moved client (and any
-- coach could add one about another coach's client under their own coach_id).
--
-- NOW: one RESTRICTIVE policy, ANDed with the four permissive ones for every
-- command. A row passes only for the owner, a plan with no client, the plan's
-- client, or the client's current coach (app.is_user_coached_by, the tenure
-- helper the other slices use). The client's own branch, the current-coach
-- branch and the no-client coach branch pass unchanged; the plan coach's
-- branch now needs the client to still be theirs, before and after an
-- update. Restrictive, not an ALTER of the permissive text, so it composes in
-- any merge order with #1009 (20270502000700), which rewrites the permissive
-- MealPlan policies; with #1009 in, this fence is already implied.
-- Scoped to the two API roles: service_role and the migration role are
-- untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "p_mealplan_coach_keeps_current_client" ON "MealPlan";
CREATE POLICY "p_mealplan_coach_keeps_current_client" ON "MealPlan" AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING ((app.current_user_id() IS NOT NULL AND (app.is_owner() OR "client_id" IS NULL OR "client_id" = app.current_user_id() OR app.is_user_coached_by("client_id", app.current_user_id()))))
  WITH CHECK ((app.current_user_id() IS NOT NULL AND (app.is_owner() OR "client_id" IS NULL OR "client_id" = app.current_user_id() OR app.is_user_coached_by("client_id", app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_coach_keeps_current_client" ON "MealPlan" IS
  '20270502001500: restrictive. The owner, a plan with no client, the plan client, or that client''s current coach; so the plan coach reads and writes it only while the client is still theirs (a former coach loses it at the move).';

COMMIT;
