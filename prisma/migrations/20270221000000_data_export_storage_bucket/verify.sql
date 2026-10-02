-- Catalog verifier for 20270221000000_data_export_storage_bucket (B-EXPORT).
--
-- Run by scripts/release.sh step 4 after `prisma migrate deploy` (and listed
-- in scripts/release-required-verifiers.txt). Read-only. RAISEs, failing the
-- release, unless on a Supabase database:
--   MISSING   the `data-exports` bucket does not exist;
--   EXPOSURE  the bucket is public, or a PERMISSIVE policy on storage.objects
--             for anon / authenticated / PUBLIC could reach it: its USING or
--             WITH CHECK expression does not restrict bucket_id at all, or it
--             names 'data-exports'. Only the service-role key may touch the
--             bucket; the backend streams downloads after its own token check.
-- On a database without storage.buckets (CI, local dev) it reports a NOTICE
-- and passes: there is no Storage there to expose.
--
-- Usage (read-only):
--   npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270221000000_data_export_storage_bucket/verify.sql
--   psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f prisma/migrations/20270221000000_data_export_storage_bucket/verify.sql

DO $verify_data_export_bucket$
DECLARE
  v_public boolean;
  v_policy text;
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'data-exports verifier: storage.buckets not present (not a Supabase database); skipped.';
    RETURN;
  END IF;

  SELECT public INTO v_public FROM storage.buckets WHERE id = 'data-exports';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MISSING: storage bucket data-exports does not exist. Fix: re-run prisma migrate deploy (migration 20270221000000_data_export_storage_bucket creates it).';
  END IF;
  IF v_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'EXPOSURE: storage bucket data-exports is public. Fix: UPDATE storage.buckets SET public = false WHERE id = ''data-exports'' (or re-run the migration), then re-run this verifier.';
  END IF;

  SELECT p.policyname INTO v_policy
    FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'storage'
     AND p.tablename = 'objects'
     AND p.permissive = 'PERMISSIVE'
     AND p.roles && ARRAY['anon', 'authenticated', 'public']::name[]
     AND (
           (p.qual IS NOT NULL AND (p.qual NOT LIKE '%bucket_id%' OR p.qual LIKE '%data-exports%'))
        OR (p.with_check IS NOT NULL AND (p.with_check NOT LIKE '%bucket_id%' OR p.with_check LIKE '%data-exports%'))
        OR (p.qual IS NULL AND p.with_check IS NULL)
     )
   ORDER BY p.policyname
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'EXPOSURE: storage.objects policy % lets anon/authenticated reach every bucket (or data-exports). Fix: restrict it with bucket_id = ''<its bucket>'' so it cannot cover data-exports, then re-run this verifier.', v_policy;
  END IF;

  RAISE NOTICE 'data-exports verifier: bucket present, private, no API-role policy reaches it.';
END
$verify_data_export_bucket$;
