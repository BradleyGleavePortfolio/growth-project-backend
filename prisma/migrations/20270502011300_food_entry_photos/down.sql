-- Down for 20270502011300_food_entry_photos (MEAL-PHOTO-BE). The table and its policies go. The photo
-- objects stay in community-images: remove them through the Storage API (every key is under its
-- owner's `<uid>/` folder) before or after this runs; the bucket itself belongs to 20270502009200.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "food_entry_photos";

COMMIT;
