-- Phase 6A + 6B — Coach signals: per-coach effectiveness score (append-only
-- history) and per-coach red-flag alerts (with dedup + acknowledge flow).
--
-- Additive only. No existing column or row is touched. Existing rows stay
-- valid. The recompute hook in PtmRecomputeService writes CoachAlert rows
-- in a fire-and-forget try/catch so a failure here can never bubble back
-- into a user-facing 5xx (mirrors the PTM signal-collection doctrine).
--
-- Two new tables:
--   1. CoachEffectivenessScore — nightly score per coach (append-only)
--   2. CoachAlert              — proactive notifications to coaches
--
-- Both reference User on coach_id (and CoachAlert on client_id) so a
-- GDPR scrub of either party cleans the row up via ON DELETE CASCADE.
-- We deliberately do NOT add an enum for alert_type / bucket — the
-- string columns let us add new categories without a migration round-
-- trip; coach-alerts.service.ts owns the canonical set.

-- 1. CoachEffectivenessScore -------------------------------------------------
CREATE TABLE "CoachEffectivenessScore" (
    "id"          TEXT NOT NULL,
    "coach_id"    TEXT NOT NULL,
    "score"       DOUBLE PRECISION NOT NULL,
    "bucket"      TEXT NOT NULL,
    "factors"     JSONB,
    "basis"       TEXT NOT NULL DEFAULT 'v1',
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachEffectivenessScore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachEffectivenessScore_coach_id_computed_at_idx"
    ON "CoachEffectivenessScore"("coach_id", "computed_at");

CREATE INDEX "CoachEffectivenessScore_computed_at_idx"
    ON "CoachEffectivenessScore"("computed_at");

ALTER TABLE "CoachEffectivenessScore"
    ADD CONSTRAINT "CoachEffectivenessScore_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. CoachAlert -------------------------------------------------------------
CREATE TABLE "CoachAlert" (
    "id"              TEXT NOT NULL,
    "coach_id"        TEXT NOT NULL,
    "client_id"       TEXT NOT NULL,
    "alert_type"      TEXT NOT NULL,
    "severity"        TEXT NOT NULL DEFAULT 'warning',
    "message"         TEXT NOT NULL,
    "payload"         JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "CoachAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachAlert_coach_id_created_at_idx"
    ON "CoachAlert"("coach_id", "created_at");

CREATE INDEX "CoachAlert_coach_id_acknowledged_at_idx"
    ON "CoachAlert"("coach_id", "acknowledged_at");

CREATE INDEX "CoachAlert_client_id_alert_type_created_at_idx"
    ON "CoachAlert"("client_id", "alert_type", "created_at");

ALTER TABLE "CoachAlert"
    ADD CONSTRAINT "CoachAlert_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachAlert"
    ADD CONSTRAINT "CoachAlert_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
