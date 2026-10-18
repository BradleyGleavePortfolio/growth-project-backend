-- RLSSTORAGE (agent 145; RLSDRIFT D-S1, D-S2, D-S3): voice-note objects are
-- reachable only through the server.
--
-- Production has four policies on storage.objects for the `voice-notes` bucket
-- that were made by hand (no migration, no down, no test):
--   voice_notes_select_own / _insert_own / _delete_own key the first folder on
--     auth.uid(), the login id. The server mints every object at
--     voice-notes/<User.id>/..., and User.id never equals the login id, so
--     these match no server object. Their only live effect: any signed-in
--     account can list, upload and delete its own files in
--     voice-notes/<its login id>/ through the Storage API.
--   voice_notes_coach_read binds `name` to the person's display name inside
--     its sub-select (storage.foldername(u.name)), so it matches nothing.
-- The app never needs them. The server signs every upload and download URL
-- and does every list, stat and delete with the service_role key; the phone
-- only calls backend routes and PUTs bytes to the signed upload URL, which
-- Storage serves on its own privileged connection.
--
-- Effect:
--   * The four hand-made policies are dropped (IF EXISTS).
--   * A RESTRICTIVE fence, `voice_notes_api_roles_fence` (FOR ALL TO PUBLIC,
--     USING and WITH CHECK `bucket_id IS DISTINCT FROM 'voice-notes'`), the
--     same shape as data_exports_api_roles_fence
--     (20270221000000_data_export_storage_bucket). Restrictive policies are
--     ANDed with every permissive one, so no role that is subject to RLS
--     (anon, authenticated, any custom role) can list, read, insert, update or
--     delete a voice-notes object, whatever permissive policy exists. Roles that
--     bypass RLS (service_role, which the backend uses) are unaffected. Dropped
--     and re-created on every run, so it always has exactly this shape.
--   * The bucket row (private, size-limited) is not touched.
--
-- Non-Supabase databases (CI's bare postgres:15, local dev without the
-- storage schema) have no storage.objects table; the block is then a no-op.
--
-- No public-schema object is created or altered. Reverse: down.sql restores
-- production's four policies with their exact text and drops the fence.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DO $voice_notes_storage_rules$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'voice-notes fence: storage.objects not present (not a Supabase database); nothing to do.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS voice_notes_coach_read ON storage.objects;
  DROP POLICY IF EXISTS voice_notes_delete_own ON storage.objects;
  DROP POLICY IF EXISTS voice_notes_insert_own ON storage.objects;
  DROP POLICY IF EXISTS voice_notes_select_own ON storage.objects;

  DROP POLICY IF EXISTS voice_notes_api_roles_fence ON storage.objects;
  CREATE POLICY voice_notes_api_roles_fence ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id IS DISTINCT FROM 'voice-notes')
    WITH CHECK (bucket_id IS DISTINCT FROM 'voice-notes');
END
$voice_notes_storage_rules$;

RESET statement_timeout;
RESET lock_timeout;
