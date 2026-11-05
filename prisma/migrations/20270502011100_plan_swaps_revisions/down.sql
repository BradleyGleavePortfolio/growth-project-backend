-- Reverse of 20270502011100_plan_swaps_revisions (PLAN-SWAPS-BE). Drops the two template-link policies and
-- their helper (FIX-1221), DailyMealPlanRevision (its
-- policies go with it), DailyMealPlan.updated_at, MealTemplate.swap_template_ids and .recipe_id, and
-- ListItem.source_plan_slot_id. Irreversible for that data only: the coach's swaps and recipe links, the
-- record of today's plan changes and the grocery items' plan-meal links are deleted; every plan, meal,
-- recipe and grocery item stays.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "p_mealtemplate_links_update" ON "MealTemplate";
DROP POLICY IF EXISTS "p_mealtemplate_links_insert" ON "MealTemplate";
DROP FUNCTION IF EXISTS app.meal_template_links_ok(text, text, text[], text);

DROP TABLE IF EXISTS "DailyMealPlanRevision";

ALTER TABLE "ListItem" DROP CONSTRAINT IF EXISTS "ListItem_source_plan_slot_id_fkey";
DROP INDEX IF EXISTS "ListItem_source_plan_slot_id_idx";
ALTER TABLE "ListItem" DROP COLUMN IF EXISTS "source_plan_slot_id";

ALTER TABLE "DailyMealPlan" DROP COLUMN IF EXISTS "updated_at";

ALTER TABLE "MealTemplate" DROP CONSTRAINT IF EXISTS "MealTemplate_recipe_id_fkey";
DROP INDEX IF EXISTS "MealTemplate_recipe_id_idx";
ALTER TABLE "MealTemplate" DROP COLUMN IF EXISTS "recipe_id";
ALTER TABLE "MealTemplate" DROP COLUMN IF EXISTS "swap_template_ids";

COMMIT;
