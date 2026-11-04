-- 20270502011100_plan_swaps_revisions (PLAN-SWAPS-BE, agent 196; C2 Style C S2): a plan meal's swaps and
-- recipe, today's plan changes, and plan items on the grocery list. Additive only; no data change.
--
--   * MealTemplate.swap_template_ids TEXT[] (default empty) and MealTemplate.recipe_id (nullable, FK to
--     Recipe, ON DELETE SET NULL): the coach's swaps for a meal and their recipe for it.
--   * DailyMealPlan.updated_at, NOT NULL with a constant-per-statement default (catalogue-only on
--     Postgres 11+, no table rewrite); existing rows read the migration time.
--   * DailyMealPlanRevision: one row per meal change in a coach's plan edit (RealMealPlansService
--     .updatePlan writes it in the same transaction as the slot change). Goes with its plan (CASCADE).
--   * ListItem.source_plan_slot_id (nullable, FK to DailyMealPlanSlot, ON DELETE SET NULL, like
--     LoggedFoodEntry.plan_slot_id): the plan meal a grocery item was added from.
--
-- Row rules for the new table (RLS enabled and forced; anon has no table access), the house pattern for
-- coach-owned plan rows (20270419000000, 20270502000700):
--   * the client reads the revisions of a plan they hold (app.caller_holds_meal_plan, the helper the
--     plan, slot and template client policies use); a client who holds no assignment of it reads none;
--   * the plan's coach reads them while every client holding the plan is still theirs
--     (app.caller_keeps_meal_plan); a former coach, and any other coach, reads none;
--   * no API role writes: the server writes through Prisma's service-role connection (bypasses RLS)
--     behind the coach routes' ownership checks, and a revision is never changed or deleted by hand.
-- The new columns sit on tables whose policies already cover every column; nothing there changes.
-- Live proof: test/rls/plan-revisions-rls.spec.ts (rls-live-tests). Reverse: down.sql.
-- Placement: sorts after 20270502010900 (main) and 20270502011000 (#1219, not yet merged).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "MealTemplate" ADD COLUMN "swap_template_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "recipe_id" TEXT;
CREATE INDEX "MealTemplate_recipe_id_idx" ON "MealTemplate"("recipe_id");
ALTER TABLE "MealTemplate" ADD CONSTRAINT "MealTemplate_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DailyMealPlan" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ListItem" ADD COLUMN "source_plan_slot_id" TEXT;
CREATE INDEX "ListItem_source_plan_slot_id_idx" ON "ListItem"("source_plan_slot_id");
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_source_plan_slot_id_fkey" FOREIGN KEY ("source_plan_slot_id") REFERENCES "DailyMealPlanSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DailyMealPlanRevision" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "slot_label" TEXT NOT NULL,
    "from_template_id" TEXT,
    "to_template_id" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyMealPlanRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DailyMealPlanRevision_plan_id_changed_at_idx" ON "DailyMealPlanRevision"("plan_id", "changed_at");
ALTER TABLE "DailyMealPlanRevision" ADD CONSTRAINT "DailyMealPlanRevision_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "DailyMealPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DailyMealPlanRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyMealPlanRevision" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "DailyMealPlanRevision" FROM anon;

CREATE POLICY "p_dailymealplanrevision_select_assigned_client" ON "DailyMealPlanRevision"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.caller_holds_meal_plan("plan_id"));
COMMENT ON POLICY "p_dailymealplanrevision_select_assigned_client" ON "DailyMealPlanRevision" IS '20270502011100: a client reads the changes of a plan they hold an assignment for.';
CREATE POLICY "p_dailymealplanrevision_select_coach" ON "DailyMealPlanRevision"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."DailyMealPlan" dmp WHERE dmp."id" = "DailyMealPlanRevision"."plan_id" AND dmp."coach_id" = app.current_user_id() AND app.caller_keeps_meal_plan(dmp."id")));
COMMENT ON POLICY "p_dailymealplanrevision_select_coach" ON "DailyMealPlanRevision" IS '20270502011100: the plan''s coach reads its changes while every client holding the plan is still theirs. No API role writes.';

COMMIT;
