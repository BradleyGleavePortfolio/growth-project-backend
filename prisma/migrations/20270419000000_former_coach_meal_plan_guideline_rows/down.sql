-- Reverse of 20270419000000_former_coach_meal_plan_guideline_rows. Only for a
-- confirmed defect: a former coach reads and edits a moved client's frozen
-- meal plan, its templates and slots, and their guideline about that client
-- again through direct table access, and a new coach reads the former
-- coach's guideline. Restores the 20261213000000, 20261212010000 and
-- 20270227000000 text verbatim, then drops the two helpers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_dailymealplan_select" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_select" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: owner or the owning coach may read their daily meal plans.';
ALTER POLICY "p_dailymealplan_update" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_update" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: only the owner or owning coach may update; post-image must remain under that coach_id.';
ALTER POLICY "p_dailymealplan_delete" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_delete" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: only the owner or owning coach may delete their daily meal plans.';

ALTER POLICY "p_mealtemplate_select" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_select" ON "MealTemplate" IS 'PR-RLS-05 coach-self: owner or the owning coach may read their meal templates.';
ALTER POLICY "p_mealtemplate_update" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_update" ON "MealTemplate" IS 'PR-RLS-05 coach-self: only the owner or owning coach may update; post-image must remain under that coach_id.';
ALTER POLICY "p_mealtemplate_delete" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_delete" ON "MealTemplate" IS 'PR-RLS-05 coach-self: only the owner or owning coach may delete their templates.';

ALTER POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or the coach owning the parent DailyMealPlan or referenced MealTemplate may insert a slot.';
ALTER POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))))
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or owning coach (parent plan or referenced template) may update; post-image must satisfy the same parent ownership.';
ALTER POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or the coach owning the parent DailyMealPlan or referenced MealTemplate may delete.';

ALTER POLICY "p_coachguideline_select" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_select" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may read.';
ALTER POLICY "p_coachguideline_insert" ON "CoachGuideline"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_insert" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may insert.';
ALTER POLICY "p_coachguideline_update" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_update" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may update.';
ALTER POLICY "p_coachguideline_delete" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_delete" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may delete.';

COMMENT ON POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal" IS
  'The proposing coach reads own proposals. No client, owner or sub-coach branch; no write policy for non-service principals.';
COMMENT ON POLICY "p_workoutadjustmentevent_select_coach" ON "WorkoutAdjustmentEvent" IS
  'The proposing coach reads the audit trail of own proposals only.';

DROP FUNCTION IF EXISTS app.caller_keeps_meal_template(text);
DROP FUNCTION IF EXISTS app.caller_keeps_meal_plan(text);

COMMIT;
