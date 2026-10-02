-- S-SCHED-2: native scheduling lifecycle integrity.
--
-- 1. SessionType gets a persistent welcome marker and an optional per-type
--    default meeting link (additive, defaulted / nullable; existing rows read
--    is_welcome = false and default_meeting_url = NULL, so no reader or writer
--    changes behaviour).
-- 2. CoachingSession gets a database-level no-double-booking floor: an
--    exclusion constraint over (coach_id, [start_at, end_at)) restricted to
--    the statuses that occupy a coach's time. The service already serialises
--    booking writers per coach with an advisory lock and re-checks inside the
--    transaction; this constraint makes the guarantee independent of the
--    application path and of the transaction isolation level.
--
-- 3. NotificationDeliveryLog gets recoverable delivery state (S-SCHED-3
--    B-634-2): status / attempts / lease / claim token / session revision /
--    per-channel done markers. Additive and defaulted: rows written before
--    this migration read status = 'sent', attempts = 1 (they were attempted
--    once and are never re-sent), so no reminder is repeated by the deploy.
--
-- RLS: no new table. SessionType and CoachingSession keep their existing
-- enabled + forced RLS policies (PR-RLS-03); new columns inherit them.
--
-- Rollout safety: step 2 cannot be created while two active rows for one
-- coach already overlap. The preflight below fails the migration (the whole
-- migration is rolled back) with the number of conflicting pairs instead of
-- silently cancelling anyone's booking. Operator query to inspect before
-- deploy is in the PR body. Reverse with down.sql.

-- 1. SessionType: welcome marker + default meeting link --------------------
ALTER TABLE "SessionType" ADD COLUMN IF NOT EXISTS "is_welcome" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionType" ADD COLUMN IF NOT EXISTS "default_meeting_url" TEXT;

-- At most one active welcome type per coach. Archived welcome types do not
-- count, so a coach can archive the old one and mark a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "SessionType_one_active_welcome_per_coach"
  ON "SessionType" ("coach_id")
  WHERE "is_welcome" = true AND "archived_at" IS NULL;

-- Stored links must be https and bounded (the API validates too; this is the floor).
ALTER TABLE "SessionType" DROP CONSTRAINT IF EXISTS "SessionType_default_meeting_url_https";
ALTER TABLE "SessionType" ADD CONSTRAINT "SessionType_default_meeting_url_https"
  CHECK ("default_meeting_url" IS NULL OR ("default_meeting_url" LIKE 'https://%' AND length("default_meeting_url") <= 500));

-- 2. CoachingSession: no overlapping active bookings per coach -------------
-- btree_gist provides the gist equality operator class for coach_id (TEXT).
-- It is a trusted contrib extension (installable by the migration role on
-- Supabase). Supabase keeps extensions in the "extensions" schema; plain
-- Postgres (CI) has no such schema, so fall back to the default schema.
-- Operator-class lookup is by catalog default, not search_path, so either
-- placement serves the constraint below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION btree_gist WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION btree_gist;
    END IF;
    -- Ownership marker (S-SCHED-3 C-634-1): down.sql removes the extension
    -- only when this migration installed it. A pre-existing btree_gist is
    -- reused and left alone.
    COMMENT ON EXTENSION btree_gist IS 'installed by 20270222000000_scheduling_lifecycle_integrity';
  END IF;
END $$;

-- Preflight: refuse (and roll back) rather than drop or cancel bookings.
DO $$
DECLARE
  conflicts integer;
BEGIN
  SELECT count(*) INTO conflicts
  FROM "CoachingSession" a
  JOIN "CoachingSession" b
    ON a."coach_id" = b."coach_id"
   AND a."id" < b."id"
   AND a."status" IN ('requested', 'scheduled', 'pending_provider')
   AND b."status" IN ('requested', 'scheduled', 'pending_provider')
   AND a."start_at" < b."end_at"
   AND b."start_at" < a."end_at";
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'S-SCHED-2 preflight: % pair(s) of overlapping active CoachingSession rows exist; resolve them (cancel or move one of each pair) before applying 20270222000000', conflicts;
  END IF;
END $$;

-- Range preflight (S-SCHED-3 C-634-2): tsrange() below raises a bare
-- "range lower bound must be less than or equal to range upper bound" on an
-- active row whose end is before its start. Name the problem instead.
DO $$
DECLARE
  inverted integer;
BEGIN
  SELECT count(*) INTO inverted
  FROM "CoachingSession"
  WHERE "status" IN ('requested', 'scheduled', 'pending_provider')
    AND "end_at" < "start_at";
  IF inverted > 0 THEN
    RAISE EXCEPTION 'S-SCHED-2 range preflight: % active CoachingSession row(s) end before they start; fix their end_at (or cancel them) before applying 20270222000000', inverted;
  END IF;
END $$;

ALTER TABLE "CoachingSession" DROP CONSTRAINT IF EXISTS "CoachingSession_no_overlapping_active_booking";
ALTER TABLE "CoachingSession" ADD CONSTRAINT "CoachingSession_no_overlapping_active_booking"
  EXCLUDE USING gist (
    "coach_id" WITH =,
    tsrange("start_at", "end_at", '[)') WITH &&
  )
  WHERE ("status" IN ('requested', 'scheduled', 'pending_provider'));

-- 3. NotificationDeliveryLog: recoverable reminder delivery ----------------
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "lease_until" TIMESTAMP(3);
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "claim_token" TEXT;
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "session_start_at" TIMESTAMP(3);
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "inapp_done_at" TIMESTAMP(3);
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "push_done_at" TIMESTAMP(3);
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "notification_id" TEXT;
ALTER TABLE "NotificationDeliveryLog" ADD COLUMN IF NOT EXISTS "last_error" TEXT;

ALTER TABLE "NotificationDeliveryLog" DROP CONSTRAINT IF EXISTS "NotificationDeliveryLog_status_check";
ALTER TABLE "NotificationDeliveryLog" ADD CONSTRAINT "NotificationDeliveryLog_status_check"
  CHECK ("status" IN ('sending', 'retry', 'sent', 'gave_up') AND "attempts" >= 1);

-- The reminder sweep reads unfinished delivery work on every tick (S-SCHED-4
-- B-634-2: retries and dead workers' claims are selected on their own, not
-- only through the due band).
CREATE INDEX IF NOT EXISTS "NotificationDeliveryLog_kind_status_idx"
  ON "NotificationDeliveryLog" ("kind", "status");
