-- Food logger Trainerize-grade floor (see PR `fix/food-logger-trainerize-floor`).
--
-- 1) FoodItem.nutrient_basis — declares the canonical basis for the macro
--    columns on each row. Both upstreams (USDA FDC, OpenFoodFacts) return
--    per-100g values, so PER_100G is the default. Existing rows are
--    back-filled to PER_100G (the buggy mobile code already assumed this).
-- 2) LoggedFoodEntry.original_quantity/original_unit — preserves the
--    user-entered quantity + unit (e.g. "6 oz") for coach views. The canonical
--    math value remains `quantity_multiplier`. Both new columns are nullable;
--    older rows have nulls and the API falls back to formatting the multiplier.

CREATE TYPE "NutrientBasis" AS ENUM ('PER_100G', 'PER_SERVING');

ALTER TABLE "FoodItem"
  ADD COLUMN "nutrient_basis" "NutrientBasis" NOT NULL DEFAULT 'PER_100G';

ALTER TABLE "LoggedFoodEntry"
  ADD COLUMN "original_quantity" DOUBLE PRECISION,
  ADD COLUMN "original_unit"     TEXT;
