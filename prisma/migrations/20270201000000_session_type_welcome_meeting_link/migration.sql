-- S-SCHED: welcome appointment-type marker + per-type default meeting link.
-- Additive only: two nullable/defaulted columns and one partial unique index.
-- Existing rows get is_welcome = false and default_meeting_url = NULL, so no
-- existing reader or writer changes behaviour. Reverse with down.sql.
ALTER TABLE "SessionType" ADD COLUMN IF NOT EXISTS "is_welcome" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionType" ADD COLUMN IF NOT EXISTS "default_meeting_url" TEXT;

-- At most one active welcome type per coach. Archived welcome types do not
-- count, so a coach can archive the old one and mark a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "SessionType_one_active_welcome_per_coach"
  ON "SessionType" ("coach_id")
  WHERE "is_welcome" = true AND "archived_at" IS NULL;

-- Stored links must be https (the API validates too; this is the floor).
ALTER TABLE "SessionType" DROP CONSTRAINT IF EXISTS "SessionType_default_meeting_url_https";
ALTER TABLE "SessionType" ADD CONSTRAINT "SessionType_default_meeting_url_https"
  CHECK ("default_meeting_url" IS NULL OR ("default_meeting_url" LIKE 'https://%' AND length("default_meeting_url") <= 500));
