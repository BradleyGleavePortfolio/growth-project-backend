-- Reverse of 20270403000000_private_custom_foods. Restores the catalog SELECT
-- policy of 20261213000000_rls_tier3_nutrition verbatim, then drops the owner
-- column with its index and FK. Only for a confirmed defect: dropping the
-- column makes every custom food a shared catalog row again.

DROP POLICY IF EXISTS "p_fooditem_select_own" ON "FoodItem";
DROP POLICY IF EXISTS "p_fooditem_select" ON "FoodItem";
CREATE POLICY "p_fooditem_select" ON "FoodItem" AS PERMISSIVE FOR SELECT TO public USING (true);
COMMENT ON POLICY "p_fooditem_select" ON "FoodItem" IS 'PR-RLS-05 public-catalog-read: the food catalog is a shared reference table; any caller (including unauthenticated) may read.';

ALTER TABLE "FoodItem" DROP CONSTRAINT IF EXISTS "FoodItem_created_by_user_id_fkey";
DROP INDEX IF EXISTS "FoodItem_created_by_user_id_idx";
ALTER TABLE "FoodItem" DROP COLUMN IF EXISTS "created_by_user_id";
