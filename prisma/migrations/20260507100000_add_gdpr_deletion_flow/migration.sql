-- Phase 10 — GDPR Delete (right to erasure)
-- 
-- Two-phase deletion state machine on User:
--   NONE → REQUESTED  (deletion_requested_at set, token mailed)
--   REQUESTED → CONFIRMED  (deletion_confirmed_at set after link click)
--   CONFIRMED → DELETED  (finalize cron PII-scrubs the row after 14 days)
--
-- The existing deletion_scheduled_at / deleted_at columns stay in place
-- for the legacy 30-day scrub path (GdprScrubScheduler). The new columns
-- drive the explicit user-initiated + admin-initiated flows.

-- Add new columns to User for two-phase confirmed deletion
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletion_requested_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletion_confirmed_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletion_token_hash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletion_token_expires_at" TIMESTAMP(3);

-- Index for nightly finalize cron: finds rows where confirmed > 14 days ago
CREATE INDEX IF NOT EXISTS "User_deletion_confirmed_at_idx"
  ON "User" ("deletion_confirmed_at")
  WHERE "deletion_confirmed_at" IS NOT NULL AND "deleted_at" IS NULL;

-- deletion_audit: one row per significant event in a user's deletion
-- lifecycle. Kept separate from AuditLog so GDPR auditors can pull a
-- focused report without joining on the wide audit table.
CREATE TABLE IF NOT EXISTS "deletion_audit" (
  "id"          TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "event"       TEXT NOT NULL,  -- see DeletionAuditEvent enum in service
  "actor_id"    TEXT,           -- null for system/cron events
  "actor_role"  TEXT,
  "metadata"    JSONB,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "deletion_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "deletion_audit_user_id_created_at_idx"
  ON "deletion_audit" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "deletion_audit_event_created_at_idx"
  ON "deletion_audit" ("event", "created_at");
