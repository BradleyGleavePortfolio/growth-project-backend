-- H2 fix: add per-day structure column to MealPlan.
-- AI-approved meal plans now store the full days[] JSON (day number,
-- meals, items, macros) alongside the legacy flat items[] array.
-- Nullable so existing manually-created plans are unaffected.

ALTER TABLE "MealPlan" ADD COLUMN "days" JSONB;
