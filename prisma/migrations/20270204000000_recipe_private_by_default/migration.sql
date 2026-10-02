-- B-RECIPES (Opus C-625-1 on #625): recipes are private by default.
--
-- WHY: 20270125000000_restore_schema_declared_objects (#625) created "Recipe"
-- with "is_public" DEFAULT true, and the API it switched on defaulted every new
-- recipe to public and listed every public recipe to every user. The API now
-- keeps recipes private to their creator and shares only coach-created recipes
-- with that coach's own clients (src/recipes/recipe-access.ts). This file makes
-- the stored data say the same thing.
--
-- WHAT:
--   1. "Recipe"."is_public" DEFAULT false (was true). Catalog-only change; no
--      table rewrite. schema.prisma declares @default(false) in the same change.
--   2. Every existing row becomes private ("is_public" = false). Rows written
--      before this release were public only because of the old default; none
--      was shared through the coach-only rule. A coach re-shares by creating
--      the recipe with isPublic: true. The count of changed rows is reported in
--      the deploy log (NOTICE). No row is deleted; no other column changes
--      except "updated_at" on the rows that change.
--
-- SAFETY: one transaction, bounded lock and statement time (SET LOCAL, so
-- nothing leaks into later migrations). A timeout rolls the whole file back;
-- recover with `prisma migrate resolve --rolled-back
-- 20270204000000_recipe_private_by_default` and re-deploy. The final block
-- asserts the default and that no public row remains, so a partial result
-- cannot commit.
--
-- ROLLBACK: down.sql restores DEFAULT true only. It does not and cannot make
-- the rows changed here public again; doing that would recreate the exposure
-- this migration closes.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "Recipe" ALTER COLUMN "is_public" SET DEFAULT false;

DO $private$
DECLARE
  changed integer;
BEGIN
  UPDATE "Recipe"
     SET "is_public" = false,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "is_public" = true;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'recipe_private_by_default: % existing recipe row(s) made private', changed;
END
$private$;

DO $verify$
DECLARE
  default_expr text;
BEGIN
  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    INTO default_expr
    FROM pg_catalog.pg_attrdef d
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = '"Recipe"'::regclass
     AND a.attname = 'is_public';
  IF default_expr IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'recipe_private_by_default: "Recipe"."is_public" default is %, expected false', default_expr;
  END IF;
  IF EXISTS (SELECT 1 FROM "Recipe" WHERE "is_public") THEN
    RAISE EXCEPTION 'recipe_private_by_default: a public recipe row remains';
  END IF;
END
$verify$;

COMMIT;
