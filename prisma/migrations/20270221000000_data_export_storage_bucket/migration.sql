-- B-608-12 / lane B-EXPORT — private Supabase Storage bucket for data exports.
--
-- Creates (or re-asserts) the PRIVATE bucket `data-exports` that holds every
-- user's data-export archive (`<export id>.json`). This migration is the only
-- way the bucket is created: no console step. It runs in the Fly
-- release_command (scripts/release.sh, `prisma migrate deploy`) and its
-- verify.sql runs right after, so a release cannot go green with the bucket
-- missing or public.
--
-- Effect:
--   * `public = false` always. If a bucket with this id already exists (for
--     example created by hand), it is forced private, never left public.
--   * `allowed_mime_types = {application/json}`: only JSON archives can land.
--   * No storage.objects policy is created. With RLS on storage.objects and
--     no policy naming this bucket, anon and authenticated can neither list,
--     read nor write it; only the service-role key (the backend) can. The
--     backend never hands out a Storage URL: downloads stream through
--     GET /v1/me/data-export/download after a 5-minute user-bound token check.
--
-- Non-Supabase databases (CI's bare postgres:15, local dev without the
-- storage schema) have no storage.buckets table; the block is then a no-op,
-- and the schema (prisma parity, pg_dump) is unchanged everywhere.
--
-- Additive only. No public-schema object is created or altered. Reverse:
-- down.sql (removes the bucket only while it holds no object).

SET lock_timeout = '5s';

DO $data_export_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'data-exports bucket: storage.buckets not present (not a Supabase database); nothing to do.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('data-exports', 'data-exports', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) THEN
    UPDATE storage.buckets
       SET allowed_mime_types = ARRAY['application/json']::text[]
     WHERE id = 'data-exports';
  END IF;
END
$data_export_bucket$;

RESET lock_timeout;
