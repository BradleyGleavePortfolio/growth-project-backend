-- FOODLINK (decisions 141-3 and 141-4): a food log entry can carry the plan
-- meal it was logged for.
--
-- "LoggedFoodEntry"."plan_slot_id": the coach's plan meal (DailyMealPlanSlot)
-- named by the Food tab's "Ate it as planned" or "Something else". Set only by
-- POST /log/food after the server checks the slot is in a meal plan assigned
-- to the caller on the entry's date. ON DELETE SET NULL: a plan edit or a
-- coach's account deletion never deletes or blocks a food log.
-- "LoggedFoodEntry"."fills_usual_meal": set by the coachless "Your usual day".
--
-- Additive only. Reverse: down.sql. No backfill: every existing row keeps a
-- null link and false, so it shows exactly as before.
-- RLS unchanged: LoggedFoodEntry stays ENABLE + FORCE with
-- food_entry_owner_access (user_id = app.current_user_id(), 20270410000000)
-- and food_entry_current_coach_select (SELECT for the client's current coach,
-- 20270502000700). Both cover every column of the row, so both new columns
-- follow them. DailyMealPlanSlot keeps its policies (20261213000000,
-- 20270502000700). No policy is added, dropped or changed. The SET NULL action runs as the table owner without
-- row security (Postgres referential actions), so a coach deleting a slot
-- clears the link on a client's entry the coach cannot read.
--
-- Locks: Prisma runs this file as one implicit transaction, so its ACCESS
-- EXCLUSIVE lock on LoggedFoodEntry lasts until the file ends. Everything here
-- is catalog-only and short: ADD COLUMN with no default and with a constant
-- default do not rewrite the table (Postgres 11+), and the FK is added NOT
-- VALID (no scan). The validation scan runs in 20270502005300, after this file
-- has committed, under SHARE UPDATE EXCLUSIVE. The index is built
-- CONCURRENTLY in 20270502005400.

SET lock_timeout = '5s';

ALTER TABLE "LoggedFoodEntry" ADD COLUMN "plan_slot_id" TEXT;

ALTER TABLE "LoggedFoodEntry" ADD COLUMN "fills_usual_meal" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LoggedFoodEntry" ADD CONSTRAINT "LoggedFoodEntry_plan_slot_id_fkey" FOREIGN KEY ("plan_slot_id") REFERENCES "DailyMealPlanSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
