-- Phase 4-5 Connect — Fee policy, split ledger, follow-on transfers,
-- dunning state, and payment reminder log.
--
-- See prisma/schema.prisma block-comments on each model for what each
-- table represents and how the lifecycle flows. Indexes match the read
-- patterns in FeePolicyService, SplitLedgerService, DunningService and
-- the admin/payment-ops controllers.

CREATE TABLE "FeePolicy" (
    "id"                            TEXT        NOT NULL,
    "coach_id"                      TEXT        NOT NULL,
    "platform_application_fee_bps"  INTEGER,
    "head_coach_split_bps"          INTEGER,
    "notes"                         TEXT,
    "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeePolicy_coach_id_key" ON "FeePolicy"("coach_id");

ALTER TABLE "FeePolicy"
    ADD CONSTRAINT "FeePolicy_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "SplitLedgerEntry" (
    "id"                          TEXT        NOT NULL,
    "purchase_id"                 TEXT        NOT NULL,
    "kind"                        TEXT        NOT NULL,
    "payee_user_id"               TEXT,
    "payee_stripe_account_id"     TEXT,
    "amount_cents"                INTEGER     NOT NULL,
    "currency"                    TEXT        NOT NULL DEFAULT 'usd',
    "status"                      TEXT        NOT NULL DEFAULT 'pending',
    "stripe_charge_id"            TEXT,
    "stripe_application_fee_id"   TEXT,
    "stripe_transfer_id"          TEXT,
    "reversed_cents"              INTEGER     NOT NULL DEFAULT 0,
    "idempotency_key"             TEXT,
    "last_error"                  TEXT,
    "posted_at"                   TIMESTAMP(3),
    "reversed_at"                 TIMESTAMP(3),
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SplitLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SplitLedgerEntry_idempotency_key_key"
    ON "SplitLedgerEntry"("idempotency_key");
CREATE UNIQUE INDEX "SplitLedgerEntry_purchase_kind_payee_idx"
    ON "SplitLedgerEntry"("purchase_id", "kind", "payee_user_id");
CREATE INDEX "SplitLedgerEntry_purchase_id_idx" ON "SplitLedgerEntry"("purchase_id");
CREATE INDEX "SplitLedgerEntry_status_idx"      ON "SplitLedgerEntry"("status");
CREATE INDEX "SplitLedgerEntry_kind_status_idx" ON "SplitLedgerEntry"("kind", "status");
CREATE INDEX "SplitLedgerEntry_payee_user_id_status_idx"
    ON "SplitLedgerEntry"("payee_user_id", "status");

ALTER TABLE "SplitLedgerEntry"
    ADD CONSTRAINT "SplitLedgerEntry_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SplitLedgerEntry"
    ADD CONSTRAINT "SplitLedgerEntry_payee_user_id_fkey"
    FOREIGN KEY ("payee_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "ConnectTransfer" (
    "id"                              TEXT        NOT NULL,
    "purchase_id"                     TEXT        NOT NULL,
    "ledger_entry_id"                 TEXT,
    "destination_stripe_account_id"   TEXT        NOT NULL,
    "destination_user_id"             TEXT,
    "amount_cents"                    INTEGER     NOT NULL,
    "currency"                        TEXT        NOT NULL DEFAULT 'usd',
    "source_stripe_charge_id"         TEXT,
    "stripe_transfer_id"              TEXT,
    "status"                          TEXT        NOT NULL DEFAULT 'pending',
    "attempts"                        INTEGER     NOT NULL DEFAULT 0,
    "max_attempts"                    INTEGER     NOT NULL DEFAULT 6,
    "next_attempt_at"                 TIMESTAMP(3),
    "last_attempt_at"                 TIMESTAMP(3),
    "last_error"                      TEXT,
    "idempotency_key"                 TEXT        NOT NULL,
    "posted_at"                       TIMESTAMP(3),
    "reversed_at"                     TIMESTAMP(3),
    "reversed_amount_cents"           INTEGER     NOT NULL DEFAULT 0,
    "created_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConnectTransfer_ledger_entry_id_key" ON "ConnectTransfer"("ledger_entry_id");
CREATE UNIQUE INDEX "ConnectTransfer_idempotency_key_key" ON "ConnectTransfer"("idempotency_key");
CREATE INDEX "ConnectTransfer_status_next_attempt_at_idx"
    ON "ConnectTransfer"("status", "next_attempt_at");
CREATE INDEX "ConnectTransfer_destination_user_id_idx"
    ON "ConnectTransfer"("destination_user_id");
CREATE INDEX "ConnectTransfer_purchase_id_idx"
    ON "ConnectTransfer"("purchase_id");

ALTER TABLE "ConnectTransfer"
    ADD CONSTRAINT "ConnectTransfer_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectTransfer"
    ADD CONSTRAINT "ConnectTransfer_destination_user_id_fkey"
    FOREIGN KEY ("destination_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;


CREATE TABLE "DunningState" (
    "id"                          TEXT        NOT NULL,
    "purchase_id"                 TEXT        NOT NULL,
    "status"                      TEXT        NOT NULL DEFAULT 'active',
    "failure_count"               INTEGER     NOT NULL DEFAULT 0,
    "last_attempt_number"         INTEGER,
    "last_failed_amount_cents"    INTEGER,
    "last_failure_at"             TIMESTAMP(3),
    "last_failure_reason"         TEXT,
    "grace_period_ends_at"        TIMESTAMP(3),
    "cancel_scheduled_at"         TIMESTAMP(3),
    "resolved_at"                 TIMESTAMP(3),
    "abandoned_at"                TIMESTAMP(3),
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DunningState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DunningState_purchase_id_key" ON "DunningState"("purchase_id");
CREATE INDEX "DunningState_status_idx" ON "DunningState"("status");
CREATE INDEX "DunningState_status_cancel_scheduled_at_idx"
    ON "DunningState"("status", "cancel_scheduled_at");

ALTER TABLE "DunningState"
    ADD CONSTRAINT "DunningState_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "PaymentReminder" (
    "id"                  TEXT        NOT NULL,
    "purchase_id"         TEXT        NOT NULL,
    "kind"                TEXT        NOT NULL,
    "channel"             TEXT        NOT NULL,
    "recipient_user_id"   TEXT        NOT NULL,
    "status"              TEXT        NOT NULL DEFAULT 'queued',
    "sent_at"             TIMESTAMP(3),
    "failure_reason"      TEXT,
    "window_key"          TEXT        NOT NULL,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentReminder_purchase_kind_channel_window_idx"
    ON "PaymentReminder"("purchase_id", "kind", "channel", "window_key");
CREATE INDEX "PaymentReminder_purchase_id_kind_idx"
    ON "PaymentReminder"("purchase_id", "kind");
CREATE INDEX "PaymentReminder_status_idx" ON "PaymentReminder"("status");
CREATE INDEX "PaymentReminder_recipient_user_id_idx"
    ON "PaymentReminder"("recipient_user_id");

ALTER TABLE "PaymentReminder"
    ADD CONSTRAINT "PaymentReminder_purchase_id_fkey"
    FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReminder"
    ADD CONSTRAINT "PaymentReminder_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
