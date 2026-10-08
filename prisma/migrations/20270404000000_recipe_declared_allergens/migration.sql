-- CF-ALLERGY-128: recipe authors declare the allergens a recipe contains.
--
-- Additive only. Reverse: down.sql. No backfill: every existing row gets an
-- empty list and allergens_declared = false, i.e. "allergens not declared",
-- which the app labels as such; nothing is hidden on an undeclared recipe.
-- (Production read-only count on 2026-10-07 16:20 PDT: 0 Recipe rows.)
--
-- "Recipe"."allergens": codes from the one list in src/recipes/allergens.ts,
-- written only by POST /recipes from the author's declaration (validated).
-- Never derived from ingredient or title text.
-- "Recipe"."allergens_declared": true once the author confirmed the list is
-- complete (an empty list then means none of the listed allergens).
--
-- Both columns have constant defaults, so on Postgres 11+ ADD COLUMN is a
-- catalog-only change (no table rewrite). RLS on "Recipe" is unchanged.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "allergens_declared" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
