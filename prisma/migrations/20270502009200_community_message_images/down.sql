-- Down for 20270502009200_community_message_images (SC-BE3). The bucket and its
-- fence go only while the bucket holds no object; the photo table and its
-- author_stays helper go; the
-- insert policy goes back to its 20270502009000 text. The enum value 'image'
-- stays: Postgres cannot drop an enum value, and an older server never writes
-- it (kind 'image' rows, if any, should be soft-deleted before this runs).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $community_images_bucket_down$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('storage.objects') IS NOT NULL
     AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'community-images') THEN
    RAISE EXCEPTION 'community-images bucket still holds photos; refusing to drop it. Fix: remove them through the Storage API, then re-run down.sql.';
  END IF;
  DELETE FROM storage.buckets WHERE id = 'community-images';
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS community_images_api_roles_fence ON storage.objects;
  END IF;
END
$community_images_bucket_down$;

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind" IN ('text', 'voice') AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502009000: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a text or voice message answering a thread app.community_voice_reply accepts). DMs and Hall rows pass.';

DROP TABLE IF EXISTS "community_message_images";
DROP FUNCTION IF EXISTS app.community_space_author_stays(uuid, text);

COMMIT;
