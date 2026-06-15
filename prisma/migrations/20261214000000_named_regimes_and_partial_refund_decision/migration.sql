-- F2 — Named Regimes + Partial-Refund Decision Surface
--
-- Additive only. Three new columns on WorkoutProgram (all with safe defaults
-- so existing rows are unaffected) plus the PartialRefundDecision table.

-- ── WorkoutProgram: named-regime layer ──────────────────────────────────────
ALTER TABLE "WorkoutProgram"
  ADD COLUMN "is_regime" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "regime_display_name" TEXT,
  ADD COLUMN "revision_retention_count" INTEGER NOT NULL DEFAULT 3;

-- Regime list query: is_regime=true AND archived_at IS NULL, per coach.
CREATE INDEX "WorkoutProgram_coach_id_is_regime_archived_at_idx"
  ON "WorkoutProgram"("coach_id", "is_regime", "archived_at");

-- ── PartialRefundDecision ───────────────────────────────────────────────────
CREATE TABLE "PartialRefundDecision" (
    "id" TEXT NOT NULL,
    "client_purchase_id" TEXT NOT NULL,
    "stripe_refund_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMP(3),
    "decided_by_coach_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartialRefundDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartialRefundDecision_stripe_refund_id_key"
  ON "PartialRefundDecision"("stripe_refund_id");

CREATE INDEX "PartialRefundDecision_client_purchase_id_decision_idx"
  ON "PartialRefundDecision"("client_purchase_id", "decision");

ALTER TABLE "PartialRefundDecision"
  ADD CONSTRAINT "PartialRefundDecision_client_purchase_id_fkey"
  FOREIGN KEY ("client_purchase_id") REFERENCES "ClientPurchase"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
