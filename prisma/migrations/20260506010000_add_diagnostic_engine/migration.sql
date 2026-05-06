-- Phase 3 — 40-point Diagnostic + AI roadmap. Append-only; no existing
-- table is modified. See src/diagnostic/README.md and docs/diagnostic.md
-- for the doctrine.
--
-- Two new tables:
--   1. DiagnosticSubmission — one row per completed 40-question submission.
--      Stores answers + computed scores + bucket. `user_id` is null for
--      anonymous lead submissions; back-filled when the lead signs up.
--   2. AiRoadmap           — 1:1 with submission. Generated async; status
--      column captures 'ready' | 'failed' so the GET endpoint can serve
--      a deterministic retry path on AI provider failure.
--
-- No new enums. `bucket` and `status` are stored as Json/Text respectively
-- so we can extend the bucket vocabulary without a migration. The seed
-- catalog (prisma/seed-diagnostic.json) is the source of truth for the
-- 40 question texts.

-- 1. DiagnosticSubmission -------------------------------------------------
CREATE TABLE "DiagnosticSubmission" (
    "id"           TEXT          NOT NULL,
    "email"        TEXT          NOT NULL,
    "name"         TEXT,
    "age"          INTEGER,
    "source"       TEXT,
    "answers"      JSONB         NOT NULL,
    "scores"       JSONB         NOT NULL,
    "bucket"       JSONB         NOT NULL,
    "submitted_at" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id"      TEXT,
    "ip"           TEXT,
    "user_agent"   TEXT,
    CONSTRAINT "DiagnosticSubmission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DiagnosticSubmission_email_submitted_at_idx"
    ON "DiagnosticSubmission"("email", "submitted_at");
CREATE INDEX "DiagnosticSubmission_user_id_idx"
    ON "DiagnosticSubmission"("user_id");
CREATE INDEX "DiagnosticSubmission_submitted_at_idx"
    ON "DiagnosticSubmission"("submitted_at");

-- 2. AiRoadmap ------------------------------------------------------------
CREATE TABLE "AiRoadmap" (
    "id"             TEXT         NOT NULL,
    "submission_id"  TEXT         NOT NULL,
    "generated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prompt_version" TEXT         NOT NULL DEFAULT 'v1',
    "status"         TEXT         NOT NULL DEFAULT 'ready',
    "payload"        JSONB,
    "tokens_used"    INTEGER,
    "model"          TEXT         NOT NULL DEFAULT 'sonar-pro',
    "error_message"  TEXT,
    CONSTRAINT "AiRoadmap_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiRoadmap_submission_id_key"
    ON "AiRoadmap"("submission_id");
CREATE INDEX "AiRoadmap_submission_id_idx"
    ON "AiRoadmap"("submission_id");
ALTER TABLE "AiRoadmap"
    ADD CONSTRAINT "AiRoadmap_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "DiagnosticSubmission"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
