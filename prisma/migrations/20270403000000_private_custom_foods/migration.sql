-- UX-FOOD-PRIV-124: custom foods are private to the person who created them.
--
-- Additive only. Reverse: down.sql. No backfill: every existing row keeps a
-- null owner and stays in the shared catalog exactly as before.
--
-- "FoodItem"."created_by_user_id": set only by the custom-food create path
-- (POST /foods). Seeded rows and USDA / OpenFoodFacts imports stay null-owned
-- and shared. The backend serves an owned row only to its creator; the
-- account-deletion manifest deletes it with the account, so a private row
-- never becomes a shared catalog row. ON DELETE CASCADE (never SET NULL) for
-- the same reason: the User row is tombstoned, but if a User row were ever
-- removed its private foods must go with it rather than turn public.
--
-- RLS (FoodItem stays ENABLE + FORCE from 20261213000000_rls_tier3_nutrition;
-- service_role and the owner-only write policies are unchanged):
--   * p_fooditem_select (public, including anon): only the shared catalog,
--     created_by_user_id IS NULL. Was USING (true).
--   * p_fooditem_select_own (authenticated): the creator's own rows, plus the
--     platform owner, through the existing app.current_user_id() and
--     app.is_owner() helpers. anon is not named, so no helper is called for it.

SET lock_timeout = '5s';

-- 1) Owner column, index and FK (the shape prisma generates for schema.prisma)
ALTER TABLE "FoodItem" ADD COLUMN "created_by_user_id" TEXT;

CREATE INDEX "FoodItem_created_by_user_id_idx" ON "FoodItem"("created_by_user_id");

ALTER TABLE "FoodItem" ADD CONSTRAINT "FoodItem_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) RLS: the shared catalog stays readable; a custom food is its creator's only
DROP POLICY IF EXISTS "p_fooditem_select" ON "FoodItem";
CREATE POLICY "p_fooditem_select" ON "FoodItem" AS PERMISSIVE FOR SELECT TO public USING ("created_by_user_id" IS NULL);
COMMENT ON POLICY "p_fooditem_select" ON "FoodItem" IS 'UX-FOOD-PRIV-124: the shared food catalog (seeded, USDA FDC and OpenFoodFacts imports; created_by_user_id IS NULL) stays readable by any caller. A custom food (created_by_user_id set) is never readable through this policy.';

DROP POLICY IF EXISTS "p_fooditem_select_own" ON "FoodItem";
CREATE POLICY "p_fooditem_select_own" ON "FoodItem" AS PERMISSIVE FOR SELECT TO authenticated USING (("created_by_user_id" = app.current_user_id()) OR app.is_owner());
COMMENT ON POLICY "p_fooditem_select_own" ON "FoodItem" IS 'UX-FOOD-PRIV-124: a custom food is readable only by the user who created it (and the platform owner role). Writes stay app.is_owner() / service_role only.';
