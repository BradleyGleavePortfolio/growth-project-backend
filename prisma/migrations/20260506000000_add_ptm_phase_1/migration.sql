-- Phase 1 PTM (Predictive Tracking Model) — append-only signal log,
-- one-row-per-client outcome label table, and append-only score
-- history. See src/ptm/README.md and docs/ptm.md for the doctrine.
--
-- Additive only. No existing column is touched. No backfill required.
-- Existing rows stay valid. The signal-collection hooks added across
-- check-ins, weight, workout, food, messaging, and finance modules
-- write to ClientSignal asynchronously and fire-and-forget — a row
-- failure in this table can never bubble up to a user request.
--
-- Three new tables:
--   1. ClientSignal     — every behavioral signal we observe (append-only)
--   2. ClientOutcome    — one teaching label per client (upsert + audit)
--   3. PtmPrediction    — every score recompute writes a new row (append-only)
--
-- Three new Postgres enums backing them:
--   - "PtmSignalType"      — 16 starter signals; new types require a migration
--   - "PtmOutcomeType"     — 7 outcomes; the teaching set for the weighted v2 engine
--   - "PtmPredictionBasis" — heuristic_v1 | weighted_v2 | model_v3
--
-- Doctrine reminders pinned by code reviewers:
--   * PTM scores are advisory-only. Mobile clients NEVER receive raw
--     risk_score or factors blobs — those surfaces are OWNER/COACH only.
--   * Signal writes are fire-and-forget. PtmService.recordSignal catches
--     and logs every failure rather than throwing.
--   * Outcome label re-writes go through the admin teaching endpoint
--     (POST /admin/clients/:id/outcome) which writes an AuditLog row
--     ("ptm.outcome_labelled") carrying both the prior and new outcomes.

-- 1. Enums ----------------------------------------------------------------
CREATE TYPE "PtmSignalType" AS ENUM (
    'checkin_streak',
    'checkin_miss',
    'weight_logged',
    'weight_skipped',
    'message_sent',
    'message_received',
    'coach_note_received',
    'workout_logged',
    'workout_skipped',
    'meal_logged',
    'meal_skipped',
    'finance_eod',
    'finance_milestone',
    'app_open',
    'consistency_low',
    'streak_dropped'
);

CREATE TYPE "PtmOutcomeType" AS ENUM (
    'churned',
    'completed_90day',
    'upgraded',
    'referred',
    'milestone_hit',
    'dropped_off',
    'renewed'
);

CREATE TYPE "PtmPredictionBasis" AS ENUM (
    'heuristic_v1',
    'weighted_v2',
    'model_v3'
);

-- 2. ClientSignal ---------------------------------------------------------
CREATE TABLE "ClientSignal" (
    "id"          TEXT            NOT NULL,
    "user_id"     TEXT            NOT NULL,
    "signal_type" "PtmSignalType" NOT NULL,
    "value"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata"    JSONB,
    "recorded_at" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientSignal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientSignal_user_id_signal_type_recorded_at_idx"
    ON "ClientSignal"("user_id", "signal_type", "recorded_at");
CREATE INDEX "ClientSignal_signal_type_recorded_at_idx"
    ON "ClientSignal"("signal_type", "recorded_at");
ALTER TABLE "ClientSignal"
    ADD CONSTRAINT "ClientSignal_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. ClientOutcome --------------------------------------------------------
CREATE TABLE "ClientOutcome" (
    "id"              TEXT             NOT NULL,
    "user_id"         TEXT             NOT NULL,
    "outcome_type"    "PtmOutcomeType" NOT NULL,
    "labelled_by_id"  TEXT,
    "labelled_at"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"           TEXT,
    "signal_snapshot" JSONB,
    CONSTRAINT "ClientOutcome_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientOutcome_user_id_key" ON "ClientOutcome"("user_id");
CREATE INDEX "ClientOutcome_outcome_type_labelled_at_idx"
    ON "ClientOutcome"("outcome_type", "labelled_at");
CREATE INDEX "ClientOutcome_labelled_by_id_labelled_at_idx"
    ON "ClientOutcome"("labelled_by_id", "labelled_at");
ALTER TABLE "ClientOutcome"
    ADD CONSTRAINT "ClientOutcome_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientOutcome"
    ADD CONSTRAINT "ClientOutcome_labelled_by_id_fkey"
    FOREIGN KEY ("labelled_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. PtmPrediction --------------------------------------------------------
CREATE TABLE "PtmPrediction" (
    "id"               TEXT                  NOT NULL,
    "user_id"          TEXT                  NOT NULL,
    "risk_score"       DOUBLE PRECISION      NOT NULL,
    "success_score"    DOUBLE PRECISION      NOT NULL,
    "prediction_basis" "PtmPredictionBasis"  NOT NULL,
    "factors"          JSONB,
    "computed_at"      TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PtmPrediction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PtmPrediction_user_id_computed_at_idx"
    ON "PtmPrediction"("user_id", "computed_at");
CREATE INDEX "PtmPrediction_prediction_basis_computed_at_idx"
    ON "PtmPrediction"("prediction_basis", "computed_at");
ALTER TABLE "PtmPrediction"
    ADD CONSTRAINT "PtmPrediction_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
