-- Down for 20270502001300_food_favorites_saved_meals (FOODSAVED).
-- Drops the three tables (their policies go with them) and the helper.
-- Irreversible for data: every favourite and saved meal is deleted. Logged
-- food entries made from a saved meal are ordinary LoggedFoodEntry rows and stay.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "SavedMealItem";
DROP TABLE IF EXISTS "SavedMeal";
DROP TABLE IF EXISTS "FoodFavorite";
DROP FUNCTION IF EXISTS app.saved_meal_item_allowed(text, boolean);

RESET lock_timeout;
