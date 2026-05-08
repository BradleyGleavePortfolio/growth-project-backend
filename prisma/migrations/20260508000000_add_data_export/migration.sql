-- Phase 10 — Data Export (GDPR Article 20 right to data portability)
--
-- Replaces the stub DataExportRequest table (status as String, payload/error/
-- fulfilled_at/delivered_at columns) with a production-ready table:
--   * status backed by a proper enum (DataExportStatus)
--   * file_url for the S3 presigned URL
--   * completed_at / expires_at / file_size_bytes / sha256 for lifecycle tracking
--
-- Migration is safe to run on existing tables: we DROP and RECREATE rather
-- than ALTER because the stub columns (payload, error, requested_at,
-- fulfilled_at, delivered_at) have no production data that needs preserving
-- and the new column set is a clean replacement.
--
-- NOTE: The User.data_export_requests relation already exists in the schema
-- from the previous stub migration. This migration updates the table only.

-- Create the enum
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'EXPIRED', 'FAILED');

-- Drop old stub table (no FK children — User references it but Prisma
-- creates the FK with ON DELETE CASCADE so the drop is clean).
DROP TABLE IF EXISTS "data_export_request";

-- Recreate with production schema
CREATE TABLE "data_export_request" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "status"          "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    -- Signed S3 URL (or local:// path in dev). Null until the export is READY.
    -- NEVER returned directly by the API — clients get a short-lived JWT token
    -- via /status and redirect through /download?token=.
    "file_url"        TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"    TIMESTAMP(3),
    -- Set to created_at + 7 days on completion. Nightly cron expires rows past this.
    "expires_at"      TIMESTAMP(3),
    "file_size_bytes" INTEGER,
    -- SHA-256 hex digest of the JSON file for integrity verification.
    "sha256"          TEXT,

    CONSTRAINT "data_export_request_pkey" PRIMARY KEY ("id")
);

-- Index: user timeline query (most-recent-first per user)
CREATE INDEX "data_export_request_user_id_created_at_idx"
    ON "data_export_request"("user_id", "created_at");

-- Index: nightly cleanup cron (find READY rows past expires_at)
CREATE INDEX "data_export_request_status_expires_at_idx"
    ON "data_export_request"("status", "expires_at");

-- FK to User with cascade (if user is deleted, export requests go too)
ALTER TABLE "data_export_request"
    ADD CONSTRAINT "data_export_request_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
