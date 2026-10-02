-- Reverse of 20270204000000_recipe_private_by_default (schema only).
--
-- Restores "Recipe"."is_public" DEFAULT true, the value #625 created. It does
-- NOT make any row public again: which rows were public before the forward
-- migration is not recorded, and re-publishing them would recreate the
-- platform-wide exposure the forward migration closes. With DEFAULT true back,
-- the application still writes "is_public" explicitly on every insert, so the
-- default only affects raw SQL inserts.
ALTER TABLE "Recipe" ALTER COLUMN "is_public" SET DEFAULT true;
