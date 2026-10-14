-- Down for 20270502001500_legacy_meal_plan_current_coach (RLSMEALLEGACY).
-- Only for a confirmed defect. Drops the restrictive policy, which brings the
-- gap back: a former coach reads, edits, deletes and adds legacy meal plans
-- about a moved client again through direct table access. The migration
-- changed no permissive policy, so there is no text to restore (production's
-- p_mealplan_* text on 2026-10-14 is main's 20261213000000 text). No data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "p_mealplan_coach_keeps_current_client" ON "MealPlan";

COMMIT;
