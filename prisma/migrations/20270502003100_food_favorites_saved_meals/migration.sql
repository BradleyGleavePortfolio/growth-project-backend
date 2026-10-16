-- FOODSAVED (agent 145, MOCKUP-3 C2 slice S1): a client's favourite foods and
-- saved meals. Additive: three tables, one helper, six policies, no data change.
-- Items keep the portion fields of LoggedFoodEntry, so logging a saved meal
-- writes ordinary food entries.
--
-- Row rules (RLS enabled and forced on all three; anon has no table access):
--   * the client reads and writes only their own rows (app.current_user_id());
--   * the client's current coach reads them (app.is_current_coach_of); a former
--     coach reads nothing;
--   * a SavedMealItem follows its meal through app.saved_meal_item_allowed, a
--     SECURITY DEFINER helper with an empty search_path that reads "SavedMeal"
--     directly, so the coach's read rule on a meal never becomes a write rule
--     on its items. A missing meal or no user answers false.
-- The server uses Prisma's service-role connection (bypasses RLS) and scopes
-- every query to the signed-in client. Reverse: down.sql.
-- Live proof: test/rls/food-saved-rls.spec.ts.

SET lock_timeout = '5s';

CREATE TABLE "FoodFavorite" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "food_item_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodFavorite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedMeal" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedMeal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedMealItem" (
    "id" TEXT NOT NULL,
    "saved_meal_id" TEXT NOT NULL,
    "food_item_id" TEXT NOT NULL,
    "quantity_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "original_quantity" DOUBLE PRECISION,
    "original_unit" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "SavedMealItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FoodFavorite_user_id_food_item_id_key" ON "FoodFavorite"("user_id", "food_item_id");
CREATE INDEX "SavedMeal_user_id_idx" ON "SavedMeal"("user_id");
CREATE UNIQUE INDEX "SavedMealItem_saved_meal_id_position_key" ON "SavedMealItem"("saved_meal_id", "position");

ALTER TABLE "FoodFavorite" ADD CONSTRAINT "FoodFavorite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FoodFavorite" ADD CONSTRAINT "FoodFavorite_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "FoodItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedMeal" ADD CONSTRAINT "SavedMeal_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedMealItem" ADD CONSTRAINT "SavedMealItem_saved_meal_id_fkey" FOREIGN KEY ("saved_meal_id") REFERENCES "SavedMeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedMealItem" ADD CONSTRAINT "SavedMealItem_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "FoodItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION app.saved_meal_item_allowed(meal_id text, coach_may_read boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."SavedMeal" m
    WHERE m."id" = meal_id
      AND (
        m."user_id" = app.current_user_id()
        OR (coach_may_read AND app.is_current_coach_of(m."user_id"))
      )
  )
$$;

COMMENT ON FUNCTION app.saved_meal_item_allowed(text, boolean) IS
  'FOODSAVED (20270502001300): true when the signed-in user owns this SavedMeal, or, with coach_may_read, is the current coach of its owner. False for a missing meal or no user. Called only by the SavedMealItem policies.';

REVOKE ALL ON FUNCTION app.saved_meal_item_allowed(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.saved_meal_item_allowed(text, boolean) TO anon, authenticated, service_role;

ALTER TABLE "FoodFavorite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FoodFavorite" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SavedMeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedMeal" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SavedMealItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedMealItem" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "FoodFavorite", "SavedMeal", "SavedMealItem" FROM anon;

CREATE POLICY "FoodFavorite_owner_all" ON "FoodFavorite" FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());
CREATE POLICY "FoodFavorite_current_coach_select" ON "FoodFavorite" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

CREATE POLICY "SavedMeal_owner_all" ON "SavedMeal" FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());
CREATE POLICY "SavedMeal_current_coach_select" ON "SavedMeal" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

CREATE POLICY "SavedMealItem_owner_all" ON "SavedMealItem" FOR ALL TO public
  USING (app.saved_meal_item_allowed("saved_meal_id", false))
  WITH CHECK (app.saved_meal_item_allowed("saved_meal_id", false));
CREATE POLICY "SavedMealItem_current_coach_select" ON "SavedMealItem" FOR SELECT TO public
  USING (app.saved_meal_item_allowed("saved_meal_id", true));

RESET lock_timeout;
