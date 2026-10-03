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
--   * A RESTRICTIVE fence policy on storage.objects,
--     `data_exports_api_roles_fence` (FOR ALL TO PUBLIC, USING and WITH CHECK
--     `bucket_id IS DISTINCT FROM 'data-exports'`), A-636-1. Restrictive
--     policies are ANDed with every permissive one, so no permissive policy,
--     however broad (`... OR true`, unscoped, inherited through PUBLIC or a
--     custom JWT role), can let a role that is subject to RLS (anon,
--     authenticated, any custom role) list, read, insert, update or delete a
--     data-exports object. Roles that bypass RLS by design (service_role,
--     which the backend uses; superusers; the table owner) are unaffected, so
--     the backend keeps working. Dropped and re-created on every run, so the
--     fence always has exactly this shape. Supabase allows CREATE POLICY on
--     storage.objects (only ALTER TABLE storage.objects is blocked); RLS on
--     storage.objects is on by default and verify.sql fails the release if it
--     is not.
--   * The backend never hands out a Storage URL: downloads stream through
--     GET /v1/me/data-export/download after a 5-minute user-bound token check.
--
-- Non-Supabase databases (CI's bare postgres:15, local dev without the
-- storage schema) have no storage.buckets table; the block is then a no-op,
-- and the schema (prisma parity, pg_dump) is unchanged everywhere.
--
-- Additive only. No public-schema object is created or altered. Reverse:
-- down.sql (removes the fence and the bucket only while the bucket holds no
-- object).

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

  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'data-exports bucket: storage.buckets exists but storage.objects does not; refusing to create an unfenced bucket.';
  END IF;

  DROP POLICY IF EXISTS data_exports_api_roles_fence ON storage.objects;
  CREATE POLICY data_exports_api_roles_fence ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id IS DISTINCT FROM 'data-exports')
    WITH CHECK (bucket_id IS DISTINCT FROM 'data-exports');
END
$data_export_bucket$;

RESET lock_timeout;
