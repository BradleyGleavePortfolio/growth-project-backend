-- Reverse of 20270221000000_data_export_storage_bucket.
--
-- Removes the `data-exports` bucket only while it holds no object. While any
-- archive is stored the bucket is kept and this script fails loudly: deleting
-- user archives is never a side effect of a rollback. To retire the bucket,
-- first let the nightly data-export cleanup expire every archive (or remove
-- them through the Storage API), then re-run this file.
--
-- Supabase projects that block direct deletes from storage tables answer
-- with their own error here; then remove the empty bucket with the Storage
-- API (deleteBucket('data-exports')) instead. Either way nothing is deleted
-- silently.
--
-- Non-Supabase databases (no storage.buckets): no-op.

SET lock_timeout = '5s';

DO $data_export_bucket_down$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('storage.objects') IS NOT NULL
     AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'data-exports') THEN
    RAISE EXCEPTION 'data-exports bucket still holds archives; refusing to drop it. Fix: let the nightly data-export cleanup expire them (or remove them through the Storage API), then re-run down.sql.';
  END IF;
  DELETE FROM storage.buckets WHERE id = 'data-exports';
END
$data_export_bucket_down$;

RESET lock_timeout;
