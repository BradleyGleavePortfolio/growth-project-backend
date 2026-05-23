-- Audit #1 P0-2 fix — defense-in-depth Row Level Security on every payment,
-- revenue-sharing, and team-mode table introduced in the Connect / Team
-- Phase migrations.
--
-- Threat model: these tables hold Stripe customer IDs, destination account
-- mirrors, purchase state, fee-policy overrides, dunning state, payment
-- reminders, head-coach <-> sub-coach assignments, and team profile data.
-- A leaked or misconfigured Supabase anon/auth key must NOT be able to
-- read or write these rows directly. All access goes through the NestJS
-- backend (service role), which performs ownership checks.
--
-- Policy doctrine for THIS migration: every listed table is a SERVER-ONLY
-- table — there are no Supabase client SELECT/INSERT/UPDATE/DELETE paths
-- against these tables today. We therefore:
--   1. ENABLE + FORCE RLS so the row filter applies to all roles including
--      table owner (FORCE) and bypasses no one (default).
--   2. Add a single `USING (false)` policy named `<table>_server_only`
--      that denies every direct authenticated read/write. Supabase
--      `service_role` bypasses RLS, so the NestJS backend continues to
--      function unchanged. When/if a direct-from-client read path is added
--      later, replace `USING (false)` with the appropriate ownership
--      filter (see comments per-table for the suggested column).
--
-- Also adds two columns to ClientPurchase (stripe_client_secret,
-- stripe_ephemeral_key) used by the PaymentIntent idempotency dedup path
-- in CheckoutService.createPaymentIntentForClient — kept in this migration
-- so payment-table changes ship together.

-- ============================================================================
-- Schema columns for PaymentIntent idempotency cache (R19)
-- ============================================================================
ALTER TABLE "ClientPurchase"
    ADD COLUMN IF NOT EXISTS "stripe_client_secret" TEXT,
    ADD COLUMN IF NOT EXISTS "stripe_ephemeral_key" TEXT;

COMMENT ON COLUMN "ClientPurchase"."stripe_client_secret" IS
    'Phase 7 PaymentIntent dedup — cached PaymentIntent client_secret. Null on the Checkout-session (web redirect) path.';
COMMENT ON COLUMN "ClientPurchase"."stripe_ephemeral_key" IS
    'Phase 7 PaymentIntent dedup — cached Stripe EphemeralKey secret. Null on the Checkout-session (web redirect) path.';

-- ============================================================================
-- ClientPurchase — purchase / entitlement state. Ownership: client_user_id,
--   coach_user_id. Future client-direct SELECT policy:
--     USING (client_user_id = auth.uid() OR coach_user_id = auth.uid())
-- ============================================================================
ALTER TABLE "ClientPurchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPurchase" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ClientPurchase_server_only" ON "ClientPurchase";
CREATE POLICY "ClientPurchase_server_only" ON "ClientPurchase"
    FOR ALL USING (false);
COMMENT ON POLICY "ClientPurchase_server_only" ON "ClientPurchase" IS
    'Server-only table: deny all direct client/anon access. NestJS backend (service_role) bypasses RLS and enforces ownership via createPaymentIntentForClient / listForClient / listForCoach. To allow direct client SELECT, replace with USING (client_user_id = auth.uid() OR coach_user_id = auth.uid()).';

-- ============================================================================
-- ConnectCustomer — Stripe Customer mirror per client. Ownership:
--   client_user_id. Future client-direct SELECT policy:
--     USING (client_user_id = auth.uid())
-- ============================================================================
ALTER TABLE "ConnectCustomer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectCustomer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConnectCustomer_server_only" ON "ConnectCustomer";
CREATE POLICY "ConnectCustomer_server_only" ON "ConnectCustomer"
    FOR ALL USING (false);
COMMENT ON POLICY "ConnectCustomer_server_only" ON "ConnectCustomer" IS
    'Server-only table: deny all direct client/anon access. Stripe customer + default card metadata. NestJS backend (service_role) bypasses RLS. To allow direct client SELECT, replace with USING (client_user_id = auth.uid()).';

-- ============================================================================
-- CoachPackage — coach's catalog of offers. Public-readable in principle,
--   but for now the read path goes through NestJS so we deny direct reads.
-- ============================================================================
ALTER TABLE "CoachPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPackage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CoachPackage_server_only" ON "CoachPackage";
CREATE POLICY "CoachPackage_server_only" ON "CoachPackage"
    FOR ALL USING (false);
COMMENT ON POLICY "CoachPackage_server_only" ON "CoachPackage" IS
    'Server-only table: deny all direct client/anon access. Reads go through PackagesService. To allow direct client SELECT of active packages, replace with USING (is_active = true AND archived_at IS NULL).';

-- ============================================================================
-- FeePolicy — per-coach revenue split overrides. Highly sensitive
--   (head-coach split bps, platform fee overrides). Ownership: coach_id.
-- ============================================================================
ALTER TABLE "FeePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeePolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "FeePolicy_server_only" ON "FeePolicy";
CREATE POLICY "FeePolicy_server_only" ON "FeePolicy"
    FOR ALL USING (false);
COMMENT ON POLICY "FeePolicy_server_only" ON "FeePolicy" IS
    'Server-only table: deny all direct client/anon access. Fee policy overrides must only be visible to platform owners. NestJS backend (service_role) bypasses RLS.';

-- ============================================================================
-- SplitLedgerEntry — internal ledger of platform/head-coach fee allocations.
--   Pure server-side accounting; no client read path exists or is planned.
-- ============================================================================
ALTER TABLE "SplitLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SplitLedgerEntry" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SplitLedgerEntry_server_only" ON "SplitLedgerEntry";
CREATE POLICY "SplitLedgerEntry_server_only" ON "SplitLedgerEntry"
    FOR ALL USING (false);
COMMENT ON POLICY "SplitLedgerEntry_server_only" ON "SplitLedgerEntry" IS
    'Server-only ledger table: deny all direct client/anon access. Backend service_role only.';

-- ============================================================================
-- ConnectTransfer — follow-on transfer queue for head-coach splits.
--   Server-only worker table.
-- ============================================================================
ALTER TABLE "ConnectTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectTransfer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConnectTransfer_server_only" ON "ConnectTransfer";
CREATE POLICY "ConnectTransfer_server_only" ON "ConnectTransfer"
    FOR ALL USING (false);
COMMENT ON POLICY "ConnectTransfer_server_only" ON "ConnectTransfer" IS
    'Server-only worker table: deny all direct client/anon access. Backend service_role only.';

-- ============================================================================
-- DunningState — failed-payment recovery state per purchase. Server-only.
-- ============================================================================
ALTER TABLE "DunningState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DunningState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DunningState_server_only" ON "DunningState";
CREATE POLICY "DunningState_server_only" ON "DunningState"
    FOR ALL USING (false);
COMMENT ON POLICY "DunningState_server_only" ON "DunningState" IS
    'Server-only table: deny all direct client/anon access. Backend service_role only.';

-- ============================================================================
-- PaymentReminder — outbound payment-reminder dispatch log. Server-only.
-- ============================================================================
ALTER TABLE "PaymentReminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentReminder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PaymentReminder_server_only" ON "PaymentReminder";
CREATE POLICY "PaymentReminder_server_only" ON "PaymentReminder"
    FOR ALL USING (false);
COMMENT ON POLICY "PaymentReminder_server_only" ON "PaymentReminder" IS
    'Server-only table: deny all direct client/anon access. Backend service_role only.';

-- ============================================================================
-- TeamProfile — head-coach business name + cached capacity counters.
--   Ownership: head_coach_id. Future client-direct SELECT policy:
--     USING (head_coach_id = auth.uid())
-- ============================================================================
ALTER TABLE "TeamProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamProfile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TeamProfile_server_only" ON "TeamProfile";
CREATE POLICY "TeamProfile_server_only" ON "TeamProfile"
    FOR ALL USING (false);
COMMENT ON POLICY "TeamProfile_server_only" ON "TeamProfile" IS
    'Server-only table: deny all direct client/anon access. Reads/writes via TeamService. To allow direct head-coach SELECT, replace with USING (head_coach_id = auth.uid()).';

-- ============================================================================
-- SubCoachInvite — sub-coach invitation tokens. Highly sensitive
--   (acceptance tokens grant team membership). Ownership: head_coach_id.
-- ============================================================================
ALTER TABLE "SubCoachInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubCoachInvite" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SubCoachInvite_server_only" ON "SubCoachInvite";
CREATE POLICY "SubCoachInvite_server_only" ON "SubCoachInvite"
    FOR ALL USING (false);
COMMENT ON POLICY "SubCoachInvite_server_only" ON "SubCoachInvite" IS
    'Server-only table: invite tokens grant team membership and must never be queryable from the client. NestJS backend (service_role) bypasses RLS. Token redemption is via the public-invites controller.';
