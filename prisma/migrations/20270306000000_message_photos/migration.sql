-- A6-PHOTOS: photos in coach <-> client messages (prefix reserved for annex lane A6).
--
-- 1. "message_photos": one row per photo. The raw upload lands at staging_key
--    (never signed for reading); the server parses it, strips EXIF/GPS and
--    every other metadata block, and writes the sanitized copy to
--    storage_key. message_id is set when the photo is sent (FK to
--    "CoachMessage", ON DELETE SET NULL so a hard-deleted message leaves the
--    row for the erasure sweep instead of dropping the key).
--    RLS (defence in depth; the backend connects as service_role):
--      SELECT for a thread participant (thread coach, client or uploader) of a
--      READY, not-removed photo, unless the viewer blocked the uploader or
--      reported the message (app.message_photo_visible_to_viewer).
--      No INSERT / UPDATE / DELETE for any API role (RESTRICTIVE deny).
-- 2. "message_photo_erasures": durable erasure work (same contract as
--    community_voice_erasures, B-610-5). Server-only: deny-all for API roles.
-- 3. The PRIVATE Supabase Storage bucket "message-photos" (public = false,
--    15 MB limit, JPEG/PNG/WebP only) and a RESTRICTIVE fence on
--    storage.objects so no RLS-bound role (anon, authenticated, custom) can
--    list, read, write or delete its objects (A-636-1 pattern). Signed upload
--    and signed read URLs are authorised by their token, and the backend uses
--    service_role (BYPASSRLS), so both keep working. verify.sql proves it at
--    release. On a database without the storage schema (CI, local) the block
--    is a no-op.
--
-- Additive only. Reverse: down.sql.

SET lock_timeout = '5s';

-- ── 1. message_photos ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "message_photos" (
    "id" UUID NOT NULL,
    "uploader_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "staging_key" TEXT NOT NULL,
    "storage_key" TEXT,
    "declared_content_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "content_type" TEXT,
    "size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "position" INTEGER,
    "reject_code" TEXT,
    "scanner" TEXT,
    "removed_reason" TEXT,
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "processing_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(6),
    "attached_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "message_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_photos_staging_key_key" ON "message_photos"("staging_key");
CREATE UNIQUE INDEX IF NOT EXISTS "message_photos_storage_key_key" ON "message_photos"("storage_key");
CREATE INDEX IF NOT EXISTS "message_photos_message_id_idx" ON "message_photos"("message_id");
CREATE INDEX IF NOT EXISTS "message_photos_coach_id_client_id_idx" ON "message_photos"("coach_id", "client_id");
CREATE INDEX IF NOT EXISTS "message_photos_uploader_id_created_at_idx" ON "message_photos"("uploader_id", "created_at");
CREATE INDEX IF NOT EXISTS "message_photos_client_id_idx" ON "message_photos"("client_id");
CREATE INDEX IF NOT EXISTS "message_photos_status_upload_expires_at_idx" ON "message_photos"("status", "upload_expires_at");

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_photos_message_id_fkey') THEN
    ALTER TABLE "message_photos" ADD CONSTRAINT "message_photos_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "CoachMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$fk$;

-- Visibility helper: the viewer has not blocked the uploader and has not
-- reported the message the photo belongs to. SECURITY DEFINER so it reads
-- "UserBlock" / "MessageReport" regardless of their own policies; it only
-- ever answers for app.current_user_id().
CREATE OR REPLACE FUNCTION app.message_photo_visible_to_viewer(p_uploader_id text, p_message_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
  SELECT app.current_user_id() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public."UserBlock" b
        WHERE b."blocker_id" = app.current_user_id()
          AND b."blocked_id" = p_uploader_id
     )
     AND (
       p_message_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public."MessageReport" r
          WHERE r."reporter_id" = app.current_user_id()
            AND r."message_id" = p_message_id
       )
     )
$function$;

COMMENT ON FUNCTION app.message_photo_visible_to_viewer(text, text) IS
  'A6-PHOTOS: true when the current viewer has not blocked the uploader and has not reported the photo''s message (a reported photo hides for the reporter at once).';

REVOKE ALL ON FUNCTION app.message_photo_visible_to_viewer(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.message_photo_visible_to_viewer(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.message_photo_visible_to_viewer(text, text) TO authenticated, service_role;

ALTER TABLE "message_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_photos" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_message_photos_service_role_all" ON "message_photos";
CREATE POLICY "p_message_photos_service_role_all" ON "message_photos" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "p_message_photos_participant_select" ON "message_photos";
CREATE POLICY "p_message_photos_participant_select" ON "message_photos" AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    app.current_user_id() IS NOT NULL
    AND "status" = 'ready'
    AND "removed_at" IS NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "uploader_id" = app.current_user_id()
    )
    -- An unsent photo (composer preview) is the uploader's alone.
    AND ("message_id" IS NOT NULL OR "uploader_id" = app.current_user_id())
    AND app.message_photo_visible_to_viewer("uploader_id", "message_id")
  );
COMMENT ON POLICY "p_message_photos_participant_select" ON "message_photos" IS
  'A6-PHOTOS: only the two thread parties (and the uploading sub-coach) read a ready photo; blocked uploaders and reported messages are hidden from the viewer.';

DROP POLICY IF EXISTS "deny_all_anon_message_photos" ON "message_photos";
CREATE POLICY "deny_all_anon_message_photos" ON "message_photos" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_insert_authenticated_message_photos" ON "message_photos";
CREATE POLICY "deny_insert_authenticated_message_photos" ON "message_photos" AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "deny_update_authenticated_message_photos" ON "message_photos";
CREATE POLICY "deny_update_authenticated_message_photos" ON "message_photos" AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_delete_authenticated_message_photos" ON "message_photos";
CREATE POLICY "deny_delete_authenticated_message_photos" ON "message_photos" AS RESTRICTIVE FOR DELETE TO authenticated USING (false);

REVOKE ALL PRIVILEGES ON TABLE "message_photos" FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "message_photos" FROM authenticated;

-- ── 2. message_photo_erasures ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "message_photo_erasures" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "message_photo_erasures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_photo_erasures_kind_target_key" ON "message_photo_erasures"("kind", "target");
CREATE INDEX IF NOT EXISTS "message_photo_erasures_completed_at_next_attempt_at_idx" ON "message_photo_erasures"("completed_at", "next_attempt_at");

ALTER TABLE "message_photo_erasures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_photo_erasures" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_message_photo_erasures_service_role_all" ON "message_photo_erasures";
CREATE POLICY "p_message_photo_erasures_service_role_all" ON "message_photo_erasures" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "deny_all_anon_message_photo_erasures" ON "message_photo_erasures";
CREATE POLICY "deny_all_anon_message_photo_erasures" ON "message_photo_erasures" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny_all_authenticated_message_photo_erasures" ON "message_photo_erasures";
CREATE POLICY "deny_all_authenticated_message_photo_erasures" ON "message_photo_erasures" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE "message_photo_erasures" FROM anon, authenticated;

-- ── 3. Private storage bucket + fence ──────────────────────────────────────
DO $message_photos_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'message-photos bucket: storage.buckets not present (not a Supabase database); nothing to do.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('message-photos', 'message-photos', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) THEN
    UPDATE storage.buckets
       SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
     WHERE id = 'message-photos';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) THEN
    UPDATE storage.buckets SET file_size_limit = 15728640 WHERE id = 'message-photos';
  END IF;

  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'message-photos bucket: storage.buckets exists but storage.objects does not; refusing to create an unfenced bucket.';
  END IF;

  DROP POLICY IF EXISTS message_photos_api_roles_fence ON storage.objects;
  CREATE POLICY message_photos_api_roles_fence ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id IS DISTINCT FROM 'message-photos')
    WITH CHECK (bucket_id IS DISTINCT FROM 'message-photos');
END
$message_photos_bucket$;

RESET lock_timeout;
