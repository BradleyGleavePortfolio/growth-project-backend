-- Reverse of 20270502000700_food_body_row_rules. Only for a confirmed defect:
-- the current coach again reads none of a client's food, weight and profile
-- rows, a client again reads none of their assigned meal plan, the client
-- again writes their own plan assignments, and the MealPlan policies again
-- admit the plan's client and coach_id for writes. Drops the six new
-- policies, restores the 20270414000000 and 20261213000000 text verbatim
-- (policies and comments), then drops the two helpers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "food_entry_current_coach_select" ON "LoggedFoodEntry";
DROP POLICY IF EXISTS "weight_log_current_coach_select" ON "WeightLog";
DROP POLICY IF EXISTS "user_profile_current_coach_select" ON "UserProfile";
DROP POLICY IF EXISTS "p_dailymealplan_select_assigned_client" ON "DailyMealPlan";
DROP POLICY IF EXISTS "p_dailymealplanslot_select_assigned_client" ON "DailyMealPlanSlot";
DROP POLICY IF EXISTS "p_mealtemplate_select_assigned_client" ON "MealTemplate";

ALTER POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
ALTER POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
ALTER POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))));
COMMENT ON POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach for a client who is theirs. Transitive current-coach access stays excluded.';
COMMENT ON POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach while the client is still theirs, before and after the change. Transitive current-coach access stays excluded.';
COMMENT ON POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" IS '20270414000000: the owner, the assigned client, or the assigning coach while the client is still theirs. Transitive current-coach access stays excluded.';

ALTER POLICY "p_mealplan_select" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
ALTER POLICY "p_mealplan_insert" ON "MealPlan"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
ALTER POLICY "p_mealplan_update" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
ALTER POLICY "p_mealplan_delete" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_select" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: owner, the plan client, that client''s current coach, or the plan coach may read.';
COMMENT ON POLICY "p_mealplan_insert" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may insert.';
COMMENT ON POLICY "p_mealplan_update" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may update (both row visibility and post-image).';
COMMENT ON POLICY "p_mealplan_delete" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may delete.';

DROP FUNCTION IF EXISTS app.caller_holds_meal_template(text);
DROP FUNCTION IF EXISTS app.caller_holds_meal_plan(text);

COMMIT;
