-- Consent layer v1: client-to-coach data access.
--
-- Additive only. Existing rows stay valid. No backfill required.
--
-- Model: one row per (client_id, coach_id, scope). `granted_at` is the
-- last grant timestamp; `revoked_at` is the last revoke timestamp. The
-- effective state at read-time is "granted" iff `revoked_at IS NULL OR
-- revoked_at < granted_at`. Keeping both timestamps (rather than a single
-- boolean) preserves the audit trail of the most recent transition on
-- the row itself; the canonical history lives in AuditLog.
--
-- Scope strings (validated in the service layer, not in SQL, so adding
-- new scopes does not require a migration):
--   fitness.profile, fitness.body_metrics, fitness.workouts,
--   fitness.food_macros, fitness.habits_progress,
--   finance.summary, finance.balances, finance.transaction_categories,
--   finance.transaction_line_items, finance.reports
--
-- The (client_id, coach_id, scope) unique constraint lets the service
-- upsert a row idempotently per scope. coach_id references User.id (the
-- coach is always a User in this app, mirroring the rest of the schema).

CREATE TABLE "ClientCoachConsent" (
    "id"          TEXT NOT NULL,
    "client_id"   TEXT NOT NULL,
    "coach_id"    TEXT NOT NULL,
    "scope"       TEXT NOT NULL,
    "granted_at"  TIMESTAMP(3),
    "revoked_at"  TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientCoachConsent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientCoachConsent_client_coach_scope_key"
    ON "ClientCoachConsent"("client_id", "coach_id", "scope");
CREATE INDEX "ClientCoachConsent_client_id_idx"
    ON "ClientCoachConsent"("client_id");
CREATE INDEX "ClientCoachConsent_coach_id_idx"
    ON "ClientCoachConsent"("coach_id");

ALTER TABLE "ClientCoachConsent"
    ADD CONSTRAINT "ClientCoachConsent_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientCoachConsent"
    ADD CONSTRAINT "ClientCoachConsent_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
