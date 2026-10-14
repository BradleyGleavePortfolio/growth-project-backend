-- RLSLIVE1a (RLS-ALL slice 9; RLSINV H09, H11, H05, H06): food, weight,
-- profile and meal-plan rows follow the coaching relationship in the row
-- policies too. Second lock only (RLS-MODE Option 1): the backend reads and
-- writes through Prisma's service-role connection, which bypasses RLS, and a
-- Data API caller has no app.current_user_id, so no app path changes.
-- No data change; nothing is deleted. Reverse: down.sql.
--
-- GAP:
--   * H09. LoggedFoodEntry, WeightLog and UserProfile had only their owner
--     policy (20270410000000), so the client's current coach read none of the
--     rows the coach dashboard shows.
--   * H11. DailyMealPlan, MealTemplate and DailyMealPlanSlot admitted only the
--     owning coach, so a client read none of the plan assigned to them.
--   * H05. p_dailymealplanassignment_* (20270414000000) let the assigned
--     client insert, change and delete their own assignments, and name any
--     coach as the assigner.
--   * H06. p_mealplan_* (20261213000000) let the plan's client write the
--     coach's plan, let a coach write a plan naming another coach, and kept
--     the plan's coach_id (a former coach) in for good.
--
-- NOW:
--   * The client's current coach reads (SELECT only) their food entries,
--     weight logs and profile: app.is_current_coach_of(user_id). A former
--     coach and any other coach read none. The owner policies are unchanged.
--   * A client reads every DailyMealPlan they hold an assignment for, and its
--     slots and templates, through two SECURITY DEFINER helpers. The template
--     needs its own helper: DailyMealPlanSlot's SELECT policy reads
--     MealTemplate, so a MealTemplate policy that read DailyMealPlanSlot
--     directly would recurse.
--   * DailyMealPlanAssignment writes: the assigning coach while the client is
--     theirs (the #976 rule); the client branch goes. SELECT is unchanged.
--   * MealPlan writes: the plan's coach for their own current client. SELECT:
--     the client, or the client's current coach; the bare coach_id branch only
--     covers a plan whose client was removed (client_id NULL).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.caller_holds_meal_plan(target_plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public."DailyMealPlanAssignment" a
    WHERE a."daily_meal_plan_id" = target_plan_id
      AND a."client_id" = app.current_user_id()
  )
$$;
COMMENT ON FUNCTION app.caller_holds_meal_plan(text) IS
  '20270502000700: true when the caller is a client holding an assignment of the plan. Reads no DailyMealPlan row.';

CREATE OR REPLACE FUNCTION app.caller_holds_meal_template(target_template_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."DailyMealPlanSlot" s
    WHERE s."meal_template_id" = target_template_id
      AND app.caller_holds_meal_plan(s."daily_meal_plan_id")
  )
$$;
COMMENT ON FUNCTION app.caller_holds_meal_template(text) IS
  '20270502000700: true when a slot of a plan the caller holds uses the template. Reads no MealTemplate row.';

REVOKE ALL ON FUNCTION app.caller_holds_meal_plan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.caller_holds_meal_template(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_holds_meal_plan(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.caller_holds_meal_template(text) TO authenticated, service_role;

-- H09: the current coach reads the client's food, weight and profile rows.
DROP POLICY IF EXISTS "food_entry_current_coach_select" ON "LoggedFoodEntry";
CREATE POLICY "food_entry_current_coach_select" ON "LoggedFoodEntry"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "food_entry_current_coach_select" ON "LoggedFoodEntry" IS '20270502000700: the client''s current coach reads the entry.';
DROP POLICY IF EXISTS "weight_log_current_coach_select" ON "WeightLog";
CREATE POLICY "weight_log_current_coach_select" ON "WeightLog"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "weight_log_current_coach_select" ON "WeightLog" IS '20270502000700: the client''s current coach reads the weight log.';
DROP POLICY IF EXISTS "user_profile_current_coach_select" ON "UserProfile";
CREATE POLICY "user_profile_current_coach_select" ON "UserProfile"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "user_profile_current_coach_select" ON "UserProfile" IS '20270502000700: the client''s current coach reads the profile.';

-- H11: a client reads the plan they hold, its slots and its templates.
DROP POLICY IF EXISTS "p_dailymealplan_select_assigned_client" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_select_assigned_client" ON "DailyMealPlan"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.caller_holds_meal_plan("id"));
COMMENT ON POLICY "p_dailymealplan_select_assigned_client" ON "DailyMealPlan" IS '20270502000700: a client reads a plan they hold an assignment for.';
DROP POLICY IF EXISTS "p_dailymealplanslot_select_assigned_client" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_select_assigned_client" ON "DailyMealPlanSlot"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.caller_holds_meal_plan("daily_meal_plan_id"));
COMMENT ON POLICY "p_dailymealplanslot_select_assigned_client" ON "DailyMealPlanSlot" IS '20270502000700: a client reads the slots of a plan they hold.';
DROP POLICY IF EXISTS "p_mealtemplate_select_assigned_client" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_select_assigned_client" ON "MealTemplate"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.caller_holds_meal_template("id"));
COMMENT ON POLICY "p_mealtemplate_select_assigned_client" ON "MealTemplate" IS '20270502000700: a client reads a template used by a plan they hold.';

-- H05: only the client's coach writes plan assignments (SELECT unchanged).
ALTER POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" IS '20270502000700: the owner, or the assigning coach for a client who is theirs. The client does not write assignments.';
ALTER POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" IS '20270502000700: the owner, or the assigning coach while the client is still theirs, before and after the change. The client does not write assignments.';
ALTER POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "assigned_by_coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" IS '20270502000700: the owner, or the assigning coach while the client is still theirs. The client does not write assignments.';

-- H06: the plan's coach writes it for their own current client; the client
-- and the client's current coach read it.
ALTER POLICY "p_mealplan_select" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR ("client_id" IS NULL AND "coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_mealplan_select" ON "MealPlan" IS '20270502000700: the owner, the plan client, that client''s current coach, or the plan coach for a plan with no client.';
ALTER POLICY "p_mealplan_insert" ON "MealPlan"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_mealplan_insert" ON "MealPlan" IS '20270502000700: the owner, or the plan coach for their own current client.';
ALTER POLICY "p_mealplan_update" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_mealplan_update" ON "MealPlan" IS '20270502000700: the owner, or the plan coach while the client is still theirs, before and after the change.';
ALTER POLICY "p_mealplan_delete" ON "MealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_mealplan_delete" ON "MealPlan" IS '20270502000700: the owner, or the plan coach while the client is still theirs.';

COMMIT;
