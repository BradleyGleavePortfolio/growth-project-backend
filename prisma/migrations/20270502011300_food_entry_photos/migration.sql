-- 20270502011300_food_entry_photos (MEAL-PHOTO-BE, agent 203; LO-FOOD C7, "a meal photo attached to the
-- entry, seen by the coach (no AI first)"): the photo a client keeps with one of their own food entries.
-- Additive only; no data change. Reverse: down.sql.
--
--   * food_entry_photos: one row per entry at most (entry_id is the key). It goes with the entry
--     (ON DELETE CASCADE); the server records the object's erasure in the same transaction first. The
--     object is the `.sent.jpg` copy at storage_key in the private community-images bucket
--     (20270502009200), under the client's own `<uid>/` folder, so account erasure's image_folder empties it.
--   * user_id has no FK (as community_message_images.author_id): the erasure manifest deletes by it.
--
-- Row rules (RLS enabled and forced; anon has no table access): the client reads their own rows, and the
-- client's coach now reads them by the food rule, copied exactly from food_entry_current_coach_select
-- (20270502000700). A former coach, another coach and another client read none. No insert, update or
-- delete policy: the server writes through Prisma's service-role connection.
-- Live proof: test/rls/food-entry-photos-rls.spec.ts (rls-live-tests).
-- Placement: sorts after 20270502011200 (main at f239683f).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "food_entry_photos" (
    "entry_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_entry_photos_pkey" PRIMARY KEY ("entry_id")
);

CREATE UNIQUE INDEX "food_entry_photos_storage_key_key" ON "food_entry_photos"("storage_key");
CREATE INDEX "food_entry_photos_user_id_idx" ON "food_entry_photos"("user_id");

ALTER TABLE "food_entry_photos" ADD CONSTRAINT "food_entry_photos_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "LoggedFoodEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "food_entry_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "food_entry_photos" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "food_entry_photos" FROM anon;

CREATE POLICY "food_entry_photos_owner_select" ON "food_entry_photos"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());
COMMENT ON POLICY "food_entry_photos_owner_select" ON "food_entry_photos" IS '20270502011300: the client reads the photos of their own food entries.';

CREATE POLICY "food_entry_photos_current_coach_select" ON "food_entry_photos"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "food_entry_photos_current_coach_select" ON "food_entry_photos" IS '20270502011300: the client''s current coach reads the photo, exactly as food_entry_current_coach_select reads the entry.';

COMMENT ON TABLE "food_entry_photos" IS
  '20270502011300: the photo a client keeps with one food entry, its object at storage_key in the private community-images bucket.';

COMMIT;
