-- Down for 20270502007900_community_voice_studio (VOICE-BE). Irreversible for
-- data: every heard marker and consent-seen row is deleted (the phone shows
-- every voice note as new and the consent card once more). The space chat
-- rows this release wrote for voice notes (community_messages kind 'voice';
-- nothing else writes that kind in a space) are soft-deleted so the older
-- server never lists them as empty messages; the voice notes themselves stay.
-- community_messages_space_takes_insert goes back to its 20270502004600 text.

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "community_messages" SET "deleted_at" = CURRENT_TIMESTAMP
  WHERE "scope" = 'cohort' AND "kind" = 'voice' AND "deleted_at" IS NULL;
ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin'))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502004600: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment or challenge opt-in row). DMs and Hall rows pass.';
DROP FUNCTION IF EXISTS app.community_voice_reply(uuid, uuid, timestamptz);
DROP TABLE IF EXISTS "community_voice_note_listens";
DROP TABLE IF EXISTS "community_voice_consents";

COMMIT;
