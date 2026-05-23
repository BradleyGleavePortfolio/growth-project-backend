-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260616000000_add_message_reports_and_user_blocks
--
-- WHAT:  Two new safety tables required for Apple App Review 1.2 compliance:
--          • MessageReport — user-filed reports against a specific CoachMessage.
--          • UserBlock     — per-user blocklist (one-way, silent).
--        Both tables are RLS-enabled in the same migration that creates them
--        (Engineering Rule 2 — never ship a table without RLS in the same PR).
--
-- WHY:   Mobile PR #189 (iMessage-grade DMs) ships block / report / abuse-filter
--        surfaces. Without server-side enforcement the mobile defense-in-depth
--        filter is the only thing standing between a blocked user and the
--        recipient's screen — and push notifications go around it entirely.
--        Apple's 1.2 reviewer tests "block silences notifications + hides
--        history". This migration closes the gap.
--
-- ROLLBACK (run as superuser):
--   BEGIN;
--   DROP POLICY IF EXISTS "user_block_select_blocker_or_owner" ON "UserBlock";
--   DROP POLICY IF EXISTS "user_block_insert_blocker_or_owner" ON "UserBlock";
--   DROP POLICY IF EXISTS "user_block_delete_blocker_or_owner" ON "UserBlock";
--   ALTER TABLE "UserBlock" DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS "UserBlock";
--   DROP POLICY IF EXISTS "message_report_select_reporter_or_owner" ON "MessageReport";
--   DROP POLICY IF EXISTS "message_report_insert_reporter_or_owner" ON "MessageReport";
--   DROP POLICY IF EXISTS "message_report_update_owner_only" ON "MessageReport";
--   ALTER TABLE "MessageReport" DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS "MessageReport";
--   COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. MessageReport ────────────────────────────────────────────────────────
CREATE TABLE "MessageReport" (
  "id"                   TEXT NOT NULL,
  "reporter_id"          TEXT NOT NULL,
  "message_id"           TEXT NOT NULL,
  "coach_id"             TEXT,
  "client_id"            TEXT,
  "reason"               TEXT NOT NULL,
  "details"              TEXT,
  "status"               TEXT NOT NULL DEFAULT 'pending',
  "action"               TEXT,
  "reviewed_at"          TIMESTAMP(3),
  "reviewed_by_admin_id" TEXT,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MessageReport"
  ADD CONSTRAINT "MessageReport_reporter_id_fkey"
    FOREIGN KEY ("reporter_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageReport"
  ADD CONSTRAINT "MessageReport_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "CoachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageReport"
  ADD CONSTRAINT "MessageReport_reviewed_by_admin_id_fkey"
    FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "MessageReport_reporter_message_key"
  ON "MessageReport"("reporter_id", "message_id");
CREATE INDEX "MessageReport_reporter_id_created_at_idx"
  ON "MessageReport"("reporter_id", "created_at" DESC);
CREATE INDEX "MessageReport_status_created_at_idx"
  ON "MessageReport"("status", "created_at" DESC);
CREATE INDEX "MessageReport_message_id_idx"
  ON "MessageReport"("message_id");

-- RLS for MessageReport.
-- Read: the reporter themselves, or owner-staff (moderation review).
-- Insert: only the reporter themselves, or owner-staff.
-- Update: owner-staff only (status / action / reviewed_*). End users cannot
-- mutate their reports after submission — the report is immutable from their
-- side, which is the right posture for a moderation audit trail.
ALTER TABLE "MessageReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageReport" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_report_select_reporter_or_owner" ON "MessageReport";
CREATE POLICY "message_report_select_reporter_or_owner" ON "MessageReport"
  FOR SELECT TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "reporter_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "message_report_insert_reporter_or_owner" ON "MessageReport";
CREATE POLICY "message_report_insert_reporter_or_owner" ON "MessageReport"
  FOR INSERT TO public
  WITH CHECK (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "reporter_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "message_report_update_owner_only" ON "MessageReport";
CREATE POLICY "message_report_update_owner_only" ON "MessageReport"
  FOR UPDATE TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- ── 2. UserBlock ────────────────────────────────────────────────────────────
CREATE TABLE "UserBlock" (
  "id"         TEXT NOT NULL,
  "blocker_id" TEXT NOT NULL,
  "blocked_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UserBlock"
  ADD CONSTRAINT "UserBlock_blocker_id_fkey"
    FOREIGN KEY ("blocker_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserBlock"
  ADD CONSTRAINT "UserBlock_blocked_id_fkey"
    FOREIGN KEY ("blocked_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "UserBlock_pair_key"
  ON "UserBlock"("blocker_id", "blocked_id");
-- Reverse-direction lookup: "who has blocked this user?" — admin tooling +
-- the messaging service uses this when filtering inbound fanout.
CREATE INDEX "UserBlock_blocked_id_idx" ON "UserBlock"("blocked_id");
CREATE INDEX "UserBlock_blocker_id_created_at_idx"
  ON "UserBlock"("blocker_id", "created_at" DESC);

-- RLS for UserBlock.
-- Read / Insert / Delete: only the blocker themselves, or owner-staff. The
-- blocked party is intentionally never able to see UserBlock rows about
-- themselves — Apple convention is "the block is silent" and exposing the
-- table to the blocked side would leak that information.
ALTER TABLE "UserBlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserBlock" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_block_select_blocker_or_owner" ON "UserBlock";
CREATE POLICY "user_block_select_blocker_or_owner" ON "UserBlock"
  FOR SELECT TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "blocker_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "user_block_insert_blocker_or_owner" ON "UserBlock";
CREATE POLICY "user_block_insert_blocker_or_owner" ON "UserBlock"
  FOR INSERT TO public
  WITH CHECK (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "blocker_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "user_block_delete_blocker_or_owner" ON "UserBlock";
CREATE POLICY "user_block_delete_blocker_or_owner" ON "UserBlock"
  FOR DELETE TO public
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "blocker_id" = app.current_user_id()
    )
  );
