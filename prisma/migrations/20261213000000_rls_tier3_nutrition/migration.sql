-- PR-RLS-05 — Tier 3 nutrition and hydration RLS lock-down
--
-- Enables (and FORCEs) row-level security on the 7 remaining Tier 3
-- nutrition / hydration tables and installs the canonical policy set for
-- each. FORCE is used so the policies also apply to the table-owning role,
-- not just to ordinary callers — only members of `service_role` (Primitive A)
-- and the `app.is_owner()` operator role bypass the per-row predicates.
--
-- Tables covered:
--   "MealPlan"                — client-self-or-coach (coach_id / client_id)
--   "MealTemplate"            — coach-self (coach_id)
--   "DailyMealPlan"           — coach-self (coach_id)
--   "DailyMealPlanSlot"       — child-via-daily-meal-plan / meal-template
--   "DailyMealPlanAssignment" — client-self-or-assigned-coach
--   "FoodItem"                — global catalog: public read, app.is_owner()-only write
--   "water_logs"              — owner-only writes; owner + current-coach read
--
-- Helper convention (unchanged): app.current_user_id(), app.is_owner(),
-- app.is_current_coach_of(text). See PR-RLS-FN (20261212000000).
--
-- Each policy is idempotent: DROP POLICY IF EXISTS precedes every CREATE so
-- the migration can be re-applied safely. ENABLE / FORCE statements are also
-- naturally idempotent.
--
-- Rollback: drop the policies created here and run
--   ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ONLY if a confirmed P0 production outage requires it; otherwise fix forward
-- with a policy patch.

-- ─────────────────────────────────────────────────────────────────────────
-- MealPlan — Tier 3; meal plan; owner columns: coach_id, client_id;
-- primitive: client-self-or-coach.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "MealPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_mealplan_service_role_all" ON "MealPlan";
CREATE POLICY "p_mealplan_service_role_all" ON "MealPlan" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_mealplan_service_role_all" ON "MealPlan" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_mealplan_select" ON "MealPlan";
CREATE POLICY "p_mealplan_select" ON "MealPlan" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_select" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: owner, the plan client, that client''s current coach, or the plan coach may read.';
DROP POLICY IF EXISTS "p_mealplan_insert" ON "MealPlan";
CREATE POLICY "p_mealplan_insert" ON "MealPlan" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_insert" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may insert.';
DROP POLICY IF EXISTS "p_mealplan_update" ON "MealPlan";
CREATE POLICY "p_mealplan_update" ON "MealPlan" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_update" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may update (both row visibility and post-image).';
DROP POLICY IF EXISTS "p_mealplan_delete" ON "MealPlan";
CREATE POLICY "p_mealplan_delete" ON "MealPlan" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" IS NOT NULL AND ("client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))) OR "coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_mealplan_delete" ON "MealPlan" IS 'PR-RLS-05 client-self-or-coach: only the owner, plan client, that client''s current coach, or the plan coach may delete.';

-- ─────────────────────────────────────────────────────────────────────────
-- MealTemplate — Tier 3; meal template; owner column: coach_id;
-- primitive: coach-self.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "MealTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MealTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_mealtemplate_service_role_all" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_service_role_all" ON "MealTemplate" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_mealtemplate_service_role_all" ON "MealTemplate" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_mealtemplate_select" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_select" ON "MealTemplate" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_select" ON "MealTemplate" IS 'PR-RLS-05 coach-self: owner or the owning coach may read their meal templates.';
DROP POLICY IF EXISTS "p_mealtemplate_insert" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_insert" ON "MealTemplate" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_insert" ON "MealTemplate" IS 'PR-RLS-05 coach-self: only the owner or the coach themselves may create templates under their coach_id.';
DROP POLICY IF EXISTS "p_mealtemplate_update" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_update" ON "MealTemplate" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_update" ON "MealTemplate" IS 'PR-RLS-05 coach-self: only the owner or owning coach may update; post-image must remain under that coach_id.';
DROP POLICY IF EXISTS "p_mealtemplate_delete" ON "MealTemplate";
CREATE POLICY "p_mealtemplate_delete" ON "MealTemplate" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_mealtemplate_delete" ON "MealTemplate" IS 'PR-RLS-05 coach-self: only the owner or owning coach may delete their templates.';

-- ─────────────────────────────────────────────────────────────────────────
-- DailyMealPlan — Tier 3; daily meal plan; owner column: coach_id;
-- primitive: coach-self.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "DailyMealPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyMealPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_dailymealplan_service_role_all" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_service_role_all" ON "DailyMealPlan" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_dailymealplan_service_role_all" ON "DailyMealPlan" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_dailymealplan_select" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_select" ON "DailyMealPlan" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_select" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: owner or the owning coach may read their daily meal plans.';
DROP POLICY IF EXISTS "p_dailymealplan_insert" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_insert" ON "DailyMealPlan" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_insert" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: only the owner or the coach themselves may create plans under their coach_id.';
DROP POLICY IF EXISTS "p_dailymealplan_update" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_update" ON "DailyMealPlan" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_update" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: only the owner or owning coach may update; post-image must remain under that coach_id.';
DROP POLICY IF EXISTS "p_dailymealplan_delete" ON "DailyMealPlan";
CREATE POLICY "p_dailymealplan_delete" ON "DailyMealPlan" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_dailymealplan_delete" ON "DailyMealPlan" IS 'PR-RLS-05 coach-self: only the owner or owning coach may delete their daily meal plans.';

-- ─────────────────────────────────────────────────────────────────────────
-- DailyMealPlanSlot — Tier 3; daily meal slot; no direct owner column;
-- ownership flows through DailyMealPlan.daily_meal_plan_id and
-- MealTemplate.meal_template_id; primitive: child-via-daily-meal-plan.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "DailyMealPlanSlot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyMealPlanSlot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_dailymealplanslot_service_role_all" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_service_role_all" ON "DailyMealPlanSlot" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_dailymealplanslot_service_role_all" ON "DailyMealPlanSlot" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_dailymealplanslot_select" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_select" ON "DailyMealPlanSlot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_select" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: owner, or the coach owning the parent DailyMealPlan or the referenced MealTemplate, may read.';
DROP POLICY IF EXISTS "p_dailymealplanslot_insert" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_insert" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or the coach owning the parent DailyMealPlan or referenced MealTemplate may insert a slot.';
DROP POLICY IF EXISTS "p_dailymealplanslot_update" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_update" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or owning coach (parent plan or referenced template) may update; post-image must satisfy the same parent ownership.';
DROP POLICY IF EXISTS "p_dailymealplanslot_delete" ON "DailyMealPlanSlot";
CREATE POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanSlot"."daily_meal_plan_id" AND dmp."coach_id" = app.current_user_id()) OR EXISTS (SELECT 1 FROM public."MealTemplate" mt WHERE mt."id" = "DailyMealPlanSlot"."meal_template_id" AND mt."coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanslot_delete" ON "DailyMealPlanSlot" IS 'PR-RLS-05 child-via-daily-meal-plan: only the owner or the coach owning the parent DailyMealPlan or referenced MealTemplate may delete.';

-- ─────────────────────────────────────────────────────────────────────────
-- DailyMealPlanAssignment — Tier 3; meal assignment;
-- owner columns: client_id, assigned_by_coach_id;
-- primitive: client-self-or-assigned-coach.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "DailyMealPlanAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyMealPlanAssignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_dailymealplanassignment_service_role_all" ON "DailyMealPlanAssignment";
CREATE POLICY "p_dailymealplanassignment_service_role_all" ON "DailyMealPlanAssignment" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_dailymealplanassignment_service_role_all" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment";
CREATE POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, the assigned client (client_id), or the assigning coach (assigned_by_coach_id) may read. Transitive app.is_current_coach_of(client_id) is intentionally EXCLUDED so a later/different current coach cannot see assignments they did not make.';
DROP POLICY IF EXISTS "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment";
CREATE POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, the assigned client, or the assigning coach may insert. Transitive current-coach access is intentionally excluded.';
DROP POLICY IF EXISTS "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment";
CREATE POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, assigned client, or assigning coach may update; post-image must satisfy the same predicate. Transitive current-coach access is intentionally excluded.';
DROP POLICY IF EXISTS "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment";
CREATE POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, assigned client, or assigning coach may delete. Transitive current-coach access is intentionally excluded.';

-- ─────────────────────────────────────────────────────────────────────────
-- FoodItem — Tier 3; food catalog; no owner column;
-- primitive: public-catalog-read, owner-write (Primitive F).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "FoodItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FoodItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_fooditem_service_role_all" ON "FoodItem";
CREATE POLICY "p_fooditem_service_role_all" ON "FoodItem" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_fooditem_service_role_all" ON "FoodItem" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_fooditem_select" ON "FoodItem";
CREATE POLICY "p_fooditem_select" ON "FoodItem" AS PERMISSIVE FOR SELECT TO public USING (true);
COMMENT ON POLICY "p_fooditem_select" ON "FoodItem" IS 'PR-RLS-05 public-catalog-read: the food catalog is a shared reference table; any caller (including unauthenticated) may read.';
DROP POLICY IF EXISTS "p_fooditem_insert" ON "FoodItem";
CREATE POLICY "p_fooditem_insert" ON "FoodItem" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_fooditem_insert" ON "FoodItem" IS 'FoodItem is a global catalog (USDA FDC + OpenFoodFacts upstream). No per-row ownership column exists. Non-bypass writes are denied; only app.is_owner() (catalog admins) or service_role may write. See RLS_REMEDIATION_PLAN.md.';
DROP POLICY IF EXISTS "p_fooditem_update" ON "FoodItem";
CREATE POLICY "p_fooditem_update" ON "FoodItem" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_fooditem_update" ON "FoodItem" IS 'FoodItem is a global catalog (USDA FDC + OpenFoodFacts upstream). No per-row ownership column exists. Non-bypass writes are denied; only app.is_owner() (catalog admins) or service_role may write. See RLS_REMEDIATION_PLAN.md.';
DROP POLICY IF EXISTS "p_fooditem_delete" ON "FoodItem";
CREATE POLICY "p_fooditem_delete" ON "FoodItem" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_fooditem_delete" ON "FoodItem" IS 'FoodItem is a global catalog (USDA FDC + OpenFoodFacts upstream). No per-row ownership column exists. Non-bypass writes are denied; only app.is_owner() (catalog admins) or service_role may write. See RLS_REMEDIATION_PLAN.md.';

-- ─────────────────────────────────────────────────────────────────────────
-- water_logs — Tier 3; hydration log; owner column: user_id;
-- primitive: user-self + current-coach read.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "water_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "water_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_water_logs_service_role_all" ON "water_logs";
CREATE POLICY "p_water_logs_service_role_all" ON "water_logs" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_water_logs_service_role_all" ON "water_logs" IS 'PR-RLS-05 Primitive A: service_role bypass for server-side jobs and migrations.';
DROP POLICY IF EXISTS "p_water_logs_select" ON "water_logs";
CREATE POLICY "p_water_logs_select" ON "water_logs" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_water_logs_select" ON "water_logs" IS 'PR-RLS-05 user-self-current-coach-read: owner, the logging user, or that user''s current coach may read hydration logs.';
DROP POLICY IF EXISTS "p_water_logs_insert" ON "water_logs";
CREATE POLICY "p_water_logs_insert" ON "water_logs" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_water_logs_insert" ON "water_logs" IS 'PR-RLS-05 owner-only writes: only the owner operator or the logging user may insert their own hydration log. Coaches have SELECT-only access to client hydration logs and may NOT write them.';
DROP POLICY IF EXISTS "p_water_logs_update" ON "water_logs";
CREATE POLICY "p_water_logs_update" ON "water_logs" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_water_logs_update" ON "water_logs" IS 'PR-RLS-05 owner-only writes: only the owner operator or the logging user may update their own hydration log; post-image must remain under that user_id. Coaches have SELECT-only access and may NOT update client hydration logs.';
DROP POLICY IF EXISTS "p_water_logs_delete" ON "water_logs";
CREATE POLICY "p_water_logs_delete" ON "water_logs" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_water_logs_delete" ON "water_logs" IS 'PR-RLS-05 owner-only writes: only the owner operator or the logging user may delete their own hydration log. Coaches have SELECT-only access and may NOT delete client hydration logs.';
