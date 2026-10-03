-- Reverse of 20270306000000_message_photos (A6-PHOTOS).
--
-- Run ONLY when no photo bytes remain to erase: dropping message_photos loses
-- every storage key, and dropping message_photo_erasures forgets pending
-- erasure work. Before running: confirm
--   SELECT count(*) FROM message_photo_erasures WHERE completed_at IS NULL;  -- 0
--   SELECT count(*) FROM message_photos WHERE removed_at IS NULL;             -- 0
-- The bucket and its fence are removed only while the bucket holds no object
-- (otherwise the fence stays, so the objects stay unreachable).

DROP POLICY IF EXISTS "p_message_photos_participant_select" ON "message_photos";
DROP TABLE IF EXISTS "message_photos";
DROP FUNCTION IF EXISTS app.message_photo_visible_to_viewer(text, text);
DROP TABLE IF EXISTS "message_photo_erasures";

DO $message_photos_bucket_down$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'message-photos') THEN
    RAISE NOTICE 'message-photos bucket still holds objects; bucket and fence kept.';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS message_photos_api_roles_fence ON storage.objects;
  DELETE FROM storage.buckets WHERE id = 'message-photos';
END
$message_photos_bucket_down$;
