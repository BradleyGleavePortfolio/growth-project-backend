-- Reverse of 20270420000000_food_entry_plan_link. Run AFTER the down.sql of
-- 20270420000001_food_entry_plan_slot_index_concurrent. Drops the plan link
-- and the usual-day flag: food logs keep every other value, and the app's
-- plan checklist (flag foodPlanChecklist) falls back to treating each food as
-- an extra. Only for a confirmed defect.

ALTER TABLE "LoggedFoodEntry" DROP CONSTRAINT IF EXISTS "LoggedFoodEntry_plan_slot_id_fkey";
ALTER TABLE "LoggedFoodEntry" DROP COLUMN IF EXISTS "plan_slot_id";
ALTER TABLE "LoggedFoodEntry" DROP COLUMN IF EXISTS "fills_usual_meal";
