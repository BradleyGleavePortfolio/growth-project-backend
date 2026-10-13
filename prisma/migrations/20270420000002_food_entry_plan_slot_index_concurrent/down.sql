-- Reverse of 20270420000002_food_entry_plan_slot_index_concurrent. Run before
-- the down.sql of 20270420000001, then 20270420000000.
DROP INDEX CONCURRENTLY IF EXISTS "LoggedFoodEntry_plan_slot_id_idx";
