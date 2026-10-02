-- S-DUNNING-R2/R3 (owner rulings 1A / 2A, 2026-10-01 16:30 PDT; fix round 3).
-- Additive only: one nullable column on "DunningState" and three new
-- server-only tables. No backfill, no shipped migration altered. Reverse:
-- down.sql (drops only what this file creates).
--   "DunningState"."client_canceled_at": the client ended the plan during the
--     dunning cycle (2A); written with the durable intent before any void.
--   "ClientBillingLease": per-purchase billing-action lease with a monotonic
--     fence (CAS on holder before every Stripe money call and inside every
--     money-write transaction). Works when no DunningState row exists.
--   "ClientBillingOperation": durable journal of one 1A pay / 2A cancel
--     (phase, per-invoice integer-cent lines); the reconciler resumes it.
--   "DunningNoticeDelivery": durable per-channel notice outbox, keyed per
--     cycle, retried by the hourly sweep.
-- RLS: the three tables are server-only (service_role full access; anon and
-- authenticated get nothing). No client ever reads them directly.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "DunningState" ADD COLUMN IF NOT EXISTS "client_canceled_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClientBillingLease" (
    "purchase_id" TEXT NOT NULL,
    "holder" TEXT,
    "holder_until" TIMESTAMP(3),
    "fence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientBillingLease_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateTable
CREATE TABLE "ClientBillingOperation" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "fence" INTEGER NOT NULL,
    "setup_intent_id" TEXT,
    "lines" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ClientBillingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DunningNoticeDelivery" (
    "id" TEXT NOT NULL,
    "dunning_state_id" TEXT NOT NULL,
    "cycle_key" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DunningNoticeDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientBillingOperation_purchase_id_kind_completed_at_idx" ON "ClientBillingOperation"("purchase_id", "kind", "completed_at");

-- CreateIndex
CREATE INDEX "ClientBillingOperation_kind_completed_at_updated_at_idx" ON "ClientBillingOperation"("kind", "completed_at", "updated_at");

-- CreateIndex
CREATE INDEX "ClientBillingOperation_setup_intent_id_idx" ON "ClientBillingOperation"("setup_intent_id");

-- CreateIndex
CREATE INDEX "DunningNoticeDelivery_status_next_attempt_at_idx" ON "DunningNoticeDelivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "DunningNoticeDelivery_dunning_state_id_cycle_key_idx" ON "DunningNoticeDelivery"("dunning_state_id", "cycle_key");

-- AddForeignKey
ALTER TABLE "ClientBillingLease" ADD CONSTRAINT "ClientBillingLease_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientBillingOperation" ADD CONSTRAINT "ClientBillingOperation_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DunningNoticeDelivery" ADD CONSTRAINT "DunningNoticeDelivery_dunning_state_id_fkey" FOREIGN KEY ("dunning_state_id") REFERENCES "DunningState"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS: server-only tables.
ALTER TABLE "ClientBillingLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientBillingLease" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientBillingOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientBillingOperation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "DunningNoticeDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DunningNoticeDelivery" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "ClientBillingLease" FROM anon;
REVOKE ALL ON TABLE "ClientBillingOperation" FROM anon;
REVOKE ALL ON TABLE "DunningNoticeDelivery" FROM anon;

CREATE POLICY "p_clientbillinglease_service_role_all" ON "ClientBillingLease"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_all_anon_clientbillinglease" ON "ClientBillingLease"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE POLICY "p_clientbillingoperation_service_role_all" ON "ClientBillingOperation"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_all_anon_clientbillingoperation" ON "ClientBillingOperation"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE POLICY "p_dunningnoticedelivery_service_role_all" ON "DunningNoticeDelivery"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_all_anon_dunningnoticedelivery" ON "DunningNoticeDelivery"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

RESET lock_timeout;
