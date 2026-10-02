-- Reverse of 20270222000000_scheduling_lifecycle_integrity.
-- Drops exactly what the forward migration added.
--
-- Data note: dropping the SessionType columns discards which type was the
-- welcome type and any stored default meeting links; dropping the
-- NotificationDeliveryLog delivery-state columns keeps every claim row (so
-- no reminder is re-sent) but forgets retry state; sessions and other columns
-- are untouched. Dropping the exclusion constraint removes the database floor
-- against double booking (the service-level advisory lock and re-check
-- remain).
--
-- btree_gist (S-SCHED-3 C-634-1): removed only when the forward migration
-- installed it (its ownership comment), and only if nothing else has come to
-- depend on it; otherwise it stays installed and a NOTICE says why. A
-- pre-existing, shared extension is never dropped by this file.
-- The recorded Prisma migration history is not rewritten here.
DROP INDEX IF EXISTS "NotificationDeliveryLog_kind_status_idx";
ALTER TABLE "NotificationDeliveryLog" DROP CONSTRAINT IF EXISTS "NotificationDeliveryLog_status_check";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "last_error";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "notification_id";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "push_done_at";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "inapp_done_at";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "session_start_at";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "claim_token";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "lease_until";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "attempts";
ALTER TABLE "NotificationDeliveryLog" DROP COLUMN IF EXISTS "status";
ALTER TABLE "CoachingSession" DROP CONSTRAINT IF EXISTS "CoachingSession_no_overlapping_active_booking";
ALTER TABLE "SessionType" DROP CONSTRAINT IF EXISTS "SessionType_default_meeting_url_https";
DROP INDEX IF EXISTS "SessionType_one_active_welcome_per_coach";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "default_meeting_url";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "is_welcome";
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e
    WHERE e.extname = 'btree_gist'
      AND obj_description(e.oid, 'pg_extension') = 'installed by 20270222000000_scheduling_lifecycle_integrity'
  ) THEN
    BEGIN
      DROP EXTENSION btree_gist RESTRICT;
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE NOTICE '20270222000000 down: btree_gist kept; other objects now depend on it';
    END;
  ELSE
    RAISE NOTICE '20270222000000 down: btree_gist was not installed by this migration; left in place';
  END IF;
END $$;
