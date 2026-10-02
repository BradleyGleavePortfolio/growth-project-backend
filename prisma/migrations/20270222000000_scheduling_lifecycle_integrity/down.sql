-- Reverse of 20270222000000_scheduling_lifecycle_integrity.
-- Drops exactly what the forward migration added.
--
-- Data note: dropping the SessionType columns discards which type was the
-- welcome type and any stored default meeting links; sessions and other
-- columns are untouched. Dropping the exclusion constraint removes the
-- database floor against double booking (the service-level advisory lock and
-- re-check remain). btree_gist is dropped last with RESTRICT semantics: if any
-- other object has come to depend on it, this statement fails and the
-- extension stays (drop that dependency first, or leave the extension).
-- The recorded Prisma migration history is not rewritten here.
ALTER TABLE "CoachingSession" DROP CONSTRAINT IF EXISTS "CoachingSession_no_overlapping_active_booking";
DROP EXTENSION IF EXISTS btree_gist;
ALTER TABLE "SessionType" DROP CONSTRAINT IF EXISTS "SessionType_default_meeting_url_https";
DROP INDEX IF EXISTS "SessionType_one_active_welcome_per_coach";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "default_meeting_url";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "is_welcome";
