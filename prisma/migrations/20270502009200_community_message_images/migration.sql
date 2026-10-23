-- 20270502009200_community_message_images (SC-BE3, agent 168; FX-1139 agent 170): photos in the
-- space chat (#167-7 IMAGES op 1). Reverse: down.sql.
--
-- 1. CommunityMessageKind gains 'image'. ADD VALUE runs on its own, before the
--    transaction; nothing below names the new value as an enum literal (the
--    policy compares "kind"::text), so the file is safe in one run.
-- 2. community_message_images: the photo behind one kind 'image' message.
--    RLS on and forced. A row is readable by whoever app.community_can_access
--    lets into its space (that rule already refuses a ban) and insertable only
--    by its author there. No update or delete policy: the server's
--    service-role connection deletes rows (account erasure) and anon has no
--    rights. Live proof: test/rls/community-message-images-rls.spec.ts.
-- 3. community_messages_space_takes_insert counts an image message with a
--    parent as a reply, exactly as text and voice (20270502009000 text, with
--    'image' added).
-- 4. Private bucket community-images (JPEG only, 10 MB), by the guarded insert
--    of 20270221000000, and a RESTRICTIVE fence so no API role reads or writes
--    its objects, as voice notes do (20270502001600). The server signs every
--    upload and read. Both are no-ops on a database without a storage schema.

ALTER TYPE "CommunityMessageKind" ADD VALUE IF NOT EXISTS 'image';

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "community_message_images" (
    "message_id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_message_images_pkey" PRIMARY KEY ("message_id")
);

CREATE UNIQUE INDEX "community_message_images_storage_key_key" ON "community_message_images"("storage_key");
CREATE INDEX "community_message_images_cohort_id_created_at_idx" ON "community_message_images"("cohort_id", "created_at");
CREATE INDEX "community_message_images_author_id_idx" ON "community_message_images"("author_id");

ALTER TABLE "community_message_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_message_images" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "community_message_images" FROM anon;

CREATE POLICY "community_message_images_read" ON "community_message_images" FOR SELECT TO public
  USING (app.community_can_access("cohort_id", app.current_user_id()));
CREATE POLICY "community_message_images_insert_own" ON "community_message_images" FOR INSERT TO public
  WITH CHECK ("author_id" = app.current_user_id() AND app.community_can_access("cohort_id", app.current_user_id()));
COMMENT ON TABLE "community_message_images" IS
  '20270502009200: the photo behind a kind image space chat message; the object is at storage_key in the private community-images bucket.';

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind"::text IN ('text', 'voice', 'image') AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502009200: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a text, voice or image message answering a thread app.community_voice_reply accepts). DMs and Hall rows pass.';

DO $community_images_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'community-images bucket: storage.buckets not present (not a Supabase database); nothing to do.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('community-images', 'community-images', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) THEN
    UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/jpeg']::text[] WHERE id = 'community-images';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) THEN
    UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = 'community-images';
  END IF;

  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'community-images bucket: storage.buckets exists but storage.objects does not; refusing to create an unfenced bucket.';
  END IF;

  DROP POLICY IF EXISTS community_images_api_roles_fence ON storage.objects;
  CREATE POLICY community_images_api_roles_fence ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id IS DISTINCT FROM 'community-images')
    WITH CHECK (bucket_id IS DISTINCT FROM 'community-images');
END
$community_images_bucket$;

COMMIT;
