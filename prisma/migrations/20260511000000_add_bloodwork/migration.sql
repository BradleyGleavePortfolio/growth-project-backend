-- Bloodwork v1: client-entered lab panels, biomarker results, and
-- attachment metadata.
--
-- Additive only. No backfill required (no panels exist in prod yet).
--
-- Sensitive-data note:
--   * Columns hold health data and must be treated as PHI-grade.
--   * Plaintext-at-rest in v1; production deploys MUST set
--     BLOODWORK_KMS_KEY_REF and migrate sensitive columns
--     (value_text, value_numeric, notes, review_note, reference_text,
--     reference_low/high) to a KMS-encrypted strategy. The
--     encryption_key_ref / kms_key_version columns on BloodworkPanel are
--     metadata pointers for that future binding; they are nullable
--     today.
--   * No raw keys live in the repo. See docs/bloodwork.md for the
--     production KMS handoff.
--
-- Tenancy: BloodworkPanel.coach_id is denormalized at submit time so the
-- coach's review queue still surfaces a panel even if the client later
-- switches coaches (mirrors the CheckIn pattern). coach_id is nullable
-- because a client may submit before being assigned a coach.
--
-- State strings (review_state, validation_status, scan_status,
-- disclaimer_level, source) are intentionally stored as TEXT, not SQL
-- enums, so adding a state is a code change rather than a migration.

CREATE TABLE "BloodworkPanel" (
    "id"                    TEXT NOT NULL,
    "client_id"             TEXT NOT NULL,
    "coach_id"              TEXT,
    "collection_date"       TIMESTAMP(3) NOT NULL,
    "source"                TEXT NOT NULL DEFAULT 'manual_entry',
    "panel_label"           TEXT,
    "notes"                 TEXT,
    "review_state"          TEXT NOT NULL DEFAULT 'draft',
    "reviewed_by_id"        TEXT,
    "reviewed_at"           TIMESTAMP(3),
    "review_note"           TEXT,
    "disclaimer_level"      TEXT NOT NULL DEFAULT 'educational_only',
    "validation_status"     TEXT NOT NULL DEFAULT 'ok',
    "is_stale"              BOOLEAN NOT NULL DEFAULT false,
    "stale_marked_at"       TIMESTAMP(3),
    "source_missing"        BOOLEAN NOT NULL DEFAULT false,
    "ai_processing_allowed" BOOLEAN NOT NULL DEFAULT false,
    "encryption_key_ref"    TEXT,
    "kms_key_version"       TEXT,
    "submitted_at"          TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BloodworkPanel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BloodworkPanel_client_id_collection_date_idx"
    ON "BloodworkPanel"("client_id", "collection_date");
CREATE INDEX "BloodworkPanel_coach_id_review_state_idx"
    ON "BloodworkPanel"("coach_id", "review_state");
CREATE INDEX "BloodworkPanel_review_state_submitted_at_idx"
    ON "BloodworkPanel"("review_state", "submitted_at");
CREATE INDEX "BloodworkPanel_is_stale_idx"
    ON "BloodworkPanel"("is_stale");

ALTER TABLE "BloodworkPanel"
    ADD CONSTRAINT "BloodworkPanel_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BloodworkPanel"
    ADD CONSTRAINT "BloodworkPanel_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BloodworkPanel"
    ADD CONSTRAINT "BloodworkPanel_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BloodworkResult" (
    "id"                 TEXT NOT NULL,
    "panel_id"           TEXT NOT NULL,
    "marker_name"        TEXT NOT NULL,
    "marker_code"        TEXT,
    "value_numeric"      DECIMAL(20,6),
    "value_text"         TEXT,
    "unit"               TEXT,
    "reference_low"      DECIMAL(20,6),
    "reference_high"     DECIMAL(20,6),
    "reference_text"     TEXT,
    "out_of_range"       BOOLEAN NOT NULL DEFAULT false,
    "validation_status"  TEXT NOT NULL DEFAULT 'ok',
    "validation_message" TEXT,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BloodworkResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BloodworkResult_panel_id_idx" ON "BloodworkResult"("panel_id");
CREATE INDEX "BloodworkResult_marker_name_idx" ON "BloodworkResult"("marker_name");

ALTER TABLE "BloodworkResult"
    ADD CONSTRAINT "BloodworkResult_panel_id_fkey"
    FOREIGN KEY ("panel_id") REFERENCES "BloodworkPanel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BloodworkAttachment" (
    "id"              TEXT NOT NULL,
    "panel_id"        TEXT NOT NULL,
    "storage_ref"     TEXT,
    "storage_backend" TEXT,
    "content_type"    TEXT,
    "byte_size"       INTEGER,
    "scan_status"     TEXT NOT NULL DEFAULT 'pending_scan',
    "scan_message"    TEXT,
    "scanned_at"      TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BloodworkAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BloodworkAttachment_panel_id_idx" ON "BloodworkAttachment"("panel_id");
CREATE INDEX "BloodworkAttachment_scan_status_idx" ON "BloodworkAttachment"("scan_status");

ALTER TABLE "BloodworkAttachment"
    ADD CONSTRAINT "BloodworkAttachment_panel_id_fkey"
    FOREIGN KEY ("panel_id") REFERENCES "BloodworkPanel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
