-- Reverse of 20270420000001_food_entry_plan_slot_fk_validate: the constraint
-- back to NOT VALID, as 20270420000000 leaves it. Run after the down.sql of
-- 20270420000002 and before the down.sql of 20270420000000.

ALTER TABLE "LoggedFoodEntry" DROP CONSTRAINT IF EXISTS "LoggedFoodEntry_plan_slot_id_fkey";
ALTER TABLE "LoggedFoodEntry" ADD CONSTRAINT "LoggedFoodEntry_plan_slot_id_fkey" FOREIGN KEY ("plan_slot_id") REFERENCES "DailyMealPlanSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
