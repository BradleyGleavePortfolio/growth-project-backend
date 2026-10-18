-- MOVERLS2 (owner 4 and 4b, after MOVE-RLS #976 and HIST3 #977): after a
-- client moves, the former coach reaches neither the client's frozen meal
-- plan nor the guideline they wrote about that client through direct table
-- access. TIGHTENING ONLY: two new helpers, thirteen policies narrowed, two
-- stale comments refreshed. No data change; nothing is deleted.
--
-- GAP:
--   * DMPRLS. p_dailymealplan_*, p_mealtemplate_* and p_dailymealplanslot_*
--     (20261213000000) admitted the plan's coach_id with no end. A move
--     freezes the client's plan into an archived copy still owned by the
--     former coach (#961 freezeForMovedClients), so the former coach could
--     still read and edit the copy, its frozen templates and its slots.
--   * GUIDE-RLS. p_coachguideline_* (20261212010000) admitted the author with
--     no end, and the client's current coach for any row about the client.
--     So the former coach kept reading and editing the guideline, and the new
--     coach read and could rewrite the former coach's private guideline
--     (HIST3: coach A's guidelines never reach coach B or Roman).
--
-- NOW, the rules the services apply:
--   * app.caller_keeps_meal_plan(plan): every client holding the plan is
--     still the caller's own student (app.is_user_coached_by), the rule of
--     freezeForMovedClients and assertClientOfCoach. MealTemplate uses
--     app.caller_keeps_meal_template(template): every plan using the
--     template passes that rule.
--   * DailyMealPlan and MealTemplate: a coach reads their live library as
--     before, and an archived row only while no client who left holds it (the
--     app opens no archived row). Update and delete need the rule too, so no
--     write reaches a moved client's plan. INSERT is unchanged.
--   * DailyMealPlanSlot: SELECT is unchanged; its RLS'd subqueries on the
--     plan and template now hide a frozen copy's slots. A write needs the
--     caller to own the parent plan and pass the rule. The template branch is
--     dropped for writes, so a live template no longer lets a coach add a
--     slot to a plan that is not theirs.
--   * CoachGuideline: the author while the client is still theirs (or the row
--     names no client), and the client as before. The current-coach branch
--     goes; a new coach writes their own row.
--   * Opus C2 on #977: the 20270227000000 comments on the adjustment policies
--     still say "own proposals". Refreshed only where 20270417000000 has
--     already narrowed the policy, so a comment never names a rule the
--     database does not have.
-- No team branch exists on these tables before or after: a sub-coach reaches
-- them only as the client's own coach, so #978's seat rule needs nothing here.
-- The helpers are SECURITY DEFINER because DailyMealPlanAssignment hides a
-- moved client's rows from the former coach (#976); the function owner must
-- bypass RLS (runbook). The backend reads through Prisma's service-role
-- connection, which bypasses RLS, so no app path changes. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.caller_keeps_meal_plan(target_plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public."DailyMealPlanAssignment" a
    WHERE a."daily_meal_plan_id" = target_plan_id
      AND NOT app.is_user_coached_by(a."client_id", app.current_user_id())
  )
$$;
COMMENT ON FUNCTION app.caller_keeps_meal_plan(text) IS
  '20270419000000: true when every client holding the plan is still the caller''s own student (freezeForMovedClients rule). Reads no DailyMealPlan row.';

CREATE OR REPLACE FUNCTION app.caller_keeps_meal_template(target_template_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public."DailyMealPlanSlot" s
    WHERE s."meal_template_id" = target_template_id
      AND NOT app.caller_keeps_meal_plan(s."daily_meal_plan_id")
  )
$$;
COMMENT ON FUNCTION app.caller_keeps_meal_template(text) IS
  '20270419000000: true when every plan using the template passes app.caller_keeps_meal_plan. Reads no MealTemplate row.';

REVOKE ALL ON FUNCTION app.caller_keeps_meal_plan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.caller_keeps_meal_template(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_keeps_meal_plan(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.caller_keeps_meal_template(text) TO anon, authenticated, service_role;

-- DailyMealPlan
ALTER POLICY "p_dailymealplan_select" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("archived_at" IS NULL OR app.caller_keeps_meal_plan("id")))));
COMMENT ON POLICY "p_dailymealplan_select" ON "DailyMealPlan" IS '20270419000000: owner, or the owning coach for a live plan, or for an archived plan no client who left holds (a frozen copy stays hidden).';
ALTER POLICY "p_dailymealplan_update" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan("id"))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan("id"))));
COMMENT ON POLICY "p_dailymealplan_update" ON "DailyMealPlan" IS '20270419000000: owner, or the owning coach while every client holding the plan is still theirs; post-image the same.';
ALTER POLICY "p_dailymealplan_delete" ON "DailyMealPlan"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan("id"))));
COMMENT ON POLICY "p_dailymealplan_delete" ON "DailyMealPlan" IS '20270419000000: owner, or the owning coach while every client holding the plan is still theirs (a delete would cascade the moved client''s assignment).';

-- MealTemplate
ALTER POLICY "p_mealtemplate_select" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND ("archived_at" IS NULL OR app.caller_keeps_meal_template("id")))));
COMMENT ON POLICY "p_mealtemplate_select" ON "MealTemplate" IS '20270419000000: owner, or the owning coach for a live template, or for an archived one no frozen copy of a moved client uses.';
ALTER POLICY "p_mealtemplate_update" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_template("id"))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_template("id"))));
COMMENT ON POLICY "p_mealtemplate_update" ON "MealTemplate" IS '20270419000000: owner, or the owning coach while no plan of a client who left uses the template; post-image the same.';
ALTER POLICY "p_mealtemplate_delete" ON "MealTemplate"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.caller_keeps_meal_template("id"))));
COMMENT ON POLICY "p_mealtemplate_delete" ON "MealTemplate" IS '20270419000000: owner, or the owning coach while no plan of a client who left uses the template.';

-- DailyMealPlanSlot (SELECT unchanged: it follows the two tables above)
ALTER POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot"
  WITH CHECK ((app.is_owner() OR EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan(dmp."id"))));
COMMENT ON POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot" IS '20270419000000: owner, or the coach owning the parent plan while every client holding it is still theirs.';
ALTER POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot"
  USING ((app.is_owner() OR EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan(dmp."id"))))
  WITH CHECK ((app.is_owner() OR EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan(dmp."id"))));
COMMENT ON POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot" IS '20270419000000: owner, or the coach owning the parent plan while every client holding it is still theirs; post-image the same.';
ALTER POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot"
  USING ((app.is_owner() OR EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan(dmp."id"))));
COMMENT ON POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot" IS '20270419000000: owner, or the coach owning the parent plan while every client holding it is still theirs.';

-- CoachGuideline
ALTER POLICY "p_coachguideline_select" ON "CoachGuideline"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.is_user_coached_by("client_id", "coach_id")))))));
COMMENT ON POLICY "p_coachguideline_select" ON "CoachGuideline" IS '20270419000000: owner, the guideline client, or the author while the client is still theirs (or the row names no client).';
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

-- Opus C2 on #977: refresh the adjustment comments once 20270417000000 is in.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'WorkoutAdjustmentProposal'
      AND policyname = 'p_workoutadjustmentproposal_select_coach' AND qual LIKE '%is_user_coached_by%'
  ) THEN
    COMMENT ON POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal" IS
      'The proposing coach reads own proposals while the client is still theirs (20270417000000). No client, owner or sub-coach branch; no write policy for non-service principals.';
    COMMENT ON POLICY "p_workoutadjustmentevent_select_coach" ON "WorkoutAdjustmentEvent" IS
      'The proposing coach reads the audit trail of own proposals, through the proposal policy (the client must still be theirs).';
  END IF;
END
$$;

COMMIT;
