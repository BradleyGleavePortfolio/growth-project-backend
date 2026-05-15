-- Phase 6 Connect — Payout snapshot, refund/dispute mirror, reconciliation
-- snapshot. See prisma/schema.prisma block-comments on each model for
-- what each table represents and how the lifecycle flows.
--
-- All four tables hang off ClientPurchase (CASCADE on delete) or User
-- (CASCADE on delete) so test teardown / GDPR erase paths sweep them
-- cleanly without orphaning Stripe-mirror rows.

CREATE TABLE "PayoutSnapshot" (
    "id"                          TEXT        NOT NULL,
    "coach_user_id"               TEXT        NOT NULL,
    "stripe_account_id"           TEXT        NOT NULL,
    "readiness_status"            TEXT        NOT NULL DEFAULT 'needs_action',
    "charges_enabled"             BOOLEAN     NOT NULL DEFAULT false,
    "payouts_enabled"             BOOLEAN     NOT NULL DEFAULT false,
    "details_submitted"           BOOLEAN     NOT NULL DEFAULT false,
    "requirements_due"            JSONB,
    "disabled_reason"             TEXT,
    "available_cents"             INTEGER     NOT NULL DEFAULT 0,
    "pending_cents"               INTEGER     NOT NULL DEFAULT 0,
    "in_transit_cents"            INTEGER     NOT NULL DEFAULT 0,
    "reserved_cents"              INTEGER     NOT NULL DEFAULT 0,
    "currency"                    TEXT        NOT NULL DEFAULT 'usd',
    "raw_balance"                 JSONB,
    "last_payout_stripe_id"       TEXT,
    "last_payout_amount_cents"    INTEGER,
    "last_payout_status"          TEXT,
    "last_payout_arrival_at"      TIMESTAMP(3),
    "last_payout_failure_message" TEXT,
    "next_payout_at"              TIMESTAMP(3),
    "refreshed_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stale_after"                 TIMESTAMP(3),
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutSnapshot_coach_user_id_key"
    ON "PayoutSnapshot"("coach_user_id");
CREATE INDEX "PayoutSnapshot_readiness_status_idx"
    ON "PayoutSnapshot"("readiness_status");
CREATE INDEX "PayoutSnapshot_stripe_account_id_idx"
    ON "PayoutSnapshot"("stripe_account_id");

ALTER TABLE "PayoutSnapshot"
    ADD CONSTRAINT "PayoutSnapshot_coach_user_id_fkey"
    FOREIGN KEY ("coach_user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "ChargeRefund" (
    "id"                    TEXT        NOT NULL,
    "purchase_id"           TEXT        NOT NULL,
    "stripe_refund_id"      TEXT        NOT NULL,
    "stripe_charge_id"      TEXT        NOT NULL,
    "amount_cents"          INTEGER     NOT NULL,
    "currency"              TEXT        NOT NULL DEFAULT 'usd',
    "status"                TEXT        NOT NULL DEFAULT 'pending',
    "reason"                TEXT,
    "note"                  TEXT,
    "initiated_by_user_id"  TEXT,
    "failure_reason"        TEXT,
    "ledger_reversed"       BOOLEAN     NOT NULL DEFAULT false,
    "transfer_reversed"     BOOLEAN     NOT NULL DEFAULT false,
    "posted_at"             TIMESTAMP(3),
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChargeRefund_stripe_refund_id_key"
    ON "ChargeRefund"("stripe_refund_id");
CREATE INDEX "ChargeRefund_purchase_id_idx"  ON "ChargeRefund"("purchase_id");
CREATE INDEX "ChargeRefund_status_idx"       ON "ChargeRefund"("status");
CREATE INDEX "ChargeRefund_stripe_charge_id_idx"
    ON "ChargeRefund"("stripe_charge_id");

ALTER TABLE "ChargeRefund"
    ADD CONSTRAINT "ChargeRefund_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "ChargeDispute" (
    "id"                     TEXT        NOT NULL,
    "purchase_id"            TEXT        NOT NULL,
    "stripe_dispute_id"      TEXT        NOT NULL,
    "stripe_charge_id"       TEXT        NOT NULL,
    "amount_cents"           INTEGER     NOT NULL,
    "currency"               TEXT        NOT NULL DEFAULT 'usd',
    "status"                 TEXT        NOT NULL DEFAULT 'needs_response',
    "reason"                 TEXT,
    "evidence_due_by"        TIMESTAMP(3),
    "evidence_submitted_at"  TIMESTAMP(3),
    "ledger_reversed"        BOOLEAN     NOT NULL DEFAULT false,
    "closed_at"              TIMESTAMP(3),
    "balance_transaction_id" TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChargeDispute_stripe_dispute_id_key"
    ON "ChargeDispute"("stripe_dispute_id");
CREATE INDEX "ChargeDispute_purchase_id_idx"   ON "ChargeDispute"("purchase_id");
CREATE INDEX "ChargeDispute_status_idx"        ON "ChargeDispute"("status");
CREATE INDEX "ChargeDispute_stripe_charge_id_idx"
    ON "ChargeDispute"("stripe_charge_id");

ALTER TABLE "ChargeDispute"
    ADD CONSTRAINT "ChargeDispute_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "ReconciliationSnapshot" (
    "id"                            TEXT        NOT NULL,
    "purchase_id"                   TEXT        NOT NULL,
    "status"                        TEXT        NOT NULL DEFAULT 'ok',
    "drift_cents"                   INTEGER,
    "stripe_amount_cents"           INTEGER,
    "stripe_refunded_cents"         INTEGER,
    "stripe_application_fee_cents"  INTEGER,
    "stripe_transfers_cents"        INTEGER,
    "ledger_destination_cents"      INTEGER,
    "ledger_application_fee_cents"  INTEGER,
    "ledger_head_coach_cents"       INTEGER,
    "ledger_reversed_cents"         INTEGER,
    "notes"                         TEXT,
    "last_checked_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReconciliationSnapshot_purchase_id_key"
    ON "ReconciliationSnapshot"("purchase_id");
CREATE INDEX "ReconciliationSnapshot_status_idx"
    ON "ReconciliationSnapshot"("status");

ALTER TABLE "ReconciliationSnapshot"
    ADD CONSTRAINT "ReconciliationSnapshot_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
