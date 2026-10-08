-- Reverse of 20270404000000_recipe_declared_allergens. Drops the two declared
-- allergen columns. Only for a confirmed defect: every author declaration is
-- lost, and the library stops hiding recipes by allergen.

ALTER TABLE "Recipe" DROP COLUMN IF EXISTS "allergens_declared";
ALTER TABLE "Recipe" DROP COLUMN IF EXISTS "allergens";
