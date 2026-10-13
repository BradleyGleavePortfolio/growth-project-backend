-- FOODLINK: validate "LoggedFoodEntry_plan_slot_id_fkey", added NOT VALID in
-- 20270420000000.
--
-- WHY A FILE OF ITS OWN: Prisma sends a migration file as one simple-query
-- message, which Postgres runs as one implicit transaction. The ADD COLUMNs in
-- 20270420000000 take ACCESS EXCLUSIVE on LoggedFoodEntry; with VALIDATE in the
-- same file, that lock would be held through the validation scan. Here,
-- 20270420000000 has committed, so VALIDATE takes only SHARE UPDATE EXCLUSIVE on
-- LoggedFoodEntry (food logs keep being read and written) and ROW SHARE on
-- DailyMealPlanSlot. Every plan_slot_id is still null, so it cannot fail.
-- ROLLBACK: down.sql (back to NOT VALID).

SET lock_timeout = '5s';

ALTER TABLE "LoggedFoodEntry" VALIDATE CONSTRAINT "LoggedFoodEntry_plan_slot_id_fkey";
