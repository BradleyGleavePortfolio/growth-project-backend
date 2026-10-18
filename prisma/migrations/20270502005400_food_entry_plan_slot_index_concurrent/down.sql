-- Reverse of 20270502005400_food_entry_plan_slot_index_concurrent. Run before
-- the down.sql of 20270502005300, then 20270502005200.
DROP INDEX CONCURRENTLY IF EXISTS "LoggedFoodEntry_plan_slot_id_idx";
