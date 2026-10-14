-- Reverse of 20270502001600_voice_notes_storage_rules.
--
-- Drops the voice-notes fence and restores production's four hand-made
-- storage.objects policies with their exact text (production catalog,
-- 2026-10-14). Restoring them also restores their effect: any signed-in
-- account can again list, upload and delete files in
-- voice-notes/<its login id>/ through the Storage API.
--
-- Non-Supabase databases (no storage.objects): no-op.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DO $voice_notes_storage_rules_down$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS voice_notes_api_roles_fence ON storage.objects;

  DROP POLICY IF EXISTS voice_notes_coach_read ON storage.objects;
  CREATE POLICY voice_notes_coach_read ON storage.objects
    AS PERMISSIVE
    FOR SELECT
    TO authenticated
    USING ((bucket_id = 'voice-notes'::text) AND (EXISTS ( SELECT 1
   FROM "User" u
  WHERE ((u.coach_id = (auth.uid())::text) AND (u.supabase_id = (storage.foldername(u.name))[1])))));

  DROP POLICY IF EXISTS voice_notes_delete_own ON storage.objects;
  CREATE POLICY voice_notes_delete_own ON storage.objects
    AS PERMISSIVE
    FOR DELETE
    TO authenticated
    USING ((bucket_id = 'voice-notes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

  DROP POLICY IF EXISTS voice_notes_insert_own ON storage.objects;
  CREATE POLICY voice_notes_insert_own ON storage.objects
    AS PERMISSIVE
    FOR INSERT
    TO authenticated
    WITH CHECK ((bucket_id = 'voice-notes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));

  DROP POLICY IF EXISTS voice_notes_select_own ON storage.objects;
  CREATE POLICY voice_notes_select_own ON storage.objects
    AS PERMISSIVE
    FOR SELECT
    TO authenticated
    USING ((bucket_id = 'voice-notes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text));
END
$voice_notes_storage_rules_down$;

RESET statement_timeout;
RESET lock_timeout;
