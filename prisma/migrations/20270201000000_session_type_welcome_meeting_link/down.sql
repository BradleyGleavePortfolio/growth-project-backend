-- Reverse of 20270201000000_session_type_welcome_meeting_link.
-- Drops the two S-SCHED columns, the partial unique index and the https check.
-- Data note: dropping the columns discards which type was the welcome type and
-- any stored default meeting links; it does not touch sessions or other types.
-- The recorded Prisma migration history is not rewritten here.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "SessionType" DROP CONSTRAINT IF EXISTS "SessionType_default_meeting_url_https";
DROP INDEX IF EXISTS "SessionType_one_active_welcome_per_coach";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "default_meeting_url";
ALTER TABLE "SessionType" DROP COLUMN IF EXISTS "is_welcome";
COMMIT;
