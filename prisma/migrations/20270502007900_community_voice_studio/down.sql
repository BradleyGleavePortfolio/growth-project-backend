-- Down for 20270502007900_community_voice_studio (VOICE-BE). Irreversible for
-- data: every heard marker and consent-seen row is deleted (the phone shows
-- every voice note as new and the consent card once more). The space chat
-- rows this release wrote for voice notes (community_messages kind 'voice';
-- nothing else writes that kind in a space) are soft-deleted so the older
-- server never lists them as empty messages; the voice notes themselves stay.

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "community_messages" SET "deleted_at" = CURRENT_TIMESTAMP
  WHERE "scope" = 'cohort' AND "kind" = 'voice' AND "deleted_at" IS NULL;
DROP TABLE IF EXISTS "community_voice_note_listens";
DROP TABLE IF EXISTS "community_voice_consents";

COMMIT;
