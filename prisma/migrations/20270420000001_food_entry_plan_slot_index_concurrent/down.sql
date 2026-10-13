-- Reverse of 20270420000001_food_entry_plan_slot_index_concurrent. Run before
-- the down.sql of 20270420000000_food_entry_plan_link.
DROP INDEX CONCURRENTLY IF EXISTS "LoggedFoodEntry_plan_slot_id_idx";
