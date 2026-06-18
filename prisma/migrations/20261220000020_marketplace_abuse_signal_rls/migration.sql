-- TM-6 — anti-bot / abuse gate: PII-governed heuristic + abuse-log store.
--
-- Creates "MarketplaceAbuseSignal", the append-only store the in-house
-- anti-bot provider writes one row to per gate evaluation. Every correlatable
-- identifier (email / IP / device fingerprint) is sha256-hashed by the
-- provider BEFORE insert — this table holds fixed-width hashes only, never
-- raw PII.
--
-- RLS summary: RESTRICTIVE deny-all to anon + authenticated. The store is
-- written/read ONLY by the server-side gate running as service_role
-- (Primitive A bypass). This mirrors MarketplaceMutationIdempotency from
-- 20261220000000_talent_marketplace_rls — the RESTRICTIVE policies AND with
-- any permissive grant, so no non-service principal can ever touch a row.
--
-- This migration is dated AFTER 20261220000000_talent_marketplace_rls and
-- performs ONLY additive DDL (one CREATE TABLE + its indexes + RLS); it does
-- not alter any shipped migration.

-- =====================================================================
-- 1) Table
-- =====================================================================
CREATE TABLE "MarketplaceAbuseSignal" (
    "id"            TEXT NOT NULL,
    "surface"       TEXT NOT NULL,
    "ip_hash"       TEXT NOT NULL,
    "identity_hash" TEXT NOT NULL,
    "device_hash"   TEXT NOT NULL,
    "reason"        TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketplaceAbuseSignal_pkey" PRIMARY KEY ("id")
);

-- =====================================================================
-- 2) Indexes — drive the device→identity and identity→ip fan-out heuristics,
--    both windowed by created_at.
-- =====================================================================
CREATE INDEX "MarketplaceAbuseSignal_device_hash_created_at_idx"
    ON "MarketplaceAbuseSignal"("device_hash", "created_at");
CREATE INDEX "MarketplaceAbuseSignal_identity_hash_created_at_idx"
    ON "MarketplaceAbuseSignal"("identity_hash", "created_at");
CREATE INDEX "MarketplaceAbuseSignal_surface_created_at_idx"
    ON "MarketplaceAbuseSignal"("surface", "created_at");

-- =====================================================================
-- 3) RLS — RESTRICTIVE deny-all to anon + authenticated (service_role only).
-- =====================================================================
ALTER TABLE "MarketplaceAbuseSignal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketplaceAbuseSignal" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_marketplace_abuse_signal_service_role_all" ON "MarketplaceAbuseSignal";
CREATE POLICY "p_marketplace_abuse_signal_service_role_all" ON "MarketplaceAbuseSignal" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_marketplace_abuse_signal_service_role_all" ON "MarketplaceAbuseSignal" IS 'Primitive A: service_role bypass. The abuse-signal store is written/read only by the server-side anti-bot gate (TM-6) running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_marketplace_abuse_signal" ON "MarketplaceAbuseSignal";
CREATE POLICY "deny_all_anon_marketplace_abuse_signal" ON "MarketplaceAbuseSignal" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_marketplace_abuse_signal" ON "MarketplaceAbuseSignal" IS 'RESTRICTIVE deny-all: anon can never read/write the abuse-signal store regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_marketplace_abuse_signal" ON "MarketplaceAbuseSignal";
CREATE POLICY "deny_all_authenticated_marketplace_abuse_signal" ON "MarketplaceAbuseSignal" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_marketplace_abuse_signal" ON "MarketplaceAbuseSignal" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the abuse-signal store; only service_role (Primitive A) may.';
