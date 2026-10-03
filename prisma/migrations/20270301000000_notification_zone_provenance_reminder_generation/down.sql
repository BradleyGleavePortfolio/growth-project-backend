-- Reverse of 20270301000000_notification_zone_provenance_reminder_generation.
-- Restores the (session, user, kind) claim key. If a session already has
-- claims for two start times, keep the newest claim per key first, or the
-- unique index cannot be rebuilt.
SET lock_timeout = '5s';

DELETE FROM "NotificationDeliveryLog" AS a
USING "NotificationDeliveryLog" AS b
WHERE a."session_id" = b."session_id" AND a."user_id" = b."user_id" AND a."kind" = b."kind"
  AND (a."created_at", a."id") < (b."created_at", b."id");

DROP INDEX IF EXISTS "NotificationDeliveryLog_session_id_user_id_kind_start_at_key";
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationDeliveryLog_session_user_kind_key"
    ON "NotificationDeliveryLog"("session_id", "user_id", "kind");
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "start_at";

ALTER TABLE "NotificationPreferences" DROP CONSTRAINT IF EXISTS "NotificationPreferences_timezone_source_check";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "timezone_updated_at";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "timezone_source";
