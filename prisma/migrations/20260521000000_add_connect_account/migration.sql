-- Phase 1 Connect (CONNECT_MASTER_PLAN.md §Phase 1 — Foundation):
-- Stripe Express account per coach. One row per coach (coach_user_id @unique),
-- one row per Stripe account (stripe_account_id @unique). The mirror is
-- maintained by the Stripe webhook handler (account.updated, capability.updated,
-- account.application.deauthorized).
--
-- requirements_due holds Stripe's verbatim `requirements` object for
-- diagnostics. disabled_reason is the top-level Stripe disabled_reason string
-- when Stripe pauses an account. deauthorized_at marks accounts that revoked
-- platform access — those rows are read-only until the coach reconnects.

CREATE TABLE "ConnectAccount" (
    "id"                TEXT        NOT NULL,
    "coach_user_id"     TEXT        NOT NULL,
    "stripe_account_id" TEXT        NOT NULL,
    "country"           TEXT        NOT NULL DEFAULT 'US',
    "default_currency"  TEXT        NOT NULL DEFAULT 'usd',
    "charges_enabled"   BOOLEAN     NOT NULL DEFAULT false,
    "payouts_enabled"   BOOLEAN     NOT NULL DEFAULT false,
    "details_submitted" BOOLEAN     NOT NULL DEFAULT false,
    "requirements_due"  JSONB,
    "disabled_reason"   TEXT,
    "deauthorized_at"   TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectAccount_coach_user_id_key"     ON "ConnectAccount"("coach_user_id");
CREATE UNIQUE INDEX "ConnectAccount_stripe_account_id_key" ON "ConnectAccount"("stripe_account_id");
CREATE        INDEX "ConnectAccount_stripe_account_id_idx" ON "ConnectAccount"("stripe_account_id");

ALTER TABLE "ConnectAccount"
    ADD CONSTRAINT "ConnectAccount_coach_user_id_fkey"
    FOREIGN KEY ("coach_user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
