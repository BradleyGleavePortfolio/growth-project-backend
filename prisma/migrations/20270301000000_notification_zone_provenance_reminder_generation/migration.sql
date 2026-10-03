-- B-NOTIF-4 (backend #647): recipient time-zone provenance and reminder-claim
-- generations. Additive except the reminder-claim unique key, which widens.
-- No RLS change: both tables keep their existing row-level policies, which
-- cover every column. Reverse: down.sql.
--
-- 1) NotificationPreferences.timezone has a schema default
--    ('America/Los_Angeles'), and a row is created by any preference toggle,
--    so a stored row is not proof of the person's zone (Opus B-647-1, Sol
--    B-647-2). Two nullable columns record provenance: they are set only when
--    a zone is actually supplied (the mobile app's device zone, or an explicit
--    settings write). No backfill: no client has ever written the zone, so
--    every existing row is correctly "never supplied" and notification copy
--    falls back to the coach's zone instead of a synthetic Pacific default.
SET lock_timeout = '5s';

ALTER TABLE "NotificationPreferences" ADD COLUMN IF NOT EXISTS "timezone_source" TEXT;
ALTER TABLE "NotificationPreferences" ADD COLUMN IF NOT EXISTS "timezone_updated_at" TIMESTAMP(3);

ALTER TABLE "NotificationPreferences" DROP CONSTRAINT IF EXISTS "NotificationPreferences_timezone_source_check";
ALTER TABLE "NotificationPreferences"
    ADD CONSTRAINT "NotificationPreferences_timezone_source_check"
    CHECK ("timezone_source" IS NULL OR "timezone_source" IN ('device', 'settings'));

-- 2) Reminder claims carry the session start time they were made for (Sol
--    B-647-1). The claim key becomes (session, user, kind, start_at): a
--    reschedule gets fresh claims for the new time without deleting anything,
--    an old-time claim written by a stale sweep can no longer suppress the
--    new-time reminder, and a no-op reschedule leaves the claim in place.
--    Backfill: existing claims were made for the session's current time
--    (reminders have never been enabled in production, so this is normally
--    empty).
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "start_at" TIMESTAMP(3);

UPDATE "NotificationDeliveryLog" AS l
SET "start_at" = s."start_at"
FROM "CoachingSession" AS s
WHERE s."id" = l."session_id" AND l."start_at" IS NULL;

ALTER TABLE "NotificationDeliveryLog" ALTER COLUMN "start_at" SET NOT NULL;

DROP INDEX IF EXISTS "NotificationDeliveryLog_session_user_kind_key";
DROP INDEX IF EXISTS "NotificationDeliveryLog_session_id_user_id_kind_key";
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationDeliveryLog_session_id_user_id_kind_start_at_key"
    ON "NotificationDeliveryLog"("session_id", "user_id", "kind", "start_at");
