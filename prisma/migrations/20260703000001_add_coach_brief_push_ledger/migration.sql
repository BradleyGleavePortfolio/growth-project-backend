-- P1-9: Move push-dedup state to a server-only ledger table so a coach
-- with direct RLS write access to CoachBriefPreferences cannot poison
-- the dedup fields and silently suppress their own daily push.
--
-- The previous design put last_push_attempt_date and last_push_date on
-- CoachBriefPreferences, which the coach UPDATE policy allows them to
-- write to. A malicious client (or compromised credential) could set
-- last_push_attempt_date='2099-01-01' and the cron's atomic claim would
-- forever return count=0 (no push). This is an RLS escalation against a
-- backend-only invariant, so the dedup state belongs in a table the
-- coach role has zero policies on.
--
-- CoachBriefPushLedger is keyed by coach_id (unique) and only the
-- service_role can read or write. The two date columns are migrated
-- from CoachBriefPreferences via a one-time INSERT, then the columns
-- are dropped from preferences.

CREATE TABLE IF NOT EXISTS "CoachBriefPushLedger" (
  "id"                     TEXT NOT NULL,
  "coach_id"               TEXT NOT NULL,
  "last_push_attempt_date" TEXT,
  "last_push_date"         TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachBriefPushLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoachBriefPushLedger_coach_id_key"
  ON "CoachBriefPushLedger" ("coach_id");

ALTER TABLE "CoachBriefPushLedger"
  ADD CONSTRAINT "CoachBriefPushLedger_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Server-only RLS. No coach SELECT/INSERT/UPDATE/DELETE policy exists,
-- which means the coach-role direct path (if/when wired) cannot read or
-- mutate this table. Only the service_role bypass applies.
ALTER TABLE "CoachBriefPushLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachBriefPushLedger" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_brief_push_ledger_service_role_bypass" ON "CoachBriefPushLedger";
CREATE POLICY "coach_brief_push_ledger_service_role_bypass"
  ON "CoachBriefPushLedger"
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Backfill any existing dedup state into the new ledger. This is a
-- one-time copy — production rows that already carry last_push_*
-- columns get a matching ledger row keyed by coach_id.
INSERT INTO "CoachBriefPushLedger" ("id", "coach_id", "last_push_attempt_date", "last_push_date")
SELECT
  gen_random_uuid()::text,
  p."coach_id",
  p."last_push_attempt_date",
  p."last_push_date"
FROM "CoachBriefPreferences" p
WHERE p."last_push_attempt_date" IS NOT NULL OR p."last_push_date" IS NOT NULL
ON CONFLICT ("coach_id") DO NOTHING;

-- Now drop the columns from CoachBriefPreferences so the coach UPDATE
-- policy can no longer touch them.
ALTER TABLE "CoachBriefPreferences"
  DROP COLUMN IF EXISTS "last_push_attempt_date";
ALTER TABLE "CoachBriefPreferences"
  DROP COLUMN IF EXISTS "last_push_date";

-- ROLLBACK:
-- ALTER TABLE "CoachBriefPreferences" ADD COLUMN "last_push_date" TEXT;
-- ALTER TABLE "CoachBriefPreferences" ADD COLUMN "last_push_attempt_date" TEXT;
-- UPDATE "CoachBriefPreferences" p SET
--   "last_push_attempt_date" = l."last_push_attempt_date",
--   "last_push_date"         = l."last_push_date"
-- FROM "CoachBriefPushLedger" l WHERE l."coach_id" = p."coach_id";
-- DROP POLICY IF EXISTS "coach_brief_push_ledger_service_role_bypass" ON "CoachBriefPushLedger";
-- ALTER TABLE "CoachBriefPushLedger" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "CoachBriefPushLedger_coach_id_key";
-- DROP TABLE IF EXISTS "CoachBriefPushLedger" CASCADE;
